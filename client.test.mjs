/*
 * Smoke tests for the browser half without a browser.
 *
 * A minimal fake shell (window.__ModuleLoader__, document, fetch) plus a
 * hook-capable, multi-instance fake React lets us assert: the factory loads,
 * apply() registers the composer slot exactly once, every request carries the
 * owning conversation's sessionId, two conversations never share selection
 * state, a missing sessionId disables the trigger without a request, and the
 * panel's previous keyboard/focus/notice behavior still holds.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const listeners = new Map()
const styleTags = []
const bodyChildren = []

function addListener(target, type, handler) {
  const key = target + ':' + type
  const list = listeners.get(key) ?? []
  list.push(handler)
  listeners.set(key, list)
}
function removeListener(target, type, handler) {
  const key = target + ':' + type
  listeners.set(key, (listeners.get(key) ?? []).filter(fn => fn !== handler))
}
function fire(target, type, event) {
  for (const handler of listeners.get(target + ':' + type) ?? []) handler(event)
}

globalThis.window = {
  navigator: { language: 'en-US' },
  innerWidth: 1200,
  innerHeight: 800,
  setTimeout,
  clearTimeout,
  addEventListener: (type, handler) => addListener('window', type, handler),
  removeEventListener: (type, handler) => removeListener('window', type, handler),
}
globalThis.document = {
  documentElement: { lang: 'en' },
  body: {
    appendChild(node) { bodyChildren.push(node); node.parentNode = this },
    contains() { return false },
  },
  head: {
    append(tag) { styleTags.push(tag) },
  },
  createElement() {
    return { dataset: {}, textContent: '', parentNode: null, remove() { const i = styleTags.indexOf(this); if (i >= 0) styleTags.splice(i, 1) } }
  },
  activeElement: null,
  querySelector() { return null },
  addEventListener: (type, handler) => addListener('document', type, handler),
  removeEventListener: (type, handler) => removeListener('document', type, handler),
}

let moduleId = null
let factory = null
globalThis.window.__ModuleLoader__ = {
  load(entry) { moduleId = entry.id; factory = entry.factory },
}

/*
 * Hook-capable fake React. Each mount key owns one persistent hook slot list, so
 * two mounts model two component instances and re-rendering one mount models a
 * prop change on the same instance.
 */
function createFakeReact() {
  const mounts = new Map()
  let active = null
  let refElement = null
  const current = () => {
    if (!active) throw new Error('render outside a mount')
    return active
  }
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props = {}, ...children) {
      if (!props || typeof props !== 'object') props = {}
      if (typeof props.ref === 'function') {
        const element = refElement || { querySelector: () => null, querySelectorAll: () => [], contains: () => false }
        try { props.ref(element) } catch { /* ignore */ }
      }
      return { type, props, children: children.flat() }
    },
    useRef(initial) {
      const mount = current()
      const at = mount.index++
      if (mount.slots[at] === undefined) mount.slots[at] = { current: initial }
      return mount.slots[at]
    },
    useState(initial) {
      const mount = current()
      const at = mount.index++
      if (mount.slots[at] === undefined) mount.slots[at] = { value: typeof initial === 'function' ? initial() : initial }
      return [mount.slots[at].value, () => {}]
    },
    useEffect(fn) {
      const mount = current()
      const at = mount.index++
      if (mount.slots[at] === undefined) mount.slots[at] = { cleanup: undefined }
      if (mount.slots[at].cleanup === undefined) mount.slots[at].cleanup = fn() ?? null
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      current().index++
      return getSnapshot()
    },
  }
  return {
    react,
    mount(key) {
      let mount = mounts.get(key)
      if (!mount) {
        mount = { slots: [], index: 0 }
        mounts.set(key, mount)
      }
      active = mount
      mount.index = 0
      return mount
    },
    reset() {
      mounts.clear()
      active = null
      refElement = null
    },
    setRefElement(element) {
      refElement = element
    },
  }
}

const fakeReact = createFakeReact()
const portals = []
const fakeReactDOM = {
  createPortal(node, target) {
    portals.push({ node, target })
    return { type: 'portal', node, target }
  },
}

function fakeRequire(name) {
  if (name === 'react') return fakeReact.react
  if (name === 'react-dom') return fakeReactDOM
  throw new Error('unexpected require: ' + name)
}

