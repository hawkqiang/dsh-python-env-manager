import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { discover } from './discover.mjs'
import {
  buildSshArgv,
  isSshSelection,
  parseSshConfig,
  parseSshUri,
  probeHostPythons,
  serializeSshUri,
  shellQuote,
  sshEnvironmentRows,
  sshHostLabel,
} from './ssh.mjs'

export const inject = ['tools', 'systemPrompt', 'shellEnv', 'workingDirectory', 'sandboxPolicy', 'subprocess', 'webServer']

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
 * Identity key for a selection: ssh URIs compare verbatim (path.normalize
 * would mangle them into Windows backslash paths), local paths compare
 * case-insensitively and normalized on Windows.
 */
function selectionKey(value) {
  return isSshSelection(value) ? value.trim().toLowerCase() : pathKey(path.normalize(value))
}

/**
 * Test-only override of the home directory used for ~/.ssh/config discovery,
 * mirroring the state-file override; DSH itself never sets it.
 */
function sshHome() {
  const override = process.env.DSH_PYTHON_ENV_MANAGER_HOME
  if (typeof override === 'string' && override.trim() !== '' && path.isAbsolute(override.trim())) {
    return path.normalize(override.trim())
  }
  return homedir()
}

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
 * Atomic JSON file holding `{ version: 2, sessions: { [sessionId]: interpreter } }`
 * where the interpreter is either an absolute local path or an
 * `ssh://[user@]host[:port]/abs/python-path` URI. The legacy `{ selectedPath }`
 * shape is deliberately ignored: there is no profile-wide fallback, so every
 * conversation must make its own selection.
 */
