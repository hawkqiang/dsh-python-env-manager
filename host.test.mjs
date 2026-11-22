import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply, inject, API_PREFIX } from './index.mjs'

const STATE_ENV = 'DSH_PYTHON_ENV_MANAGER_STATE'

/** Point the plugin at a throwaway state file so tests never touch the real one. */
async function useTemporaryStateFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'python-env-manager-'))
  const file = path.join(dir, 'state.json')
  const previous = process.env[STATE_ENV]
  process.env[STATE_ENV] = file
  t.after(async () => {
    if (previous === undefined) delete process.env[STATE_ENV]
    else process.env[STATE_ENV] = previous
    await fs.rm(dir, { recursive: true, force: true })
  })
  return file
}

/** An existing file with a valid interpreter basename, outside the real interpreters. */
async function createFakeInterpreter(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pem-interpreter-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const bin = process.platform === 'win32' ? 'Scripts' : 'bin'
  const name = process.platform === 'win32' ? 'python.exe' : 'python'
  const interpreter = path.normalize(path.join(dir, 'fake-env', bin, name))
  await fs.mkdir(path.dirname(interpreter), { recursive: true })
  await fs.writeFile(interpreter, '')
  return interpreter
}

function fakeCtx({
  sandbox = null,
  mode = 'workspace-write',
  defaultDirectory = process.cwd(),
  subagents = null,
  spawn = null,
} = {}) {
  const record = {
    tools: new Map(),
    sections: [],
    shellEnv: [],
    routes: [],
    disposers: [],
    effects: 0,
  }
  const ctx = {
    effect(fn) {
      record.effects += 1
      const disposer = fn()
      record.disposers.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        record.tools.set(definition.name, definition)
        return () => record.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(definition) {
        record.sections.push(definition)
        return () => {}
      },
    },
    shellEnv: {
      register(contributor) {
        record.shellEnv.push(contributor)
        return () => {}
      },
    },
    workingDirectory: {
      defaultDirectory,
      async ensure() {
        return defaultDirectory
      },
    },
    sandboxPolicy: {
      resolve(request = {}) {
        return {
          mode,
          workspaceRoot: defaultDirectory,
          ...(request?.session?.id ? { sessionId: request.session.id } : {}),
        }
      },
    },
    subprocess: {
      spawn(request) {
        if (spawn) return spawn(request)
        throw new Error('spawn must not be called in these tests')
      },
    },
    // DSH exposes injected services as ctx properties. webServer must come from
    // `inject`, so the fake mirrors the real contract: ctx.webServer exists and
    // ctx.get('webServer') deliberately does not.
    webServer: {
      register(route) {
        record.routes.push(route)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sandbox') return sandbox
      if (name === 'subagents') return subagents
      return undefined
    },
  }
  return { ctx, record }
}

function executionContext(sessionId = 'session-test', agent = { session: { id: sessionId } }) {
  return { agent, signal: new AbortController().signal }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.ended = true
    },
    get text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
  }
}

async function callRoute(route, method, pathname, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const req = {
    method,
    url: pathname,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
  const res = fakeResponse()
  await route.handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.text) }
}

const stateUrl = sessionId => `${API_PREFIX}/state?sessionId=${encodeURIComponent(sessionId)}`

test('apply registers both tools, the prompt section, shell env, and the prefix route', async t => {
  await useTemporaryStateFile(t)
  const { ctx, record } = fakeCtx()
  apply(ctx)

  assert.deepEqual(inject, ['tools', 'systemPrompt', 'shellEnv', 'workingDirectory', 'sandboxPolicy', 'subprocess', 'webServer'])
  assert.deepEqual([...record.tools.keys()].sort(), ['python_env_manager', 'python_env_run'])

  const manager = record.tools.get('python_env_manager')
  assert.deepEqual(manager.parameters.properties.action.enum, ['list', 'select', 'resolve', 'clear'])
  assert.deepEqual(manager.parameters.required, ['action'])
  assert.match(manager.description, /this conversation/)
  assert.match(manager.description, /does not affect other conversations/)

  const runner = record.tools.get('python_env_run')
  assert.deepEqual(runner.parameters.required, ['argv'])
  assert.equal(runner.parameters.properties.argv.minItems, 1)
  assert.deepEqual(runner.parameters.properties.argv.items, { type: 'string' })
  assert.equal(runner.parameters.additionalProperties, false)
  assert.match(runner.description, /conversation/)

  assert.equal(record.sections.length, 1)
  assert.equal(record.sections[0].name, 'python-env-manager')
  assert.match(record.sections[0].text, /python_env_run/)
  assert.match(record.sections[0].text, /subagents/i)
  assert.match(record.sections[0].text, /per conversation/i)
  assert.match(record.sections[0].text, /toolbar/i)
  assert.match(record.sections[0].text, /system python/i)

  assert.equal(record.shellEnv.length, 1)
  assert.match(record.shellEnv[0].variables.DSH_PYTHON.description, /sandboxed shell/)
  assert.deepEqual(record.shellEnv[0].resolve({}), {})
  assert.deepEqual(record.shellEnv[0].resolve(executionContext('session-no-selection')), {})

  assert.equal(record.routes.length, 1)
  assert.equal(record.routes[0].kind, 'prefix')
  assert.equal(record.routes[0].path, API_PREFIX)
  assert.equal(typeof record.routes[0].handler, 'function')

  assert.equal(record.effects, 5)
  assert.ok(record.disposers.every(disposer => typeof disposer === 'function'))
})