function createCtx(dictionaries) {
  const effects = []
  const registrations = []
  const ctx = {
    effects,
    registrations,
    effect(fn, description) {
      const disposer = fn()
      effects.push({ disposer, description })
      return disposer
    },
    locale: {
      register(namespace, dicts) { dictionaries.push({ namespace, dicts }); return () => {} },
      bind(namespace) {
        return (key, params) => {
          const set = dictionaries.find(entry => entry.namespace === namespace)
          const text = set && set.dicts.en ? set.dicts.en[key] : key
          return params ? String(text).replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : text
        }
      },
    },
    slots: {
      inject(name, callback) {
        ctx.injected = name
        return callback()
      },
      register(spec, component) { registrations.push({ spec, component }); return () => {} },
    },
  }
  return ctx
}

const ENVIRONMENTS = [
  { name: 'open-webui', prefix: 'C:/miniconda3/envs/open-webui', path: 'C:/miniconda3/envs/open-webui/python.exe', source: 'conda' },
  { name: 'py311', prefix: 'C:/venvs/py311', path: 'C:/venvs/py311/Scripts/python.exe', source: 'venv' },
]

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload } }
}

function sessionOfRequest(url, init) {
  const parsed = new URL(url, 'http://localhost')
  if (parsed.pathname.endsWith('/state')) return parsed.searchParams.get('sessionId') || ''
  try {
    const body = JSON.parse(init.body)
    return typeof body.sessionId === 'string' ? body.sessionId : ''
  } catch {
    return ''
  }
}

/** Fake API that keeps one selected path per sessionId and records requests. */
function installSessionApi() {
  const calls = []
  const selections = new Map()
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url)
    calls.push({ url: text, init })
    const session = sessionOfRequest(text, init)
    if (text.startsWith('/python-env/api/state')) {
      return jsonResponse({ ok: true, sessionId: session, selected: selections.get(session) ?? null, environments: ENVIRONMENTS })
    }
    if (text === '/python-env/api/select') {
      const body = JSON.parse(init.body)
      selections.set(body.sessionId, body.path)
      return jsonResponse({ ok: true, sessionId: body.sessionId, selected: body.path, environment: { path: body.path } })
    }
    if (text === '/python-env/api/clear') {
      const body = JSON.parse(init.body)
      selections.set(body.sessionId, null)
      return jsonResponse({ ok: true, sessionId: body.sessionId, selected: null })
    }
    if (text === '/python-env/api/refresh') {
      const body = JSON.parse(init.body)
      return jsonResponse({ ok: true, sessionId: body.sessionId, selected: selections.get(body.sessionId) ?? null, environments: ENVIRONMENTS })
    }
    throw new Error('unexpected request ' + text)
  }
  return { calls, selections }
}

const dictionaries = []
await import('./client.js')

test('module loader receives the package id and a factory', () => {
  assert.equal(moduleId, '@local/python-env-manager')
  assert.equal(typeof factory, 'function')
})

const exportsObject = factory(fakeRequire)

test('factory exports slots/locale injection and apply', () => {
  assert.deepEqual(exportsObject.inject, ['slots', 'locale'])
  assert.equal(typeof exportsObject.apply, 'function')
  assert.equal(typeof exportsObject.PythonEnvButton, 'function')
})

const ctx = createCtx(dictionaries)
ctx.styles = styleTags
exportsObject.apply(ctx)

const spec = ctx.registrations[0].spec
const component = ctx.registrations[0].component

test('apply registers per-conversation copy, styles, listeners, and the composer slot', () => {
  assert.ok(dictionaries.some(entry => entry.namespace === 'python-env-manager'))
  const dicts = dictionaries.find(entry => entry.namespace === 'python-env-manager').dicts
  for (const key of ['title', 'loading', 'empty', 'refresh', 'clear', 'current', 'scopeHint', 'error', 'needSession', 'emptySelection']) {
    assert.equal(typeof dicts.en[key], 'string', 'missing dictionary key ' + key)
    assert.ok(dicts.en[key].length > 0)
    assert.equal(typeof dicts.zh[key], 'string', 'missing zh dictionary key ' + key)
    assert.ok(dicts.zh[key].length > 0)
  }
  assert.equal(
    dicts.zh.scopeHint,
    '仅作用于当前对话及其子代理；其他对话不受影响。终端里的 python 命令与系统 PATH 不变。',
  )
  assert.equal(
    dicts.en.scopeHint,
    'Applies only to this conversation and its subagents; other conversations are unaffected. The terminal python command and system PATH stay unchanged.',
  )
  assert.equal(dicts.zh.needSession, '需要会话')
  assert.equal(dicts.en.needSession, 'Session required')
  assert.equal(styleTags.length, 1)
  assert.equal(ctx.injected, 'conversation.input.left')
  assert.equal(ctx.registrations.length, 1)
  assert.equal(spec.name, 'conversation.input.left')
  assert.equal(spec.id, 'python-env')
  assert.equal(spec.order, 40)
  assert.equal(typeof spec.inject, 'function')
  assert.equal(typeof component, 'function')
  assert.ok(ctx.effects.length >= 4)
  assert.ok(ctx.effects.some(entry => entry.description === 'python-env-manager: composer control'))
})

