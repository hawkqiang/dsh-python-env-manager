import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { discover } from './discover.mjs'

export const inject = ['tools', 'systemPrompt', 'shellEnv', 'workingDirectory', 'sandboxPolicy', 'subprocess']

export const API_PREFIX = '/python-env/api'
export const DEFAULT_STATE_FILE = path.join(homedir(), '.dsh', 'python-env-manager', 'state.json')
export const STATE_VERSION = 2

const actions = ['list', 'select', 'resolve', 'clear']
const pageSize = 40
const interpreterBasename = /^python(\d+(?:\.\d+)?)?(\.exe)?$/i
const sessionIdPattern = /^[^\s\u0000-\u001f]{1,200}$/
const isWindows = process.platform === 'win32'
const pathKey = value => (isWindows ? value.toLowerCase() : value)

/**
 * The state path is fixed for production. The environment override exists only
 * so tests (and local probes) can point at a throwaway file without touching the
 * user's real selection; DSH itself never sets it.
 */
function stateFile() {
  const override = process.env.DSH_PYTHON_ENV_MANAGER_STATE
  if (typeof override === 'string' && override.trim() !== '' && path.isAbsolute(override.trim())) {
    return path.normalize(override.trim())
  }
  return DEFAULT_STATE_FILE
}

/** Shared by the HTTP API and the tools: non-empty, <=200 chars, no whitespace/control chars. */
export function validateSessionId(value) {
  if (typeof value !== 'string' || !sessionIdPattern.test(value)) {
    throw new Error('会话 ID 无效：必须是非空字符串，长度不超过 200，且不含空白或控制字符。')
  }
  return value
}

/**
 * Atomic JSON file holding `{ version: 2, sessions: { [sessionId]: interpreter } }`.
 * The legacy `{ selectedPath }` shape is deliberately ignored: there is no
 * profile-wide fallback, so every conversation must make its own selection.
 */
export function createStore(file = stateFile()) {
  const sessions = new Map()

  const pick = parsed => {
    const next = new Map()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return next
    if (parsed.version !== STATE_VERSION) return next
    const raw = parsed.sessions
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return next
    for (const [sessionId, value] of Object.entries(raw)) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || !sessionIdPattern.test(sessionId)) continue
      next.set(sessionId, path.normalize(value))
    }
    return next
  }

  const replace = values => {
    sessions.clear()
    for (const [sessionId, selected] of values) sessions.set(sessionId, selected)
  }

  const readSync = () => {
    try {
      replace(pick(JSON.parse(readFileSync(file, 'utf8'))))
    } catch {
      replace(new Map())
    }
  }
  readSync()

  const snapshot = () => Object.fromEntries(
    [...sessions.entries()].sort(([left], [right]) => left.localeCompare(right)),
  )

  // Serialize writes so two rapid changes cannot land on disk out of order.
  let writing = Promise.resolve()
  const persist = () => {
    const data = { version: STATE_VERSION, sessions: snapshot() }
    const run = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
        await rename(tmp, file)
      } catch (error) {
        await unlink(tmp).catch(() => {})
        throw error
      }
    })
    writing = run.catch(() => {})
    return run
  }

  return {
    file,
    /** Synchronous in-memory lookup; call load() first to observe other processes' writes. */
    get(sessionId) {
      validateSessionId(sessionId)
      return sessions.get(sessionId) ?? null
    },
    /** Re-read the file before any HTTP/tool decision so toolbar changes apply immediately. */
    async load() {
      try {
        replace(pick(JSON.parse(await readFile(file, 'utf8'))))
      } catch {
        replace(new Map())
      }
      return snapshot()
    },
    async set(sessionId, interpreter) {
      validateSessionId(sessionId)
      if (typeof interpreter !== 'string' || !path.isAbsolute(interpreter)) {
        throw new Error('Python 解释器必须是绝对路径。')
      }
      sessions.set(sessionId, path.normalize(interpreter))
      await persist()
      return sessions.get(sessionId)
    },
    async clear(sessionId) {
      validateSessionId(sessionId)
      sessions.delete(sessionId)
      await persist()
      return null
    },
  }
}

async function interpreterAvailability(value) {
  try {
    const info = await stat(value)
    return info.isFile() ? null : 'not-a-file'
  } catch {
    return 'missing'
  }
}