test('python_env_run fails clearly before spawning when this conversation has no interpreter', async t => {
  await useTemporaryStateFile(t)
  const { ctx, record } = fakeCtx()
  apply(ctx)

  const runner = record.tools.get('python_env_run')
  await assert.rejects(
    runner.execute({ argv: ['-c', 'print(1)'] }, executionContext('session-one')),
    /本对话尚未选择默认 Python 解释器/,
  )
  await assert.rejects(
    runner.execute({ argv: ['-c', 'print(1)'] }, executionContext('session-one')),
    /不会继承其他对话，也不会回退到系统 Python/,
  )
  // No agent/session at all must be an explicit error, never a global default.
  await assert.rejects(
    runner.execute({ argv: ['-c', 'print(1)'] }, { signal: new AbortController().signal }),
    /无法确定当前对话/,
  )

  const manager = record.tools.get('python_env_manager')
  await assert.rejects(manager.execute({ action: 'list' }, undefined), /无法确定当前对话/)
  const list = await manager.execute({ action: 'list' }, executionContext('session-one'))
  assert.equal(list.sessionId, 'session-one')
  assert.equal(list.selected, null)
  assert.ok(Array.isArray(list.environments))
})

test('select rejects illegal session ids and invalid interpreter paths in the tool and over HTTP', async t => {
  await useTemporaryStateFile(t)
  const interpreter = await createFakeInterpreter(t)
  const wrongName = path.join(path.dirname(interpreter), 'notes.txt')
  await fs.writeFile(wrongName, '')

  const { ctx, record } = fakeCtx()
  apply(ctx)
  const manager = record.tools.get('python_env_manager')
  const route = record.routes[0]

  await assert.rejects(
    manager.execute({ action: 'list' }, executionContext('bad session')),
    /会话 ID 无效/,
  )
  await assert.rejects(
    manager.execute({ action: 'select', path: path.join('relative', 'python.exe') }, executionContext('session-a')),
    /绝对路径/,
  )
  await assert.rejects(
    manager.execute({ action: 'select', path: wrongName }, executionContext('session-a')),
    /python/,
  )
  await assert.rejects(
    manager.execute({ action: 'select', path: path.join(path.dirname(interpreter), 'missing', 'python.exe') }, executionContext('session-a')),
    /不存在/,
  )

  const invalidPath = await callRoute(route, 'POST', `${API_PREFIX}/select`, { sessionId: 'session-a', path: wrongName })
  assert.equal(invalidPath.status, 400)
  assert.equal(invalidPath.body.ok, false)

  const missingSession = await callRoute(route, 'POST', `${API_PREFIX}/select`, { path: interpreter })
  assert.equal(missingSession.status, 400)
  assert.match(missingSession.body.error, /会话 ID 无效/)

  const badSession = await callRoute(route, 'POST', `${API_PREFIX}/select`, { sessionId: 'bad session', path: interpreter })
  assert.equal(badSession.status, 400)

  const longSession = await callRoute(route, 'GET', stateUrl('x'.repeat(201)))
  assert.equal(longSession.status, 400)

  const noSession = await callRoute(route, 'GET', `${API_PREFIX}/state`)
  assert.equal(noSession.status, 400)

  const unknown = await callRoute(route, 'GET', `${API_PREFIX}/does-not-exist`)
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.ok, false)

  const wrongMethod = await callRoute(route, 'PUT', `${API_PREFIX}/state`)
  assert.equal(wrongMethod.status, 405)

  const wrongMethod2 = await callRoute(route, 'GET', `${API_PREFIX}/select`)
  assert.equal(wrongMethod2.status, 405)
})