test('locale metadata describes a per-conversation choice', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL('./locale/' + name + '.json', import.meta.url), 'utf8'))
  const en = read('en')
  const zh = read('zh')
  assert.match(en.meta.description, /conversation/i)
  assert.doesNotMatch(en.meta.description, /profile-wide global/i)
  assert.match(zh.meta.description, /对话/)
  assert.doesNotMatch(zh.meta.description, /配置档的全局默认/)
})

test('inject forwards the owning sessionId and a translator', () => {
  const injected = spec.inject('session-A')
  assert.equal(injected.sessionId, 'session-A')
  assert.equal(typeof injected.t, 'function')
  assert.equal(injected.t('title'), 'Python environment')
  assert.equal(typeof injected.registry.add, 'function')
})

const triggerEl = {
  focus() {},
  isConnected: true,
  getBoundingClientRect: () => ({ left: 120, top: 700 }),
}

function render(key, injected) {
  fakeReact.mount(key)
  portals.length = 0
  return component(injected)
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function openPanel(key, injected) {
  const closed = render(key, injected)
  const trigger = closed.children[0]
  trigger.props.onClick({ preventDefault() {}, currentTarget: triggerEl })
  await flush()
  const opened = render(key, injected)
  assert.equal(portals.length, 1, 'the panel portals to document.body')
  assert.equal(portals[0].target, document.body)
  return { trigger: opened.children[0], panel: portals[0].node }
}

function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

function findByClass(panel, className) {
  return collect(panel).find(node => {
    if (!node.props || typeof node.props.className !== 'string') return false
    return node.props.className.split(/\s+/).includes(className)
  })
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

function listGroup(panel) {
  return collect(panel).find(node => node.props && node.props.role === 'radiogroup')
}

function listRows(panel) {
  const group = listGroup(panel)
  return group ? group.children : []
}

function findButton(panel, label) {
  return collect(panel).find(node => node.type === 'button' && textOf(node) === label)
}

test('a missing sessionId disables the trigger and sends no request', async () => {
  const api = installSessionApi()
  const injected = spec.inject()
  assert.equal(injected.sessionId, undefined)
  const tree = render('no-session', injected)
  const trigger = tree.children[0]
  assert.equal(trigger.props.disabled, true)
  assert.equal(trigger.props['aria-label'], 'Session required')
  assert.ok(textOf(trigger).includes('Session required'))
  trigger.props.onClick({ preventDefault() {}, currentTarget: triggerEl })
  await flush()
  assert.equal(api.calls.length, 0)
  const again = render('no-session', injected)
  assert.equal(again.children.length, 1, 'no panel opens without a session')
  assert.equal(again.children[0].props['aria-expanded'], false)
})

test('opening the panel loads this conversation state with sessionId in the query', async () => {
  const api = installSessionApi()
  const injected = spec.inject('session-A')
  const { panel } = await openPanel('flow-a', injected)
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].url, '/python-env/api/state?sessionId=session-A')
  assert.equal(api.calls[0].init.method, 'GET')
  assert.equal(api.calls[0].init.credentials, 'same-origin')
  const current = textOf(findByClass(panel, 'pem-current'))
  assert.ok(current.startsWith('Current'))
  assert.ok(current.includes('Not set'))
  const hint = findByClass(panel, 'pem-empty-hint')
  assert.ok(hint, 'the empty selection explains the per-conversation choice')
  assert.match(textOf(hint), /this conversation/i)
  const rows = listRows(panel)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].props.role, 'radio')
  assert.equal(rows[0].props['aria-checked'], false)
  assert.equal(rows[1].props['aria-checked'], false)
  assert.equal(rows[0].props.tabIndex, 0)
  assert.equal(rows[1].props.tabIndex, -1)
  const sourceBadge = collect(rows[0]).find(node => node.props && node.props.className === 'pem-badge')
  assert.equal(sourceBadge.children[0], 'conda')
})

