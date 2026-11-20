/*
 * Python environment manager — browser half.
 *
 * Loaded by the DSH module loader as a plain factory-form CJS module. The only
 * platform modules requested are `react` and `react-dom` (both baseline seeds
 * of the shell module table); no @deepseek-ai client package is imported.
 *
 * The selection is per conversation: the composer slot injects the owning
 * sessionId, and every component instance owns the store bound to that session.
 * All requests carry the sessionId (GET as a query, POST in the JSON body); a
 * store without a session never reaches the network.
 *
 * The composer slot `conversation.input.left` lives inside the docked composer,
 * which is explicitly a containing block for fixed descendants and clips them,
 * so the panel portals to document.body (ReactDOM.createPortal) and positions
 * itself from the trigger's viewport rect. Global dismissal listeners are
 * installed once by apply() inside ctx.effect and removed on dispose or page
 * teardown; they act on the registry of live per-session stores.
 */
window.__ModuleLoader__.load({
  id: '@local/python-env-manager',
  factory(require) {
    const React = require('react')
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      // Defensive: keep the button usable with an inline panel if a future shell
      // stops seeding react-dom.
      ReactDOM = null
    }
    const h = React.createElement
    const NS = 'python-env-manager'
    const API_BASE = '/python-env/api'
    const REQUEST_TIMEOUT = 8000

    const DICT = {
      en: {
        title: 'Python environment',
        triggerTitle: 'Choose the Python environment for this conversation',
        scopeHint: 'Applies only to this conversation and its subagents; other conversations are unaffected. The terminal python command and system PATH stay unchanged.',
        current: 'Current',
        none: 'Not set',
        needSession: 'Session required',
        emptySelection: 'No interpreter is set for this conversation yet. Click a list item to set it in one step.',
        missing: 'The saved interpreter is not in the discovered list.',
        loading: 'Loading Python environments…',
        refreshing: 'Refreshing…',
        working: 'Switching…',
        empty: 'No Python environments were found.',
        refresh: 'Refresh',
        clear: 'Clear',
        close: 'Close',
        retry: 'Retry',
        error: 'Could not read Python environments.',
        invalidResponse: 'The service returned data this panel cannot read.',
        timeout: 'The request timed out.',
        selectedNotice: 'Default set: {name}',
        clearedNotice: 'Default selection cleared',
      },
      zh: {
        title: 'Python 环境',
        triggerTitle: '为当前对话选择 Python 环境',
        scopeHint: '仅作用于当前对话及其子代理；其他对话不受影响。终端里的 python 命令与系统 PATH 不变。',
        current: '当前',
        none: '未选择',
        needSession: '需要会话',
        emptySelection: '尚未为当前对话选择解释器，点击列表项即可一键设置。',
        missing: '已保存的解释器不在当前列表中。',
        loading: '正在读取 Python 环境…',
        refreshing: '正在刷新…',
        working: '正在切换…',
        empty: '未发现可用的 Python 环境。',
        refresh: '刷新',
        clear: '清除选择',
        close: '关闭',
        retry: '重试',
        error: '无法读取 Python 环境列表。',
        invalidResponse: '服务返回的数据无法解析。',
        timeout: '请求超时。',
        selectedNotice: '已设为默认：{name}',
        clearedNotice: '已清除默认选择',
      },
    }

    const STYLE = `
.pem-trigger{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:28px;max-width:100%;margin:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden;-webkit-appearance:none;appearance:none;transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease}
.pem-trigger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.pem-trigger[aria-expanded='true']{border-color:var(--dsw-alias-brand-primary)}
.pem-trigger[aria-expanded='true'] .pem-trigger-label{color:var(--dsw-alias-brand-primary)}
.pem-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pem-trigger:disabled{cursor:default;opacity:.65;color:var(--dsw-alias-label-secondary)}
.pem-trigger-label{flex:none;color:var(--dsw-alias-label-primary)}
.pem-trigger-env{min-width:0;max-width:9em;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.pem-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.pem-dot[data-on='true']{background:var(--dsw-alias-state-success-primary)}
.pem-chevron{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;transform:translateY(-1px)}
.pem-panel{position:fixed;z-index:1200;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;animation:pem-in 120ms ease-out}
.pem-panel[data-inline='true']{position:absolute;left:0;bottom:calc(100% + 8px);z-index:1200}
.pem-wrap{position:relative;display:inline-flex;align-items:center}
@container (max-width: 480px){.pem-trigger{padding:0 8px}.pem-trigger-env{display:none}}
@keyframes pem-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.pem-panel{animation:none}}
.pem-head{padding:12px 14px 9px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.pem-title{min-width:0;margin:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}
.pem-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pem-current{min-width:0;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.pem-current strong{font-weight:600;color:var(--dsw-alias-brand-primary)}
.pem-hint{margin:4px 0 0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.pem-empty-hint{padding:8px 14px 2px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.pem-list{flex:1 1 auto;min-height:0;margin:0;padding:6px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.pem-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-width:0;margin:0;padding:7px 8px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.pem-row:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.pem-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.pem-row:disabled,.pem-row[aria-disabled='true']{cursor:default;opacity:.6}
.pem-row-current{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.pem-row-main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.pem-row-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;font-weight:600;line-height:16px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pem-badge{flex:none;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:10px;font-weight:500;line-height:14px;color:var(--dsw-alias-label-secondary);text-transform:lowercase}
.pem-row-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary)}
.pem-check{flex:none;font-size:12px;line-height:1;color:var(--dsw-alias-brand-primary)}
.pem-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.pem-status{padding:14px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.pem-note{padding:6px 14px 0;font-size:11px;line-height:15px;color:var(--dsw-alias-state-warn-primary)}
.pem-error{display:flex;align-items:center;gap:8px;margin:6px 8px 0;padding:7px 9px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary)}
.pem-error-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pem-footer{display:flex;align-items:center;gap:6px;padding:8px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.pem-status-text{flex:1 1 auto;min-width:0;font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary)}
.pem-action{margin:0;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:14px;cursor:pointer;white-space:nowrap}
.pem-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.pem-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pem-action:disabled{cursor:default;opacity:.55;color:var(--dsw-alias-label-secondary)}
.pem-action-danger:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
`

    const DEFAULT_ANCHOR = { left: 16, bottom: 88, width: 320, maxHeight: 320 }

    function prefersZh() {
      try {
        const language = window.navigator && typeof window.navigator.language === 'string'
          ? window.navigator.language
          : (document.documentElement && document.documentElement.lang) || ''
        return /^zh/i.test(String(language))
      } catch {
        return false
      }
    }

    function interpolate(text, params) {
      if (!params || typeof text !== 'string') return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function fallbackT(key, params) {
      const dict = prefersZh() ? DICT.zh : DICT.en
      const text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
      return interpolate(text, params)
    }

    function createTranslator(ctx) {
      let bound = null
      try {
        if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(NS)
      } catch {
        bound = null
      }
      return function t(key, params) {
        if (typeof key !== 'string' || key === '') return ''
        let text = null
        if (bound) {
          try {
            const value = bound(key, params)
            if (typeof value === 'string' && value !== '' && value !== key) text = value
          } catch {
            text = null
          }
        }
        if (text === null) text = fallbackT(key, params)
        return typeof text === 'string' ? text : String(text)
      }
    }

    function shortFromPath(value) {
      if (typeof value !== 'string' || value === '') return ''
      const parts = value.split(/[\\/]+/).filter(Boolean)
      let base = parts.length > 0 ? parts[parts.length - 1] : value
      base = base.replace(/\.(exe|cmd|bat|ps1)$/i, '')
      if (parts.length > 1 && /^(python[\d.]*|py)$/i.test(base)) base = parts[parts.length - 2]
      return base === '' ? value : base
    }

    /** A slot injects with the owning sessionId, but props may carry the string. */
    function sessionOf(value) {
      if (typeof value === 'string') return value.trim()
      if (value && typeof value === 'object' && typeof value.sessionId === 'string') {
        return value.sessionId.trim()
      }
      return ''
    }

    function normalizeEnvironments(payload) {
      const rows = payload && Array.isArray(payload.environments) ? payload.environments : []
      const out = []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const path = typeof row.path === 'string' ? row.path : ''
        if (path === '') continue
        const name = typeof row.name === 'string' && row.name !== '' ? row.name : shortFromPath(path)
        out.push({
          name,
          path,
          source: typeof row.source === 'string' ? row.source : '',
          prefix: typeof row.prefix === 'string' ? row.prefix : '',
        })
      }
      return out
    }

    function selectedOf(payload, fallback) {
      if (payload && typeof payload.selected === 'string' && payload.selected !== '') return payload.selected
      if (payload && payload.selected === null) return null
      return fallback === undefined ? null : fallback
    }

    async function requestJson(t, method, route, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT) : null
      try {
        const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } }
        if (body !== undefined) {
          init.headers['Content-Type'] = 'application/json'
          init.body = JSON.stringify(body)
        }
        if (controller) init.signal = controller.signal
        const response = await fetch(API_BASE + route, init)
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok) {
          const detail = payload && typeof payload.error === 'string' && payload.error !== '' ? payload.error : 'HTTP ' + response.status
          throw new Error(detail)
        }
        if (!payload || typeof payload !== 'object') throw new Error(t('invalidResponse'))
        if (payload.ok === false) {
          const detail = typeof payload.error === 'string' && payload.error !== '' ? payload.error : t('error')
          throw new Error(detail)
        }
        return payload
      } finally {
        if (timer !== null) window.clearTimeout(timer)
      }
    }

    /**
     * Per-conversation panel registry. Stores are owned by component instances
     * (one per session) and tracked here only so the apply-level dismissal
     * listeners can act on whichever panel is currently open.
     */
    function createPanelRegistry() {
      const stores = new Set()
      return {
        add(store) {
          stores.add(store)
          return () => {
            stores.delete(store)
          }
        },
        remove(store) {
          stores.delete(store)
        },
        open() {
          const out = []
          for (const store of stores) {
            let snapshot = null
            try {
              snapshot = store.getSnapshot()
            } catch {
              snapshot = null
            }
            if (snapshot && snapshot.open === true) out.push(store)
          }
          return out
        },
      }
    }

    const NO_PANEL_REGISTRY = {
      add() {
        return () => {}
      },
      remove() {},
      open() {
        return []
      },
    }

    /**
     * One store per conversation. Every request carries this session's id; a
     * store without a session never touches the network.
     */
    function createStore(t, sessionId, registry) {
      const session = sessionOf(sessionId)
      const panels = registry && typeof registry.add === 'function' ? registry : NO_PANEL_REGISTRY
      const hasSession = session !== ''
      let disposed = false
      let api = null
      let untrack = null
      let snapshot = {
        sessionId: session,
        phase: hasSession ? 'idle' : 'no-session',
        environments: [],
        selected: null,
        error: '',
        actionError: '',
        notice: '',
        busy: false,
        open: false,
        openFor: null,
        anchor: DEFAULT_ANCHOR,
      }
      const listeners = new Set()
      let triggerEl = null
      let panelEl = null
      let noticeTimer = null

      function publish(patch) {
        if (disposed) return
        snapshot = Object.assign({}, snapshot, patch)
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch {
            // A broken subscriber must not break the store or other subscribers.
          }
        }
      }

      function notice(text) {
        if (noticeTimer !== null) window.clearTimeout(noticeTimer)
        publish({ notice: text })
        noticeTimer = window.setTimeout(() => {
          noticeTimer = null
          publish({ notice: '' })
        }, 5000)
      }

      function describe(error) {
        if (error && error.name === 'AbortError') return t('timeout')
        const message = error && typeof error.message === 'string' ? error.message : ''
        if (/^HTTP \d{3}$/.test(message) || message === 'invalid json') return t('error')
        return message !== '' ? message : t('error')
      }

      function computeAnchor() {
        try {
          const rect = triggerEl && typeof triggerEl.getBoundingClientRect === 'function'
            ? triggerEl.getBoundingClientRect()
            : null
          const width = 320
          if (!rect) return Object.assign({}, DEFAULT_ANCHOR, { width })
          const viewportWidth = window.innerWidth || 1024
          const viewportHeight = window.innerHeight || 768
          const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8))
          const bottom = Math.max(8, viewportHeight - rect.top + 8)
          const maxHeight = Math.max(180, Math.min(360, rect.top - 24))
          return { left, bottom, width, maxHeight }
        } catch {
          return DEFAULT_ANCHOR
        }
      }

      function closeOtherPanels() {
        let opened = []
        try {
          opened = panels.open()
        } catch {
          opened = []
        }
        for (const other of opened) {
          if (other === api) continue
          try {
            other.close(false)
          } catch {
            // A sibling panel may already be gone.
          }
        }
      }

      function openPanel(trigger, owner) {
        if (!hasSession || disposed) return
        closeOtherPanels()
        if (trigger) triggerEl = trigger
        publish({ open: true, openFor: owner || null, anchor: computeAnchor(), actionError: '' })
        if (snapshot.phase !== 'loading') load()
      }

      function close(focus) {
        if (disposed || !snapshot.open) return
        publish({ open: false, openFor: null })
        if (focus !== false) {
          try {
            if (triggerEl && triggerEl.isConnected && typeof triggerEl.focus === 'function') triggerEl.focus()
          } catch {
            // Detached triggers cannot take focus.
          }
        }
      }

      async function load() {
        if (!hasSession || disposed) return
        if (snapshot.phase === 'loading') return
        publish({ phase: 'loading', error: '' })
        try {
          const payload = await requestJson(t, 'GET', '/state?sessionId=' + encodeURIComponent(session))
          publish({
            phase: 'ready',
            environments: normalizeEnvironments(payload),
            selected: selectedOf(payload),
            error: '',
          })
        } catch (error) {
          publish({ phase: 'error', error: describe(error) })
        }
      }

      async function refresh() {
        if (!hasSession || disposed) return
        if (snapshot.phase === 'loading' || snapshot.busy) return
        publish({ phase: 'loading', error: '' })
        try {
          const payload = await requestJson(t, 'POST', '/refresh', { sessionId: session })
          publish({
            phase: 'ready',
            environments: normalizeEnvironments(payload),
            selected: selectedOf(payload),
            error: '',
          })
        } catch (error) {
          publish({ phase: 'error', error: describe(error) })
        }
      }

      async function choose(path) {
        if (!hasSession || disposed || snapshot.busy) return
        if (typeof path !== 'string' || path === '') return
        publish({ busy: true, actionError: '' })
        try {
          const payload = await requestJson(t, 'POST', '/select', { sessionId: session, path })
          const chosen = selectedOf(payload, path)
          const env = snapshot.environments.find(row => row.path === chosen) || null
          const label = env ? env.name : shortFromPath(chosen || path)
          publish({
            busy: false,
            selected: chosen,
            phase: 'ready',
            error: '',
          })
          notice(t('selectedNotice', { name: label }))
        } catch (error) {
          publish({ busy: false, actionError: describe(error) })
        }
      }

      async function clear() {
        if (!hasSession || disposed || snapshot.busy) return
        publish({ busy: true, actionError: '' })
        try {
          await requestJson(t, 'POST', '/clear', { sessionId: session })
          publish({ busy: false, selected: null })
          notice(t('clearedNotice'))
        } catch (error) {
          publish({ busy: false, actionError: describe(error) })
        }
      }

      api = {
        session() {
          return session
        },
        hasSession() {
          return hasSession
        },
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        getSnapshot() {
          return snapshot
        },
        load,
        refresh,
        choose,
        clear,
        openPanel,
        close,
        toggle(trigger, owner) {
          if (snapshot.open && snapshot.openFor === owner) close(true)
          else openPanel(trigger, owner)
        },
        panel() {
          return panelEl
        },
        setPanel(element) {
          panelEl = element || null
        },
        owner() {
          return snapshot.openFor
        },
        dispose() {
          if (disposed) return
          disposed = true
          if (noticeTimer !== null) window.clearTimeout(noticeTimer)
          noticeTimer = null
          listeners.clear()
          triggerEl = null
          panelEl = null
          if (untrack) {
            try {
              untrack()
            } catch {
              // The registry may already be torn down.
            }
          }
          untrack = null
        },
      }
      untrack = panels.add(api)
      return api
    }

    function useSnapshot(store) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      }
      const [snap, setSnap] = React.useState(store.getSnapshot())
      React.useEffect(() => store.subscribe(() => setSnap(store.getSnapshot())), [store])
      return snap
    }

    function focusFirst(panel) {
      if (!panel || typeof panel.querySelector !== 'function') return
      const target = panel.querySelector('[role="radio"][aria-checked="true"]')
        || panel.querySelector('[role="radio"]')
        || panel.querySelector('button')
      if (target && typeof target.focus === 'function') target.focus()
    }

    /** Keep Tab inside the dialog (aria-modal) instead of leaking to the page. */
    function trapTab(panel, event) {
      if (!event || event.key !== 'Tab') return
      if (!panel || typeof panel.querySelectorAll !== 'function') return
      const nodes = panel.querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])')
      const list = Array.prototype.filter.call(nodes, node => node && node.getAttribute('aria-disabled') !== 'true')
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        first.focus()
      }
    }

    function rowKeyDown(event, activate) {
      const key = event && event.key
      if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
      const group = event.currentTarget
      if (!group || typeof group.querySelectorAll !== 'function') return
      const rows = group.querySelectorAll('[role="radio"]')
      if (!rows || rows.length === 0) return
      let index = Array.prototype.indexOf.call(rows, document.activeElement)
      if (index < 0) index = 0
      if (key === 'ArrowDown') index = (index + 1) % rows.length
      else if (key === 'ArrowUp') index = (index - 1 + rows.length) % rows.length
      else if (key === 'Home') index = 0
      else index = rows.length - 1
      if (typeof event.preventDefault === 'function') event.preventDefault()
      try {
        rows[index].focus()
      } catch {
        // Ignore detached rows.
      }
      if (typeof activate === 'function') activate(index)
    }

    function environmentRow(props) {
      const { env, checked, busy, onChoose } = props
      const children = [
        h('span', { className: 'pem-row-main', key: 'main' },
          h('span', { className: 'pem-row-name' },
            h('span', null, env.name),
            env.source !== '' ? h('span', { className: 'pem-badge' }, env.source) : null,
          ),
          h('span', { className: 'pem-row-path', title: env.path }, env.path),
        ),
      ]
      if (checked) children.push(h('span', { className: 'pem-check', key: 'check', 'aria-hidden': 'true' }, '✓'))
      return h('button', {
        key: env.path,
        type: 'button',
        role: 'radio',
        'aria-checked': checked,
        'aria-label': env.name + ' — ' + env.path,
        className: 'pem-row' + (checked ? ' pem-row-current' : ''),
        tabIndex: props.tabIndex,
        'aria-disabled': busy ? 'true' : undefined,
        onClick: () => onChoose(env.path),
      }, children)
    }

    function PythonEnvButton(injected) {
      const props = injected && typeof injected === 'object' ? injected : {}
      const t = typeof props.t === 'function' ? props.t : fallbackT
      const sessionId = sessionOf(props.sessionId)
      const hasSession = sessionId !== ''
      const registry = props.registry && typeof props.registry.add === 'function'
        ? props.registry
        : NO_PANEL_REGISTRY
      // One store per component instance, bound to that instance's session. A
      // different sessionId on the same instance rebuilds the store and disposes
      // the previous one (notice timer, listeners, registry entry).
      const storeRef = React.useRef(null)
      if (storeRef.current === null || storeRef.current.sessionId !== sessionId) {
        if (storeRef.current !== null) {
          try {
            storeRef.current.store.dispose()
          } catch {
            // The previous store was already disposed.
          }
        }
        storeRef.current = { sessionId, store: createStore(t, sessionId, registry) }
      }
      const store = storeRef.current.store
      const snap = useSnapshot(store)
      const ownerRef = React.useRef(null)
      if (ownerRef.current === null) ownerRef.current = {}
      const owner = ownerRef.current
      const isOwner = snap.open === true && snap.openFor === owner

      const wasOpen = React.useRef(false)
      React.useEffect(() => {
        if (isOwner && !wasOpen.current) {
          wasOpen.current = true
          focusFirst(store.panel())
        } else if (!isOwner) {
          wasOpen.current = false
        }
      })

      React.useEffect(() => () => {
        const current = storeRef.current
        if (!current || !current.store) return
        if (current.store.owner() === owner) current.store.close(false)
        current.store.setPanel(null)
        current.store.dispose()
      }, [])

      const environments = Array.isArray(snap.environments) ? snap.environments : []
      const selected = typeof snap.selected === 'string' && snap.selected !== '' ? snap.selected : null
      const selectedEnv = selected === null ? null : environments.find(env => env.path === selected) || null
      const shortName = selected === null ? '' : (selectedEnv ? selectedEnv.name : shortFromPath(selected))
      const loading = snap.phase === 'loading'
      const busy = snap.busy === true
      const noSession = !hasSession
      const disabled = busy || noSession
      const triggerLabel = noSession
        ? t('needSession')
        : t('triggerTitle') + (shortName !== '' ? ' · ' + shortName : '')
      const triggerTitle = noSession
        ? t('needSession')
        : triggerLabel + (selected !== null ? '\n' + selected : '')

      const trigger = h('button', {
        type: 'button',
        className: 'pem-trigger',
        'aria-haspopup': 'dialog',
        'aria-expanded': isOwner,
        'aria-label': triggerLabel,
        'aria-busy': busy || loading,
        title: triggerTitle,
        disabled,
        onClick: (event) => {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (disabled) return
          store.toggle(event.currentTarget, owner)
        },
      },
        h('span', { className: 'pem-dot', 'aria-hidden': 'true', 'data-on': selected !== null && !noSession }),
        h('span', { className: 'pem-trigger-label' }, noSession ? t('needSession') : 'Python'),
        shortName !== '' && !noSession ? h('span', { className: 'pem-trigger-env' }, shortName) : null,
        h('span', { className: 'pem-chevron', 'aria-hidden': 'true' }, '▾'),
      )

      if (!isOwner) return h(React.Fragment, null, trigger)

      const anchor = snap.anchor && typeof snap.anchor === 'object' ? snap.anchor : DEFAULT_ANCHOR
      const portalAvailable = ReactDOM && typeof ReactDOM.createPortal === 'function'
      const children = []

      children.push(h('div', { className: 'pem-head', key: 'head' },
        h('div', { className: 'pem-title-row' },
          h('h2', { className: 'pem-title' }, t('title')),
          h('span', { className: 'pem-current' },
            t('current') + ' ',
            selected === null ? t('none') : h('strong', null, shortName),
          ),
        ),
        h('p', { className: 'pem-hint' }, t('scopeHint')),
      ))

      if (selected !== null && selectedEnv === null) {
        children.push(h('div', { className: 'pem-note', key: 'missing' }, t('missing')))
      }

      if (snap.actionError) {
        children.push(h('div', { className: 'pem-error', key: 'action-error', role: 'alert' },
          h('span', { className: 'pem-error-text' }, snap.actionError),
        ))
      }

      const listBody = []
      if (snap.phase === 'error' && snap.error) {
        listBody.push(h('div', { className: 'pem-error', key: 'load-error', role: 'alert' },
          h('span', { className: 'pem-error-text' }, snap.error),
          h('button', {
            type: 'button',
            className: 'pem-action',
            onClick: () => store.refresh(),
          }, t('retry')),
        ))
      }
      if (loading && environments.length === 0) {
        listBody.push(h('div', { className: 'pem-status', key: 'loading', role: 'status', 'aria-live': 'polite' }, t('loading')))
      } else if (snap.phase === 'ready' && environments.length === 0) {
        listBody.push(h('div', { className: 'pem-status', key: 'empty', role: 'status', 'aria-live': 'polite' }, t('empty')))
      }
      if (environments.length > 0 && selected === null) {
        listBody.push(h('div', { className: 'pem-empty-hint', key: 'empty-selection' }, t('emptySelection')))
      }
      if (environments.length > 0) {
        const focusIndex = Math.max(0, environments.findIndex(env => env.path === selected))
        listBody.push(h('div', {
          className: 'pem-list',
          key: 'list',
          role: 'radiogroup',
          'aria-label': t('title'),
          onKeyDown: (event) => rowKeyDown(event, (index) => {
            const env = environments[index]
            if (env) store.choose(env.path)
          }),
        }, environments.map((env, index) => environmentRow({
          env,
          checked: env.path === selected,
          busy,
          tabIndex: index === focusIndex ? 0 : -1,
          onChoose: (path) => store.choose(path),
        }))))
      }
      children.push(h('div', { className: 'pem-body', key: 'body' }, listBody))

      children.push(h('div', { className: 'pem-footer', key: 'footer' },
        h('span', { className: 'pem-status-text', role: 'status', 'aria-live': 'polite' },
          busy ? t('working') : (snap.notice || (loading ? t('refreshing') : '')),
        ),
        h('button', {
          type: 'button',
          className: 'pem-action',
          disabled: busy || loading || noSession,
          onClick: () => store.refresh(),
        }, t('refresh')),
        h('button', {
          type: 'button',
          className: 'pem-action pem-action-danger',
          disabled: busy || noSession || selected === null,
          onClick: () => store.clear(),
        }, t('clear')),
        h('button', {
          type: 'button',
          className: 'pem-action',
          onClick: () => store.close(true),
        }, t('close')),
      ))

      const panelProps = {
        className: 'pem-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('title'),
        onKeyDown: (event) => trapTab(store.panel(), event),
        ref: (element) => store.setPanel(element),
        style: portalAvailable
          ? { left: anchor.left, bottom: anchor.bottom, width: anchor.width, maxHeight: anchor.maxHeight }
          : { width: anchor.width, maxHeight: anchor.maxHeight },
        'data-inline': portalAvailable ? undefined : 'true',
      }
      const panel = h('div', panelProps, children)
      if (portalAvailable) {
        try {
          return h(React.Fragment, null, trigger, ReactDOM.createPortal(panel, document.body))
        } catch {
          // Fall through to the inline panel below.
        }
      }
      return h('div', { className: 'pem-wrap' }, trigger, panel)
    }

    function apply(ctx) {
      const t = createTranslator(ctx)
      // Not selection state: only the live per-session stores, so the dismissal
      // listeners installed once by apply() can reach whichever panel is open.
      const panels = createPanelRegistry()

      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh })
        } catch {
          // A second fiber applying the same namespace must not break this one;
          // the bound dictionary already resolves, and the built-in fallback
          // keeps every string readable.
          return () => {}
        }
      }, 'python-env-manager: copy')

      ctx.effect(() => {
        try {
          const tag = document.createElement('style')
          tag.dataset.plugin = NS
          tag.textContent = STYLE
          document.head.append(tag)
          return () => {
            tag.remove()
          }
        } catch {
          return () => {}
        }
      }, 'python-env-manager: style')

      ctx.effect(() => {
        const openStores = () => {
          try {
            return panels.open()
          } catch {
            return []
          }
        }
        const inAnyPanel = (node) => {
          for (const store of openStores()) {
            const panel = store.panel()
            if (panel && typeof panel.contains === 'function' && panel.contains(node)) return true
          }
          return false
        }
        const closeAll = (focus) => {
          for (const store of openStores()) store.close(focus)
        }
        const onPointerDown = (event) => {
          if (openStores().length === 0) return
          if (inAnyPanel(event.target)) return
          const trigger = typeof event.composedPath === 'function'
            ? event.composedPath().find(node => node && node.nodeType === 1 && node.classList && node.classList.contains('pem-trigger'))
            : null
          if (trigger) return
          closeAll(false)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          closeAll(true)
        }
        const onScroll = (event) => {
          if (openStores().length === 0) return
          if (inAnyPanel(event.target)) return
          closeAll(false)
        }
        const onResize = () => {
          closeAll(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
        }
      }, 'python-env-manager: dismiss listeners')

      ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'python-env',
        order: 40,
        locale: NS,
        inject: (sessionId) => {
          const session = sessionOf(sessionId)
          const injected = { t, registry: panels }
          if (session !== '') injected.sessionId = session
          return injected
        },
      }, PythonEnvButton)), 'python-env-manager: composer control')
    }

    return { inject: ['slots', 'locale'], apply, PythonEnvButton }
  },
})