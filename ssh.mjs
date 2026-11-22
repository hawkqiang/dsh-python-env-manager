/*
 * SSH remote Python environment support.
 *
 * Responsibilities kept deliberately narrow and dependency-free:
 * - parse ~/.ssh/config (a practical subset: Host / HostName / User / Port /
 *   IdentityFile / Include / IgnoreUnknown) into concrete host entries;
 * - represent a remote interpreter as an `ssh://[user@]host[:port]/abs/path`
 *   URI so the per-conversation state file needs no schema migration;
 * - build the local `ssh` argv for a remote command with every argument
 *   quoted for the remote POSIX shell;
 * - probe one host for candidate Python interpreters, given an injected
 *   `run` (so tests and the host plugin share one code path).
 *
 * The probe only ever runs `command -v` style lookups remotely: no files are
 * written, no commands beyond the probe are executed by discovery itself, and
 * BatchMode keeps ssh from ever waiting on a password prompt.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const SSH_URI_PATTERN = /^ssh:\/\/(?:([^/@:\s]+)@)?([^/:@\s]+)(?::(\d+))?\/(.+)$/i

const INTERPRETER_BASENAME = /^python(\d+(?:\.\d+)*)?(\.(exe|bat|cmd))?$/i
const MAX_HOSTS = 16
const MAX_INCLUDE_DEPTH = 6

/** Fixed candidate paths probed on every host (Termux layouts, common prefixes). */
const FIXED_CANDIDATES = [
  '/data/data/com.termux/files/usr/bin/python3',
  '/data/data/com.termux/files/usr/bin/python',
  '/usr/local/bin/python3',
  '/usr/local/bin/python',
  '/opt/homebrew/bin/python3',
  '/opt/homebrew/bin/python',
]

export function isSshSelection(value) {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('ssh://')
}

/**
 * Parse an `ssh://[user@]host[:port]/absolute/python-path` URI.
 * Returns `{ user, host, port, path }` or null when malformed; `path` keeps
 * its leading slash and must be absolute on the remote host.
 */
export function parseSshUri(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = SSH_URI_PATTERN.exec(text)
  if (!match) return null
  const [, user, host, port, remotePath] = match
  // In an ssh:// URI everything after the authority is the remote path, and
  // URI paths are absolute on the remote host by definition.
  const resolvedPath = '/' + remotePath.replace(/^\/+/, '')
  if (!INTERPRETER_BASENAME.test(path.posix.basename(resolvedPath))) return null
  return {
    user: user || null,
    host,
    port: port ? Number.parseInt(port, 10) : null,
    path: resolvedPath,
  }
}

/** Canonical `ssh://[user@]host[:port]/abs/path` string from parsed parts. */
export function serializeSshUri({ user = null, host, port = null, path: remotePath }) {
  if (typeof host !== 'string' || host === '' || typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    throw new Error('SSH 解释器信息不完整。')
  }
  const authority = (user ? `${user}@` : '') + host + (port ? `:${port}` : '')
  return `ssh://${authority}${remotePath}`
}

/** Human label used as the environment name in lists: `host` or `host:port`. */
export function sshHostLabel({ host, port }) {
  return port ? `${host}:${port}` : host
}

/**
 * Parse a practical subset of ~/.ssh/config. Returns concrete entries
 * `[{ host, hostName, user, port, identityFiles }]` in file order; wildcard
 * patterns (`*`, `?`) are skipped because they cannot be probed directly.
 * `Include` is followed (relative to ~/.ssh or absolute, `~` expanded) with a
 * depth guard so a broken config can never recurse forever. The first block
 * for an alias wins, matching ssh's first-value-wins option semantics.
 */