test('selections are per conversation: A never leaks into B, clear only clears its conversation', async t => {
  const stateFile = await useTemporaryStateFile(t)
  const interpreterA = await createFakeInterpreter(t)
  const interpreterB = await createFakeInterpreter(t)

  const { ctx, record } = fakeCtx()
  apply(ctx)
  const manager = record.tools.get('python_env_manager')
  const runner = record.tools.get('python_env_run')
  const route = record.routes[0]

  const selectedA = await manager.execute({ action: 'select', path: interpreterA }, executionContext('session-a'))
  assert.equal(selectedA.status, 'selected')
  assert.equal(selectedA.sessionId, 'session-a')
  assert.equal(selectedA.selected, interpreterA)
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), {
    version: 2,
    sessions: { 'session-a': interpreterA },
  })

  const selectedB = await callRoute(route, 'POST', `${API_PREFIX}/select`, { sessionId: 'session-b', path: interpreterB })
  assert.equal(selectedB.status, 200)
  assert.equal(selectedB.body.sessionId, 'session-b')
  assert.equal(selectedB.body.selected, interpreterB)
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), {
    version: 2,
    sessions: { 'session-a': interpreterA, 'session-b': interpreterB },
  })

  const listA = await manager.execute({ action: 'list' }, executionContext('session-a'))
  const listB = await manager.execute({ action: 'list' }, executionContext('session-b'))
  assert.equal(listA.sessionId, 'session-a')
  assert.equal(listA.selected, interpreterA)
  assert.equal(listB.sessionId, 'session-b')
  assert.equal(listB.selected, interpreterB)

  const stateA = await callRoute(route, 'GET', stateUrl('session-a'))
  assert.equal(stateA.status, 200)
  assert.equal(stateA.body.ok, true)
  assert.equal(stateA.body.sessionId, 'session-a')
  assert.equal(stateA.body.selected, interpreterA)
  assert.ok(Array.isArray(stateA.body.environments))
  const stateB = await callRoute(route, 'GET', stateUrl('session-b'))
  assert.equal(stateB.body.selected, interpreterB)
  const stateC = await callRoute(route, 'GET', stateUrl('session-c'))
  assert.equal(stateC.body.sessionId, 'session-c')
  assert.equal(stateC.body.selected, null)

  const refreshed = await callRoute(route, 'POST', `${API_PREFIX}/refresh`, { sessionId: 'session-a' })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.sessionId, 'session-a')
  assert.equal(refreshed.body.selected, interpreterA)

  assert.deepEqual(record.shellEnv[0].resolve(executionContext('session-a')), { DSH_PYTHON: interpreterA })
  assert.deepEqual(record.shellEnv[0].resolve(executionContext('session-b')), { DSH_PYTHON: interpreterB })
  assert.deepEqual(record.shellEnv[0].resolve(executionContext('session-c')), {})

  // B has a selection, so python_env_run gets past selection and fails closed on the missing sandbox.
  await assert.rejects(
    runner.execute({ argv: ['-V'] }, executionContext('session-b')),
    /沙箱/,
  )

  // Clearing A leaves B untouched.
  const clearedA = await manager.execute({ action: 'clear' }, executionContext('session-a'))
  assert.deepEqual(clearedA, { status: 'cleared', sessionId: 'session-a' })
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), {
    version: 2,
    sessions: { 'session-b': interpreterB },
  })
  assert.equal((await manager.execute({ action: 'list' }, executionContext('session-a'))).selected, null)
  assert.equal((await manager.execute({ action: 'list' }, executionContext('session-b'))).selected, interpreterB)
  await assert.rejects(
    runner.execute({ argv: ['-V'] }, executionContext('session-a')),
    /本对话尚未选择默认 Python 解释器/,
  )

  // A fresh apply (plugin reload) reads the persisted per-session file synchronously.
  const second = fakeCtx()
  apply(second.ctx)
  assert.deepEqual(second.record.shellEnv[0].resolve(executionContext('session-b')), { DSH_PYTHON: interpreterB })
  assert.deepEqual(second.record.shellEnv[0].resolve(executionContext('session-a')), {})
  const secondState = await callRoute(second.record.routes[0], 'GET', stateUrl('session-b'))
  assert.equal(secondState.body.selected, interpreterB)

  // Clearing B over HTTP persists an empty v2 file and keeps the selected field null.
  const clearedB = await callRoute(route, 'POST', `${API_PREFIX}/clear`, { sessionId: 'session-b' })
  assert.deepEqual(clearedB.body, { ok: true, sessionId: 'session-b', selected: null })
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), { version: 2, sessions: {} })
})

