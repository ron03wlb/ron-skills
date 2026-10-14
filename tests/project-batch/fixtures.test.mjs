import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { atomicJSON, readJSON } from '../../skills/in-progress/project-batch/scripts/lib/store.mjs';
import { validateLedger, loadLedger, recordIntent, recordCreated } from '../../skills/in-progress/project-batch/scripts/lib/fixtures.mjs';

const database = { id: 'test', identity: 'isolated', test: { targets: [{ schema: 'app', table: 'payments', keyColumns: ['requestId'] }] } };
const run = { id: 'run1' }, fixture = { schema: 'app', table: 'payments', key: { requestId: 'run1-fixture' } };
const empty = () => ({ version: 1, testRunId: 'run1', databaseId: 'test', identity: 'isolated', scope: 'owned-test-data', targets: database.test.targets, intents: [], created: [] });
async function ledger(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batch-ledger-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixtures.json'); await atomicJSON(file, empty()); return file;
}
test('durable reserved exact intent precedes created record; crash intent remains reconcilable', async t => {
  const file = await ledger(t), id = await recordIntent(file, fixture);
  let state = await loadLedger(file, run, database); assert.deepEqual(state.intentIds, [id]); assert.equal(state.ledger.created.length, 0);
  // An unknown application response does not lose the reserved unique selector.
  assert.deepEqual(state.selectors, [fixture]);
  await recordCreated(file, id, fixture); state = await loadLedger(file, run, database); assert.equal(state.ledger.created[0].intentId, id);
  await assert.rejects(recordCreated(file, id, fixture), /already journaled/);
});
test('missing, broad, foreign or forged fixture selectors cannot supply deletion authority', () => {
  for (const patch of [{ key: {} }, { table: 'foreign' }, { schema: 'production' }, { key: { guessedPrefix: 'run1' } }]) {
    const l = empty(); l.intents.push({ id: 'i', ...fixture, ...patch }); assert.throws(() => validateLedger(l, run, database));
  }
  const l = empty(); l.created.push({ intentId: 'missing', ...fixture }); assert.throws(() => validateLedger(l, run, database), /prior/);
  l.intents.push({ id: 'missing', ...fixture }); l.created[0].key = { requestId: 'foreign-row' }; assert.throws(() => validateLedger(l, run, database), /reserved/);
  l.created = []; l.intents.push({ id: 'other', ...fixture }); assert.throws(() => validateLedger(l, run, database), /Duplicate fixture selector/);
});
test('intent helper refuses unapproved target/key before any application effect', async t => {
  const file = await ledger(t);
  for (const patch of [{ table: 'foreign' }, { schema: 'production' }, { key: { guessedPrefix: 'run1' } }]) {
    await assert.rejects(recordIntent(file, { ...fixture, ...patch }), /approved/);
    assert.deepEqual(await readJSON(file), empty());
  }
  const changed = empty(); changed.targets = [];
  assert.throws(() => validateLedger(changed, run, database), /targets changed/);
});
test('unresolved ledger writer and symlinked ledger fail closed without lock adoption', async t => {
  const file = await ledger(t); await mkdir(`${file}.lock`);
  await assert.rejects(loadLedger(file, run, database), /writer unresolved/); await assert.rejects(recordIntent(file, fixture), /no automatic lock takeover/);
  assert.deepEqual(await readJSON(file), empty());
  await rm(`${file}.lock`, { recursive: true }); const alias = `${file}.link`; await symlink(file, alias);
  await assert.rejects(loadLedger(alias, run, database), /regular/); await assert.rejects(recordIntent(alias, fixture), /regular/);
});
