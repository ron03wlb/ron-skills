import { randomUUID } from 'node:crypto';
import { assert, digest } from './contracts.mjs';
import { validateLedger, updateLedger } from './fixtures.mjs';
import { literal, frameSQL, jsonSQL } from './mysql.mjs';
import { nativeIdentifier, metadataRows, hexFrame } from './mysql-catalog.mjs';

const name = (schema, table) => `${nativeIdentifier(schema)}.${nativeIdentifier(table)}`;
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const nativeRunHash = run => digest({ id: run.id, purpose: run.purpose, database: run.database, identity: run.identity, planHash: run.planHash, profileHash: run.profileHash, sourceFingerprint: run.sourceFingerprint, commandHash: run.commandHash, sqlPackageHash: run.sqlPackageHash });
function runBound(ledger, run, d) {
  const owned = validateLedger(ledger, run, d);
  assert(d.native?.protocol === 'mysql-cli-v1' && d.test?.isolated === true && ['delivery', 'qualification'].includes(run.purpose), 'Native isolated run/purpose required');
  assert(run.database === d.id && run.identity === d.identity && [run.planHash, run.profileHash, run.sourceFingerprint].every(hash), 'Native run source/target binding missing');
  assert(ledger.native?.version === 1 && ledger.native.runHash === nativeRunHash(run) && ledger.native.targetHash === digest(d.test.targets), 'Native ledger authority changed');
  return owned;
}
// A compilation policy, NOT execution/qualification authority. Its caller must
// supply the actual fresh collector snapshot; no SQL string is a write grant.
export function nativeFixturePolicy(snapshot, d) {
  assert(d.native?.protocol === 'mysql-cli-v1' && d.test?.isolated && snapshot.identity === d.identity && snapshot.serverVersion === d.serverVersion, 'Native fixture metadata identity mismatch');
  for (const f of ['tables', 'columns', 'constraints', 'indexes', 'triggers', 'routines', 'permissions']) assert(snapshot.facets[f] === 'complete', 'Incomplete native fixture visibility');
  const policies = [];
  for (const target of d.test.targets) {
    const table = metadataRows(snapshot, 'TABLES').filter(r => r.TABLE_SCHEMA === target.schema && r.TABLE_NAME === target.table);
    assert(table.length === 1 && table[0].TABLE_TYPE === 'BASE TABLE' && table[0].ENGINE === 'InnoDB', 'Native effects require a proven transactional base table');
    const columns = metadataRows(snapshot, 'COLUMNS').filter(r => r.TABLE_SCHEMA === target.schema && r.TABLE_NAME === target.table);
    assert(columns.length && new Set(columns.map(c => c.COLUMN_NAME)).size === columns.length, 'Missing/duplicate native target columns');
    const groups = new Map();
    for (const r of metadataRows(snapshot, 'STATISTICS').filter(r => r.TABLE_SCHEMA === target.schema && r.TABLE_NAME === target.table && r.NON_UNIQUE === '0')) {
      assert(/^\d+$/.test(r.SEQ_IN_INDEX), 'Unknown native key ordinal'); (groups.get(r.INDEX_NAME) ?? groups.set(r.INDEX_NAME, []).get(r.INDEX_NAME)).push(r);
    }
    const unique = [...groups.values()].some(rows => rows.sort((a, b) => BigInt(a.SEQ_IN_INDEX) < BigInt(b.SEQ_IN_INDEX) ? -1 : 1).every((r, i) => BigInt(r.SEQ_IN_INDEX) === BigInt(i + 1) && r.COLUMN_NAME !== null && r.EXPRESSION === null && r.SUB_PART === null && r.INDEX_TYPE === 'BTREE') && digest(rows.map(r => r.COLUMN_NAME).sort()) === digest([...target.keyColumns].sort()));
    assert(unique && target.keyColumns.every(k => columns.some(c => c.COLUMN_NAME === k && c.IS_NULLABLE === 'NO' && !/(?:VIRTUAL|STORED) GENERATED/.test(c.EXTRA ?? ''))), 'Exact complete nonnullable unique key is not natively proven');
    assert(!metadataRows(snapshot, 'TRIGGERS').some(r => r.EVENT_OBJECT_SCHEMA === target.schema && r.EVENT_OBJECT_TABLE === target.table), 'Trigger effects cannot be proved isolated; native mutation/cleanup blocked');
    assert(!metadataRows(snapshot, 'INCOMING_KEYS').some(r => r.REFERENCED_TABLE_SCHEMA === target.schema && r.REFERENCED_TABLE_NAME === target.table), 'Inbound foreign-key/cascade effects cannot be proved isolated; native mutation/cleanup blocked');
    assert(!metadataRows(snapshot, 'EVENTS').some(r => r.STATUS === 'ENABLED'), 'Enabled scoped events require independent fencing before native effects');
    policies.push({ ...target, columns });
  }
  return { version: 1, database: d.id, identity: d.identity, targets: policies, metadataHash: digest(snapshot) };
}
function targetOf(policy, fixture) {
  const t = policy.targets.find(t => t.schema === fixture.schema && t.table === fixture.table); assert(t, 'Native selector outside approved tables'); return t;
}
function scalar(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') { assert(Number.isSafeInteger(value), 'Native numeric values require lossless strings or safe integers'); return String(value); }
  assert(typeof value === 'string' && [...value].every(c => { const p = c.codePointAt(0); return !(p >= 0xd800 && p <= 0xdfff); }), 'Native values require lossless valid Unicode scalars'); return literal(value);
}
function keyValues(t, key) {
  assert(key && digest(Object.keys(key).sort()) === digest([...t.keyColumns].sort()), 'Native selector must be an exact complete unique key');
  for (const [column, value] of Object.entries(key)) {
    assert(typeof value === 'string' && value.length || Number.isSafeInteger(value), 'Null/empty/generated native identity rejected'); scalar(value);
    const c = t.columns.find(c => c.COLUMN_NAME === column), text = String(value), integer = { tinyint: 8, smallint: 16, mediumint: 24, int: 32, bigint: 64 }[c.DATA_TYPE];
    if (integer) {
      assert(/^-?(?:0|[1-9]\d*)$/.test(text), 'Native integer keys cannot rely on coercion'); const v = BigInt(text), unsigned = /\bunsigned\b/.test(c.COLUMN_TYPE), bits = BigInt(integer);
      assert(v >= (unsigned ? 0n : -(1n << (bits - 1n))) && v < (1n << (unsigned ? bits : bits - 1n)), 'Native integer key outside exact range');
    } else if (['decimal', 'numeric'].includes(c.DATA_TYPE)) {
      assert(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && /^\d+$/.test(c.NUMERIC_SCALE ?? '') && /^\d+$/.test(c.NUMERIC_PRECISION ?? ''), 'Unknown native decimal key semantics');
      const [a, b = ''] = text.replace(/^-/, '').split('.'), p = BigInt(c.NUMERIC_PRECISION), s = BigInt(c.NUMERIC_SCALE);
      assert(p > 0n && p <= 65n && s <= p && BigInt(b.length) <= s && BigInt(a === '0' ? 0 : a.length) <= p - s, 'Native decimal identity would be truncated');
    } else assert(['char', 'varchar', 'binary', 'varbinary'].includes(c.DATA_TYPE) && typeof value === 'string', 'Unsupported exact native key type; no guessed ownership');
  }
  return t.keyColumns.map(k => `${nativeIdentifier(k)} <=> ${scalar(key[k])}`).join(' AND ');
}
export function nativeDataSQL(policy, fixture) {
  const t = targetOf(policy, fixture), where = fixture.key ? ` WHERE ${keyValues(t, fixture.key)}` : '';
  const row = `JSON_OBJECT(${t.columns.map(c => `${literal(c.COLUMN_NAME)}, HEX(CAST(${nativeIdentifier(c.COLUMN_NAME)} AS BINARY))`).join(', ')})`;
  return ["SET SESSION time_zone = '+00:00';", 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;', `SELECT HEX(CAST(${jsonSQL([['kind', "'data-row'"], ['row', row]])} AS CHAR CHARACTER SET utf8mb4)) AS PB_FRAME FROM ${name(t.schema, t.table)}${where} ORDER BY ${t.keyColumns.map(nativeIdentifier).join(', ')};`, `SELECT HEX(CAST(${jsonSQL([['kind', "'data-end'"], ['count', 'CAST(COUNT(*) AS CHAR)']])} AS CHAR CHARACTER SET utf8mb4)) AS PB_FRAME FROM ${name(t.schema, t.table)}${where};`, 'ROLLBACK;'].join('\n') + '\n';
}
export function parseNativeData(sets, policy, fixture) {
  const t = targetOf(policy, fixture); assert(sets.length === 2 && sets[1].rows.length === 1, 'Truncated native data readback');
  const end = hexFrame(sets[1].rows[0]); assert(end.kind === 'data-end' && Object.keys(end).length === 2 && typeof end.count === 'string' && /^\d+$/.test(end.count) && BigInt(end.count) === BigInt(sets[0].rows.length), 'Native data count/readback mismatch');
  const rows = sets[0].rows.map(r => {
    const f = hexFrame(r); assert(f.kind === 'data-row' && Object.keys(f).length === 2 && f.row && digest(Object.keys(f.row).sort()) === digest(t.columns.map(c => c.COLUMN_NAME).sort()), 'Incomplete native row columns');
    assert(Object.values(f.row).every(v => v === null || typeof v === 'string' && /^(?:[0-9A-F]{2})*$/.test(v)), 'Lossy/unknown native row byte encoding'); return f.row;
  });
  assert(!fixture.key || rows.length <= 1, 'Native key was not unique'); return { rows, count: end.count, hash: digest(rows) };
}
export function initializeNativeLedger(file, run, d, binding) {
  return updateLedger(file, ledger => {
    validateLedger(ledger, run, d); assert(!ledger.native && ['delivery', 'qualification'].includes(run.purpose) && [run.planHash, run.profileHash, run.sourceFingerprint, binding.sourceHash, binding.permissionHash, binding.readerDefinitionHash].every(hash), 'Native ledger initialization binding missing/already initialized');
    ledger.native = { version: 1, runHash: nativeRunHash(run), targetHash: digest(d.test.targets), bindingHash: digest(binding), admission: 'open', actors: [], absence: [] }; runBound(ledger, run, d);
  });
}
export function admitNativeActor(file, run, d, owner) {
  return updateLedger(file, ledger => {
    runBound(ledger, run, d); assert(ledger.native.admission === 'open', 'Native writer admission is closed');
    assert(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && /^\d+$/.test(owner.startTime) && /^[a-f0-9-]{36}$/.test(owner.bootId), 'Native actor needs an exact Linux process incarnation, not a reused PID');
    const id = randomUUID(); ledger.native.actors.push({ id, owner, phase: 'admitted' }); return id;
  });
}
export function fenceNativeAdmission(file, run, d) {
  return updateLedger(file, ledger => { runBound(ledger, run, d); assert(['open', 'closed'].includes(ledger.native.admission), 'Unknown admission state'); ledger.native.admission = 'closed'; return { runHash: ledger.native.runHash, actorIds: ledger.native.actors.map(a => a.id).sort() }; });
}
export function reserveNativeIntent(file, run, d, fixture, absence, actorId) {
  return updateLedger(file, ledger => {
    runBound(ledger, run, d); assert(ledger.native.admission === 'open' && ledger.native.actors.some(a => a.id === actorId && a.phase === 'admitted'), 'Unregistered/late native writer');
    assert(fixture && Object.keys(fixture).every(k => ['schema', 'table', 'key'].includes(k)) && absence && Object.keys(absence).every(k => ['count', 'readHash', 'bindingHash', 'selectorHash'].includes(k)), 'Unknown native intent/absence fields');
    const candidate = { ...ledger, intents: [...ledger.intents, { id: randomUUID(), ...fixture }] }; const owned = validateLedger(candidate, run, d), intent = candidate.intents.at(-1);
    assert(absence?.count === '0' && hash(absence.readHash) && absence.bindingHash === ledger.native.bindingHash && absence.selectorHash === digest(owned.selectors.at(-1)), 'Native intent needs complete bound prior key-absence readback');
    ledger.intents.push(intent); ledger.native.absence.push({ ...absence, intentId: intent.id, actorId }); return intent.id;
  });
}
// Compiles only the approved operation grammar. The runner/qualification/settle
// integration remains separate; these return strings, never dispatch native DML.
export function nativeMutationSQL(policy, ledger, run, d, operation) {
  runBound(ledger, run, d);
  assert(operation && Object.keys(operation).every(k => ['kind', 'intentId', 'actorId', 'values'].includes(k)) && ['insert', 'update', 'cleanup'].includes(operation.kind), 'Arbitrary SQL/DDL/unclassified native operation rejected');
  const intent = ledger.intents.find(i => i.id === operation.intentId); assert(intent, 'Native mutation has no exact durable intent');
  const t = targetOf(policy, intent), where = keyValues(t, intent.key), proof = ledger.native.absence.find(p => p.intentId === intent.id);
  assert(proof?.count === '0' && hash(proof.readHash), 'No prior native absence ownership proof');
  let sql;
  if (operation.kind === 'cleanup') {
    assert(ledger.native.admission === 'closed' && Number.isSafeInteger(run.cleanupAttempts) && run.cleanupAttempts > 0 && run.cleanupAttempts <= 3 && operation.values === undefined, 'Cleanup needs closed admission and preconsumed exact retry budget');
    sql = `DELETE FROM ${name(t.schema, t.table)} WHERE ${where}`;
  } else {
    assert(ledger.native.admission === 'open' && proof.actorId === operation.actorId && ledger.native.actors.some(a => a.id === operation.actorId && a.phase === 'admitted'), 'Native writer unregistered/fenced');
    const values = operation.values; assert(values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length, 'Native row values required');
    for (const c of Object.keys(values)) assert(t.columns.some(v => v.COLUMN_NAME === c && !/(?:VIRTUAL|STORED) GENERATED/.test(v.EXTRA ?? '')), 'Unknown/generated native column');
    if (operation.kind === 'insert') {
      assert(t.keyColumns.every(k => Object.hasOwn(values, k) && digest(values[k]) === digest(intent.key[k])), 'Generated/unreserved/changed insert identity');
      sql = `INSERT INTO ${name(t.schema, t.table)} (${Object.keys(values).map(nativeIdentifier).join(', ')}) VALUES (${Object.values(values).map(scalar).join(', ')})`;
    } else {
      assert(ledger.created.some(f => f.intentId === intent.id) && !Object.keys(values).some(c => t.keyColumns.includes(c)), 'Native update cannot adopt unconfirmed rows/change ownership keys');
      sql = `UPDATE ${name(t.schema, t.table)} SET ${Object.entries(values).map(([c, v]) => `${nativeIdentifier(c)} = ${scalar(v)}`).join(', ')} WHERE ${where}`;
    }
  }
  return ["SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO';", "SET SESSION time_zone = '+00:00';", 'START TRANSACTION;', `${sql};`, 'SET @pb_affected = ROW_COUNT();', 'COMMIT;', frameSQL(jsonSQL([['kind', "'committed'"], ['count', 'CAST(@pb_affected AS CHAR)']])), 'SET @pb_affected = NULL;'].join('\n') + '\n';
}