test('subagents resolve the selection of their root conversation', async t => {
  const stateFile = await useTemporaryStateFile(t)
  const interpreter = await createFakeInterpreter(t)
  const rootAgent = { session: { id: 'session-root' } }
  const childAgent = { session: { id: 'session-child' } }
  const subagents = { rootOf: () => rootAgent }

  const { ctx, record } = fakeCtx({ subagents })
  apply(ctx)
  const manager = record.tools.get('python_env_manager')
  const runner = record.tools.get('python_env_run')

  const selected = await manager.execute(
    { action: 'select', path: interpreter },
    { agent: rootAgent, signal: new AbortController().signal },
  )
  assert.equal(selected.sessionId, 'session-root')
  // The child session id never becomes its own key.
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), {
    version: 2,
    sessions: { 'session-root': interpreter },
  })

  const childList = await manager.execute(
    { action: 'list' },
    { agent: childAgent, signal: new AbortController().signal },
  )
  assert.equal(childList.sessionId, 'session-root')
  assert.equal(childList.selected, interpreter)

  assert.deepEqual(record.shellEnv[0].resolve({ agent: childAgent }), { DSH_PYTHON: interpreter })
  // Getting past interpreter resolution proves the child followed its root; it then fails closed on the sandbox.
  await assert.rejects(
    runner.execute({ argv: ['-V'] }, { agent: childAgent, signal: new AbortController().signal }),
    /沙箱/,
  )

  // A missing/broken subagents service falls back to the agent's own session instead of throwing.
  const broken = fakeCtx({ subagents: { rootOf() { throw new Error('subagents unavailable') } } })
  apply(broken.ctx)
  const solo = { session: { id: 'session-solo' } }
  const brokenManager = broken.record.tools.get('python_env_manager')
  await brokenManager.execute({ action: 'select', path: interpreter }, { agent: solo, signal: new AbortController().signal })
  assert.deepEqual(broken.record.shellEnv[0].resolve({ agent: solo }), { DSH_PYTHON: interpreter })
  assert.deepEqual(broken.record.shellEnv[0].resolve({}), {})
})

test('a legacy selectedPath file grants no conversation a default', async t => {
  const stateFile = await useTemporaryStateFile(t)
  const interpreter = await createFakeInterpreter(t)
  await fs.writeFile(stateFile, JSON.stringify({ selectedPath: interpreter }), 'utf8')

  const { ctx, record } = fakeCtx()
  apply(ctx)
  const manager = record.tools.get('python_env_manager')
  const runner = record.tools.get('python_env_run')
  const route = record.routes[0]

  assert.deepEqual(record.shellEnv[0].resolve(executionContext('legacy-session')), {})
  await assert.rejects(
    runner.execute({ argv: ['-V'] }, executionContext('legacy-session')),
    /本对话尚未选择默认 Python 解释器/,
  )
  const state = await callRoute(route, 'GET', stateUrl('legacy-session'))
  assert.equal(state.body.selected, null)
  const list = await manager.execute({ action: 'list' }, executionContext('legacy-session'))
  assert.equal(list.selected, null)

  // An explicit selection replaces the legacy file with the v2 per-session shape.
  await manager.execute({ action: 'select', path: interpreter }, executionContext('legacy-session'))
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), {
    version: 2,
    sessions: { 'legacy-session': interpreter },
  })
})

test('a per-conversation interpreter that disappeared fails without fallback', async t => {
  const stateFile = await useTemporaryStateFile(t)
  const missing = path.normalize(path.join(path.dirname(stateFile), 'gone', 'python.exe'))
  await fs.writeFile(stateFile, JSON.stringify({ version: 2, sessions: { 'session-gone': missing } }), 'utf8')

  const { ctx, record } = fakeCtx()
  apply(ctx)
  assert.deepEqual(record.shellEnv[0].resolve(executionContext('session-gone')), { DSH_PYTHON: missing })
  assert.deepEqual(record.shellEnv[0].resolve(executionContext('session-other')), {})
  await assert.rejects(
    record.tools.get('python_env_run').execute({ argv: ['-V'] }, executionContext('session-gone')),
    /不可用（文件不存在）/,
  )
  await assert.rejects(
    record.tools.get('python_env_manager').execute({ action: 'resolve' }, executionContext('session-gone')),
    /不可用（文件不存在）/,
  )
})