/** Absolute path + existing file + basename `python`/`python.exe`; returns normalized path. */
export async function validateInterpreterPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || !path.isAbsolute(text)) throw new Error('Python 解释器必须是绝对路径。')
  const normalized = path.normalize(text)
  if (!interpreterBasename.test(path.basename(normalized))) {
    throw new Error('路径的文件名必须为 python、python3 或 python.exe。')
  }
  const availability = await interpreterAvailability(normalized)
  if (availability === 'missing') throw new Error(`解释器文件不存在：${normalized}`)
  if (availability === 'not-a-file') throw new Error(`解释器路径不是文件：${normalized}`)
  return normalized
}

function sessionIdOf(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Resolve the session that owns an agent. Subagents follow the conversation
 * they were started from, so their selection is the root agent's session. The
 * subagents service is optional; without it (or if rootOf throws) the agent's
 * own session is used.
 */
function rootSessionId(ctx, agent) {
  let root = null
  try {
    const subagents = ctx.get('subagents')
    root = subagents?.rootOf?.(agent) ?? null
  } catch {
    root = null
  }
  return sessionIdOf(root) ?? sessionIdOf(agent)
}

function environmentRows(rows) {
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || !path.isAbsolute(row.path)) continue
    const key = pathKey(path.normalize(row.path))
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: typeof row.name === 'string' && row.name !== '' ? row.name : path.basename(row.prefix ?? row.path),
      prefix: row.prefix,
      path: row.path,
      source: row.source,
    })
  }
  return out
}

async function environmentsIn(cwd) {
  return environmentRows(await discover({ cwd }))
}

/** Descriptor used when a validated interpreter is not present in discovery. */
function manualEnvironment(interpreter) {
  const dir = path.dirname(interpreter)
  const tail = path.basename(dir).toLowerCase()
  const prefix = tail === 'scripts' || tail === 'bin' ? path.dirname(dir) : dir
  return { name: path.basename(prefix) || path.basename(interpreter), prefix, path: interpreter, source: 'manual' }
}

