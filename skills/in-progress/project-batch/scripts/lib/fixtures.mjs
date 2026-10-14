import { mkdir, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assert, digest } from './contracts.mjs';
import { readJSON, atomicJSON } from './store.mjs';

function selector(f) {
  assert(f && typeof f.schema === 'string' && f.schema && typeof f.table === 'string' && f.table, 'Exact fixture schema/table required');
  assert(f.key && typeof f.key === 'object' && !Array.isArray(f.key) && Object.keys(f.key).length > 0, 'Exact fixture key required; no broad selector');
  assert(Object.entries(f.key).every(([k, v]) => k && (typeof v === 'string' && v || typeof v === 'number' && Number.isSafeInteger(v))), 'Fixture keys must be nonempty lossless scalar identities');
  return { schema: f.schema, table: f.table, key: Object.fromEntries(Object.entries(f.key).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}
function approvedSelector(f, targets) {
  assert(Array.isArray(targets), 'Missing approved fixture targets');
  const value = selector(f), target = targets.find(t => t.schema === value.schema && t.table === value.table);
  assert(target && Array.isArray(target.keyColumns) && digest([...target.keyColumns].sort()) === digest(Object.keys(value.key).sort()), 'Fixture ledger selector outside approved unique-key targets');
  return value;
}
export function validateLedger(ledger, run, database) {
  assert(ledger?.version === 1 && ledger.testRunId === run.id && ledger.databaseId === database.id && ledger.identity === database.identity && ledger.scope === 'owned-test-data', 'Fixture ledger identity mismatch');
  assert(Array.isArray(ledger.intents) && Array.isArray(ledger.created), 'Fixture ledger intents and exact created identities required');
  assert(Array.isArray(ledger.targets) && digest(ledger.targets) === digest(database.test.targets), 'Fixture ledger approved targets changed');
  const ids = new Map(), keys = new Set();
  for (const intent of ledger.intents) {
    assert(typeof intent.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(intent.id) && !ids.has(intent.id), 'Invalid/duplicate fixture intent');
    const value = approvedSelector(intent, database.test.targets);
    const key = digest(value); assert(!keys.has(key), 'Duplicate fixture selector'); keys.add(key); ids.set(intent.id, value);
  }
  const completed = new Set();
  for (const fixture of ledger.created) {
    assert(typeof fixture.intentId === 'string' && ids.has(fixture.intentId) && !completed.has(fixture.intentId), 'Created fixture missing prior unique durable intent');
    assert(digest(selector(fixture)) === digest(ids.get(fixture.intentId)), 'Created fixture does not match reserved exact intent'); completed.add(fixture.intentId);
  }
  return { ledger, hash: digest(ledger), intentIds: [...ids.keys()].sort(), selectors: [...ids.values()] };
}
export async function loadLedger(file, run, database) {
  const info = await lstat(file); assert(info.isFile() && !info.isSymbolicLink(), 'Fixture ledger must be a regular owned evidence file');
  try { await lstat(`${file}.lock`); throw new Error('Fixture ledger writer unresolved; no cleanup'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return validateLedger(await readJSON(file), run, database);
}
export async function updateLedger(file, fn) {
  const lock = `${file}.lock`;
  try { await mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Fixture ledger writer unresolved; no automatic lock takeover'); throw e; }
  try {
    const info = await lstat(file); assert(info.isFile() && !info.isSymbolicLink(), 'Fixture ledger must be a regular evidence file');
    const ledger = await readJSON(file); assert(ledger?.version === 1 && Array.isArray(ledger.intents) && Array.isArray(ledger.created), 'Invalid fixture ledger');
    const result = await fn(ledger); await atomicJSON(file, ledger); return result;
  } finally { await rm(lock, { recursive: true }); }
}
// Await this durable intent BEFORE the application call. The approved key is a
// pre-existing unique application identity (or pre-reserved PK), never a broad prefix.
// Generated-only identities need a project-specific safe reservation/reconciliation
// bridge; do not claim ownership from a response that might be lost after creation.
export function recordIntent(file, fixture) {
  return updateLedger(file, ledger => {
    assert(!ledger.native, 'Native fixtures require the native absence/admission guard');
    const value = approvedSelector(fixture, ledger.targets), id = randomUUID();
    assert(!ledger.intents.some(i => digest(selector(i)) === digest(value)), 'Duplicate fixture intent');
    ledger.intents.push({ id, ...value }); return id;
  });
}
export function recordCreated(file, intentId, fixture) {
  return updateLedger(file, ledger => {
    assert(!ledger.native, 'Native creation requires the registered native writer receipt');
    const intent = ledger.intents.find(i => i.id === intentId);
    assert(intent && digest(selector(intent)) === digest(selector(fixture)), 'Fixture creation lacks exact prior intent');
    assert(!ledger.created.some(i => i.intentId === intentId), 'Fixture creation already journaled');
    ledger.created.push({ intentId, ...selector(fixture) }); return intentId;
  });
}