test('python_env_run uses this conversation\'s interpreter and reports its sessionId', async t => {
  await useTemporaryStateFile(t)
  const interpreter = await createFakeInterpreter(t)
  const calls = []
  const { ctx, record } = fakeCtx({
    mode: 'danger-full-access',
    spawn(request) {
      calls.push(request)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
      }
    },
  })
  apply(ctx)
  const manager = record.tools.get('python_env_manager')
  const runner = record.tools.get('python_env_run')
  await manager.execute({ action: 'select', path: interpreter }, executionContext('session-run'))

  const result = await runner.execute({ argv: ['-c', 'print(1)'] }, executionContext('session-run'))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, [interpreter, '-c', 'print(1)'])
  assert.equal(result.sessionId, 'session-run')
  assert.equal(result.interpreter, interpreter)
  assert.equal(result.exitCode, 0)
})

test('workspace-write without a sandbox service fails closed for a selected conversation', async t => {
  await useTemporaryStateFile(t)
  const interpreter = await createFakeInterpreter(t)
  const { ctx, record } = fakeCtx()
  apply(ctx)
  await record.tools.get('python_env_manager').execute(
    { action: 'select', path: interpreter },
    executionContext('session-fail-closed'),
  )
  await assert.rejects(
    record.tools.get('python_env_run').execute({ argv: ['-V'] }, executionContext('session-fail-closed')),
    /沙箱/,
  )
})

/** A throwaway home directory whose ~/.ssh/config declares one reachable host. */
async function useSshHomeFixture(t, { hosts = ['Host probe-box\n  HostName 192.0.2.10\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/probe_key\n'] } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pem-ssh-home-'))
  t.after(async () => {
    if (process.env.DSH_PYTHON_ENV_MANAGER_HOME === home) delete process.env.DSH_PYTHON_ENV_MANAGER_HOME
    await fs.rm(home, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true })
  await fs.writeFile(path.join(home, '.ssh', 'config'), hosts.join('\n'), 'utf8')
  process.env.DSH_PYTHON_ENV_MANAGER_HOME = home
  return home
}

/** Fake ctx.subprocess.spawn that answers ssh probe/run calls with canned output. */
function sshSpawnRecorder({ stdout = '', exitCode = 0 } = {}) {
  const calls = []
  return {
    calls,
    spawn(request) {
      calls.push(request)
      const isSsh = request.argv[0] === 'ssh'
      const text = isSsh ? stdout : ''
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        collected: {
          stdout: { readFrom() { return { text, lossy: false } } },
          stderr: { readFrom() { return { text: '', lossy: false } } },
        },
      }
    },
  }
}

test('ssh:// selections persist, resolve, and execute over ssh with quoted argv', async t => {
  const stateFile = await useTemporaryStateFile(t)
  await useSshHomeFixture(t)
  const uri = 'ssh://deploy@probe-box:2222/usr/bin/python3'
  const spawn = sshSpawnRecorder({ stdout: 'ok' })
  const { ctx, record } = fakeCtx({ mode: 'danger-full-access', spawn: spawn.spawn })
  apply(ctx)
  const manager = record.tools.get('python_env_manager')
  const runner = record.tools.get('python_env_run')

  await assert.rejects(
    manager.execute({ action: 'select', path: 'ssh://probe-box/usr/bin/bash' }, executionContext('session-ssh')),
    /SSH 解释器路径无效/,
  )
  await assert.rejects(
    manager.execute({ action: 'select', path: 'ssh://probe-box:not-a-port/usr/bin/python3' }, executionContext('session-ssh')),
    /SSH 解释器路径无效/,
  )
  await assert.rejects(
    manager.execute({ action: 'select', path: 'ssh:///usr/bin/python3' }, executionContext('session-ssh')),
    /SSH 解释器路径无效/,
  )

  const selected = await manager.execute({ action: 'select', path: 'ssh://deploy@probe-box:2222/usr/bin/python3' }, executionContext('session-ssh'))
  assert.equal(selected.status, 'selected')
  assert.equal(selected.selected, uri)
  assert.equal(selected.environment.name, 'probe-box:2222')
  assert.equal(selected.environment.source, 'ssh')
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), {
    version: 2,
    sessions: { 'session-ssh': uri },
  })

  const resolved = await manager.execute({ action: 'resolve' }, executionContext('session-ssh'))
  assert.equal(resolved.executable, uri)

  const result = await runner.execute({ argv: ['-c', 'print(1)'] }, executionContext('session-ssh'))
  assert.equal(result.interpreter, uri)
  assert.equal(result.exitCode, 0)
  assert.equal(spawn.calls.length, 1, 'python_env_run must spawn exactly one ssh process')
  assert.deepEqual(spawn.calls[0].argv, [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-p', '2222',
    'deploy@probe-box',
    `'/usr/bin/python3' '-c' 'print(1)'`,
  ])
})