test('the trigger stays clickable while the panel is loading', async () => {
  const calls = []
  let release = null
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init })
    return new Promise(resolve => {
      release = () => resolve(jsonResponse({ ok: true, sessionId: 'session-loading', selected: null, environments: ENVIRONMENTS }))
    })
  }
  const injected = spec.inject('session-loading')
  const closed = render('loading-1', injected)
  const trigger = closed.children[0]
  assert.equal(trigger.props.disabled, false)
  trigger.props.onClick({ preventDefault() {}, currentTarget: triggerEl })
  await flush()
  const loading = render('loading-1', injected)
  const loadingTrigger = loading.children[0]
  assert.equal(loading.children.length, 2, 'the panel is open while loading')
  assert.equal(loadingTrigger.props['aria-busy'], true)
  assert.equal(loadingTrigger.props.disabled, false)
  loadingTrigger.props.onClick({ preventDefault() {}, currentTarget: triggerEl })
  const closedAgain = render('loading-1', injected)
  assert.equal(closedAgain.children.length, 1, 'the loading trigger closes the panel')
  release()
  await flush()
  assert.equal(calls.length, 1)
})

test('choosing a row posts sessionId and highlights only this conversation', async () => {
  const api = installSessionApi()
  const injected = spec.inject('session-choose')
  const { panel } = await openPanel('choose-1', injected)
  listRows(panel)[0].props.onClick()
  await flush()
  const select = api.calls.find(call => call.url === '/python-env/api/select')
  assert.ok(select, 'select posts to the API')
  assert.equal(select.init.method, 'POST')
  assert.equal(select.init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(select.init.body), { sessionId: 'session-choose', path: ENVIRONMENTS[0].path })

  const reopened = render('choose-1', injected)
  assert.equal(reopened.children.length, 2)
  const panel2 = portals[0].node
  const rows2 = listRows(panel2)
  assert.equal(rows2[0].props['aria-checked'], true)
  assert.equal(rows2[1].props['aria-checked'], false)
  assert.ok(textOf(findByClass(panel2, 'pem-current')).includes('open-webui'))
  assert.ok(textOf(findByClass(panel2, 'pem-status-text')).includes('Default set'))
  assert.equal(findByClass(panel2, 'pem-empty-hint'), undefined, 'the empty hint disappears once a choice exists')
})

test('arrow keys move focus onto the next row and select it immediately', async () => {
  const api = installSessionApi()
  const injected = spec.inject('session-keys')
  const { panel } = await openPanel('keys-1', injected)
  const group = listGroup(panel)
  const focused = []
  const fakeRows = [{ focus() { focused.push(0) } }, { focus() { focused.push(1) } }]
  document.activeElement = fakeRows[0]
  try {
    group.props.onKeyDown({
      key: 'ArrowDown',
      currentTarget: { querySelectorAll: () => fakeRows },
      preventDefault() {},
    })
    await flush()
  } finally {
    document.activeElement = null
  }
  assert.deepEqual(focused, [1])
  const select = api.calls.find(call => call.url === '/python-env/api/select')
  assert.deepEqual(JSON.parse(select.init.body), { sessionId: 'session-keys', path: ENVIRONMENTS[1].path })
})

test('clear posts sessionId and resets this conversation', async () => {
  const api = installSessionApi()
  const injected = spec.inject('session-clear')
  const { panel } = await openPanel('clear-1', injected)
  listRows(panel)[1].props.onClick()
  await flush()
  render('clear-1', injected)
  const panel2 = portals[0].node
  const clearButton = findButton(panel2, 'Clear')
  assert.equal(clearButton.props.disabled, false)
  clearButton.props.onClick()
  await flush()
  const clearCall = api.calls.find(call => call.url === '/python-env/api/clear')
  assert.ok(clearCall, 'clear posts to the API')
  assert.equal(clearCall.init.method, 'POST')
  assert.deepEqual(JSON.parse(clearCall.init.body), { sessionId: 'session-clear' })
  render('clear-1', injected)
  const panel3 = portals[0].node
  assert.equal(listRows(panel3).every(row => row.props['aria-checked'] === false), true)
  assert.ok(textOf(findByClass(panel3, 'pem-current')).includes('Not set'))
  assert.ok(textOf(findByClass(panel3, 'pem-status-text')).includes('cleared'))
})

