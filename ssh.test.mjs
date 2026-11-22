import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildRemoteProbeCommand,
  buildSshArgv,
  isSshSelection,
  parseProbeOutput,
  parseSshConfig,
  parseSshUri,
  probeHostPythons,
  serializeSshUri,
  shellQuote,
  sshEnvironmentRows,
  sshHostLabel,
} from './ssh.mjs'

test('parseSshUri accepts canonical forms and rejects non-python basenames', () => {
  assert.deepEqual(parseSshUri('ssh://host/usr/bin/python3'), { user: null, host: 'host', port: null, path: '/usr/bin/python3' })
  assert.deepEqual(parseSshUri('ssh://root@10.0.0.2:2222/data/data/com.termux/files/usr/bin/python'), {
    user: 'root',
    host: '10.0.0.2',
    port: 2222,
    path: '/data/data/com.termux/files/usr/bin/python',
  })
  assert.equal(parseSshUri('ssh://host/usr/bin/bash'), null)
  assert.equal(parseSshUri('http://host/python3'), null)
  assert.equal(parseSshUri('ssh://host'), null)
  assert.equal(parseSshUri(''), null)
  assert.equal(parseSshUri(null), null)
})

test('serializeSshUri round-trips through parseSshUri', () => {
  const uri = 'ssh://deploy@box.example:2222/opt/py310/bin/python3.10'
  assert.equal(serializeSshUri(parseSshUri(uri)), uri)
  assert.equal(isSshSelection('  SSH://host/python3 '), true)
  assert.equal(isSshSelection('C:\\python\\python.exe'), false)
})

test('shellQuote keeps remote arguments literal', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote('print(1)'), `'print(1)'`)
  assert.equal(shellQuote('a b; rm -rf /'), `'a b; rm -rf /'`)
})

test('buildSshArgv orders options, destination, and the joined command', () => {
  const argv = buildSshArgv({
    user: 'root',
    host: 'box',
    port: 2200,
    identityFiles: ['C:/keys/id_ed25519'],
    command: `'python3' '-c' 'print(1)'`,
  })
  assert.deepEqual(argv, [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-p', '2200',
    '-i', 'C:/keys/id_ed25519',
    'root@box',
    `'python3' '-c' 'print(1)'`,
  ])
  assert.deepEqual(buildSshArgv({ host: 'box', command: 'true' }), ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'box', 'true'])
  assert.throws(() => buildSshArgv({ host: '', command: 'true' }))
})

test('parseSshConfig reads hosts, skips wildcards, honors Include, and dedupes aliases', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pem-ssh-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const sshDir = path.join(home, '.ssh')
  await fs.mkdir(path.join(sshDir, 'config.d'), { recursive: true })
  await fs.writeFile(path.join(sshDir, 'config.d', 'extra.conf'), [
    'Host cloud1',
    '  HostName 1.2.3.4',
    '  User deploy',
    '  Port 2222',
    '  IdentityFile ~/.ssh/cloud_key',
  ].join('\n'))
  await fs.writeFile(path.join(sshDir, 'config'), [
    '# comment',
    'Host cloud1',
    '  User overridden-by-first-block', // first block wins for the alias
    '',
    'Host * !cloud2',
    '  Compression yes',
    '',
    'Host cloud2',
    `Include ${path.join(sshDir, 'config.d', 'extra.conf').replace(/\\/g, '/')}`,
    '  HostName cloud2.internal',
  ].join('\n'))

  const hosts = await parseSshConfig({ home })
  assert.deepEqual(hosts.map(h => h.host), ['cloud1', 'cloud2'])
  const cloud1 = hosts.find(h => h.host === 'cloud1')
  // First block wins per option: the main file's User stays, and the Include
  // inside cloud2 still merges its unset cloud1 options (HostName/Port/Key).
  assert.equal(cloud1.user, 'overridden-by-first-block')
  assert.equal(cloud1.hostName, '1.2.3.4')
  assert.equal(cloud1.port, 2222)
  assert.deepEqual(cloud1.identityFiles, [path.join(home, '.ssh', 'cloud_key')])
  const cloud2 = hosts.find(h => h.host === 'cloud2')
  assert.equal(cloud2.hostName, 'cloud2.internal')
  assert.deepEqual(cloud2.identityFiles, [])
})

test('a missing or empty config yields no hosts', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pem-ssh-empty-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  assert.deepEqual(await parseSshConfig({ home }), [])
})

test('parseProbeOutput keeps only absolute python paths, deduplicated', () => {
  assert.deepEqual(
    parseProbeOutput('/usr/bin/python3\nrelative/python\n/usr/bin/python3\n/usr/bin/python3.12\n/data/data/com.termux/files/usr/bin/python\nbash\n/usr/bin/'), 
    ['/usr/bin/python3', '/usr/bin/python3.12', '/data/data/com.termux/files/usr/bin/python'],
  )
})

test('probeHostPythons parses interpreter paths from a fake run', async () => {
  const calls = []
  const outcome = await probeHostPythons(
    { host: 'box', hostName: 'box.internal', user: 'root', port: 22, identityFiles: [] },
    async argv => {
      calls.push(argv)
      return { exitCode: 0, stdout: '/usr/bin/python3\n', stderr: '' }
    },
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.interpreterPaths, ['/usr/bin/python3'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 6), ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p'])
  assert.equal(calls[0][7], 'root@box.internal')

  const failed = await probeHostPythons({ host: 'down', hostName: 'down', user: null, port: null, identityFiles: [] }, async () => ({ exitCode: 255, stdout: '', stderr: '' }))
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'exit-255')
})

test('buildRemoteProbeCommand includes Termux candidates and quotes safely', () => {
  const command = buildRemoteProbeCommand()
  assert.match(command, /python3/)
  assert.match(command, /\/data\/data\/com\.termux\/files\/usr\/bin\/python/)
  // Every candidate is wrapped in single quotes, so no value can break out of
  // the quoting despite the command's own $( ) substitution.
  for (const candidate of ['python3', 'python', '/data/data/com.termux/files/usr/bin/python3']) {
    assert.ok(command.includes(`'${candidate}'`), `candidate must be single-quoted: ${candidate}`)
  }
})

test('sshEnvironmentRows builds selectable descriptors', () => {
  const rows = sshEnvironmentRows({ host: 'box', user: 'root', port: 2222 }, ['/usr/bin/python3', '/usr/bin/python3.12'])
  assert.deepEqual(rows.map(r => r.path), [
    'ssh://root@box:2222/usr/bin/python3',
    'ssh://root@box:2222/usr/bin/python3.12',
  ])
  assert.deepEqual(rows.map(r => [r.name, r.source]), [['box:2222', 'ssh'], ['box:2222', 'ssh']])
  assert.equal(sshHostLabel({ host: 'box', port: null }), 'box')
})