export async function parseSshConfig({ home = os.homedir(), platform = process.platform } = {}) {
  const sshDir = path.join(home, '.ssh')
  const main = path.join(sshDir, 'config')
  const hosts = new Map()
  const visited = new Set()

  const stripQuotes = value => {
    const text = value.trim()
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
      return text.slice(1, -1)
    }
    return text
  }

  const splitTokens = value => {
    const tokens = []
    let current = ''
    let quote = null
    for (const char of value) {
      if (quote) {
        if (char === quote) quote = null
        else current += char
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (/\s/.test(char)) {
        if (current !== '') tokens.push(current)
        current = ''
      } else {
        current += char
      }
    }
    if (current !== '') tokens.push(current)
    return tokens
  }

  const expandToken = token => {
    const text = stripQuotes(token)
    if (text === '~' || text.startsWith('~/')) {
      return path.join(home, text.slice(1))
    }
    return path.isAbsolute(text) ? text : path.join(sshDir, text)
  }

  const globSafe = async pattern => {
    if (typeof fs.glob !== 'function') return [pattern]
    try {
      return await fs.glob(pattern)
    } catch {
      return []
    }
  }

  async function readConfigFile(file, depth) {
    const resolved = path.resolve(file)
    if (visited.has(resolved) || depth > MAX_INCLUDE_DEPTH) return
    visited.add(resolved)
    let text = ''
    try {
      text = await fs.readFile(resolved, 'utf8')
    } catch {
      return
    }

    let current = null
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line === '' || line.startsWith('#')) continue
      const separator = line.search(/[=\s]/)
      if (separator < 0) continue
      const keyword = line.slice(0, separator).toLowerCase()
      const value = line.slice(separator + 1).replace(/^[ \t=]+/, '')
      if (keyword === 'host') {
        // Concrete hosts only: wildcards and negations cannot be probed.
        const aliases = splitTokens(value).filter(alias => alias !== '' && !/[*?]/.test(alias) && !alias.startsWith('!'))
        current = null
        for (const alias of aliases) {
          if (!hosts.has(alias)) {
            const entry = { host: alias, hostName: alias, user: null, port: null, identityFiles: [] }
            hosts.set(alias, entry)
            current = current ?? entry
          } else {
            current = current ?? hosts.get(alias)
          }
        }
        continue
      }
      if (!current) continue
      if (keyword === 'hostname') {
        if (current.hostName === current.host) current.hostName = stripQuotes(value)
      } else if (keyword === 'user') {
        if (current.user === null) current.user = stripQuotes(value)
      } else if (keyword === 'port') {
        const port = Number.parseInt(stripQuotes(value), 10)
        if (current.port === null && Number.isSafeInteger(port) && port > 0) current.port = port
      } else if (keyword === 'identityfile') {
        current.identityFiles.push(expandToken(value))
      } else if (keyword === 'include') {
        for (const token of splitTokens(value)) {
          const target = expandToken(token)
          const matches = /[*?]/.test(target) ? await globSafe(target) : [target]
          for (const match of matches) await readConfigFile(match, depth + 1)
        }
      }
      // Unknown keywords (IgnoreUnknown, Match, …) are skipped. `Match` blocks
      // are not evaluated: their options are appended to the current host as
      // best-effort defaults, which is safe for probing.
    }
  }

  await readConfigFile(main, 0)
  const list = [...hosts.values()].map(entry => ({
    ...entry,
    identityFiles: entry.identityFiles.filter(file => path.isAbsolute(file)),
  }))
  return platform === 'win32' ? list : list
}

/** Quote one argument for the remote POSIX shell (single-quote wrapping). */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, `'\\''`) + "'"
}

/**
 * Local argv for `ssh` that runs `command` on the host. Options come first,
 * then the destination, then the joined remote command string (OpenSSH joins
 * command operands with spaces, so the remote command is pre-quoted).
 */
export function buildSshArgv({ user = null, host, port = null, identityFiles = [], command }) {
  if (typeof host !== 'string' || host === '' || typeof command !== 'string' || command === '') {
    throw new Error('SSH 目标主机或命令无效。')
  }
  const argv = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
  if (Number.isSafeInteger(port) && port > 0) argv.push('-p', String(port))
  for (const key of identityFiles) {
    if (typeof key === 'string' && key !== '') argv.push('-i', key)
  }
  argv.push(user ? `${user}@${host}` : host, command)
  return argv
}

/**
 * Remote probe command: prints the absolute path of every candidate
 * interpreter found via `command -v`, covering PATH entries and the fixed
 * Termux / common-prefix candidates. POSIX-sh compatible (Termux sshd may run
 * dash/busybox sh for non-login commands).
 */
export function buildRemoteProbeCommand() {
  const candidates = ['python3', 'python', ...FIXED_CANDIDATES]
  const list = candidates.map(shellQuote).join(' ')
  return `for c in ${list}; do p=$(command -v "$c" 2>/dev/null); case "$p" in /*) echo "$p";; esac; done`
}

/** Keep stdout lines that look like absolute interpreter paths; dedupe. */
export function parseProbeOutput(stdout) {
  const seen = new Set()
  const out = []
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('/')) continue
    const base = path.posix.basename(line)
    if (!INTERPRETER_BASENAME.test(base)) continue
    const normalized = line.replace(/\/+/g, '/')
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * Probe one configured host with an injected `run(argv)` async that resolves
 * to `{ exitCode, stdout, stderr }` or throws. Returns
 * `{ ok: true, interpreterPaths }` or `{ ok: false, reason }`.
 */
export async function probeHostPythons(host, run) {
  try {
    const outcome = await run(buildSshArgv({
      user: host.user,
      host: host.hostName && host.hostName !== host.host ? host.hostName : host.host,
      port: host.port,
      identityFiles: host.identityFiles,
      command: buildRemoteProbeCommand(),
    }))
    if (!outcome || typeof outcome.exitCode !== 'number') return { ok: false, reason: 'no-exit' }
    if (outcome.exitCode !== 0) return { ok: false, reason: 'exit-' + outcome.exitCode }
    return { ok: true, interpreterPaths: parseProbeOutput(outcome.stdout) }
  } catch (error) {
    return { ok: false, reason: 'spawn-failed', message: String(error?.message ?? error) }
  }
}

/** Convenience: one host + its interpreter paths → list of env descriptors. */
export function sshEnvironmentRows(host, interpreterPaths) {
  const label = sshHostLabel({ host: host.host, port: host.port })
  const prefix = `ssh://${host.user ? `${host.user}@` : ''}${label}`
  return (interpreterPaths ?? []).map(remotePath => ({
    name: label,
    prefix,
    path: serializeSshUri({ user: host.user, host: host.host, port: host.port, path: remotePath }),
    source: 'ssh',
  }))
}
