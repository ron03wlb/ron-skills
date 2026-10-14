import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';
import { MySQLPreflight, validateNative } from '../../skills/in-progress/project-batch/scripts/lib/mysql.mjs';
import { nativeIdentifier, grantSchema, prepareNativeReader, permissionSQL, parsePermissionSets, provePermissions, mandatoryAccounts, catalogSpec, parseCatalogSets, catalogSnapshot, normalizeNative, MySQLDatabase } from '../../skills/in-progress/project-batch/scripts/lib/mysql-catalog.mjs';
import { nativeTarget, nativeFixture, permissionFrames, auditSets, catalogSets, blankRow, frameSets, xmlRows } from './mysql-native-helpers.mjs';
import { DatabaseGate } from '../../skills/in-progress/project-batch/scripts/lib/database.mjs';
import { readJSON } from '../../skills/in-progress/project-batch/scripts/lib/store.mjs';

function oneTable(d, name = 't', definition = 'CREATE TABLE `t` (\n  `id` bigint NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4') {
  const make = (catalog, data) => { const spec = catalogSpec().find(([, n]) => n === catalog); return { kind: spec[0], catalog, row: { ...blankRow(spec[3]), ...data } }; };
  const rows = [make('TABLES', { TABLE_SCHEMA: d.scopes[0], TABLE_NAME: name, TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', ROW_FORMAT: 'Dynamic', TABLE_COLLATION: 'utf8mb4_0900_ai_ci', CREATE_OPTIONS: '', TABLE_COMMENT: '中文\n\t' }), make('COLUMNS', { TABLE_SCHEMA: d.scopes[0], TABLE_NAME: name, COLUMN_NAME: 'id', ORDINAL_POSITION: '1', IS_NULLABLE: 'NO', DATA_TYPE: 'bigint', COLUMN_TYPE: 'bigint', NUMERIC_PRECISION: '18446744073709551615.123456', NUMERIC_SCALE: '0', EXTRA: '' })];
  const native = [{ schema: d.scopes[0], name, type: 'TABLE', definition: { Table: name, 'Create Table': definition } }];
  return { rows, native, sets: catalogSets(d, rows, native) };
}

test('new protocol is explicit; offline human SQL package covers native definitions, visibility and pre-CALL audit without DML dispatch', () => {
  const d = nativeTarget(); d.scopes.push('scope_under%score', 'schema\n\t中文'); validateNative(d);
  const p = prepareNativeReader(d); assert.equal(p.protocol, 'mysql-cli-v1'); assert.equal(p.qualified, false); assert.equal(p.executable, false); assert.equal(p.sqlHash, digest(p.sql));
  assert.match(p.sql, /CREATE USER 'locked_metadata'@'localhost' ACCOUNT LOCK/); assert.match(p.sql, /GRANT REFERENCES ON \*\.\* TO 'locked_metadata'/);
  assert.match(p.sql, /GRANT SELECT \(`User`, `Host`, `account_locked`/); assert.match(p.body, /PREPARE native_show FROM @pb_native_show/);
  assert.match(p.body, /show_gipk_in_create_table_and_information_schema = ON/); assert.match(p.body, /INCOMING_KEYS/); assert.match(p.body, /information_schema\.`EVENTS`/);
  assert.doesNotMatch(p.body, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\s/i); assert.doesNotMatch(p.sql, /authentication_string|IDENTIFIED BY|PASSWORD\s*=/i);
  assert.equal(grantSchema('scope_under%score'), '`scope\\_under\\%score`'); assert.equal(nativeIdentifier('中文`\n\t'), '`中文``\n\t`');
  for (const name of ['', 'a\0b', '\ud800', '😀']) assert.throws(() => nativeIdentifier(name));
  const old = nativeTarget(); delete old.native.protocol; assert.throws(() => prepareNativeReader(old), /Explicit/);
});

test('direct permission audit selects every known non-secret column and proves bounded effective role closure', () => {
  const d = nativeTarget(), frames = permissionFrames(d), audit = parsePermissionSets(auditSets(frames));
  const proof = provePermissions(audit, d, { partialRevokes: '0', mandatoryRoles: '' });
  assert.equal(proof.checks[1].locked, 'Y'); assert.equal(proof.hash, digest(proof.checks));
  assert.match(permissionSQL(), /FROM mysql\.`role_edges`/); assert.match(permissionSQL(), /FROM mysql\.`default_roles`/); assert.doesNotMatch(permissionSQL(), /authentication_string/);
  const role = { ...frames.find(f => f.catalog === 'user').row, User: 'safe_role', Host: '%', account_locked: 'Y' };
  frames.push({ kind: 'permissions', catalog: 'user', row: role }, { kind: 'permissions', catalog: 'role_edges', row: { FROM_USER: 'safe_role', FROM_HOST: '%', TO_USER: 'reader', TO_HOST: '%', WITH_ADMIN_OPTION: 'N' } });
  assert.equal(provePermissions(frames, d, { partialRevokes: '0', mandatoryRoles: '' }).checks[0].closure.length, 2);
  assert.equal(provePermissions(frames, d, { partialRevokes: '0', mandatoryRoles: "'safe_role'@'%'" }).checks[1].closure.length, 2);
  role.Super_priv = 'Y'; assert.throws(() => provePermissions(frames, d, { partialRevokes: '0', mandatoryRoles: '' }), /Dangerous/);
});

test('native permission proof refuses unlocked/missing definers, unknown privileges and missing direct visibility even with matching stored hashes', () => {
  const d = nativeTarget();
  for (const mutate of [
    f => { f.find(f => f.catalog === 'user' && f.row.User === 'locked_metadata').row.account_locked = 'N'; },
    f => { f.find(f => f.catalog === 'user' && f.row.User === 'locked_metadata').row.References_priv = 'N'; },
    f => { f.find(f => f.catalog === 'db' && f.row.User === 'locked_metadata').row.Trigger_priv = 'N'; },
    f => { f.find(f => f.catalog === 'db' && f.row.User === 'reader').row.Drop_priv = 'Y'; },
    f => { f.find(f => f.catalog === 'global_grants').row.PRIV = 'SESSION_VARIABLES_ADMIN'; },
    f => { f.find(f => f.catalog === 'columns_priv').row.Column_name = 'authentication_string'; },
    f => { f.find(f => f.catalog === 'tables_priv').row.Table_priv = 'Select'; },
    f => { f.splice(f.findIndex(f => f.catalog === 'user' && f.row.User === 'locked_metadata'), 1); },
  ]) { const f = permissionFrames(d); mutate(f); assert.throws(() => provePermissions(f, d, { partialRevokes: '0', mandatoryRoles: '' })); }
  assert.throws(() => provePermissions(permissionFrames(d), d, { partialRevokes: '1', mandatoryRoles: '' }), /Partial-revoke/);
  assert.throws(() => provePermissions(permissionFrames(d), d, { partialRevokes: '0', mandatoryRoles: "'missing'@'%'" }), /missing/);
});

test('role cycles, dangling defaults, grant option and default/mandatory high privilege paths fail closed', () => {
  const d = nativeTarget(), source = permissionFrames(d), user = source.find(f => f.catalog === 'user').row;
  const role = { ...user, User: 'unsafe', Host: '%', account_locked: 'Y' };
  const edge = { FROM_USER: 'unsafe', FROM_HOST: '%', TO_USER: 'reader', TO_HOST: '%', WITH_ADMIN_OPTION: 'N' };
  const f = [...source, { kind: 'permissions', catalog: 'user', row: role }, { kind: 'permissions', catalog: 'role_edges', row: edge }];
  role.Insert_priv = 'Y'; assert.throws(() => provePermissions(f, d, { partialRevokes: '0', mandatoryRoles: '' }), /Dangerous/);
  role.Insert_priv = 'N'; edge.WITH_ADMIN_OPTION = 'Y'; assert.throws(() => provePermissions(f, d, { partialRevokes: '0', mandatoryRoles: '' }), /delegation/);
  edge.WITH_ADMIN_OPTION = 'N'; f.push({ kind: 'permissions', catalog: 'role_edges', row: { FROM_USER: 'reader', FROM_HOST: '%', TO_USER: 'unsafe', TO_HOST: '%', WITH_ADMIN_OPTION: 'N' } });
  assert.throws(() => provePermissions(f, d, { partialRevokes: '0', mandatoryRoles: '' }), /cycle/);
  assert.throws(() => mandatoryAccounts('guess@%'), /grammar/); assert.deepEqual(mandatoryAccounts("'role'@'%', `other`@`localhost`"), [{ user: 'role', host: '%' }, { user: 'other', host: 'localhost' }]);
});

test('permission framing refuses missing, reordered, unknown, truncated and numeric/hidden fields', () => {
  const d = nativeTarget(), sets = auditSets(permissionFrames(d));
  for (const s of [sets.slice(1), sets.slice(0, -1), sets.filter((_, i) => i !== 2), [sets[0], ...sets.slice(3), sets[1], sets[2]]]) assert.throws(() => parsePermissionSets(s));
  const f = permissionFrames(d); f[0].row.Super_priv = 1; assert.throws(() => parsePermissionSets(auditSets(f)), /non-lossless/);
});

test('full catalog proves empty facets and complete native table/column identity without numeric coercion', () => {
  const d = nativeTarget(), proof = provePermissions(permissionFrames(d), d, { partialRevokes: '0', mandatoryRoles: '' });
  const empty = parseCatalogSets(catalogSets(d), d); assert.equal(empty.native.length, 0);
  const data = oneTable(d), parsed = parseCatalogSets(data.sets, d), snapshot = catalogSnapshot(parsed, d, proof);
  assert.equal(parsed.rows.find(f => f.catalog === 'COLUMNS').row.NUMERIC_PRECISION, '18446744073709551615.123456');
  assert.equal(snapshot.facets.columns, 'complete'); assert.equal(snapshot.facets.sequences, 'not-applicable'); assert.equal(snapshot.readerReadOnly, true);
  assert.doesNotMatch(parsed.native[0].definition['Create Table'], /AUTO_INCREMENT=9/);
});

test('native catalog rejects hidden definitions/columns, unsupported kinds/clauses and wrong scope or facet termination', () => {
  const d = nativeTarget(), data = oneTable(d);
  for (const transform of [s => s.slice(1), s => s.slice(0, -1), s => s.filter((_, i) => i !== 3), s => [...s, frameSets([{ kind: 'catalog-end', version: 1, scopeHash: digest(d.scopes) }])]]) assert.throws(() => parseCatalogSets(transform(data.sets), d));
  const hidden = data.rows.filter(f => f.catalog !== 'COLUMNS'); assert.throws(() => parseCatalogSets(catalogSets(d, hidden, data.native), d), /columns/);
  const unknown = structuredClone(data.rows); unknown.find(f => f.catalog === 'COLUMNS').row.DATA_TYPE = 'futuretype'; assert.throws(() => parseCatalogSets(catalogSets(d, unknown, data.native), d), /type/);
  const future = structuredClone(data.native); future[0].definition['Create Table'] += ' UNKNOWN_OPTION=1'; assert.throws(() => parseCatalogSets(catalogSets(d, data.rows, future), d), /Unknown native table clause/);
  const absent = structuredClone(data.native); absent[0].definition['Create Table'] = null; assert.throws(() => parseCatalogSets(catalogSets(d, data.rows, absent), d), /Hidden/);
});

test('normalization excludes only live AUTO_INCREMENT option, preserving literal data, column attributes and versioned partition clauses', () => {
  const a = "CREATE TABLE `t` (`id` bigint AUTO_INCREMENT, `note` varchar(20) DEFAULT 'AUTO_INCREMENT=1  中文') ENGINE=InnoDB AUTO_INCREMENT=99 DEFAULT CHARSET=utf8mb4 COMMENT='two  spaces'";
  const b = a.replace('AUTO_INCREMENT=99', 'AUTO_INCREMENT=18446744073709551615');
  assert.equal(normalizeNative('TABLE', a), normalizeNative('TABLE', b));
  assert.match(normalizeNative('TABLE', a), /DEFAULT 'AUTO_INCREMENT=1  中文'/); assert.match(normalizeNative('TABLE', a), /COMMENT='two  spaces'/); assert.match(normalizeNative('TABLE', a), /bigint AUTO_INCREMENT/);
  assert.match(normalizeNative('TABLE', a + ' /*!50100 PARTITION BY HASH (`id`) PARTITIONS 2 */'), /PARTITION BY/);
  for (const text of [a + ' ZORP=1', a + ' /*!50100 UNKNOWN_SQL */', a + ' AUTO_INCREMENT=garbage', "CREATE TABLE `t` (`id` int COMMENT 'unclosed)"]) assert.throws(() => normalizeNative('TABLE', text));
});

test('native doctor performs independent audit BEFORE every CALL, retains raw bytes and cannot qualify writes', async t => {
  const f = await nativeFixture(t), result = await f.adapter.doctor();
  assert.equal(result.readerExecution, 'native-audited'); assert.equal(result.permissionAudit, 'native-role-closure'); assert.equal(result.ready, true); assert.equal(result.qualified, false);
  const sql = f.state.calls.map(c => c.options.input).filter(Boolean); assert.equal(sql.filter(s => s.startsWith('CALL')).length, 2);
  for (let i = 0; i < sql.length; i++) if (sql[i].startsWith('CALL')) { assert.match(sql[i - 1], /^SHOW CREATE/); assert.match(sql[i - 2], /audit-begin/); }
  assert(f.state.observations.length >= 11); assert(f.state.observations.every(r => r.rawHash === digest(Buffer.from(r.rawBase64, 'base64'))));
  assert.equal(JSON.stringify(f.state.observations).includes('DO-NOT-LOG-THIS-OFFLINE-SECRET'), false);
});

for (const [name, mutate] of [
  ['unlocked definer', s => { s.permissions.find(f => f.catalog === 'user' && f.row.User === 'locked_metadata').row.account_locked = 'N'; }],
  ['global write privilege', s => { s.permissions.find(f => f.catalog === 'user' && f.row.User === 'locked_metadata').row.Create_priv = 'Y'; }],
  ['identity', s => { s.identity.serverUUID = 'foreign'; }], ['role invisibility', s => { s.permissions.splice(s.permissions.findIndex(f => f.catalog === 'user'), 1); }],
  ['source definition', s => { s.definition += '\n'; }], ['partial revokes', s => { s.identity.partialRevokes = '1'; }],
]) test(`native collector refuses ${name} before CALL`, async t => {
  const f = await nativeFixture(t, mutate); await assert.rejects(f.adapter.collect()); assert.equal(f.state.calls.some(c => c.options.input?.startsWith('CALL')), false);
});

test('native collector detects between-collection schema changes, never returning a partial/qualified snapshot', async t => {
  const f = await nativeFixture(t); let count = 0;
  f.state.catalog = () => { count++; return count === 1 ? catalogSets(f.d) : oneTable(f.d).sets; };
  await assert.rejects(f.adapter.collect(), /catalog changed/); assert.equal(count, 2);
});

test('public preflight statement override cannot expand the dispatch SQL allowlist', async t => {
  const f = await nativeFixture(t), adapter = new MySQLPreflight(f.d, f.runner, f.dir, { nativeReadPolicy: () => true });
  adapter.statements = () => ({ arbitrary: 'DROP TABLE `app中文`.`t`;\n' }); const connection = await adapter.connection();
  await assert.rejects(adapter.query('DROP TABLE `app中文`.`t`;\n', connection), /guard rejects/); assert.equal(f.state.calls.length, 0);
});

test('explicit protocol is connected to doctor evidence but never unlocks planning or schema qualification', async t => {
  const f = await nativeFixture(t), gate = new DatabaseGate({ databases: [f.d] }, f.runner, f.dir, f.dir);
  const [result] = await gate.doctor(), record = await readJSON(result.evidence);
  assert.equal(result.readerExecution, 'native-audited'); assert.equal(result.qualified, false); assert.equal(record.status, 'native-read-only'); assert(record.observations.length >= 11);
  await assert.rejects(gate.observe(), /Native MySQL qualification blocked/);
});

test('complete unique-key absence is obtained from native bytes, with fresh native authority/schema checks around the read-only transaction', async t => {
  const f = await nativeFixture(t), d = structuredClone(f.d);
  d.native.credentials.writerFileRef = 'PB_NATIVE_WRITER_TEST_FILE';
  d.native.writer = { principal: { user: 'writer', host: '%' }, hookScript: 'writer.mjs', settleScript: 'settle.mjs' };
  d.test = { isolated: true, targets: [{ schema: d.scopes[0], table: 't', keyColumns: ['id'] }] };
  f.state.permissions = permissionFrames(d); const data = oneTable(d), spec = catalogSpec().find(([, n]) => n === 'STATISTICS');
  data.rows.push({ kind: spec[0], catalog: 'STATISTICS', row: { ...blankRow(spec[3]), TABLE_SCHEMA: d.scopes[0], TABLE_NAME: 't', NON_UNIQUE: '0', INDEX_SCHEMA: d.scopes[0], INDEX_NAME: 'PRIMARY', SEQ_IN_INDEX: '1', COLUMN_NAME: 'id', INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' } });
  f.state.catalog = catalogSets(d, data.rows, data.native);
  const queries = [], runner = async (file, args, opts) => {
    if (opts.input?.startsWith('SET SESSION time_zone')) { queries.push(opts.input); return Buffer.concat([xmlRows([]), xmlRows(frameSets([{ kind: 'data-end', count: '0' }]).rows)]); }
    return f.runner(file, args, opts);
  };
  const reader = new MySQLDatabase(d, runner, f.dir), fixture = { schema: d.scopes[0], table: 't', key: { id: '9223372036854775807' } }, result = await reader.readTarget(fixture);
  assert.equal(result.count, '0'); assert.equal(result.qualified, false); assert.equal(result.selectorHash, digest(fixture)); assert.equal(queries.length, 1); assert.match(queries[0], /READ ONLY/);
  assert.throws(() => { reader.d = d; }); assert.throws(() => { reader.d.scopes.push('other'); });
  await assert.rejects(reader.readTarget({ ...fixture, table: 'unapproved' }), /outside approved/); assert.equal(queries.length, 1);
});

test('failed native transport retains partial raw stdout, never stderr credentials, before refusing incomplete reads', async t => {
  const f = await nativeFixture(t), observations = [], bytes = Buffer.from([0xc3, 0x28]);
  const runner = async (_file, args) => { if (args.includes('--version')) return Buffer.from(f.d.native.client.version); throw Object.assign(new Error('DO-NOT-LOG-THIS-OFFLINE-SECRET'), { stdout: bytes, stderr: Buffer.from('DO-NOT-LOG-THIS-OFFLINE-SECRET') }); };
  await assert.rejects(new MySQLDatabase(f.d, runner, f.dir, { record: async r => observations.push(r) }).doctor(), /diagnostics withheld/);
  assert.equal(observations[0].status, 'transport-failed'); assert.equal(observations[0].rawHash, digest(bytes)); assert.equal(Buffer.from(observations[0].rawBase64, 'base64').equals(bytes), true);
  assert.equal(JSON.stringify(observations).includes('DO-NOT-LOG-THIS-OFFLINE-SECRET'), false);
});
