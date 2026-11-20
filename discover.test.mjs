import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover } from './discover.mjs';

for (const windows of process.platform === 'win32' ? [true] : [true,false]) test(`filesystem discovery (${windows ? 'Windows' : 'POSIX'} layout)`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'discover-python-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const p = (...parts) => path.join(root,...parts);
  async function file(filename, data = 'not an executable') {
    await fs.mkdir(path.dirname(filename), {recursive:true});
    await fs.writeFile(filename,data);
    return filename;
  }
  const py = windows ? 'python.exe' : 'python3';
  const bin = windows ? 'Scripts' : 'bin';
  const condaBin = windows ? '' : 'bin';
  const base = p('home','miniforge3');
  const cwd = p('project');
  const paths = [await file(p('project','.venv',bin,py)), await file(p('environments','registered',condaBin,py)), await file(path.join(base,condaBin,py)), await file(path.join(base,'envs','lab',condaBin,py)), await file(p('system','bin',py))];
  await file(p('project','.venv','pyvenv.cfg'));
  await file(p('home','.conda','environments.txt'), `\uFEFF${p('environments','registered')}\r\n${p('stale')}\r\n`);
  const dirs = paths.map(x => `"${path.dirname(x)}"`);
  if (windows) { await file(p('WindowsApps',py)); dirs.push(p('WindowsApps')); }
  const env = { [windows ? 'Path' : 'PATH']: dirs.join(windows ? ';' : ':') };
  const rows = await discover({platform: windows ? 'win32' : 'linux',cwd,home:p('home'),env});
  assert.deepEqual(rows.map(r => r.path),paths);
  assert.deepEqual(rows.map(r => r.source),['venv','conda','conda','conda','PATH']);
  assert.deepEqual(rows.map(r => r.name),['.venv','registered','base','lab',windows ? 'bin' : 'system']);
  assert.deepEqual(rows[0].prefix,p('project','.venv'));
});

test('custom Conda installation from each Windows PATH layout; registered base keeps its name', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'conda-path-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const base = path.join(dir,'custom');
  const child = path.join(base,'envs','analytics');
  for (const part of ['condabin','Scripts','Library/bin','conda-meta','envs/analytics']) await fs.mkdir(path.join(base,part),{recursive:true});
  for (const prefix of [base,child]) await fs.writeFile(path.join(prefix,'python.exe'),'stub');
  await fs.mkdir(path.join(dir,'.conda'));
  for (const part of ['condabin','Scripts','Library/bin','']) {
    const options = {cwd:dir, home:dir, platform:'win32', env:{Path:path.join(base,part)}};
    for (const registration of ['',base]) {
      await fs.writeFile(path.join(dir,'.conda','environments.txt'),registration);
      const rows = await discover(options);
      assert.deepEqual(rows.map(r => [r.prefix,r.name]),[[base,'base'],[child,'analytics']],part);
    }
  }
});

test('discover({cwd}) finds a venv under the specified project directory', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(),'project-venv-'));
  t.after(() => fs.rm(cwd,{recursive:true,force:true}));
  const prefix = path.join(cwd,'.venv');
  const dir = path.join(prefix,process.platform === 'win32' ? 'Scripts' : 'bin');
  const executable = path.join(dir,process.platform === 'win32' ? 'python.exe' : 'python3');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(executable,'stub');
  await fs.writeFile(path.join(prefix,'pyvenv.cfg'),'');
  assert.deepEqual((await discover({cwd})).find(row => row.prefix === prefix),{prefix,path:executable,name:'.venv',source:'venv'});
});
