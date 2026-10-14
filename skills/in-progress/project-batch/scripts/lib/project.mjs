import path from 'node:path';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { assert, digest, safeId, confirmation } from './contracts.mjs';
import { readJSON, atomicJSON } from './store.mjs';
import { validateNative, nativeSourceHashes } from './mysql.mjs';

export const profilePath = '.project-batch/project.json';
export const engines = new Set(['mysql', 'mariadb', 'postgresql', 'sqlserver', 'oracle', 'sqlite', 'db2']);
export function command(c) {
  assert(c && typeof c.file === 'string' && c.file && !c.file.startsWith('-') && Array.isArray(c.args) && c.args.every(a => typeof a === 'string'), 'Command requires executable and argument array');
  assert(Object.keys(c).every(k => ['file', 'args', 'timeoutMs', 'envRefs', 'effect', 'database'].includes(k)), 'Unknown command field; never store credentials');
  for (const argument of c.args) {
    assert(!/(?:^|[\s;])(?:--?(?:password|passwd|pwd|token|secret)(?:[=\s]|$)|(?:password|passwd|pwd|token|secret)\s*[:=])/i.test(argument), 'Credentials belong in environment references, not arguments');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(argument)) {
      let u; try { u = new URL(argument); } catch { throw new Error('Invalid command URL'); }
      assert(!u.username && !u.password, 'Credential-bearing command URL forbidden');
    }
  }
  assert(c.timeoutMs === undefined || Number.isSafeInteger(c.timeoutMs) && c.timeoutMs > 0, 'Invalid command timeout');
  assert(c.envRefs === undefined || c.envRefs && !Array.isArray(c.envRefs) && Object.entries(c.envRefs).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(v)), 'Use environment variable names, never credential values');
  return c;
}
export function validateProfile(p) {
  assert(p?.version === 1, 'ProjectProfile version must be 1'); safeId(p.id);
  assert(Object.keys(p).every(k => ['version', 'id', 'repositoryBase', 'targetBranch', 'tracker', 'standards', 'databases'].includes(k)), 'Unknown project field; credentials belong only in environment references');
  assert(typeof p.targetBranch === 'string' && p.targetBranch && !p.targetBranch.startsWith('-'), 'Target branch required');
  assert(typeof p.repositoryBase === 'string' && /^[a-f0-9]{40,64}$/.test(p.repositoryBase), 'Repository baseline commit required');
  assert(['github', 'gitlab', 'local'].includes(p.tracker?.provider), 'Choose one tracker: github, gitlab or local');
  assert(Object.keys(p.tracker).every(k => ['provider', 'origin', 'projectPath', 'projectId', 'remote'].includes(k)), 'Unknown tracker field; never persist credentials');
  if (p.tracker.provider === 'local') assert(p.tracker.origin === `local://${p.id}` && p.tracker.projectPath === p.id && p.tracker.projectId === p.id, 'Local binding must use this project identity');
  else {
    let u; try { u = new URL(p.tracker.origin); } catch { throw new Error('Invalid tracker origin'); }
    assert(['https:', 'http:'].includes(u.protocol) && u.origin === p.tracker.origin && !u.username && !u.password, 'Credential-free tracker origin required');
    assert(p.tracker.provider !== 'github' || u.protocol === 'https:', 'GitHub requires HTTPS');
    assert(typeof p.tracker.projectPath === 'string' && /^[^/\s]+(?:\/[^/\s]+)+$/.test(p.tracker.projectPath) && !p.tracker.projectPath.includes('..'), 'Complete tracker project path required');
    assert(p.tracker.provider !== 'github' || p.tracker.projectPath.split('/').length === 2, 'GitHub requires owner/repository');
    assert(Number.isSafeInteger(p.tracker.projectId) && p.tracker.projectId > 0, 'Read-back numeric project identity required');
  }
  assert(Array.isArray(p.standards) && p.standards.length > 0 && p.standards.every(relativePath), 'Declare repository standards paths');
  assert(Array.isArray(p.databases), 'Declare databases explicitly, including [] for no database');
  const ids = new Set();
  for (const d of p.databases) {
    safeId(d.id); assert(!ids.has(d.id), 'Duplicate database identity'); ids.add(d.id);
    assert(Object.keys(d).every(k => ['id', 'engine', 'identity', 'serverVersion', 'scopes', 'inspectScript', 'inspect', 'test', 'native'].includes(k)), 'Unknown database field; never store credentials');
    assert(engines.has(d.engine) && typeof d.identity === 'string' && d.identity && typeof d.serverVersion === 'string' && d.serverVersion, 'Database engine, identity and exact version required');
    assert(Array.isArray(d.scopes) && d.scopes.length && d.scopes.every(s => typeof s === 'string' && s) && new Set(d.scopes).size === d.scopes.length, 'Application schema scopes required');
    if (d.native) {
      assert(d.inspect === undefined && d.inspectScript === undefined, 'Native MySQL cannot fallback to a custom inspector');
      validateNative(d);
    } else {
      command(d.inspect);
      assert(typeof d.inspectScript === 'string' && relativePath(d.inspectScript), 'Pin the repository-owned read-only inspector source');
    }
    if (d.test) {
      assert(Object.keys(d.test).every(k => ['isolated', 'ownership', 'schemaWrites', 'cleanup', 'cleanupScript', 'leftovers', 'leftoversScript', 'targets'].includes(k)), 'Unknown test field; never store credentials');
      assert(d.test.isolated === true && d.test.ownership === 'test-run-id' && d.test.schemaWrites === false, 'Tests require isolated DB, run-scoped ownership and no schema writes');
      assert(Array.isArray(d.test.targets) && d.test.targets.length > 0, 'Declare approved exact fixture targets and unique keys');
      const targets = new Set();
      for (const t of d.test.targets) {
        assert(t && Object.keys(t).every(k => ['schema', 'table', 'keyColumns'].includes(k)) && d.scopes.includes(t.schema) && typeof t.table === 'string' && t.table, 'Invalid fixture target');
        assert(Array.isArray(t.keyColumns) && t.keyColumns.length && t.keyColumns.every(k => typeof k === 'string' && k) && new Set(t.keyColumns).size === t.keyColumns.length, 'Fixture target needs exact unique-key columns');
        const key = JSON.stringify([t.schema, t.table]); assert(!targets.has(key), 'Duplicate fixture target'); targets.add(key);
      }
      command(d.test.cleanup); command(d.test.leftovers);
      assert(relativePath(d.test.cleanupScript) && relativePath(d.test.leftoversScript), 'Pin cleanup and read-only leftover inspector sources');
    }
  }
  return p;
}
export function relativePath(p) { return typeof p === 'string' && p && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0'); }
export async function sourceHashes(cwd, profile) {
  const entries = [];
  for (const file of [...new Set([...profile.standards, ...profile.databases.flatMap(d => [...(d.native ? [d.native.writer?.hookScript, d.native.writer?.settleScript, d.native.qualification].filter(Boolean) : [d.inspectScript]), ...(d.test ? [d.test.cleanupScript, d.test.leftoversScript] : [])])])].sort()) {
    const absolute = await realpath(path.join(cwd, file));
    assert(absolute.startsWith(await realpath(cwd) + path.sep), 'Profile source escapes repository');
    entries.push({ path: file, hash: digest(await readFile(absolute)) });
  }
  if (profile.databases.some(d => d.native)) entries.push(...await nativeSourceHashes());
  return entries;
}
async function profileLocation(cwd) {
  const directory = path.join(cwd, path.dirname(profilePath));
  try { assert((await lstat(directory)).isDirectory(), 'Profile directory must not be a symlink'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const file = path.join(cwd, profilePath);
  try { assert((await lstat(file)).isFile(), 'Profile must be a regular file, not a symlink'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return file;
}
export async function loadProfile(cwd, required = false) {
  const p = await readJSON(await profileLocation(cwd));
  assert(p || !required, `Initialize ${profilePath} once with init before planning`);
  return p ? validateProfile(p) : null;
}
export async function saveProfile(cwd, p, confirm) {
  validateProfile(p);
  const prior = await loadProfile(cwd);
  const preview = confirmation('init', { previous: prior ? digest(prior) : null, profile: p, sources: await sourceHashes(cwd, p) }, confirm);
  if (!confirm) return preview;
  await atomicJSON(await profileLocation(cwd), p);
  return { initialized: p.id, path: profilePath, profileHash: digest(p), next: 'Review and commit this credential-free profile using project conventions. No automatic commit.' };
}
export function commandEnvironment(c, extra = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [name, ref] of Object.entries(c.envRefs ?? {})) {
    assert(process.env[ref] !== undefined, `Missing credential/environment reference: ${ref}`);
    env[name] = process.env[ref];
  }
  return { ...env, ...extra };
}
export function redact(text, c) {
  let out = String(text);
  for (const ref of Object.values(c.envRefs ?? {})) if (process.env[ref]) out = out.split(process.env[ref]).join('[REDACTED]');
  return out;
}