test('refresh posts sessionId and replaces the listed state', async () => {
  const api = installSessionApi()
  api.selections.set('session-refresh', ENVIRONMENTS[1].path)
  const injected = spec.inject('session-refresh')
  const { panel } = await openPanel('refresh-1', injected)
  const refreshButton = findButton(panel, 'Refresh')
  assert.equal(refreshButton.props.disabled, false)
  refreshButton.props.onClick()
  await flush()
  const call = api.calls.find(entry => entry.url === '/python-env/api/refresh')
  assert.ok(call, 'refresh posts to the API')
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(JSON.parse(call.init.body), { sessionId: 'session-refresh' })
  render('refresh-1', injected)
  const panel2 = portals[0].node
  assert.equal(listRows(panel2)[1].props['aria-checked'], true)
})

test('two conversations keep independent stores and requests', async () => {
  const api = installSessionApi()
  const a = spec.inject('session-A')
  const b = spec.inject('session-B')

  const openedA = await openPanel('iso-a', a)
  listRows(openedA.panel)[0].props.onClick()
  await flush()
  const selectA = api.calls.filter(call => call.url === '/python-env/api/select')
  assert.equal(selectA.length, 1)
  assert.deepEqual(JSON.parse(selectA[0].init.body), { sessionId: 'session-A', path: ENVIRONMENTS[0].path })

  const openedB = await openPanel('iso-b', b)
  assert.equal(listRows(openedB.panel).every(row => row.props['aria-checked'] === false), true)
  assert.ok(textOf(findByClass(openedB.panel, 'pem-current')).includes('Not set'))
  const stateCalls = api.calls.filter(call => call.url.startsWith('/python-env/api/state'))
  assert.equal(stateCalls[stateCalls.length - 1].url, '/python-env/api/state?sessionId=session-B')

  const reopenedA = await openPanel('iso-a', a)
  assert.equal(listRows(reopenedA.panel)[0].props['aria-checked'], true)
  assert.ok(textOf(findByClass(reopenedA.panel, 'pem-current')).includes('open-webui'))
})

test('a sessionId change on the same instance rebuilds the store', async () => {
  const api = installSessionApi()
  const first = spec.inject('session-old')
  const second = spec.inject('session-new')
  const { panel } = await openPanel('switch-1', first)
  listRows(panel)[0].props.onClick()
  await flush()
  assert.equal(api.selections.get('session-old'), ENVIRONMENTS[0].path)

  const switched = render('switch-1', second)
  assert.equal(switched.children.length, 1, 'the previous panel is gone after the rebuild')
  assert.equal(switched.children[0].props['aria-expanded'], false)
  const reopened = await openPanel('switch-1', second)
  assert.ok(textOf(findByClass(reopened.panel, 'pem-current')).includes('Not set'))
  const stateCalls = api.calls.filter(call => call.url.startsWith('/python-env/api/state'))
  assert.equal(stateCalls[stateCalls.length - 1].url, '/python-env/api/state?sessionId=session-new')
})

test('load failures map to panel errors instead of throwing', async () => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const injected = spec.inject('session-error')
  const { panel } = await openPanel('error-1', injected)
  assert.ok(textOf(panel).includes('offline'))
  assert.ok(findButton(panel, 'Retry'), 'the error offers a retry')

  globalThis.fetch = async () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  const timeout = await openPanel('error-2', spec.inject('session-timeout'))
  assert.ok(textOf(timeout.panel).includes('The request timed out.'))
})

test('Tab focus stays inside the dialog', async () => {
  installSessionApi()
  const injected = spec.inject('session-focus')
  const focused = []
  const first = { focus() { focused.push('first') }, getAttribute: () => null }
  const last = { focus() { focused.push('last') }, getAttribute: () => null }
  fakeReact.setRefElement({ querySelector: () => null, querySelectorAll: () => [first, last], contains: () => false })
  try {
    const { panel } = await openPanel('focus-1', injected)
    document.activeElement = last
    panel.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() {} })
    assert.deepEqual(focused, ['first'])
    document.activeElement = first
    panel.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault() {} })
    assert.deepEqual(focused, ['first', 'last'])
  } finally {
    fakeReact.setRefElement(null)
    document.activeElement = null
  }
})

test('Escape closes the open panel and disposal removes the global listeners', async () => {
  installSessionApi()
  const injected = spec.inject('session-escape')
  await openPanel('escape-1', injected)
  fire('document', 'keydown', { key: 'Escape' })
  const closed = render('escape-1', injected)
  assert.equal(closed.children.length, 1)

  const before = styleTags.length
  for (const entry of ctx.effects) {
    if (typeof entry.disposer === 'function') entry.disposer()
  }
  assert.ok(styleTags.length < before || before === 0)
  assert.equal((listeners.get('document:keydown') ?? []).length, 0)
})