test('the /ssh endpoint probes ~/.ssh/config hosts and the panel state carries the result', async t => {
  await useTemporaryStateFile(t)
  await useSshHomeFixture(t)
  const spawn = sshSpawnRecorder({ stdout: '/usr/bin/python3\n/usr/bin/python3.12\n' })
  const { ctx, record } = fakeCtx({ mode: 'danger-full-access', spawn: spawn.spawn })
  apply(ctx)
  const route = record.routes[0]
  const manager = record.tools.get('python_env_manager')

  const state = await callRoute(route, 'GET', stateUrl('session-ssh-panel'))
  assert.equal(state.status, 200)
  assert.ok(['probing', 'ready'].includes(state.body.ssh.status), `unexpected ssh status ${state.body.ssh.status}`)

  const ssh = await callRoute(route, 'GET', `${API_PREFIX}/ssh?sessionId=${encodeURIComponent('session-ssh-panel')}`)
  assert.equal(ssh.status, 200)
  assert.equal(ssh.body.ssh.status, 'ready')
  assert.deepEqual(ssh.body.ssh.environments.map(row => row.path), [
    'ssh://deploy@probe-box:2222/usr/bin/python3',
    'ssh://deploy@probe-box:2222/usr/bin/python3.12',
  ])
  assert.deepEqual(ssh.body.ssh.environments.map(row => row.source), ['ssh', 'ssh'])

  const select = await callRoute(route, 'POST', `${API_PREFIX}/select`, {
    sessionId: 'session-ssh-panel',
    path: 'ssh://deploy@probe-box:2222/usr/bin/python3',
  })
  assert.equal(select.status, 200)
  assert.equal(select.body.selected, 'ssh://deploy@probe-box:2222/usr/bin/python3')

  const list = await manager.execute({ action: 'list' }, executionContext('session-ssh-panel'))
  assert.equal(list.ssh.status, 'ready')
  assert.equal(list.ssh.environments.length, 2)
  assert.ok(list.environments.every(row => !row.path.startsWith('ssh://')), 'local rows never mix with ssh rows')

  const refresh = await callRoute(route, 'POST', `${API_PREFIX}/refresh`, { sessionId: 'session-ssh-panel' })
  assert.equal(refresh.body.ssh.status, 'ready')
})

test('unreachable or unconfigured ssh setups degrade to non-selectable statuses', async t => {
  await useTemporaryStateFile(t)

  // An empty ~/.ssh → unconfigured, and ssh is never spawned.
  await useSshHomeFixture(t, { hosts: [] })
  const quietSpawn = sshSpawnRecorder()
  const quiet = fakeCtx({ mode: 'danger-full-access', spawn: quietSpawn.spawn })
  apply(quiet.ctx)
  const quietSsh = await callRoute(quiet.record.routes[0], 'GET', `${API_PREFIX}/ssh?sessionId=s1`)
  assert.equal(quietSsh.body.ssh.status, 'unconfigured')
  assert.deepEqual(quietSsh.body.ssh.environments, [])
  assert.equal(quietSpawn.calls.length, 0)

  // Hosts configured but unreachable → error status with no rows.
  await useSshHomeFixture(t)
  const failingSpawn = sshSpawnRecorder({ exitCode: 255 })
  const failing = fakeCtx({ mode: 'danger-full-access', spawn: failingSpawn.spawn })
  apply(failing.ctx)
  const failingSsh = await callRoute(failing.record.routes[0], 'GET', `${API_PREFIX}/ssh?sessionId=s2&force=1`)
  assert.equal(failingSsh.body.ssh.status, 'error')
  assert.deepEqual(failingSsh.body.ssh.environments, [])
})
