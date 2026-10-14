import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { digest } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';
import { permissionCatalog } from '../../skills/in-progress/project-batch/scripts/lib/mysql.mjs';
import { catalogSpec, prepareNativeReader, MySQLDatabase } from '../../skills/in-progress/project-batch/scripts/lib/mysql-catalog.mjs';
export const escapeXML = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const xmlRows = rows => Buffer.from(`<?xml version="1.0"?><resultset statement="SELECT native fixture" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${rows.map(r => `<row>${Object.entries(r).map(([k, v]) => v === null ? `<field name="${escapeXML(k)}" xsi:nil="true" />` : `<field name="${escapeXML(k)}">${escapeXML(v)}</field>`).join('')}</row>`).join('')}</resultset>\n`);
export const frameRow = f => ({ PB_FRAME: Buffer.from(JSON.stringify(f)).toString('hex').toUpperCase() });
export const frameSets = frames => ({ rows: frames.map(frameRow) });
export const blankRow = columns => Object.fromEntries(columns.map(c => [c, null]));
export function nativeTarget() {
  return { id: 'trial', engine: 'mysql', identity: '11111111-2222-3333-4444-555555555555', serverVersion: '8.3.0', scopes: ['app中文', 'scope`quote'], native: {
    version: 1, protocol: 'mysql-cli-v1', client: { path: '/approved/mysql', version: 'mysql  Ver 8.3.0 for Linux on x86_64 (MySQL Community Server - GPL)', sha256: 'a'.repeat(64) },
    endpoint: { host: 'db.example.test', port: 3306, serverUUID: '11111111-2222-3333-4444-555555555555', tlsMode: 'VERIFY_IDENTITY', caFile: '/approved/ca.pem' },
    credentials: { readerFileRef: 'PB_NATIVE_READER_TEST_FILE' }, principal: { user: 'reader', host: '%' },
    reader: { schema: 'control', name: 'read_catalog', definer: { user: 'locked_metadata', host: 'localhost' }, definitionHash: 'b'.repeat(64) },
    authorization: { scope: 'isolated-read-only', evidence: 'Fictional OFFLINE unit-test resource only; never live authority' },
  } };
}
export function permissionFrames(d) {
  const rows = [], user = (a, flags = {}) => ({ ...Object.fromEntries(permissionCatalog[0][1].map(c => [c, c === 'User' ? a.user : c === 'Host' ? a.host : 'N'])), ...flags });
  rows.push({ kind: 'permissions', catalog: 'user', row: user(d.native.principal, d.test ? { Process_priv: 'Y' } : {}) }, { kind: 'permissions', catalog: 'user', row: user(d.native.reader.definer, { account_locked: 'Y', References_priv: 'Y' }) });
  if (d.native.writer) rows.push({ kind: 'permissions', catalog: 'user', row: user(d.native.writer.principal) });
  for (const [a, flags] of [[d.native.principal, ['Select_priv', 'Show_view_priv']], [d.native.reader.definer, ['Select_priv', 'Show_view_priv', 'Trigger_priv', 'Execute_priv', 'Event_priv']]]) for (const s of d.scopes) {
    rows.push({ kind: 'permissions', catalog: 'db', row: { ...Object.fromEntries(permissionCatalog[1][1].map(c => [c, c === 'User' ? a.user : c === 'Host' ? a.host : c === 'Db' ? s.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%') : 'N'])), ...Object.fromEntries(flags.map(c => [c, 'Y'])) } });
  }
  for (const [table, columns] of permissionCatalog) {
    rows.push({ kind: 'permissions', catalog: 'tables_priv', row: { User: d.native.principal.user, Host: d.native.principal.host, Db: 'mysql', Table_name: table, Table_priv: '', Column_priv: 'Select' } });
    for (const column of columns) rows.push({ kind: 'permissions', catalog: 'columns_priv', row: { User: d.native.principal.user, Host: d.native.principal.host, Db: 'mysql', Table_name: table, Column_name: column, Column_priv: 'Select' } });
  }
  rows.push({ kind: 'permissions', catalog: 'procs_priv', row: { User: d.native.principal.user, Host: d.native.principal.host, Db: d.native.reader.schema, Routine_name: d.native.reader.name, Routine_type: 'PROCEDURE', Proc_priv: 'Execute' } });
  for (const a of [d.native.principal, d.native.reader.definer]) rows.push({ kind: 'permissions', catalog: 'global_grants', row: { USER: a.user, HOST: a.host, PRIV: 'SHOW_ROUTINE', WITH_GRANT_OPTION: 'N' } });
  for (const t of d.test?.targets ?? []) rows.push({ kind: 'permissions', catalog: 'tables_priv', row: { User: d.native.writer.principal.user, Host: d.native.writer.principal.host, Db: t.schema, Table_name: t.table, Table_priv: 'Select,Insert,Update,Delete', Column_priv: '' } });
  return rows;
}
export function auditSets(rows) {
  return [frameSets([{ kind: 'audit-begin', version: 1 }]), ...permissionCatalog.flatMap(([catalog]) => [frameSets(rows.filter(r => r.catalog === catalog)), frameSets([{ kind: 'facet-end', catalog }])]), frameSets([{ kind: 'audit-end', version: 1 }])];
}
export function catalogSets(d, rows = [], native = []) {
  const schema = d.scopes.map(s => ({ kind: 'tables', catalog: 'SCHEMATA', row: { SCHEMA_NAME: s, DEFAULT_CHARACTER_SET_NAME: 'utf8mb4', DEFAULT_COLLATION_NAME: 'utf8mb4_0900_ai_ci', DEFAULT_ENCRYPTION: 'NO' } }));
  const binding = { scopeHash: digest(d.scopes), version: 1 };
  return [frameSets([{ kind: 'catalog-begin', ...binding }]), ...catalogSpec().flatMap(([, catalog]) => [frameSets([...schema, ...rows].filter(r => r.catalog === catalog)), frameSets([{ kind: 'facet-end', catalog }])]), ...native.flatMap(n => [frameSets([{ kind: 'native-begin', schema: n.schema, name: n.name, type: n.type }]), { rows: [n.definition] }, frameSets([{ kind: 'native-end', schema: n.schema, name: n.name, type: n.type }])]), frameSets([{ kind: 'catalog-end', ...binding }])];
}
export async function nativeFixture(t, change = () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native mysql offline 中文 ')); t.after(() => rm(dir, { recursive: true, force: true }));
  const d = nativeTarget(), client = path.join(dir, 'mysql'), credential = path.join(dir, 'reader.cnf');
  await writeFile(client, 'offline fake bytes ONLY', { mode: 0o700 }); await writeFile(credential, '[client]\nuser=reader\npassword=DO-NOT-LOG-THIS-OFFLINE-SECRET\n', { mode: 0o600 });
  d.native.client.path = client; d.native.client.sha256 = digest(await readFile(client));
  const previous = process.env.PB_NATIVE_READER_TEST_FILE; process.env.PB_NATIVE_READER_TEST_FILE = credential;
  t.after(() => { if (previous === undefined) delete process.env.PB_NATIVE_READER_TEST_FILE; else process.env.PB_NATIVE_READER_TEST_FILE = previous; });
  const definition = `CREATE DEFINER=\`locked_metadata\`@\`localhost\` PROCEDURE \`read_catalog\`()\nREADS SQL DATA\n${prepareNativeReader(d).body}`;
  d.native.reader.definitionHash = digest(definition);
  const state = { calls: [], definition, identity: { version: '8.3.0', comment: 'MySQL Community Server - GPL', serverUUID: d.identity, principal: 'reader@%', authenticatedUser: 'reader@test-host', mandatoryRoles: '', partialRevokes: '0', lowerCaseNames: '0' }, permissions: permissionFrames(d), catalog: catalogSets(d), observations: [] };
  change(state, d);
  const runner = async (file, args, options) => {
    state.calls.push({ file, args, options });
    if (args.includes('--version')) return Buffer.from(d.native.client.version);
    if (options.input.startsWith('SELECT VERSION')) return xmlRows([state.identity]);
    if (options.input.startsWith('SELECT HEX')) return Buffer.concat(auditSets(state.permissions).map(s => xmlRows(s.rows)));
    if (options.input.startsWith('SHOW CREATE')) return xmlRows([{ Procedure: 'read_catalog', sql_mode: 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES', 'Create Procedure': state.definition, character_set_client: 'utf8mb4', collation_connection: 'utf8mb4_0900_ai_ci', 'Database Collation': 'utf8mb4_0900_ai_ci' }]);
    if (options.input.startsWith('CALL')) return Buffer.concat((typeof state.catalog === 'function' ? state.catalog() : state.catalog).map(s => xmlRows(s.rows)));
    throw new Error('Unexpected OFFLINE query');
  };
  return { dir, d, state, runner, adapter: new MySQLDatabase(d, runner, dir, { record: async r => state.observations.push(r) }) };
}
