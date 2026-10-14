import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { atomicJSON, readJSON } from '../../skills/in-progress/project-batch/scripts/lib/store.mjs';
import { digest } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';
import { recordIntent, recordCreated, updateLedger } from '../../skills/in-progress/project-batch/scripts/lib/fixtures.mjs';
import { nativeFixturePolicy, nativeDataSQL, parseNativeData, initializeNativeLedger, admitNativeActor, fenceNativeAdmission, reserveNativeIntent, nativeMutationSQL } from '../../skills/in-progress/project-batch/scripts/lib/mysql-fixtures.mjs';
import { nativeTarget, frameSets } from './mysql-native-helpers.mjs';
const h = 'a'.repeat(64);
function fixtureData() {
  const d = nativeTarget(); d.test = { isolated: true, targets: [{ schema: d.scopes[0], table: 't中文`', keyColumns: ['id'] }] };
  const column = (name, type) => ({ TABLE_SCHEMA: d.scopes[0], TABLE_NAME: 't中文`', COLUMN_NAME: name, DATA_TYPE: type, COLUMN_TYPE: type, IS_NULLABLE: 'NO', EXTRA: '' });
  const rows = [
    ['TABLES', { TABLE_SCHEMA: d.scopes[0], TABLE_NAME: 't中文`', TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB' }],
    ['COLUMNS', column('id', 'bigint')], ['COLUMNS', column("label'\n\t", 'varchar')],
    ['STATISTICS', { TABLE_SCHEMA: d.scopes[0], TABLE_NAME: 't中文`', INDEX_NAME: 'PRIMARY', SEQ_IN_INDEX: '1', NON_UNIQUE: '0', COLUMN_NAME: 'id', EXPRESSION: null, SUB_PART: null, INDEX_TYPE: 'BTREE' }],
  ];
  const snapshot = { identity: d.identity, serverVersion: d.serverVersion, facets: Object.fromEntries(['tables', 'columns', 'constraints', 'indexes', 'triggers', 'routines', 'permissions'].map(f => [f, 'complete'])), objects: rows.map(([catalog, row], i) => ({ name: String(i), definition: { catalog, row } })) };
  return { d, snapshot, selector: { schema: d.scopes[0], table: 't中文`', key: { id: '9223372036854775807' } } };
}
async function stateFixture(t) {
  const f = fixtureData(), dir = await mkdtemp(path.join(os.tmpdir(), 'native ledger guards ')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json'), run = { id: 'offline-run', purpose: 'qualification', database: f.d.id, identity: f.d.identity, planHash: h, profileHash: h, sourceFingerprint: h, commandHash: h, sqlPackageHash: h, ledger: file };
  await atomicJSON(file, { version: 1, testRunId: run.id, databaseId: f.d.id, identity: f.d.identity, scope: 'owned-test-data', targets: f.d.test.targets, intents: [], created: [] });
  const binding = { sourceHash: h, permissionHash: h, readerDefinitionHash: h };
  await initializeNativeLedger(file, run, f.d, binding);
  const actor = await admitNativeActor(file, run, f.d, { pid: 12345, startTime: '987654321', bootId: '11111111-2222-3333-4444-555555555555' });
  const absence = { count: '0', readHash: h, bindingHash: digest(binding), selectorHash: digest(f.selector) };
  const intent = await reserveNativeIntent(file, run, f.d, f.selector, absence, actor);
  return { ...f, file, run, actor, intent, policy: nativeFixturePolicy(f.snapshot, f.d) };
}

test('native fixture policy requires full transactional unique keys and blocks triggers/cascades/events rather than guessing cleanup isolation', () => {
  const f = fixtureData(); assert.equal(nativeFixturePolicy(f.snapshot, f.d).targets.length, 1);
  for (const alter of [
    s => { s.objects.find(o => o.definition.catalog === 'TABLES').definition.row.ENGINE = 'MyISAM'; },
    s => { s.objects.find(o => o.definition.catalog === 'STATISTICS').definition.row.SUB_PART = '8'; },
    s => { s.objects.find(o => o.definition.catalog === 'COLUMNS').definition.row.IS_NULLABLE = 'YES'; },
    s => { s.facets.constraints = 'not-applicable'; },
    s => { s.objects.push({ definition: { catalog: 'TRIGGERS', row: { EVENT_OBJECT_SCHEMA: f.selector.schema, EVENT_OBJECT_TABLE: f.selector.table } } }); },
    s => { s.objects.push({ definition: { catalog: 'INCOMING_KEYS', row: { REFERENCED_TABLE_SCHEMA: f.selector.schema, REFERENCED_TABLE_NAME: f.selector.table } } }); },
    s => { s.objects.push({ definition: { catalog: 'EVENTS', row: { STATUS: 'ENABLED' } } }); },
  ]) { const copy = structuredClone(f.snapshot); alter(copy); assert.throws(() => nativeFixturePolicy(copy, f.d)); }
});

test('native key/data compilation preserves bytes and escapes identifiers/JSON keys without arbitrary SQL', () => {
  const f = fixtureData(), p = nativeFixturePolicy(f.snapshot, f.d), sql = nativeDataSQL(p, f.selector);
  assert.match(sql, /READ ONLY/); assert.match(sql, /`t中文```/); assert.match(sql, /`id` <=> _utf8mb4 X/); assert.match(sql, /_utf8mb4 X'6c6162656c270a09'/); assert.match(sql, /HEX\(CAST\(`label'\n\t` AS BINARY\)\)/);
  for (const id of ['9223372036854775808', '1.23', '01', '1 OR 1=1', null, '', 1.23]) assert.throws(() => nativeDataSQL(p, { ...f.selector, key: { id } }));
  const data = [frameSets([{ kind: 'data-row', row: { id: '39323233333732303336383534373735383037', "label'\n\t": 'E4B8ADE69687F09F9880000A09' } }]), frameSets([{ kind: 'data-end', count: '1' }])];
  assert.equal(parseNativeData(data, p, f.selector).count, '1');
  for (const sets of [data.slice(0, 1), [data[0], frameSets([{ kind: 'data-end', count: '0' }])], [frameSets([{ kind: 'data-row', row: { id: '0F' } }]), data[1]]]) assert.throws(() => parseNativeData(sets, p, f.selector));
});

test('native intent/actor/fence transitions use the existing durable ledger and reject late/unregistered writers and legacy helpers', async t => {
  const f = await stateFixture(t);
  await assert.rejects(recordIntent(f.file, { ...f.selector, key: { id: '2' } }), /native absence/);
  await assert.rejects(recordCreated(f.file, f.intent, f.selector), /registered native/);
  await assert.rejects(reserveNativeIntent(f.file, f.run, f.d, { ...f.selector, key: { id: '2' } }, { count: '0', readHash: h, bindingHash: h, selectorHash: h }, 'unregistered'), /Unregistered/);
  await fenceNativeAdmission(f.file, f.run, f.d); await fenceNativeAdmission(f.file, f.run, f.d);
  await assert.rejects(admitNativeActor(f.file, f.run, f.d, { pid: 123, startTime: '1', bootId: '11111111-2222-3333-4444-555555555555' }), /closed/);
  const ledger = await readJSON(f.file); assert.equal(ledger.native.admission, 'closed');
  assert.throws(() => nativeMutationSQL(f.policy, ledger, f.run, f.d, { kind: 'insert', actorId: f.actor, intentId: f.intent, values: { id: f.selector.key.id } }), /fenced/);
});

test('native operation compiler refuses SQL/DDL, unreserved identities, generated keys, key changes and cleanup without consumed budget', async t => {
  const f = await stateFixture(t), ledger = await readJSON(f.file), insert = { kind: 'insert', actorId: f.actor, intentId: f.intent, values: { id: f.selector.key.id, "label'\n\t": "中文😀'\n\t\\\0" } };
  const sql = nativeMutationSQL(f.policy, ledger, f.run, f.d, insert); assert.match(sql, /INSERT INTO `app中文`\.`t中文```/); assert.match(sql, /NO_AUTO_VALUE_ON_ZERO/); assert.doesNotMatch(sql, /中文😀/); assert.match(sql, /ROW_COUNT\(\)/);
  for (const op of [ { kind: 'sql', sql: 'DROP TABLE t' }, { ...insert, sql: 'ALTER TABLE t' }, { ...insert, intentId: 'absent' }, { ...insert, actorId: 'other' }, { ...insert, values: { id: '1' } }, { ...insert, values: { id: f.selector.key.id, bad: 0 } }, { kind: 'update', actorId: f.actor, intentId: f.intent, values: { id: '2' } }, { kind: 'cleanup', intentId: f.intent } ]) assert.throws(() => nativeMutationSQL(f.policy, ledger, f.run, f.d, op));
  await fenceNativeAdmission(f.file, f.run, f.d); const closed = await readJSON(f.file);
  for (const cleanupAttempts of [undefined, 0, 4]) assert.throws(() => nativeMutationSQL(f.policy, closed, { ...f.run, cleanupAttempts }, f.d, { kind: 'cleanup', intentId: f.intent }));
  const removal = nativeMutationSQL(f.policy, closed, { ...f.run, cleanupAttempts: 1 }, f.d, { kind: 'cleanup', intentId: f.intent }); assert.match(removal, /DELETE FROM `app中文`\.`t中文``` WHERE `id` <=> _utf8mb4 X/); assert.doesNotMatch(removal, /TRUNCATE|LIKE|DELETE FROM[^;]+;[^;]*DELETE/);
});

test('async native ledger changes are durably awaited, with locks retained until mutation completes', async t => {
  const f = await stateFixture(t);
  await updateLedger(f.file, async ledger => { await Promise.resolve(); ledger.native.note = 'after await'; });
  assert.equal((await readJSON(f.file)).native.note, 'after await');
  await assert.rejects(initializeNativeLedger(f.file, f.run, f.d, { sourceHash: h, permissionHash: h, readerDefinitionHash: h }), /already initialized/);
});
