import { mkdir, open, readFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { assert, safeId, digest, validatePlan } from './contracts.mjs';

export async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot read state ${file}: ${e.message}`); }
}
export async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await rename(tmp, file);
    const dir = await open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(tmp, { force: true }); }
}
export class Store {
  constructor(common) { this.root = path.join(common, 'project-batch'); this.legacyRoot = path.join(common, 'gitlab-batch'); }
  async assertNoLegacy() {
    for (const directory of ['locks', 'batches']) {
      const location = path.join(this.legacyRoot, directory);
      let names; try { names = await readdir(location); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (directory === 'locks') assert(names.length === 0, `Legacy gitlab-batch lock present: ${location}; preserve it and stop. No migration or takeover.`);
      else for (const name of names.filter(n => n.endsWith('.json'))) {
        const prior = await readJSON(path.join(location, name));
        assert(prior?.state === 'done', `Unfinished legacy gitlab-batch record: ${name}; preserve original data and finish or explicitly retire it outside project-batch.`);
      }
    }
  }
  file(id) { return path.join(this.root, 'batches', `${safeId(id)}.json`); }
  async load(id) {
    const s = await readJSON(this.file(id));
    assert(s?.version === 1 && s.plan?.id === id && s.station === os.hostname(), 'Batch absent, unsupported, or owned by another workstation');
    validatePlan(s.plan);
    assert(s.planHash === digest(s.plan), 'Local plan changed without a confirmed revision');
    return s;
  }
  save(s) { return atomicJSON(this.file(s.plan.id), s); }
  async all() {
    let names; try { names = await readdir(path.join(this.root, 'batches')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.load(n.slice(0, -5))));
  }
  async locked(key, fn, { repository = false } = {}) {
    await this.assertNoLegacy();
    const lock = path.join(this.root, 'locks', `${repository ? 'repository' : 'batch'}-${safeId(key)}`);
    await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
    try { await mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error(`Operation lock held: ${lock}; verify the prior process is inactive and confirm manual lock recovery. No timeout takeover.`); throw e; }
    await atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid, station: os.hostname(), created: new Date().toISOString() });
    try { return await fn(); } finally { await rm(lock, { recursive: true }); }
  }
}
