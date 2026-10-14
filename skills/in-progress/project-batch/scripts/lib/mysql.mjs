import path from 'node:path';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { assert, digest, safeId } from './contracts.mjs';
import { prepareNativeReader, nativeIdentifier } from './mysql-catalog.mjs';

// Deliberately not a certification flag. Native delivery is closed until the
// catalog and writer/settlement conformance implementation has real evidence.
export const nativeBlockers = [
  'Legacy preflight cannot CALL; the explicit mysql-cli-v1 audited collector has offline coverage but no approved live conformance',
  'Native effect/admission compilers are not a connected, qualified writer/session-settlement/cleanup pipeline',
  'Native foreign-sentinel verification and qualification state-machine integration remain unfinished',
  'Human SQL receipt and live server/client/profile-bound qualification are required',
];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (v, names, label) => assert(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => names.includes(k)), `Unknown ${label} field; never embed credentials`);
const account = a => {
  fields(a, ['user', 'host'], 'MySQL account');
  assert(typeof a.user === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(a.user) && typeof a.host === 'string' && /^[A-Za-z0-9_.%:-]{1,255}$/.test(a.host), 'Explicit MySQL user/host required');
};
export const identifier = value => {
  assert(typeof value === 'string' && value.length > 0 && [...value].length <= 64 && [...value].every(c => c.codePointAt(0) <= 0xffff) && !/[\u0000-\u001f\u007f]/.test(value) && !/[\uD800-\uDFFF]/u.test(value), 'Invalid MySQL identifier');
  return '`' + value.replaceAll('`', '``') + '`';
};
export const literal = value => `_utf8mb4 X'${Buffer.from(value, 'utf8').toString('hex')}'`;
export const accountSQL = a => `'${a.user}'@'${a.host}'`;
export function nativeVersion(version, comment) {
  assert(typeof version === 'string' && /^8\.[123]\.\d+(?:-[A-Za-z0-9_.-]+)?$/.test(version) && typeof comment === 'string' && /^MySQL (?:Community|Enterprise) Server(?: - (?:GPL|Commercial))?$/.test(comment), 'Only native MySQL 8.1–8.3 is in scope; compatible products/other versions stop');
  return version;
}
export function validateNative(d, { preparing = false } = {}) {
  fields(d, ['id', 'engine', 'identity', 'serverVersion', 'scopes', 'native', 'test'], 'native database');
  const n = d.native; safeId(d.id);
  assert(Array.isArray(d.scopes) && d.scopes.length && new Set(d.scopes).size === d.scopes.length, 'Explicit unique native MySQL schemas required');
  const system = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
  assert(d.scopes.every(s => typeof s === 'string' && !system.has(s.toLowerCase()) && (n?.protocol === 'mysql-cli-v1' || !/[%_\\\\]/.test(s))), 'Application scopes cannot be MySQL system schemas or privilege wildcard/backslash names (not yet supported)');
  assert(d.engine === 'mysql', 'Native configuration currently supports only MySQL');
  fields(n, ['version', 'protocol', 'client', 'endpoint', 'credentials', 'reader', 'principal', 'writer', 'authorization', 'qualification'], 'native MySQL');
  assert(n.version === 1, 'Native MySQL profile version must be 1; no automatic upgrades');
  assert(n.protocol === undefined || n.protocol === 'mysql-cli-v1', 'Unknown native MySQL protocol; no automatic upgrades');
  fields(n.client, ['path', 'sha256', 'version'], 'MySQL client');
  assert(path.isAbsolute(n.client.path ?? '') && sha(n.client.sha256) && typeof n.client.version === 'string' && /^.+\bVer 8\.[123]\.\d+\b.*\bMySQL\b.*$/.test(n.client.version), 'Pin absolute native mysql client path, full version and byte hash');
  fields(n.endpoint, ['host', 'port', 'serverUUID', 'tlsMode', 'caFile'], 'MySQL endpoint');
  assert(typeof n.endpoint.host === 'string' && /^[A-Za-z0-9_.:-]+$/.test(n.endpoint.host) && Number.isSafeInteger(n.endpoint.port) && n.endpoint.port > 0 && n.endpoint.port <= 65535 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(n.endpoint.serverUUID ?? ''), 'Explicit isolated MySQL TCP endpoint/server UUID required');
  assert(n.endpoint.tlsMode === 'VERIFY_IDENTITY' && path.isAbsolute(n.endpoint.caFile ?? ''), 'Native MySQL requires explicit VERIFY_IDENTITY CA path');
  fields(n.credentials, ['readerFileRef', 'writerFileRef'], 'MySQL credential references');
  assert(typeof n.credentials.readerFileRef === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(n.credentials.readerFileRef) && (n.credentials.writerFileRef === undefined || /^[A-Z_][A-Z0-9_]*$/.test(n.credentials.writerFileRef)), 'Use environment names referencing owner-only mysql option files, not secrets');
  account(n.principal);
  fields(n.reader, ['schema', 'name', 'definer', 'definitionHash'], 'MySQL reader');
  const quoteIdentifier = n.protocol === 'mysql-cli-v1' ? nativeIdentifier : identifier;
  quoteIdentifier(n.reader.schema); quoteIdentifier(n.reader.name); account(n.reader.definer);
  assert(!system.has(n.reader.schema.toLowerCase()), 'Use an existing non-system control schema');
  assert(sha(n.reader.definitionHash) || preparing && n.reader.definitionHash === undefined, 'Reader definition hash required (hash of exact SHOW CREATE definition, not consent)');
  assert(d.scopes.every(s => { quoteIdentifier(s); return s !== n.reader.schema; }), 'Reader must live in a named existing control schema outside application scopes');
  assert(d.scopes.length <= 32, 'At most 32 fixed MySQL reader scopes');
  assert(d.serverVersion && /^8\.[123]\.\d+(?:-[A-Za-z0-9_.-]+)?$/.test(d.serverVersion), 'Native profile binds runtime-discovered exact MySQL 8.1–8.3 version');
  assert(d.identity === n.endpoint.serverUUID, 'Native database identity must be the read-back server UUID');
  fields(n.authorization, ['scope', 'evidence'], 'MySQL authorization');
  assert(n.authorization.scope === 'isolated-read-only' && typeof n.authorization.evidence === 'string' && n.authorization.evidence.trim(), 'Named nonproduction read-only resource authorization required; does not authorize DML');
  if (n.writer) {
    fields(n.writer, ['principal', 'hookScript', 'settleScript'], 'MySQL writer'); account(n.writer.principal);
    for (const f of [n.writer.hookScript, n.writer.settleScript]) assert(typeof f === 'string' && f && !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..') && !f.includes('\0'), 'Pin repository-owned writer/settle sources');
  }
  assert(!d.test || n.writer && n.credentials.writerFileRef, 'Native test configuration requires distinct writer principal and credential reference');
  const principals = [n.principal, n.reader.definer, ...(n.writer ? [n.writer.principal] : [])].map(a => `${a.user}@${a.host}`);
  assert(new Set(principals).size === principals.length, 'Reader, locked definer and writer principals must be distinct');
  assert(n.qualification === undefined || typeof n.qualification === 'string' && n.qualification && !path.isAbsolute(n.qualification) && !n.qualification.split(/[\\/]/).includes('..') && !n.qualification.includes('\0'), 'Qualification is an evidence reference, never certified:true');
  return n;
}

// A deliberately narrow XML grammar for mysql --xml output, not a general XML
// parser. No DTD/entity expansion, CDATA, comments, permissive repair or lossy UTF8.
function decode(value) {
  assert(!/[<>]/.test(value), 'Unexpected markup in MySQL XML value');
  return value.replace(/&[^;]*;|&/g, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const m = entity.match(/^&#(x[0-9a-f]+|[0-9]+);$/i);
    assert(m, 'Unknown MySQL XML entity');
    const code = m[1][0].toLowerCase() === 'x' ? parseInt(m[1].slice(1), 16) : Number(m[1]);
    assert(code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), 'Invalid MySQL XML code point');
    return String.fromCodePoint(code);
  });
}
export function parseXML(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Invalid MySQL client UTF8'); }
  const sets = [];
  while (text.trim()) {
    const m = text.match(/^\s*<\?xml version="1\.0"\?>\s*<resultset statement="([^"<>]*)" xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance">([\s\S]*?)<\/resultset>/);
    assert(m, 'Malformed/truncated MySQL XML resultset');
    const rows = []; let body = m[2];
    while (body.trim()) {
      const r = body.match(/^\s*<row>([\s\S]*?)<\/row>/); assert(r, 'Malformed MySQL XML row');
      let rest = r[1]; const row = {};
      while (rest.trim()) {
        const f = rest.match(/^\s*<field name="([^"<>]*)"(?:>([^<]*)<\/field>| xsi:nil="true"\s*\/>)/);
        assert(f, 'Malformed MySQL XML field'); const name = decode(f[1]);
        assert(!Object.hasOwn(row, name), 'Duplicate MySQL XML field');
        Object.defineProperty(row, name, { value: f[2] === undefined ? null : decode(f[2]), enumerable: true });
        rest = rest.slice(f[0].length);
      }
      rows.push(row); body = body.slice(r[0].length);
    }
    sets.push({ statement: decode(m[1]), rows }); text = text.slice(m[0].length);
  }
  assert(sets.length, 'Empty MySQL client result'); return sets;
}
function one(sets, keys) {
  assert(sets.length === 1 && sets[0].rows.length === 1, 'Expected exactly one MySQL readback row');
  const row = sets[0].rows[0]; assert(digest(Object.keys(row).sort()) === digest([...keys].sort()), 'Unexpected MySQL readback fields'); return row;
}
export const frameSQL = payload => `SELECT HEX(CAST(${payload} AS CHAR CHARACTER SET utf8mb4)) AS PB_FRAME;`;
export const jsonSQL = pairs => `JSON_OBJECT(${pairs.map(([k, v]) => `'${k}', ${v}`).join(', ')})`;