function findEnvironment(rows, interpreter) {
  const key = pathKey(interpreter)
  return rows.find(row => pathKey(path.normalize(row.path)) === key)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit = 64 * 1024) {
  try {
    const raw = await readBody(req, limit)
    if (raw.length === 0) return {}
    const parsed = JSON.parse(raw.toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readCollected(handle, stream) {
  const reader = handle?.collected?.[stream]
  if (!reader || typeof reader.readFrom !== 'function') return { text: '', lossy: false }
  try {
    const read = reader.readFrom(0)
    return {
      text: typeof read?.text === 'string' ? read.text : '',
      lossy: read?.lossy === true,
      spillPath: typeof read?.spillPath === 'string' ? read.spillPath : undefined,
    }
  } catch {
    return { text: '', lossy: false }
  }
}

function renderRun(value) {
  const result = value !== null && typeof value === 'object' ? value : {}
  const lines = [
    `Interpreter: ${typeof result.interpreter === 'string' ? result.interpreter : '(unknown)'}`,
  ]
  if (typeof result.environmentName === 'string') lines.push(`Environment: ${result.environmentName}`)
  if (typeof result.sessionId === 'string') lines.push(`Session: ${result.sessionId}`)
  lines.push(`CWD: ${typeof result.cwd === 'string' ? result.cwd : '(unknown)'}`)
  lines.push(`Exit code: ${result.exitCode ?? 'null'}${result.signal ? ` (signal: ${result.signal})` : ''}`)
  if (result.stdoutLossy) lines.push('stdout: truncated (see spillPaths for the full stream)')
  if (result.stderrLossy) lines.push('stderr: truncated (see spillPaths for the full stream)')
  if (Array.isArray(result.spillPaths) && result.spillPaths.length > 0) {
    lines.push(`Spill files: ${result.spillPaths.join(', ')}`)
  }
  lines.push('', '--- stdout ---', typeof result.stdout === 'string' && result.stdout !== '' ? result.stdout : '(empty)')
  lines.push('', '--- stderr ---', typeof result.stderr === 'string' && result.stderr !== '' ? result.stderr : '(empty)')
  return lines.join('\n')
}

const NO_SELECTION = '本对话尚未选择默认 Python 解释器。请在输入框工具栏为该对话选择；不会继承其他对话，也不会回退到系统 Python。'

export function apply(ctx, config = {}) {
  const store = createStore()

  ctx.effect(() => ctx.tools.register({
    name: 'python_env_manager',
    description: 'List local Python candidates, select or clear the Python interpreter for this conversation (including its subagents), or resolve that interpreter for a sandboxed shell. The selection applies only to the current conversation and its subagents; it does not affect other conversations, and a conversation without a selection never inherits another one or the system Python. The selection is stored per session in ~/.dsh/python-env-manager/state.json. On ambiguous names, show matching environments and ask which one; never guess. Report that the change affects this conversation only, not the system or other terminals. Does not execute Python; use python_env_run to execute the selected interpreter.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions },
        path: { type: 'string', description: 'select only: exact absolute path of the interpreter to select.' },
        offset: { type: 'integer', description: 'list only: zero-based offset (default 0).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ action, path: choice, offset }, exec) {
      if (!actions.includes(action) || (action !== 'select' && choice !== undefined) ||
          (offset !== undefined && (action !== 'list' || !Number.isSafeInteger(offset) || offset < 0))) {
        throw new Error('操作或参数无效。')
      }
      const sessionId = rootSessionId(ctx, exec?.agent)
      if (sessionId === null) {
        throw new Error('无法确定当前对话（缺少 agent 或 session）；不会使用任何全局默认解释器。')
      }
      validateSessionId(sessionId)
      await store.load()
      if (action === 'clear') {
        await store.clear(sessionId)
        return { status: 'cleared', sessionId }
      }
      const cwd = exec?.agent
        ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        : ctx.workingDirectory.defaultDirectory
      const rows = await environmentsIn(cwd)
      if (action === 'list') {
        const selected = store.get(sessionId)
        const start = offset ?? 0
        const end = start + pageSize
        return {
          sessionId,
          selected,
          selectedAvailable: !!selected && rows.some(row => pathKey(row.path) === pathKey(selected)),
          total: rows.length,
          environments: rows.slice(start, end),
          nextOffset: end < rows.length ? end : null,
        }
      }
      if (action === 'select') {
        const interpreter = await validateInterpreterPath(choice)
        const environment = findEnvironment(rows, interpreter) ?? manualEnvironment(interpreter)
        await store.set(sessionId, interpreter)
        return { status: 'selected', sessionId, selected: interpreter, environment }
      }
      const selected = store.get(sessionId)
      if (!selected) {
        throw new Error(`${NO_SELECTION} 请先 list，然后按用户意愿 select。`)
      }
      const availability = await interpreterAvailability(selected)
      if (availability === 'missing') throw new Error(`所选解释器当前不可用（文件不存在）：${selected}。不会回退到其他环境。`)
      if (availability === 'not-a-file') throw new Error(`所选解释器当前不可用（不是文件）：${selected}。不会回退到其他环境。`)
      return {
        sessionId,
        executable: selected,
        environment: findEnvironment(rows, selected) ?? manualEnvironment(selected),
        execution: 'Use only a sandboxed shell with this exact executable as a quoted literal. Stop if the sandbox is unavailable or denies access. Do not change PATH or activate scripts.',
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'python_env_run',
    description: 'Default execution entry point for the Python interpreter selected in this conversation\'s DSH toolbar; subagents use the interpreter of the conversation they belong to. This is not a shell: every argv entry is passed literally to the interpreter as one argument, with no shell expansion, quoting, pipes, redirection, globbing, or environment activation. Runs are subject to the session sandbox and permission policy, and this tool never changes PATH or bypasses the sandbox. Do not use it to install software or activate environments. If this conversation has no selected interpreter, it fails instead of inheriting another conversation\'s choice or substituting the system Python.',
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Literal arguments after the interpreter, e.g. ["-c","print(1)"] or ["script.py","a"]',
        },
        cwd: { type: 'string', description: 'Working directory; a relative path resolves against the session directory.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Terminate after this many milliseconds (default 120000).' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: renderRun(value) }] },
    async execute(input, exec) {
      const args = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null
      if (!args) throw new Error('参数必须是对象。')
      const { argv, cwd: requestedCwd } = args
      const timeoutMs = args.timeoutMs ?? 120000
      if (!Array.isArray(argv) || argv.length === 0 || argv.some(item => typeof item !== 'string')) {
        throw new Error('argv 必须是非空的字符串数组。')
      }
      if (requestedCwd !== undefined && (typeof requestedCwd !== 'string' || requestedCwd.trim() === '')) {
        throw new Error('cwd 必须是非空字符串。')
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
        throw new Error('timeoutMs 必须是 1000 到 600000 之间的整数。')
      }
      if (exec?.signal?.aborted) throw new Error('执行已取消。')

      const sessionId = rootSessionId(ctx, exec?.agent)
      if (sessionId === null) {
        throw new Error('无法确定当前对话（缺少 agent 或 session），不能解析 Python 解释器；不会回退到系统 Python。')
      }
      validateSessionId(sessionId)
      await store.load()
      const interpreter = store.get(sessionId)
      if (!interpreter) {
        throw new Error(NO_SELECTION)
      }
      const availability = await interpreterAvailability(interpreter)
      if (availability) {
        throw new Error(`所选 Python 解释器不可用（${availability === 'missing' ? '文件不存在' : '不是文件'}）：${interpreter}。请在该对话中重新选择；不会回退到其他解释器。`)
      }

      const sessionCwd = exec?.agent
        ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        : ctx.workingDirectory.defaultDirectory
      const cwd = typeof requestedCwd === 'string'
        ? (path.isAbsolute(requestedCwd) ? path.normalize(requestedCwd) : path.resolve(sessionCwd, requestedCwd))
        : sessionCwd
      if (!path.isAbsolute(cwd)) throw new Error('解析后的工作目录不是绝对路径。')
      const cwdInfo = await stat(cwd).catch(() => null)
      if (!cwdInfo?.isDirectory()) throw new Error(`工作目录不存在或不是目录：${cwd}`)

      const session = exec?.agent?.session
      const policy = ctx.sandboxPolicy.resolve(session ? { session } : {})
      const baseArgv = [interpreter, ...argv]
      let spawnArgv = baseArgv
      if (policy.mode !== 'danger-full-access') {
        const sandbox = ctx.get('sandbox')
        if (!sandbox) {
          throw new Error('当前主机没有可用的沙箱服务；已拒绝在无约束环境中运行 Python（不会绕过沙箱）。')
        }
        const confined = await sandbox.confine(baseArgv, policy, exec.signal)
        if (!confined || !Array.isArray(confined.argv) || confined.argv.length === 0) {
          throw new Error('沙箱未返回可执行的受限命令；已拒绝执行。')
        }
        spawnArgv = confined.argv
      }

      let handle = null
      let timedOut = false
      const controller = new AbortController()
      const abortRun = () => {
        controller.abort()
        try {
          handle?.terminate()
        } catch {
          /* already exited */
        }
      }
      const onOuterAbort = () => abortRun()
      const timer = setTimeout(() => {
        timedOut = true
        abortRun()
      }, timeoutMs)
      exec?.signal?.addEventListener?.('abort', onOuterAbort, { once: true })
      if (exec?.signal?.aborted) abortRun()
      let outcome
      try {
        handle = ctx.subprocess.spawn({
          argv: spawnArgv,
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 2 * 1024 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } },
            stderr: { maxBytes: 2 * 1024 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } },
          },
          graceMs: 5000,
          signal: controller.signal,
        })
        outcome = await handle.done
      } catch (error) {
        if (timedOut) throw new Error(`Python 执行超过 ${timeoutMs} ms，已超时终止。`)
        if (exec?.signal?.aborted) throw new Error('Python 执行已取消。')
        throw error
      } finally {
        clearTimeout(timer)
        exec?.signal?.removeEventListener?.('abort', onOuterAbort)
      }
      if (timedOut) throw new Error(`Python 执行超过 ${timeoutMs} ms，已超时终止。`)
      if (exec?.signal?.aborted) throw new Error('Python 执行已取消。')

      const stdout = readCollected(handle, 'stdout')
      const stderr = readCollected(handle, 'stderr')
      const environment = findEnvironment(await environmentsIn(sessionCwd).catch(() => []), interpreter) ??
        manualEnvironment(interpreter)
      const spillPaths = [stdout.spillPath, stderr.spillPath].filter(item => typeof item === 'string')
      const result = {
        sessionId,
        interpreter,
        environmentName: environment.name,
        cwd,
        exitCode: outcome?.exitCode ?? null,
        signal: outcome?.signal ?? null,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutLossy: stdout.lossy,
        stderrLossy: stderr.lossy,
      }
      if (spillPaths.length > 0) result.spillPaths = spillPaths
      return result
    },
  }))

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'python-env-manager',
    order: 700,
    text: 'Python interpreters are selected per conversation: each conversation and its subagents share one selection, and no conversation inherits another conversation\'s selection or the system Python. Every Python task (including subagents) must run through the python_env_run tool instead of a bare python/python3 or the system interpreter. If this conversation has no selected interpreter, ask the user to choose one from that conversation\'s input-toolbar picker instead of using the system python; do not change PATH. python_env_run passes arguments literally and is still constrained by the session sandbox and permissions. Do not change PATH or elevate permissions. If the selected interpreter is missing or unavailable, report the failure instead of substituting another Python. Use python_env_run to execute Python code only, not to install software or activate environments.',
  }))

  ctx.effect(() => ctx.shellEnv.register({
    name: 'python-env-manager',
    variables: {
      DSH_PYTHON: {
        description: 'Absolute path of the interpreter selected for this conversation (subagents follow their root conversation); use only in an already-permitted sandboxed shell, without changing PATH or activating environments.',
      },
    },
    resolve: execution => {
      try {
        const sessionId = rootSessionId(ctx, execution?.agent)
        if (sessionId === null) return {}
        const selected = store.get(sessionId)
        return selected ? { DSH_PYTHON: selected } : {}
      } catch {
        return {}
      }
    },
  }))

  const stateFor = async sessionId => {
    await store.load()
    return {
      ok: true,
      sessionId,
      selected: store.get(sessionId),
      environments: await environmentsIn(ctx.workingDirectory.defaultDirectory),
    }
  }

  const handler = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'only GET and POST are supported' })
      }
      // Same-origin guard: a browser sends Origin on cross-site POSTs; require its
      // host to match this request's Host header. Requests without Origin (curl,
      // local tools) are allowed — the server only binds the loopback listener.
      const origin = req.headers?.origin
      if (typeof origin === 'string' && origin !== '') {
        let originHost
        try { originHost = new URL(origin).host } catch { originHost = null }
        if (!originHost || originHost !== req.headers?.host) {
          return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      let rest = url.pathname.slice(API_PREFIX.length)
      if (rest.length > 1 && rest.endsWith('/')) rest = rest.slice(0, -1)

      const expected = { '/state': 'GET', '/select': 'POST', '/clear': 'POST', '/refresh': 'POST' }
      if (!Object.prototype.hasOwnProperty.call(expected, rest)) {
        return sendJson(res, 404, { ok: false, error: `unknown route "${rest}"` })
      }
      if (expected[rest] !== req.method) {
        return sendJson(res, 405, { ok: false, error: `${rest} only supports ${expected[rest]}` })
      }

      const sessionFrom = value => {
        try {
          return { sessionId: validateSessionId(value) }
        } catch (error) {
          return { error: String(error?.message ?? error) }
        }
      }

      if (rest === '/state' || rest === '/refresh') {
        let body = null
        if (rest === '/refresh') {
          body = await readJson(req, 4096)
          if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid json' })
        }
        const raw = rest === '/refresh'
          ? (body.sessionId ?? url.searchParams.get('sessionId'))
          : url.searchParams.get('sessionId')
        const { sessionId, error } = sessionFrom(raw)
        if (error) return sendJson(res, 400, { ok: false, error })
        return sendJson(res, 200, await stateFor(sessionId))
      }

      if (rest === '/select') {
        const body = await readJson(req, 64 * 1024)
        if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid json' })
        const { sessionId, error } = sessionFrom(body.sessionId)
        if (error) return sendJson(res, 400, { ok: false, error })
        let interpreter
        try {
          interpreter = await validateInterpreterPath(body.path)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        await store.load()
        const rows = await environmentsIn(ctx.workingDirectory.defaultDirectory)
        const environment = findEnvironment(rows, interpreter) ?? manualEnvironment(interpreter)
        await store.set(sessionId, interpreter)
        return sendJson(res, 200, { ok: true, sessionId, selected: interpreter, environment })
      }

      // /clear
      const body = await readJson(req, 4096)
      if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid json' })
      const { sessionId, error } = sessionFrom(body.sessionId)
      if (error) return sendJson(res, 400, { ok: false, error })
      await store.load()
      await store.clear(sessionId)
      return sendJson(res, 200, { ok: true, sessionId, selected: null })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
  }
}
