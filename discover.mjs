import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const isFile = async p => (await fs.stat(p).catch(() => null))?.isFile();

/** Inspect filesystem metadata only. The first (most specific) source wins. */
export async function discover({ env = process.env, cwd = process.cwd(), home = os.homedir(), platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const exe = windows ? ['python.exe'] : ['python3', 'python'];
  const vars = windows ? Object.fromEntries(Object.entries(env).map(([k,v]) => [k.toUpperCase(),v])) : env;
  const key = p => windows ? p.toLowerCase() : p;
  const records = new Map();
  async function add(prefix, source, dirs, names = exe, name = path.basename(prefix)) {
    prefix = path.normalize(prefix);
    if (!path.isAbsolute(prefix) || records.has(key(prefix))) return;
    for (const dir of dirs) for (const file of names) {
      const candidate = path.join(dir, file);
      if (await isFile(candidate)) {
        records.set(key(prefix), {path: candidate, prefix, name: name || prefix, source});
        return;
      }
    }
  }
  const venv = prefix => add(prefix, 'venv', [path.join(prefix, windows ? 'Scripts' : 'bin')]);
  const conda = (prefix, name) => add(prefix, 'conda', [windows ? prefix : path.join(prefix,'bin')], exe, name);
  if (vars.VIRTUAL_ENV) await venv(vars.VIRTUAL_ENV);
  if (vars.CONDA_PREFIX) await conda(vars.CONDA_PREFIX, vars.CONDA_DEFAULT_ENV);
  for (const prefix of [cwd, path.join(cwd,'.venv'), path.join(cwd,'venv')]) {
    if (await isFile(path.join(prefix,'pyvenv.cfg'))) await venv(prefix);
  }
  const list = await fs.readFile(path.join(home,'.conda','environments.txt'),'utf8').catch(() => '');
  const registered = list.split(/\r?\n/).map(line => line.trim()).filter(p => path.isAbsolute(p));
  const roots = new Set();
  for (const parent of [home, ...(windows ? [vars.LOCALAPPDATA, vars.PROGRAMDATA, vars.PROGRAMFILES, vars.LOCALAPPDATA && path.join(vars.LOCALAPPDATA,'Programs')] : [])].filter(Boolean)) {
    for (const dist of ['miniforge3','mambaforge','miniconda3','anaconda3']) roots.add(path.join(parent,dist));
  }
  if (vars.CONDA_EXE && path.isAbsolute(vars.CONDA_EXE)) roots.add(path.dirname(path.dirname(vars.CONDA_EXE)));
  const delim = windows ? ';' : ':';
  const pathDirs = (vars.PATH || '').split(delim).map(s => path.normalize(s.trim().replace(/^"(.*)"$/, '$1'))).filter(p => path.isAbsolute(p));
  const isDir = async p => (await fs.stat(p).catch(() => null))?.isDirectory();
  const candidates = new Set(registered);
  for (const dir of pathDirs) {
    const tail = key(path.basename(dir));
    const parent = path.dirname(dir);
    if (tail === 'condabin' && await isDir(dir)) roots.add(parent);
    else if (windows && tail === 'bin' && key(path.basename(parent)) === 'library') candidates.add(path.dirname(parent));
    else if (tail === (windows ? 'scripts' : 'bin')) candidates.add(parent);
    else candidates.add(dir);
  }
  for (const prefix of candidates) {
    if (await isDir(path.join(prefix,'condabin')) || await isFile(path.join(prefix,'Scripts','conda.exe')) ||
        (await isDir(path.join(prefix,'conda-meta')) && (await isDir(path.join(prefix,'envs')) || await isFile(path.join(prefix,'bin','conda'))))) roots.add(prefix);
    else if (await isDir(path.join(prefix,'conda-meta'))) await conda(prefix);
  }
  const rootKeys = new Set([...roots].map(p => key(path.normalize(p))));
  for (const p of registered) await conda(p, rootKeys.has(key(path.normalize(p))) ? 'base' : undefined);
  for (const root of roots) {
    await conda(root, 'base');
    const row = records.get(key(path.normalize(root)));
    if (row?.source === 'conda') row.name = 'base';
  }
  const envDirs = [...roots].map(root => path.join(root,'envs'));
  envDirs.push(path.join(home,'.conda','envs'), ...(vars.CONDA_ENVS_PATH || '').split(delim).filter(p => path.isAbsolute(p)));
  for (const dir of new Set(envDirs)) {
    const entries = await fs.readdir(dir,{withFileTypes:true}).catch(() => []);
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() || entry.isSymbolicLink()) await conda(path.join(dir,entry.name));
    }
  }
  for (const dir of pathDirs) {
    if (windows && path.basename(dir).toLowerCase() === 'windowsapps') continue;
    const prefix = key(path.basename(dir)) === (windows ? 'scripts' : 'bin') ? path.dirname(dir) : dir;
    const source = await isFile(path.join(prefix,'pyvenv.cfg')) ? 'venv' : 'PATH';
    await add(prefix, source, [dir]);
  }
  return [...records.values()];
}