export function createStore(file = stateFile()) {
  const sessions = new Map()

  const isValidSelection = value =>
    typeof value === 'string' && value.trim() !== '' && (isSshSelection(value) || path.isAbsolute(value))
  const normalizeSelection = value =>
    isSshSelection(value) ? value.trim() : path.normalize(value)

  const pick = parsed => {
    const next = new Map()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return next
    if (parsed.version !== STATE_VERSION) return next
    const raw = parsed.sessions
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return next
    for (const [sessionId, value] of Object.entries(raw)) {
      if (!isValidSelection(value) || !sessionIdPattern.test(sessionId)) continue
      next.set(sessionId, normalizeSelection(value))
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
      if (!isValidSelection(interpreter)) {
        throw new Error('Python 解释器必须是绝对路径或 ssh:// 远程解释器。')
      }
      sessions.set(sessionId, normalizeSelection(interpreter))
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
  // A remote interpreter cannot be stat()ed locally; reachability is checked
  // when it actually runs (ssh failures surface with their own message).
  if (isSshSelection(value)) return null
  try {
    const info = await stat(value)
    return info.isFile() ? null : 'not-a-file'
  } catch {
    return 'missing'
  }
}

/** Validate an ssh:// interpreter URI and return its canonical form. */
async function validateSshInterpreter(value) {
  const parsed = parseSshUri(value)
  if (!parsed) {
    throw new Error('SSH 解释器路径无效：应为 ssh://[user@]host[:port]/绝对路径/python3 形式，且以 python/python3 结尾。')
  }
  return serializeSshUri(parsed)
}

/** Absolute path or ssh:// URI + existing file + python basename; normalized. */
export async function validateInterpreterPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (isSshSelection(text)) return validateSshInterpreter(text)
  if (text === '' || !path.isAbsolute(text)) throw new Error('Python 解释器必须是绝对路径或 ssh:// 远程解释器。')
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
  if (isSshSelection(interpreter)) {
    const parsed = parseSshUri(interpreter)
    if (!parsed) {
      return { name: interpreter, prefix: interpreter, path: interpreter, source: 'ssh' }
    }
    return {
      name: sshHostLabel(parsed),
      prefix: `ssh://${parsed.user ? `${parsed.user}@` : ''}${parsed.host}`,
      path: serializeSshUri(parsed),
      source: 'ssh',
    }
  }
  const dir = path.dirname(interpreter)
  const tail = path.basename(dir).toLowerCase()
  const prefix = tail === 'scripts' || tail === 'bin' ? path.dirname(dir) : dir
  return { name: path.basename(prefix) || path.basename(interpreter), prefix, path: interpreter, source: 'manual' }
}

function findEnvironment(rows, interpreter) {
  const key = selectionKey(interpreter)
  return rows.find(row => selectionKey(row.path) === key)
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

  /*
   * SSH remote environments. Probes run through ctx.subprocess.spawn with
   * BatchMode-only ssh (never hangs on a password prompt), are cached for one
   * minute, and are triggered by the panel (/ssh, /refresh) or the manager
   * tool's list action — never eagerly at startup.
   */
  const SSH_PROBE_TIMEOUT = 10_000
  const SSH_CACHE_TTL = 60_000
  const sshCache = {
    status: 'idle', // idle | unconfigured | probing | ready | empty | error | unavailable
    environments: [],
    probedAt: 0,
    promise: null,
  }

  const sshSnapshot = () => ({ status: sshCache.status, environments: sshCache.environments })

  async function runSsh(argv, timeoutMs = SSH_PROBE_TIMEOUT) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: ctx.workingDirectory.defaultDirectory,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 1000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      const stdout = readCollected(handle, 'stdout')
      const stderr = readCollected(handle, 'stderr')
      return { exitCode: outcome?.exitCode ?? -1, signal: outcome?.signal ?? null, stdout: stdout.text, stderr: stderr.text }
    } catch (error) {
      if (controller.signal.aborted) return { exitCode: -1, signal: 'timeout', stdout: '', stderr: '' }
      const spawnError = new Error(`无法启动 ssh 客户端：${String(error?.message ?? error)}`)
      spawnError.spawnFailed = true
      throw spawnError
    } finally {
      clearTimeout(timer)
    }
  }

  async function probeSshHosts() {
    let hosts = []
    try {
      hosts = await parseSshConfig({ home: sshHome() })
    } catch {
      hosts = []
    }
    if (hosts.length === 0) {
      sshCache.status = 'unconfigured'
      sshCache.environments = []
      sshCache.probedAt = Date.now()
      return
    }
    hosts = hosts.slice(0, 16)
    const outcomes = await Promise.all(hosts.map(async host => {
      try {
        const result = await probeHostPythons(host, argv => runSsh(argv))
        return { host, result }
      } catch (error) {
        return { host, result: { ok: false, reason: error?.spawnFailed ? 'spawn-failed' : 'error' } }
      }
    }))
    if (outcomes.every(entry => entry.result.reason === 'spawn-failed')) {
      sshCache.status = 'unavailable'
      sshCache.environments = []
      sshCache.probedAt = Date.now()
      return
    }
    const reachable = outcomes.filter(entry => entry.result.ok)
    if (reachable.length === 0) {
      sshCache.status = 'error'
      sshCache.environments = []
      sshCache.probedAt = Date.now()
      return
    }
    const rows = reachable.flatMap(entry => sshEnvironmentRows(entry.host, entry.result.interpreterPaths))
    sshCache.status = rows.length > 0 ? 'ready' : 'empty'
    sshCache.environments = rows
    sshCache.probedAt = Date.now()
  }

  /** Probe when forced, expired, or never probed; concurrent callers share one run. */
  async function probeSsh({ force = false } = {}) {
    const expired = Date.now() - sshCache.probedAt >= SSH_CACHE_TTL
    if (!force && sshCache.promise && sshCache.status !== 'idle') return sshSnapshot()
    if (!force && sshCache.status !== 'idle' && !expired) return sshSnapshot()
    if (sshCache.status === 'unconfigured' && !force) return sshSnapshot()
    if (!sshCache.promise || force) {
      sshCache.promise = probeSshHosts().finally(() => {
        sshCache.promise = null
      })
    }
    await sshCache.promise
    return sshSnapshot()
  }

  /** Non-blocking: used by GET /state so the panel paints local rows first. */
  function probeSshInBackground() {
    if (sshCache.status === 'idle' && !sshCache.promise) {
      sshCache.promise = probeSshHosts().finally(() => {
        sshCache.promise = null
      })
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'python_env_manager',
    description: 'List local Python candidates plus optional SSH remote interpreters (probed from ~/.ssh/config hosts), select or clear the Python interpreter for this conversation (including its subagents), or resolve that interpreter for a sandboxed shell. A selection may be an absolute local path or an ssh://[user@]host/path URI reported in the list. The selection applies only to the current conversation and its subagents; it does not affect other conversations, and a conversation without a selection never inherits another one or the system Python. The selection is stored per session in ~/.dsh/python-env-manager/state.json. On ambiguous names, show matching environments and ask which one; never guess. Report that the change affects this conversation only, not the system or other terminals. Does not execute Python; use python_env_run to execute the selected interpreter.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions },
        path: { type: 'string', description: 'select only: exact absolute local path or ssh:// URI from the list.' },
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
        const ssh = await probeSsh()
        const selected = store.get(sessionId)
        const start = offset ?? 0
        const end = start + pageSize
        return {
          sessionId,
          selected,
          selectedAvailable: !!selected && rows.some(row => selectionKey(row.path) === selectionKey(selected)),
          total: rows.length,
          environments: rows.slice(start, end),
          nextOffset: end < rows.length ? end : null,
          ssh,
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
    description: 'Default execution entry point for the Python interpreter selected in this conversation\'s DSH toolbar; subagents use the interpreter of the conversation they belong to. For an ssh:// selection the command runs that remote interpreter over ssh with arguments quoted for the remote shell. This is not a shell: every argv entry is passed literally to the interpreter as one argument, with no local shell expansion, quoting, pipes, redirection, globbing, or environment activation. Runs are subject to the session sandbox and permission policy, and this tool never changes PATH or bypasses the sandbox. Do not use it to install software or activate environments. If this conversation has no selected interpreter, it fails instead of inheriting another conversation\'s choice or substituting the system Python.',
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
      // ssh:// selection → run the remote interpreter over ssh; every argument
      // is quoted for the remote shell so the argv stays literal end to end.
      const remote = isSshSelection(interpreter) ? parseSshUri(interpreter) : null
      if (remote === null && isSshSelection(interpreter)) {
        throw new Error(`所选 SSH 解释器无效（无法解析）：${interpreter}。请在该对话中重新选择。`)
      }
      const baseArgv = remote
        ? buildSshArgv({
            user: remote.user,
            host: remote.host,
            port: remote.port,
            command: [remote.path, ...argv].map(shellQuote).join(' '),
          })
        : [interpreter, ...argv]
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
      const localRows = await environmentsIn(sessionCwd).catch(() => [])
      const environment = findEnvironment([...localRows, ...sshCache.environments], interpreter) ??
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
    text: 'Python interpreters are selected per conversation: each conversation and its subagents share one selection, and no conversation inherits another conversation\'s selection or the system Python. Every Python task (including subagents) must run through the python_env_run tool instead of a bare python/python3 or the system interpreter. If this conversation has no selected interpreter, ask the user to choose one from that conversation\'s input-toolbar picker instead of using the system python; do not change PATH. python_env_run passes arguments literally and is still constrained by the session sandbox and permissions. A selection may be an ssh://[user@]host/path URI from the picker; python_env_run then executes that remote interpreter over ssh with every argument quoted for the remote shell (remote cwd is the login home). Do not change PATH or elevate permissions. If the selected interpreter is missing or unavailable, report the failure instead of substituting another Python. Use python_env_run to execute Python code only, not to install software or activate environments.',
  }))

  ctx.effect(() => ctx.shellEnv.register({
    name: 'python-env-manager',
    variables: {
      DSH_PYTHON: {
        description: 'Absolute local path or ssh:// URI of the interpreter selected for this conversation (subagents follow their root conversation); use only in an already-permitted sandboxed shell, without changing PATH or activating environments.',
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
    const sshFresh = sshCache.status !== 'idle' || sshCache.promise
    if (!sshFresh) probeSshInBackground()
    return {
      ok: true,
      sessionId,
      selected: store.get(sessionId),
      environments: await environmentsIn(ctx.workingDirectory.defaultDirectory),
      ssh: sshCache.status === 'idle' ? { status: 'probing', environments: [] } : sshSnapshot(),
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

      const expected = { '/state': 'GET', '/select': 'POST', '/clear': 'POST', '/refresh': 'POST', '/ssh': 'GET' }
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

      if (rest === '/ssh') {
        const { sessionId, error } = sessionFrom(url.searchParams.get('sessionId'))
        if (error) return sendJson(res, 400, { ok: false, error })
        const force = url.searchParams.get('force') === '1'
        const ssh = await probeSsh({ force })
        return sendJson(res, 200, { ok: true, sessionId, ssh })
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
        if (rest === '/refresh') {
          // Refresh covers both layers: local discovery re-runs in stateFor,
          // and SSH hosts are re-probed (bounded by the probe timeouts).
          await probeSsh({ force: true }).catch(() => {})
        }
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
        const environment = findEnvironment([...rows, ...sshCache.environments], interpreter) ??
          manualEnvironment(interpreter)
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

  // DSH only exposes webServer to plugins that declare it in `inject`, so the
  // toolbar panel gets its routes. Keep the guard for hosts without a web
  // surface (headless), where the tools still work without the HTTP API.
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
  }
}