// Candidate metadata reader: no parameters, only literal scope/account predicates,
// no PREPARE, CALL, DML, DDL or caller-provided identifier in its body. Catalog rows
// are hex framed and every native value is a string/null. Native SHOW CREATE and
// consistency collection remain a separate explicit blocker, not fake coverage.
export const catalog = [
  ['tables', 'TABLES', 'TABLE_SCHEMA', ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'ENGINE', 'ROW_FORMAT', 'TABLE_COLLATION', 'CREATE_OPTIONS', 'TABLE_COMMENT']],
  ['columns', 'COLUMNS', 'TABLE_SCHEMA', ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'COLUMN_DEFAULT', 'IS_NULLABLE', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH', 'CHARACTER_OCTET_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'DATETIME_PRECISION', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'COLUMN_TYPE', 'COLUMN_KEY', 'EXTRA', 'COLUMN_COMMENT', 'GENERATION_EXPRESSION', 'SRS_ID']],
  ['constraints', 'TABLE_CONSTRAINTS', 'TABLE_SCHEMA', ['CONSTRAINT_SCHEMA', 'TABLE_SCHEMA', 'TABLE_NAME', 'CONSTRAINT_NAME', 'CONSTRAINT_TYPE', 'ENFORCED']],
  ['constraints', 'KEY_COLUMN_USAGE', 'TABLE_SCHEMA', ['CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'POSITION_IN_UNIQUE_CONSTRAINT', 'REFERENCED_TABLE_SCHEMA', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME']],
  ['constraints', 'REFERENTIAL_CONSTRAINTS', 'CONSTRAINT_SCHEMA', ['CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'UNIQUE_CONSTRAINT_SCHEMA', 'UNIQUE_CONSTRAINT_NAME', 'MATCH_OPTION', 'UPDATE_RULE', 'DELETE_RULE', 'TABLE_NAME', 'REFERENCED_TABLE_NAME']],
  ['constraints', 'CHECK_CONSTRAINTS', 'CONSTRAINT_SCHEMA', ['CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'CHECK_CLAUSE']],
  ['indexes', 'STATISTICS', 'TABLE_SCHEMA', ['TABLE_SCHEMA', 'TABLE_NAME', 'NON_UNIQUE', 'INDEX_SCHEMA', 'INDEX_NAME', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'COLLATION', 'SUB_PART', 'PACKED', 'NULLABLE', 'INDEX_TYPE', 'COMMENT', 'INDEX_COMMENT', 'IS_VISIBLE', 'EXPRESSION']],
  ['views', 'VIEWS', 'TABLE_SCHEMA', ['TABLE_SCHEMA', 'TABLE_NAME', 'VIEW_DEFINITION', 'CHECK_OPTION', 'IS_UPDATABLE', 'DEFINER', 'SECURITY_TYPE', 'CHARACTER_SET_CLIENT', 'COLLATION_CONNECTION']],
  ['triggers', 'TRIGGERS', 'TRIGGER_SCHEMA', ['TRIGGER_SCHEMA', 'TRIGGER_NAME', 'EVENT_MANIPULATION', 'EVENT_OBJECT_SCHEMA', 'EVENT_OBJECT_TABLE', 'ACTION_ORDER', 'ACTION_CONDITION', 'ACTION_STATEMENT', 'ACTION_ORIENTATION', 'ACTION_TIMING', 'SQL_MODE', 'DEFINER', 'CHARACTER_SET_CLIENT', 'COLLATION_CONNECTION', 'DATABASE_COLLATION']],
  ['routines', 'ROUTINES', 'ROUTINE_SCHEMA', ['ROUTINE_SCHEMA', 'ROUTINE_NAME', 'ROUTINE_TYPE', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH', 'CHARACTER_OCTET_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'DATETIME_PRECISION', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'DTD_IDENTIFIER', 'ROUTINE_BODY', 'ROUTINE_DEFINITION', 'EXTERNAL_LANGUAGE', 'PARAMETER_STYLE', 'IS_DETERMINISTIC', 'SQL_DATA_ACCESS', 'SQL_PATH', 'SECURITY_TYPE', 'SQL_MODE', 'ROUTINE_COMMENT', 'DEFINER', 'CHARACTER_SET_CLIENT', 'COLLATION_CONNECTION', 'DATABASE_COLLATION']],
  ['routines', 'PARAMETERS', 'SPECIFIC_SCHEMA', ['SPECIFIC_SCHEMA', 'SPECIFIC_NAME', 'ORDINAL_POSITION', 'PARAMETER_MODE', 'PARAMETER_NAME', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH', 'CHARACTER_OCTET_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'DATETIME_PRECISION', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'DTD_IDENTIFIER', 'ROUTINE_TYPE']],
  ['tables', 'PARTITIONS', 'TABLE_SCHEMA', ['TABLE_SCHEMA', 'TABLE_NAME', 'PARTITION_NAME', 'SUBPARTITION_NAME', 'PARTITION_ORDINAL_POSITION', 'SUBPARTITION_ORDINAL_POSITION', 'PARTITION_METHOD', 'SUBPARTITION_METHOD', 'PARTITION_EXPRESSION', 'SUBPARTITION_EXPRESSION', 'PARTITION_DESCRIPTION', 'ENGINE', 'PARTITION_COMMENT', 'NODEGROUP', 'TABLESPACE_NAME']],
];
export const permissionCatalog = [
  ['user', ['User', 'Host', 'account_locked', 'Select_priv', 'Insert_priv', 'Update_priv', 'Delete_priv', 'Create_priv', 'Drop_priv', 'Reload_priv', 'Shutdown_priv', 'Process_priv', 'File_priv', 'Grant_priv', 'References_priv', 'Index_priv', 'Alter_priv', 'Show_db_priv', 'Super_priv', 'Create_tmp_table_priv', 'Lock_tables_priv', 'Execute_priv', 'Repl_slave_priv', 'Repl_client_priv', 'Create_view_priv', 'Show_view_priv', 'Create_routine_priv', 'Alter_routine_priv', 'Create_user_priv', 'Event_priv', 'Trigger_priv', 'Create_tablespace_priv', 'Create_role_priv', 'Drop_role_priv']],
  ['db', ['User', 'Host', 'Db', 'Select_priv', 'Insert_priv', 'Update_priv', 'Delete_priv', 'Create_priv', 'Drop_priv', 'Grant_priv', 'References_priv', 'Index_priv', 'Alter_priv', 'Create_tmp_table_priv', 'Lock_tables_priv', 'Create_view_priv', 'Show_view_priv', 'Create_routine_priv', 'Alter_routine_priv', 'Execute_priv', 'Event_priv', 'Trigger_priv']],
  ['tables_priv', ['User', 'Host', 'Db', 'Table_name', 'Table_priv', 'Column_priv']],
  ['columns_priv', ['User', 'Host', 'Db', 'Table_name', 'Column_name', 'Column_priv']],
  ['procs_priv', ['User', 'Host', 'Db', 'Routine_name', 'Routine_type', 'Proc_priv']],
  ['global_grants', ['USER', 'HOST', 'PRIV', 'WITH_GRANT_OPTION']],
  ['role_edges', ['FROM_USER', 'FROM_HOST', 'TO_USER', 'TO_HOST', 'WITH_ADMIN_OPTION']],
  ['default_roles', ['USER', 'HOST', 'DEFAULT_ROLE_USER', 'DEFAULT_ROLE_HOST']],
];
export function prepareReader(d) {
  if (d.native?.protocol === 'mysql-cli-v1') return prepareNativeReader(d);
  const n = validateNative(d, { preparing: true }), accounts = [n.principal, n.reader.definer, ...(n.writer ? [n.writer.principal] : [])];
  const statements = [frameSQL(jsonSQL([['version', '1'], ['kind', "'begin'"], ['scopeHash', literal(digest(d.scopes))]]))];
  for (const [kind, view, scope, columns] of catalog) {
    const row = jsonSQL(columns.map(c => [c, `CAST(${identifier(c)} AS CHAR CHARACTER SET utf8mb4)`]));
    const predicate = `${identifier(scope)} IN (${d.scopes.map(literal).join(', ')})`;
    statements.push(`SELECT HEX(CAST(${jsonSQL([['kind', `'${kind}'`], ['catalog', `'${view}'`], ['row', row]])} AS CHAR CHARACTER SET utf8mb4)) AS PB_FRAME FROM information_schema.${identifier(view)} WHERE ${predicate};`);
    statements.push(frameSQL(jsonSQL([['kind', "'facet-end'"], ['catalog', `'${view}'`]])));
  }
  // No authentication_string/password columns are exposed. Select flags are used
  // for audit only; they do not certify effective privileges or role closure.
  const grants = permissionCatalog.slice(0, 6);
  for (const [table, columns] of grants) {
    const user = table === 'global_grants' ? 'USER' : 'User', host = table === 'global_grants' ? 'HOST' : 'Host';
    const predicate = accounts.map(a => `(${identifier(user)} = ${literal(a.user)} AND ${identifier(host)} = ${literal(a.host)})`).join(' OR ');
    statements.push(`SELECT HEX(CAST(${jsonSQL([['kind', "'permissions'"], ['catalog', `'${table}'`], ['row', jsonSQL(columns.map(c => [c, `CAST(${identifier(c)} AS CHAR CHARACTER SET utf8mb4)`]))]])} AS CHAR CHARACTER SET utf8mb4)) AS PB_FRAME FROM mysql.${identifier(table)} WHERE ${predicate};`);
    statements.push(frameSQL(jsonSQL([['kind', "'facet-end'"], ['catalog', `'${table}'`]])));
  }
  // Reachable role grants are NOT implemented. Surface direct edges/defaults and
  // mandatory roles and block qualification, rather than trusting flat grants.
  for (const [table, columns, user, host] of [
    ['role_edges', ['FROM_USER', 'FROM_HOST', 'TO_USER', 'TO_HOST', 'WITH_ADMIN_OPTION'], 'TO_USER', 'TO_HOST'],
    ['default_roles', ['USER', 'HOST', 'DEFAULT_ROLE_USER', 'DEFAULT_ROLE_HOST'], 'USER', 'HOST'],
  ]) {
    const predicate = accounts.map(a => `(${identifier(user)} = ${literal(a.user)} AND ${identifier(host)} = ${literal(a.host)})`).join(' OR ');
    statements.push(`SELECT HEX(CAST(${jsonSQL([['kind', "'permissions'"], ['catalog', `'${table}'`], ['row', jsonSQL(columns.map(c => [c, `CAST(${identifier(c)} AS CHAR CHARACTER SET utf8mb4)`]))]])} AS CHAR CHARACTER SET utf8mb4)) AS PB_FRAME FROM mysql.${identifier(table)} WHERE ${predicate};`);
    statements.push(frameSQL(jsonSQL([['kind', "'facet-end'"], ['catalog', `'${table}'`]])));
  }
  statements.push(frameSQL(jsonSQL([['kind', "'end'"], ['scopeHash', literal(digest(d.scopes))], ['mandatoryRoles', '@@GLOBAL.mandatory_roles']])));
  const body = `BEGIN\n${statements.map(s => '  ' + s).join('\n')}\nEND`;
  const target = `${identifier(n.reader.schema)}.${identifier(n.reader.name)}`, definer = accountSQL(n.reader.definer);
  const sql = [
    '-- CANDIDATE ONLY: human review/execution; not a complete or qualified collector.',
    '-- Existing isolated server/control/application schemas only. No automatic bootstrap.',
    "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES';",
    `CREATE USER ${definer} ACCOUNT LOCK;`,
    ...d.scopes.flatMap(s => [`GRANT SELECT, SHOW VIEW, TRIGGER, EXECUTE ON ${identifier(s)}.* TO ${definer};`]),
    `GRANT SHOW_ROUTINE ON *.* TO ${definer};`,
    ...[...grants.map(([t]) => t), 'role_edges', 'default_roles'].map(t => `GRANT SELECT ON mysql.${identifier(t)} TO ${definer};`),
    'DELIMITER $$',
    `CREATE DEFINER = ${definer} PROCEDURE ${target}()\nSQL SECURITY DEFINER\nREADS SQL DATA\n${body}$$`,
    'DELIMITER ;',
    ...d.scopes.map(s => `GRANT SELECT, SHOW VIEW ON ${identifier(s)}.* TO ${accountSQL(n.principal)};`),
    `GRANT SHOW_ROUTINE ON *.* TO ${accountSQL(n.principal)};`,
    `GRANT EXECUTE ON PROCEDURE ${target} TO ${accountSQL(n.principal)};`,
    '-- No writer account creation/grants, REVOKE, ALTER, DROP or application DML in this package.',
  ].join('\n') + '\n';
  return { version: 1, database: d.id, identity: d.identity, serverVersion: d.serverVersion, scopes: d.scopes, reader: n.reader, profileTargetHash: digest(d), sql, sqlHash: digest(sql), bodyHash: digest(body), executable: false, qualified: false, blockers: nativeBlockers,
    checklist: [
      'Confirm named endpoint/schemas are isolated and owned; review full source, SQL and privilege exposure',
      'Existing control/application schemas and caller must already exist; stop on collision (no DROP/retry)',
      'Human executes separately approved SQL and records exact SQL hash and actual execution receipt',
      'Human obtains exact SHOW CREATE PROCEDURE definition and confirms profile definitionHash via normal init; bodyHash is not definitionHash',
      'Readback locked definer, all effective grants/role closure, native definitions and before/after consistency',
      'Independent source review and actual native conformance/fencing/cleanup remain required before any application-write qualification',
    ] };
}

export function auditPermissions(frames, d) {
  const n = d.native, names = new Map([[`${n.principal.user}@${n.principal.host}`, 'reader'], [`${n.reader.definer.user}@${n.reader.definer.host}`, 'definer'], ...(n.writer ? [[`${n.writer.principal.user}@${n.writer.principal.host}`, 'writer']] : [])]);
  const users = new Set();
  const subset = (text, allowed) => typeof text === 'string' && text.split(',').filter(Boolean).every(p => allowed.includes(p));
  for (const f of frames.filter(f => f.kind === 'permissions')) {
    const r = f.row;
    assert(!['role_edges', 'default_roles'].includes(f.catalog), 'Assigned MySQL roles require unimplemented closure; stop');
    const principal = `${r.User ?? r.USER}@${r.Host ?? r.HOST}`, role = names.get(principal);
    assert(role, 'Native permission evidence outside fixed account allowlist');
    if (f.catalog === 'user') {
      assert(!users.has(principal), 'Duplicate native account evidence'); users.add(principal);
      assert(['Y', 'N'].includes(r.account_locked) && (role !== 'definer' || r.account_locked === 'Y'), 'MySQL metadata definer missing/unlocked');
      assert(Object.entries(r).filter(([k]) => k.endsWith('_priv')).every(([, v]) => v === 'N'), 'Dangerous global MySQL privilege; stop');
    } else if (f.catalog === 'db') {
      assert(d.scopes.includes(r.Db), 'MySQL scope grants outside fixed allowlist');
      let allowed = [];
      if (role === 'definer') allowed = ['Select_priv', 'Show_view_priv', 'Trigger_priv', 'Execute_priv'];
      else if (role === 'reader') allowed = ['Select_priv', 'Show_view_priv'];
      assert(Object.entries(r).filter(([k]) => k.endsWith('_priv')).every(([k, v]) => v === 'N' || v === 'Y' && allowed.includes(k)), 'Dangerous MySQL schema grant; writer requires exact table grants');
    } else if (f.catalog === 'global_grants') {
      assert(['reader', 'definer'].includes(role) && r.PRIV === 'SHOW_ROUTINE' && r.WITH_GRANT_OPTION === 'N', 'Dangerous/unknown dynamic MySQL privilege');
    } else if (f.catalog === 'tables_priv') {
      const metadata = role === 'definer' && r.Db === 'mysql' && permissionCatalog.some(([name]) => name === r.Table_name);
      const writer = role === 'writer' && d.test?.targets.some(t => t.schema === r.Db && t.table === r.Table_name);
      assert((metadata && subset(r.Table_priv, ['Select']) || writer && subset(r.Table_priv, ['Select', 'Insert', 'Update', 'Delete'])) && r.Column_priv === '', 'Dangerous/unknown MySQL table grant');
    } else if (f.catalog === 'procs_priv') {
      assert(role === 'reader' && r.Db === n.reader.schema && r.Routine_name === n.reader.name && r.Routine_type === 'PROCEDURE' && r.Proc_priv === 'Execute', 'Dangerous/unknown MySQL routine grant');
    } else throw new Error('Column/unknown MySQL grants are not supported; stop');
  }
  assert(users.size === names.size, 'Missing native account evidence');
  return { accountCount: users.size, qualified: false };
}

export async function nativeSourceHashes() {
  return Promise.all(['mysql.mjs', 'mysql-catalog.mjs', 'mysql-fixtures.mjs', 'contracts.mjs', 'platform.mjs', 'project.mjs', 'database.mjs', 'fixtures.mjs', 'store.mjs'].map(async file => ({ path: `@project-batch/${file}`, hash: digest(await readFile(new URL(file, import.meta.url))) })));
}

function preflightStatements(n) {
  const qi = n.protocol === 'mysql-cli-v1' ? nativeIdentifier : identifier;
  return { identity: "SELECT VERSION() AS version, @@version_comment AS comment, @@server_uuid AS serverUUID, CURRENT_USER() AS principal, USER() AS authenticatedUser, @@GLOBAL.mandatory_roles AS mandatoryRoles;\n", grants: 'SHOW GRANTS;\n', definition: `SHOW CREATE PROCEDURE ${qi(n.reader.schema)}.${qi(n.reader.name)};\n` };
}
export class MySQLPreflight {
  constructor(database, runner, cwd, { record = async () => {} } = {}) { this.d = database; this.n = validateNative(database); this.runner = runner; this.cwd = cwd; this.record = record; }
  async client() {
    const selected = this.n.client.path, actual = await realpath(selected);
    const info = await lstat(actual); assert(info.isFile() && (info.mode & 0o111) !== 0, 'MySQL client is not a regular executable file');
    assert(digest(await readFile(actual)) === this.n.client.sha256, 'MySQL client source integrity changed');
    const version = (await this.runner(selected, ['--no-defaults', '--no-login-paths', '--version'], { cwd: this.cwd, env: { PATH: path.dirname(selected), LANG: 'C.UTF-8' }, timeoutMs: 30000 })).toString().trim();
    assert(version === this.n.client.version && !/MariaDB|Percona|TiDB/i.test(version), 'Native MySQL client version/source mismatch');
    return { path: selected, resolvedPath: actual, version, sha256: this.n.client.sha256 };
  }
  async connection() {
    const ref = this.n.credentials.readerFileRef, file = process.env[ref];
    assert(file && path.isAbsolute(file), `Missing absolute MySQL credential-file reference: ${ref}`);
    const info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid(), 'MySQL credential file must be owner-only regular file owned by this user');
    // Deliberately whitelist only authentication options. Includes/init-command,
    // login-path, plugins, alternate endpoints and other client options are refused.
    const text = await readFile(file, 'utf8'); let group = false; const keys = new Set();
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim(); if (!s || /^[#;]/.test(s)) continue;
      if (s === '[client]') { assert(!group, 'Duplicate MySQL credential group'); group = true; continue; }
      const match = s.match(/^(user|password)\s*=\s*(.+)$/);
      assert(group && match && !keys.has(match[1]) && !/[\u0000-\u001f\u007f]/.test(match[2]), 'Credential option file permits only one client user/password; no includes or executable options'); keys.add(match[1]);
      if (match[1] === 'user') assert(match[2] === this.n.principal.user, 'Credential-file user differs from approved reader principal');
    }
    assert(keys.has('user') && keys.has('password'), 'MySQL credential file needs reader user/password');
    const e = this.n.endpoint;
    return { args: [`--defaults-file=${file}`, '--no-login-paths', '--protocol=TCP', `--host=${e.host}`, `--port=${e.port}`, `--ssl-mode=${e.tlsMode}`, `--ssl-ca=${e.caFile}`, '--default-character-set=utf8mb4', '--xml', '--batch', '--skip-reconnect', '--skip-auto-rehash', '--skip-local-infile', '--binary-mode'], env: { PATH: path.dirname(this.n.client.path), LANG: 'C.UTF-8', HOME: '/nonexistent' } };
  }
  statements() { return preflightStatements(this.n); }
  readerGrants(sets) {
    assert(sets.length === 1 && sets[0].rows.length, 'Complete MySQL caller grants required');
    const principal = `${identifier(this.n.principal.user)}@${identifier(this.n.principal.host)}`;
    const allowed = new Set(['USAGE ON *.*', 'SHOW_ROUTINE ON *.*', `EXECUTE ON PROCEDURE ${identifier(this.n.reader.schema)}.${identifier(this.n.reader.name)}`, ...this.d.scopes.flatMap(s => [`SELECT ON ${identifier(s)}.*`, `SHOW VIEW ON ${identifier(s)}.*`, `SELECT, SHOW VIEW ON ${identifier(s)}.*`])].map(g => `GRANT ${g} TO ${principal}`));
    const found = new Set();
    for (const row of sets[0].rows) {
      const values = Object.values(row);
      assert(values.length === 1 && typeof values[0] === 'string' && allowed.has(values[0]) && !found.has(values[0]), 'Dangerous, unknown or role-based MySQL reader grant; no CALL');
      found.add(values[0]);
    }
    assert(found.has(`GRANT SHOW_ROUTINE ON *.* TO ${principal}`) && found.has(`GRANT EXECUTE ON PROCEDURE ${identifier(this.n.reader.schema)}.${identifier(this.n.reader.name)} TO ${principal}`), 'Reader metadata privileges missing');
    for (const scope of this.d.scopes) assert(found.has(`GRANT SELECT ON ${identifier(scope)}.* TO ${principal}`) || found.has(`GRANT SELECT, SHOW VIEW ON ${identifier(scope)}.* TO ${principal}`), 'Reader scope SELECT missing');
    return [...found].sort();
  }
  async query(sql, connection) {
    assert(Object.values(preflightStatements(this.n)).includes(sql), 'Native MySQL guard rejects arbitrary SQL/DDL before dispatch');
    try {
      const out = await this.runner(this.n.client.path, connection.args, { cwd: this.cwd, env: connection.env, input: sql, timeoutMs: 30000 });
      await this.record({ queryHash: digest(sql), rawEncoding: 'base64', rawBase64: out.toString('base64'), rawHash: digest(out), byteLength: out.length });
      assert(!out.stderr?.length, 'Unexpected MySQL client diagnostic; readback is not clean');
      const sets = parseXML(out); // strict UTF8 before returning a textual view
      return { raw: out.toString('utf8'), sets };
    } catch (error) {
      if (Buffer.isBuffer(error.stdout)) await this.record({ queryHash: digest(sql), status: 'transport-failed', rawEncoding: 'base64', rawBase64: error.stdout.toString('base64'), rawHash: digest(error.stdout), byteLength: error.stdout.length });
      throw new Error('Native MySQL read-only query failed; no retry/fallback (credential/client diagnostics withheld)');
    }
  }
  async doctor() {
    const client = await this.client(), connection = await this.connection();
    const statements = this.statements();
    const bootstrap = await this.query(statements.identity, connection);
    const identity = one(bootstrap.sets, ['version', 'comment', 'serverUUID', 'principal', 'authenticatedUser', 'mandatoryRoles']);
    nativeVersion(identity.version, identity.comment);
    assert(identity.version === this.d.serverVersion && identity.serverUUID === this.n.endpoint.serverUUID && identity.principal === `${this.n.principal.user}@${this.n.principal.host}`, 'MySQL server/version/authenticated principal mismatch');
    assert(identity.mandatoryRoles === '', 'Mandatory MySQL roles require unimplemented effective role closure; stop');
    const grants = await this.query(statements.grants, connection);
    const readerGrants = this.readerGrants(grants.sets);
    const definition = await this.query(statements.definition, connection);
    const r = one(definition.sets, ['Procedure', 'sql_mode', 'Create Procedure', 'character_set_client', 'collation_connection', 'Database Collation']);
    assert(r.Procedure === this.n.reader.name && typeof r['Create Procedure'] === 'string' && digest(r['Create Procedure']) === this.n.reader.definitionHash, 'Reader definition changed/hidden; stop before CALL');
    // Definition must be the generated fixed reader body, not just any user hash.
    const proposal = prepareReader(this.d);
    assert(r['Create Procedure'].endsWith(proposal.sql.slice(proposal.sql.indexOf('BEGIN\n'), proposal.sql.indexOf('END$$') + 3)), 'Reader body differs from fixed source/scopes/accounts');
    assert(r['Create Procedure'].startsWith(`CREATE DEFINER=${accountSQL(this.n.reader.definer).replaceAll("'", '`')}`) && r['Create Procedure'].includes('READS SQL DATA') && !r['Create Procedure'].includes('SQL SECURITY INVOKER') && r.sql_mode.split(',').sort().join(',') === 'NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES' && r.character_set_client === 'utf8mb4', 'Reader definer/security/sql-mode attributes mismatch');
    // The definer's own procedure cannot prove its locking/grants BEFORE its
    // execution. Until a separate native read-only audit exists, do not CALL it,
    // even when source/body/hash/caller grants match. No stored assertion unlocks.
    return { version: 1, database: this.d.id, client, identity, readerDefinitionHash: digest(r['Create Procedure']), sqlMode: r.sql_mode, sourceHash: digest(await nativeSourceHashes()), readerGrantHash: digest(readerGrants), rawEvidence: { bootstrap: bootstrap.raw, grants: grants.raw, definition: definition.raw }, readerExecution: 'blocked', permissionAudit: 'unverified', qualified: false, ready: false, blockers: nativeBlockers };
  }
}
export function parseFrames(sets, d) {
  const frames = [];
  for (const set of sets) for (const row of set.rows) {
    assert(Object.keys(row).length === 1 && typeof row.PB_FRAME === 'string' && /^(?:[0-9A-F]{2})+$/.test(row.PB_FRAME), 'Invalid native metadata frame');
    let frame; try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(row.PB_FRAME, 'hex'))); } catch { throw new Error('Invalid native metadata JSON/UTF8 frame'); }
    assert(frame && typeof frame === 'object' && !Array.isArray(frame), 'Invalid native metadata object'); frames.push(frame);
  }
  assert(frames[0]?.kind === 'begin' && frames[0].version === 1 && frames[0].scopeHash === digest(d.scopes) && frames.at(-1)?.kind === 'end' && frames.at(-1).scopeHash === digest(d.scopes) && frames.at(-1).mandatoryRoles === '', 'Missing/changed native metadata termination/scope/roles');
  fields(frames[0], ['kind', 'version', 'scopeHash'], 'native begin'); fields(frames.at(-1), ['kind', 'scopeHash', 'mandatoryRoles'], 'native end');
  const expected = [...catalog.map(([kind, name]) => [kind, name]), ...['user', 'db', 'tables_priv', 'columns_priv', 'procs_priv', 'global_grants', 'role_edges', 'default_roles'].map(name => ['permissions', name])];
  let facet = 0;
  for (const frame of frames.slice(1, -1)) {
    assert(facet < expected.length && frame.catalog === expected[facet][1], 'Unknown/reordered/duplicate native catalog facet');
    if (frame.kind === 'facet-end') { fields(frame, ['kind', 'catalog'], 'facet terminator'); facet++; continue; }
    fields(frame, ['kind', 'catalog', 'row'], 'catalog frame');
    assert(frame.kind === expected[facet][0] && frame.row && typeof frame.row === 'object' && !Array.isArray(frame.row) && Object.values(frame.row).every(v => v === null || typeof v === 'string'), 'Native metadata values must be lossless strings/null');
    if (frame.kind === 'permissions') {
      const spec = permissionCatalog[facet - catalog.length];
      assert(digest(Object.keys(frame.row).sort()) === digest([...spec[1]].sort()), 'Hidden/missing/unknown native permission fields');
    } else {
      const spec = catalog[facet];
      assert(digest(Object.keys(frame.row).sort()) === digest([...spec[3]].sort()) && d.scopes.includes(frame.row[spec[2]]), 'Hidden/missing/unknown native metadata fields or schema');
    }
  }
  assert(facet === expected.length, 'Incomplete native metadata facets'); return frames;
}
export function requireNativeQualification() {
  throw new Error(`Native MySQL qualification blocked: ${nativeBlockers.join('; ')}. Custom inspector assertions and stored hashes cannot grant native write authority.`);
}
