import { assert, digest } from './contracts.mjs';
import { nativeFixturePolicy, nativeDataSQL, parseNativeData } from './mysql-fixtures.mjs';
import { MySQLPreflight, validateNative, nativeVersion, catalog, permissionCatalog, literal, accountSQL, frameSQL, jsonSQL, parseXML, nativeSourceHashes } from './mysql.mjs';

export const protocol = 'mysql-cli-v1';
export function nativeIdentifier(value) {
  assert(typeof value === 'string' && value.length && value.length <= 64 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && [...value].every(c => { const n = c.codePointAt(0); return n <= 0xffff && !(n >= 0xd800 && n <= 0xdfff); }), 'Invalid native MySQL identifier');
  return '`' + value.replaceAll('`', '``') + '`';
}
export const grantSchema = value => nativeIdentifier(value.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%'));
const qualifiedName = (schema, name) => `${nativeIdentifier(schema)}.${nativeIdentifier(name)}`;
const canonicalRows = rows => [...rows].sort((a, b) => Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b))));
const key = (user, host) => JSON.stringify([user, host]);
const roots = d => [d.native.principal, d.native.reader.definer, ...(d.native.writer ? [d.native.writer.principal] : [])];
const staticPrivilege = c => c.slice(0, -5).replaceAll('_', ' ').toUpperCase();
const list = v => { assert(typeof v === 'string', 'Invalid privilege set'); return v ? v.split(',').map(s => s.trim().toUpperCase()) : []; };
function checkFields(row, names) {
  assert(row && !Array.isArray(row) && digest(Object.keys(row).sort()) === digest([...names].sort()) && Object.values(row).every(v => v === null || typeof v === 'string'), 'Incomplete/unknown/non-lossless native fields');
}
export function hexFrame(row) {
  assert(Object.keys(row).length === 1 && typeof row.PB_FRAME === 'string' && /^(?:[0-9A-F]{2})+$/.test(row.PB_FRAME), 'Invalid native frame');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(row.PB_FRAME, 'hex'))); }
  catch { throw new Error('Invalid native frame JSON/UTF8'); }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid native frame object'); return value;
}
const stringRow = columns => jsonSQL(columns.map(c => [c, `CAST(${nativeIdentifier(c)} AS CHAR CHARACTER SET utf8mb4)`]));
function emit(kind, name, table, columns, where = '') {
  return `SELECT HEX(CAST(${jsonSQL([['kind', `'${kind}'`], ['catalog', `'${name}'`], ['row', stringRow(columns)]])} AS CHAR CHARACTER SET utf8mb4)) AS PB_FRAME FROM ${table}${where ? ' WHERE ' + where : ''};\n${frameSQL(jsonSQL([['kind', "'facet-end'"], ['catalog', `'${name}'`]]))}`;
}
const scopePredicate = (field, d) => `${nativeIdentifier(field)} IN (${d.scopes.map(literal).join(', ')})`;
export function catalogSpec() {
  return [
    ['tables', 'SCHEMATA', 'SCHEMA_NAME', ['SCHEMA_NAME', 'DEFAULT_CHARACTER_SET_NAME', 'DEFAULT_COLLATION_NAME', 'DEFAULT_ENCRYPTION']],
    ...catalog,
    ['constraints', 'INCOMING_KEYS', 'REFERENCED_TABLE_SCHEMA', [...catalog.find(([, name]) => name === 'KEY_COLUMN_USAGE')[3]]],
    ['routines', 'EVENTS', 'EVENT_SCHEMA', ['EVENT_SCHEMA', 'EVENT_NAME', 'DEFINER', 'TIME_ZONE', 'EVENT_BODY', 'EVENT_DEFINITION', 'EVENT_TYPE', 'EXECUTE_AT', 'INTERVAL_VALUE', 'INTERVAL_FIELD', 'SQL_MODE', 'STARTS', 'ENDS', 'STATUS', 'ON_COMPLETION', 'EVENT_COMMENT', 'ORIGINATOR', 'CHARACTER_SET_CLIENT', 'COLLATION_CONNECTION', 'DATABASE_COLLATION']],
  ];
}

// Direct, read-only audit runs BEFORE any definer CALL. Only known non-secret
// columns are selected, with explicit facet terminators, including the role graph.
// The human grants column SELECT to the caller, never TRIGGER/schema-write rights.
export function permissionSQL() {
  return [frameSQL(jsonSQL([['kind', "'audit-begin'"], ['version', '1']])), ...permissionCatalog.map(([name, columns]) => emit('permissions', name, `mysql.${nativeIdentifier(name)}`, columns)), frameSQL(jsonSQL([['kind', "'audit-end'"], ['version', '1']]))].join('\n') + '\n';
}
export function parsePermissionSets(sets) {
  const frames = sets.flatMap(s => s.rows.map(hexFrame));
  assert(frames[0]?.kind === 'audit-begin' && frames[0].version === 1 && frames.at(-1)?.kind === 'audit-end' && frames.at(-1).version === 1 && Object.keys(frames[0]).length === 2 && Object.keys(frames.at(-1)).length === 2, 'Truncated/unknown native permission audit');
  let index = 0; const rows = [];
  for (const f of frames.slice(1, -1)) {
    const spec = permissionCatalog[index]; assert(spec && f.catalog === spec[0], 'Missing/reordered/unknown permission facet');
    if (f.kind === 'facet-end') { assert(Object.keys(f).length === 2, 'Unknown permission terminator'); index++; }
    else { assert(f.kind === 'permissions' && Object.keys(f).length === 3, 'Invalid permission frame'); checkFields(f.row, spec[1]); rows.push(f); }
  }
  assert(index === permissionCatalog.length, 'Hidden/incomplete permission audit'); return rows;
}
export function mandatoryAccounts(text) {
  assert(typeof text === 'string', 'Missing mandatory role evidence'); if (!text) return [];
  const result = []; let rest = text;
  while (rest.trim()) {
    const m = rest.match(/^\s*(['`])((?:\1\1|[^'`])*)\1\s*@\s*(['`])((?:\3\3|[^'`])*)\3\s*(,|$)/);
    assert(m, 'Unrecognized mandatory role grammar');
    result.push({ user: m[2].replaceAll(m[1] + m[1], m[1]), host: m[4].replaceAll(m[3] + m[3], m[3]) }); rest = rest.slice(m[0].length);
  }
  return result;
}
export function provePermissions(frames, d, identity) {
  assert(identity.partialRevokes === '0', 'Partial-revoke semantics are not in this native profile');
  const byCatalog = name => frames.filter(f => f.catalog === name).map(f => f.row);
  const users = new Map();
  for (const row of byCatalog('user')) { const id = key(row.User, row.Host); assert(!users.has(id), 'Duplicate native account'); users.set(id, row); }
  const edges = new Map(), defaults = new Map();
  for (const row of byCatalog('role_edges')) {
    assert(['Y', 'N'].includes(row.WITH_ADMIN_OPTION), 'Unknown role delegation flag');
    const from = key(row.FROM_USER, row.FROM_HOST), to = key(row.TO_USER, row.TO_HOST);
    assert(users.has(from) && users.has(to), 'Dangling/hidden native role account');
    const e = edges.get(to) ?? []; assert(!e.includes(from), 'Duplicate native role edge'); e.push(from); edges.set(to, e);
  }
  for (const row of byCatalog('default_roles')) {
    const id = key(row.USER, row.HOST), role = key(row.DEFAULT_ROLE_USER, row.DEFAULT_ROLE_HOST);
    assert(users.has(id) && users.has(role) && edges.get(id)?.includes(role), 'Unprovable default role grant');
    (defaults.get(id) ?? defaults.set(id, []).get(id)).push(role);
  }
  const mandatory = mandatoryAccounts(identity.mandatoryRoles).map(a => key(a.user, a.host));
  mandatory.forEach(id => assert(users.has(id), 'Mandatory role missing from native catalog'));
  const closure = root => {
    const seen = new Set(), active = new Set();
    const visit = id => {
      assert(users.has(id), 'Native principal/role missing'); assert(!active.has(id), 'Native role graph cycle'); if (seen.has(id)) return;
      active.add(id); for (const r of edges.get(id) ?? []) visit(r); active.delete(id); seen.add(id);
    };
    visit(root); mandatory.forEach(visit); return [...seen].sort();
  };
  const checks = [];
  for (const [index, principal] of roots(d).entries()) {
    const role = ['reader', 'definer', 'writer'][index], id = key(principal.user, principal.host), members = closure(id), selected = new Set(members);
    const grants = [];
    assert(byCatalog('role_edges').filter(r => selected.has(key(r.TO_USER, r.TO_HOST))).every(r => r.WITH_ADMIN_OPTION === 'N'), 'Effective role admin delegation is forbidden');
    if (role === 'definer') assert(users.get(id).account_locked === 'Y', 'Definer must be locked BEFORE CALL');
    for (const member of members) {
      const row = users.get(member);
      assert(['Y', 'N'].includes(row.account_locked), 'Unknown lock status');
      if (member !== id) assert(row.account_locked === 'Y', 'Inheritable roles must be non-login accounts');
      for (const [column, flag] of Object.entries(row).filter(([c]) => c.endsWith('_priv'))) {
        assert(flag === 'Y' || flag === 'N', 'Unknown static grant flag'); if (flag === 'N') continue;
        const privilege = staticPrivilege(column);
        assert(role === 'reader' && privilege === 'PROCESS' || role === 'definer' && privilege === 'REFERENCES', `Dangerous global ${role} privilege: ${privilege}`);
        grants.push({ owner: member, level: 'global', privilege });
      }
    }
    for (const f of frames) {
      if (['user', 'role_edges', 'default_roles'].includes(f.catalog)) continue;
      const r = f.row, owner = key(r.User ?? r.USER, r.Host ?? r.HOST); if (!selected.has(owner)) continue;
      if (f.catalog === 'global_grants') {
        assert(r.WITH_GRANT_OPTION === 'N' && r.PRIV === 'SHOW_ROUTINE' && role !== 'writer', 'Dangerous/unknown dynamic privilege'); grants.push({ owner, level: 'global', privilege: r.PRIV });
      } else if (f.catalog === 'db') {
        // mysql.db stores privilege patterns. Require the escaped, exact schema
        // pattern; an unescaped wildcard is not the approved target.
        const scope = d.scopes.find(s => r.Db === s.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%'));
        assert(scope, 'Database grant exceeds exact native schemas');
        let allowed = [];
        if (role === 'definer') allowed = ['SELECT', 'SHOW VIEW', 'TRIGGER', 'EXECUTE', 'EVENT'];
        else if (role === 'reader') allowed = ['SELECT', 'SHOW VIEW'];
        for (const [c, v] of Object.entries(r).filter(([c]) => c.endsWith('_priv'))) {
          assert(v === 'N' || v === 'Y', 'Invalid schema privilege'); if (v === 'N') continue;
          const privilege = staticPrivilege(c); assert(allowed.includes(privilege), `Dangerous ${role} schema privilege`); grants.push({ owner, level: 'schema', schema: scope, privilege });
        }
      } else if (f.catalog === 'tables_priv') {
        const columnAudit = role === 'reader' && r.Db === 'mysql' && permissionCatalog.some(([name]) => name === r.Table_name);
        assert(r.Column_priv === '' || columnAudit && list(r.Column_priv).every(p => p === 'SELECT'), 'Unsafe aggregate column grants');
        const target = d.test?.targets.find(t => t.schema === r.Db && t.table === r.Table_name);
        const allowed = role === 'writer' && target ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [];
        for (const privilege of list(r.Table_priv)) { assert(allowed.includes(privilege), 'Unexpected native table privilege'); grants.push({ owner, level: 'table', schema: r.Db, table: r.Table_name, privilege }); }
      } else if (f.catalog === 'columns_priv') {
        const spec = permissionCatalog.find(([name]) => name === r.Table_name);
        assert(role === 'reader' && r.Db === 'mysql' && spec?.[1].includes(r.Column_name) && r.Column_priv.toUpperCase() === 'SELECT', 'Unsafe metadata column grant');
        grants.push({ owner, level: 'column', schema: r.Db, table: r.Table_name, column: r.Column_name, privilege: 'SELECT' });
      } else if (f.catalog === 'procs_priv') {
        assert(role === 'reader' && r.Db === d.native.reader.schema && r.Routine_name === d.native.reader.name && r.Routine_type === 'PROCEDURE' && r.Proc_priv === 'Execute', 'Unsafe routine grant');
        grants.push({ owner, level: 'procedure', schema: r.Db, name: r.Routine_name, privilege: 'EXECUTE' });
      } else throw new Error('Unknown native privilege facet');
    }
    const has = (privilege, scope) => grants.some(g => g.owner === id && g.privilege === privilege && (!scope || g.schema === scope) && (g.level === 'global' || g.level === 'schema'));
    if (role === 'definer') { assert(has('REFERENCES') && has('SHOW_ROUTINE'), 'Incomplete full metadata visibility authority'); for (const s of d.scopes) for (const p of ['SELECT', 'SHOW VIEW', 'TRIGGER', 'EXECUTE', 'EVENT']) assert(has(p, s), 'Hidden native schema facet: missing definer visibility grant'); }
    if (role === 'reader') {
      assert(has('SHOW_ROUTINE') && (!d.test || has('PROCESS')), 'Native inspector definition/session read authority missing');
      for (const s of d.scopes) assert(has('SELECT', s), 'Reader lacks approved native data probe scope');
      for (const [table, columns] of permissionCatalog) for (const column of columns) assert(grants.some(g => g.owner === id && g.level === 'column' && g.table === table && g.column === column), 'Incomplete direct pre-CALL column audit authority');
      assert(grants.some(g => g.level === 'procedure'), 'Reader EXECUTE authority missing');
    }
    if (role === 'writer') for (const t of d.test?.targets ?? []) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert(grants.some(g => g.level === 'table' && g.schema === t.schema && g.table === t.table && g.privilege === p), 'Required DML-only writer table authority missing');
    checks.push({ role, principal, locked: users.get(id).account_locked, closure: members, defaults: defaults.get(id) ?? [], grants: canonicalRows(grants) });
  }
  return { version: 1, identity: d.identity, mandatory, checks, hash: digest(checks) };
}

export function prepareNativeReader(d) {
  const n = validateNative(d, { preparing: true }); assert(n.protocol === protocol, 'Explicit new native protocol required');
  const meta = catalogSpec(), statements = [];
  statements.push(frameSQL(jsonSQL([['kind', "'catalog-begin'"], ['scopeHash', literal(digest(d.scopes))], ['version', '1']])));
  for (const [kind, name, field, columns] of meta) statements.push(emit(kind, name, `information_schema.${nativeIdentifier(name === 'INCOMING_KEYS' ? 'KEY_COLUMN_USAGE' : name)}`, columns, scopePredicate(field, d)));
  const inventory = [
    `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, IF(TABLE_TYPE='VIEW','VIEW','TABLE') AS k FROM information_schema.TABLES WHERE ${scopePredicate('TABLE_SCHEMA', d)}`,
    `SELECT TRIGGER_SCHEMA, TRIGGER_NAME, 'TRIGGER' FROM information_schema.TRIGGERS WHERE ${scopePredicate('TRIGGER_SCHEMA', d)}`,
    `SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ${scopePredicate('ROUTINE_SCHEMA', d)}`,
    `SELECT EVENT_SCHEMA, EVENT_NAME, 'EVENT' FROM information_schema.EVENTS WHERE ${scopePredicate('EVENT_SCHEMA', d)}`,
  ].join('\nUNION ALL\n');
  const nativeLoop = [
    '  OPEN objects;', '  read_objects: LOOP', '    FETCH objects INTO object_schema, object_name, object_kind;', '    IF exhausted THEN LEAVE read_objects; END IF;',
    '    ' + frameSQL(jsonSQL([['kind', "'native-begin'"], ['schema', 'object_schema'], ['name', 'object_name'], ['type', 'object_kind']])),
    "    SET @pb_native_show = CONCAT('SHOW CREATE ', object_kind, ' `', REPLACE(object_schema, '`', '``'), '`.`', REPLACE(object_name, '`', '``'), '`');",
    '    PREPARE native_show FROM @pb_native_show;', '    EXECUTE native_show;', '    DEALLOCATE PREPARE native_show;',
    '    ' + frameSQL(jsonSQL([['kind', "'native-end'"], ['schema', 'object_schema'], ['name', 'object_name'], ['type', 'object_kind']])),
    '  END LOOP;', '  CLOSE objects;', '  SET @pb_native_show = NULL;',
  ].join('\n');
  const body = ['BEGIN', '  DECLARE exhausted BOOLEAN DEFAULT FALSE;', '  DECLARE object_schema VARCHAR(64) CHARACTER SET utf8mb4;', '  DECLARE object_name VARCHAR(64) CHARACTER SET utf8mb4;', '  DECLARE object_kind VARCHAR(16);', `  DECLARE objects CURSOR FOR SELECT s, n, k FROM (${inventory}) AS fixed_objects ORDER BY BINARY s, BINARY n, BINARY k;`, '  DECLARE CONTINUE HANDLER FOR NOT FOUND SET exhausted = TRUE;', '  SET SESSION sql_quote_show_create = 1;', '  SET SESSION show_gipk_in_create_table_and_information_schema = ON;', ...statements.map(s => '  ' + s), nativeLoop, '  ' + frameSQL(jsonSQL([['kind', "'catalog-end'"], ['scopeHash', literal(digest(d.scopes))], ['version', '1']])), 'END'].join('\n');
  const definer = accountSQL(n.reader.definer), caller = accountSQL(n.principal), target = qualifiedName(n.reader.schema, n.reader.name);
  const sql = [
    '-- HUMAN-EXECUTED ONLY. Existing isolated server/schemas/accounts; no DROP/retry/bootstrap.',
    "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES';",
    'SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
    `CREATE USER ${definer} ACCOUNT LOCK;`,
    `GRANT REFERENCES ON *.* TO ${definer}; -- visibility of inbound foreign keys, not caller DDL authority`,
    `GRANT SHOW_ROUTINE ON *.* TO ${definer};`,
    ...d.scopes.map(s => `GRANT SELECT, SHOW VIEW, TRIGGER, EXECUTE, EVENT ON ${grantSchema(s)}.* TO ${definer};`),
    ...permissionCatalog.map(([table, columns]) => `GRANT SELECT (${columns.map(nativeIdentifier).join(', ')}) ON mysql.${nativeIdentifier(table)} TO ${caller};`),
    ...d.scopes.map(s => `GRANT SELECT, SHOW VIEW ON ${grantSchema(s)}.* TO ${caller};`),
    `GRANT SHOW_ROUTINE ON *.* TO ${caller};`, ...(d.test ? [`GRANT PROCESS ON *.* TO ${caller}; -- required read-only INNODB_TRX/session visibility`] : []),
    'DELIMITER $$', `CREATE DEFINER = ${definer} PROCEDURE ${target}()\nSQL SECURITY DEFINER\nREADS SQL DATA\n${body}$$`, 'DELIMITER ;',
    `GRANT EXECUTE ON PROCEDURE ${target} TO ${caller};`,
    ...(d.test && n.writer ? d.test.targets.map(t => `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualifiedName(t.schema, t.table)} TO ${accountSQL(n.writer.principal)};`) : []),
    '-- Record exact execution receipt and SHOW CREATE definition hash; this package is not consent or qualification.',
  ].join('\n') + '\n';
  return { version: 1, protocol, database: d.id, identity: d.identity, serverVersion: d.serverVersion, scopes: d.scopes, reader: n.reader, profileTargetHash: digest(d), sql, sqlHash: digest(sql), body, bodyHash: digest(body), executable: false, qualified: false, checklist: ['Human reviews source and scoped/non-secret column grants', 'Human confirms and executes exact SQL in existing isolated resources', 'Native direct audit proves locked definer, complete role closure and minimal effective privileges BEFORE CALL', 'Confirm profile definition hash; complete native qualification remains separately authorized'] };
}

export function sqlTokens(text) {
  assert(typeof text === 'string' && text.length, 'Missing native definition');
  const tokens = []; let i = 0, depth = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; } const start = i, ch = text[i];
    if (ch === '`' || ch === "'" || ch === '"') {
      i++; let value = ''; let closed = false;
      while (i < text.length) { const c = text[i++]; if (c === ch) { if (text[i] === ch) { value += ch; i++; } else { closed = true; break; } } else if (c === '\\' && ch !== '`') { assert(i < text.length, 'Truncated native escape'); value += text[i++]; } else value += c; }
      assert(closed, 'Truncated native quote'); tokens.push({ type: ch === '`' ? 'identifier' : 'literal', value, start, end: i, depth }); continue;
    }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); assert(end !== -1, 'Truncated native comment'); const comment = text.slice(i + 2, end); const executable = comment.startsWith('!'); assert(!executable || /^!\d{5,6}\s/.test(comment), 'Unknown executable native comment'); tokens.push({ type: executable ? 'comment' : 'plain-comment', value: comment.replace(/^!\d{5,6}\s*/, ''), start, end: end + 2, depth }); i = end + 2; continue; }
    if (ch === '#' || text.startsWith('--', i) && /\s/.test(text[i + 2] ?? '')) { const end = text.indexOf('\n', i); i = end === -1 ? text.length : end; tokens.push({ type: 'plain-comment', value: text.slice(start, i), start, end: i, depth }); continue; }
    if (/[A-Za-z_]/.test(ch)) { while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) i++; tokens.push({ type: 'word', value: text.slice(start, i).toUpperCase(), start, end: i, depth }); continue; }
    if (/[0-9]/.test(ch)) { while (i < text.length && /[0-9.]/.test(text[i])) i++; tokens.push({ type: 'number', value: text.slice(start, i), start, end: i, depth }); continue; }
    if (ch === '(') { tokens.push({ type: 'symbol', value: ch, start, end: ++i, depth }); depth++; continue; }
    if (ch === ')') { assert(depth > 0, 'Unbalanced native definition'); depth--; tokens.push({ type: 'symbol', value: ch, start, end: ++i, depth }); continue; }
    tokens.push({ type: 'symbol', value: ch, start, end: ++i, depth });
  }
  assert(depth === 0, 'Unbalanced native definition'); return tokens;
}
const tableWords = new Set(('ENGINE AUTO_INCREMENT DEFAULT CHARSET CHARACTER SET COLLATE ROW_FORMAT KEY_BLOCK_SIZE COMPRESSION ENCRYPTION COMMENT CONNECTION INSERT_METHOD UNION STATS_AUTO_RECALC STATS_PERSISTENT STATS_SAMPLE_PAGES SECONDARY_ENGINE SECONDARY_ENGINE_ATTRIBUTE ENGINE_ATTRIBUTE AVG_ROW_LENGTH MIN_ROWS MAX_ROWS PACK_KEYS TABLESPACE DATA DIRECTORY INDEX STORAGE DISK MEMORY PARTITION BY SUBPARTITION LINEAR HASH KEY RANGE LIST COLUMNS ALGORITHM PARTITIONS SUBPARTITIONS VALUES LESS THAN IN MAXVALUE NODEGROUP INNODB MYISAM CSV ARCHIVE NDBCLUSTER NDB BLACKHOLE FEDERATED MRG_MYISAM DYNAMIC COMPACT REDUNDANT COMPRESSED FIXED NONE NULL YES NO ON OFF FIRST LAST BTREE ASCII BINARY UNDEFINED').split(' '));
export function normalizeNative(type, definition) {
  const tokens = sqlTokens(definition); assert(tokens[0]?.value === 'CREATE', 'Unknown native definition header');
  if (type !== 'TABLE') return definition;
  assert(tokens.some(t => t.value === 'TABLE'), 'Not a native table definition');
  const close = tokens.findIndex(t => t.value === ')' && t.depth === 0); assert(close !== -1, 'Missing native table columns');
  const removals = [];
  for (let i = close + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'word' && t.depth === 0) {
      // Charset/collation are actual metadata identifiers, not grammar options.
      const previous = tokens[i - 1]?.value;
      const valueOf = previous === '=' ? tokens[i - 2]?.value : previous;
      assert(tableWords.has(t.value) || ['CHARSET', 'COLLATE'].includes(valueOf), `Unknown native table clause: ${t.value}`);
    }
    if (t.value === 'AUTO_INCREMENT' && t.depth === 0) {
      assert(tokens[i + 1]?.value === '=' && tokens[i + 2]?.type === 'number' && /^\d+$/.test(tokens[i + 2].value), 'Unknown AUTO_INCREMENT counter clause');
      removals.push([t.start > 0 && definition[t.start - 1] === ' ' ? t.start - 1 : t.start, tokens[i + 2].end]); i += 2;
    }
    if (t.type === 'comment') {
      const inner = sqlTokens(t.value); assert(inner.every(v => v.type !== 'word' || tableWords.has(v.value)), 'Unknown native versioned clause');
    }
  }
  let result = definition; for (const [a, b] of removals.toReversed()) result = result.slice(0, a) + result.slice(b); return result.trim();
}
function showDefinition(type, row, name) {
  const specs = {
    TABLE: ['Table', 'Create Table'], VIEW: ['View', 'Create View', 'character_set_client', 'collation_connection'],
    PROCEDURE: ['Procedure', 'sql_mode', 'Create Procedure', 'character_set_client', 'collation_connection', 'Database Collation'],
    FUNCTION: ['Function', 'sql_mode', 'Create Function', 'character_set_client', 'collation_connection', 'Database Collation'],
    TRIGGER: ['Trigger', 'sql_mode', 'SQL Original Statement', 'character_set_client', 'collation_connection', 'Database Collation'],
    EVENT: ['Event', 'sql_mode', 'time_zone', 'Create Event', 'character_set_client', 'collation_connection', 'Database Collation'],
  };
  const spec = specs[type]; assert(spec, 'Unknown native object kind'); checkFields(row, spec); assert(row[spec[0]] === name, 'Native definition object mismatch');
  const field = spec.find(c => c.startsWith('Create ') || c === 'SQL Original Statement'); assert(row[field], 'Hidden/empty native definition');
  return { ...row, [field]: normalizeNative(type, row[field]) };
}
function inventoryOf(rows) {
  return rows.flatMap(f => {
    const r = f.row;
    if (f.catalog === 'TABLES') { assert(['BASE TABLE', 'VIEW'].includes(r.TABLE_TYPE), 'Unknown native table type'); return [{ schema: r.TABLE_SCHEMA, name: r.TABLE_NAME, type: r.TABLE_TYPE === 'VIEW' ? 'VIEW' : 'TABLE' }]; }
    if (f.catalog === 'TRIGGERS') return [{ schema: r.TRIGGER_SCHEMA, name: r.TRIGGER_NAME, type: 'TRIGGER' }];
    if (f.catalog === 'ROUTINES') { assert(['PROCEDURE', 'FUNCTION'].includes(r.ROUTINE_TYPE), 'Unknown native routine type'); return [{ schema: r.ROUTINE_SCHEMA, name: r.ROUTINE_NAME, type: r.ROUTINE_TYPE }]; }
    if (f.catalog === 'EVENTS') return [{ schema: r.EVENT_SCHEMA, name: r.EVENT_NAME, type: 'EVENT' }];
    return [];
  }).sort((a, b) => Buffer.compare(Buffer.from(a.schema), Buffer.from(b.schema)) || Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) || Buffer.compare(Buffer.from(a.type), Buffer.from(b.type)));
}
export function parseCatalogSets(sets, d) {
  let at = 0;
  const takeFrame = () => { const set = sets[at++]; assert(set?.rows.length === 1, 'Missing native catalog control frame'); return hexFrame(set.rows[0]); };
  const begin = takeFrame(); assert(begin.kind === 'catalog-begin' && begin.version === 1 && begin.scopeHash === digest(d.scopes) && Object.keys(begin).length === 3, 'Catalog binding/header mismatch');
  const rows = [], spec = catalogSpec();
  for (const [kind, name, field, columns] of spec) {
    // Each SELECT yields one resultset (including a proven empty resultset),
    // followed by its explicit terminator. No query omission is treated as empty.
    const set = sets[at++]; assert(set, 'Missing catalog facet result');
    for (const row of set.rows) { const f = hexFrame(row); assert(f.kind === kind && f.catalog === name && Object.keys(f).length === 3, 'Unknown/reordered native facet'); checkFields(f.row, columns); assert(d.scopes.includes(f.row[field]), 'Native catalog scope changed'); rows.push(f); }
    const end = takeFrame(); assert(end.kind === 'facet-end' && end.catalog === name && Object.keys(end).length === 2, 'Truncated native catalog facet');
  }
  assert(digest(rows.filter(f => f.catalog === 'SCHEMATA').map(f => f.row.SCHEMA_NAME).sort()) === digest([...d.scopes].sort()), 'Hidden/missing native schema');
  const inventory = inventoryOf(rows), native = [], seen = new Set();
  for (const item of inventory) {
    const start = takeFrame(); assert(start.kind === 'native-begin' && start.schema === item.schema && start.name === item.name && start.type === item.type && Object.keys(start).length === 4, 'Hidden/reordered native object');
    const id = JSON.stringify(item); assert(!seen.has(id), 'Duplicate native inventory object'); seen.add(id);
    const set = sets[at++]; assert(set?.rows.length === 1, 'Truncated/missing native definition');
    const definition = showDefinition(item.type, set.rows[0], item.name);
    const end = takeFrame(); assert(end.kind === 'native-end' && end.schema === item.schema && end.name === item.name && end.type === item.type && Object.keys(end).length === 4, 'Truncated native object');
    native.push({ ...item, definition });
  }
  const end = takeFrame(); assert(end.kind === 'catalog-end' && end.version === 1 && end.scopeHash === digest(d.scopes) && Object.keys(end).length === 3 && at === sets.length, 'Truncated/extra native catalog results');
  validateCoherence(rows, native);
  return { rows, native };
}
const dataTypes = new Set('tinyint smallint mediumint int bigint decimal numeric float double bit char varchar binary varbinary tinyblob blob mediumblob longblob tinytext text mediumtext longtext enum set date datetime timestamp time year json geometry point linestring polygon multipoint multilinestring multipolygon geometrycollection'.split(' '));
function validateCoherence(rows, native) {
  const select = name => rows.filter(f => f.catalog === name).map(f => f.row);
  const columns = select('COLUMNS');
  for (const r of columns) assert(dataTypes.has(r.DATA_TYPE) && typeof r.COLUMN_TYPE === 'string' && r.COLUMN_TYPE.length && ['YES', 'NO'].includes(r.IS_NULLABLE), 'Unknown/incomplete native column type/nullability');
  for (const r of select('TABLE_CONSTRAINTS')) assert(['PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK'].includes(r.CONSTRAINT_TYPE) && ['YES', 'NO'].includes(r.ENFORCED), 'Unknown native constraint clause');
  for (const r of select('STATISTICS')) assert(['0', '1'].includes(r.NON_UNIQUE) && ['YES', 'NO'].includes(r.IS_VISIBLE), 'Unknown native index clause');
  for (const r of select('VIEWS')) assert(r.VIEW_DEFINITION && ['NONE', 'CASCADED', 'LOCAL'].includes(r.CHECK_OPTION) && ['DEFINER', 'INVOKER'].includes(r.SECURITY_TYPE), 'Hidden/unknown native view clause');
  for (const r of select('TRIGGERS')) assert(r.ACTION_STATEMENT && r.ACTION_ORIENTATION === 'ROW' && ['BEFORE', 'AFTER'].includes(r.ACTION_TIMING) && ['INSERT', 'UPDATE', 'DELETE'].includes(r.EVENT_MANIPULATION), 'Hidden/unknown native trigger clause');
  for (const r of select('ROUTINES')) assert(r.ROUTINE_DEFINITION && r.ROUTINE_BODY === 'SQL' && ['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA'].includes(r.SQL_DATA_ACCESS) && ['DEFINER', 'INVOKER'].includes(r.SECURITY_TYPE), 'Hidden/unknown native routine clause');
  for (const r of select('EVENTS')) assert(r.EVENT_DEFINITION && ['ENABLED', 'DISABLED', 'SLAVESIDE_DISABLED'].includes(r.STATUS) && ['ONE TIME', 'RECURRING'].includes(r.EVENT_TYPE), 'Hidden/unknown native event clause');
  for (const item of native.filter(n => n.type === 'TABLE')) {
    const tokens = sqlTokens(item.definition['Create Table']), start = tokens.findIndex(t => t.value === '(' && t.depth === 0), names = [];
    assert(start > 0, 'Missing native table definition body'); let first = true;
    for (const t of tokens.slice(start + 1)) {
      if (t.value === ')' && t.depth === 0) break;
      if (t.type === 'plain-comment' || t.type === 'comment') continue;
      if (t.depth === 1 && t.value === ',') { first = true; continue; }
      if (first && t.depth === 1) { if (t.type === 'identifier') names.push(t.value); else assert(['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FOREIGN', 'CHECK', 'FULLTEXT', 'SPATIAL'].includes(t.value), 'Unknown native column/constraint clause'); first = false; }
    }
    const fields = columns.filter(c => c.TABLE_SCHEMA === item.schema && c.TABLE_NAME === item.name).map(c => c.COLUMN_NAME);
    assert(names.length && new Set(names).size === names.length && digest([...names].sort()) === digest(fields.sort()), 'Hidden/inconsistent native table columns');
  }
}
export function catalogSnapshot(data, d, permissions) {
  const objects = [];
  for (const f of data.rows) {
    const spec = catalogSpec().find(([, name]) => name === f.catalog);
    const schema = f.row[spec[2]], row = f.row;
    objects.push({ kind: f.kind, schema, name: `${f.catalog}:${digest(row)}`, definition: { catalog: f.catalog, row } });
  }
  const kind = { TABLE: 'tables', VIEW: 'views', TRIGGER: 'triggers', PROCEDURE: 'routines', FUNCTION: 'routines', EVENT: 'routines' };
  for (const item of data.native) objects.push({ kind: kind[item.type], schema: item.schema, name: `native:${item.type}:${item.name}`, definition: item.definition });
  for (const p of permissions.checks) objects.push({ kind: 'permissions', schema: d.scopes[0], name: p.role, definition: p });
  objects.sort((a, b) => Buffer.compare(Buffer.from(JSON.stringify([a.kind, a.schema, a.name])), Buffer.from(JSON.stringify([b.kind, b.schema, b.name]))));
  return { version: 1, engine: 'mysql', identity: d.identity, serverVersion: d.serverVersion, scopes: d.scopes, readerReadOnly: true, permissionEvidence: permissions.hash, testSchemaWrites: false, testIsolated: d.test?.isolated === true, facets: Object.fromEntries(['tables', 'columns', 'constraints', 'indexes', 'views', 'triggers', 'routines', 'permissions'].map(f => [f, 'complete']).concat([['sequences', 'not-applicable'], ['types', 'not-applicable']])), objects };
}
export function metadataRows(snapshot, name) { return snapshot.objects.filter(o => o.definition?.catalog === name).map(o => o.definition.row); }

export class MySQLDatabase {
  #proof = null;
  #dataSQL = null;
  #transport;
  #runner;
  #cwd;
  #record;
  constructor(d, runner, cwd, { record = async () => {} } = {}) {
    assert(d.native?.protocol === protocol, 'Explicit native mysql-cli-v1 profile/confirmation required');
    const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
    Object.defineProperty(this, 'd', { value: freeze(structuredClone(d)), enumerable: true });
    this.#runner = runner; this.#cwd = cwd; this.#record = record;
    this.#transport = new MySQLPreflight(this.d, runner, cwd, { record });
  }
  async #query(sql, connection) {
    const allowed = [this.#identitySQL(), permissionSQL(), `SHOW CREATE PROCEDURE ${qualifiedName(this.d.native.reader.schema, this.d.native.reader.name)};\n`];
    if (this.#proof) { allowed.push(`CALL ${qualifiedName(this.d.native.reader.schema, this.d.native.reader.name)}();\n`); if (this.#dataSQL) allowed.push(this.#dataSQL); }
    assert(allowed.includes(sql), 'Native MySQL guard rejects arbitrary SQL/DDL before dispatch');
    try {
      const out = await this.#runner(this.d.native.client.path, connection.args, { cwd: this.#cwd, env: connection.env, input: sql, timeoutMs: 30000 });
      await this.#record({ queryHash: digest(sql), rawEncoding: 'base64', rawBase64: out.toString('base64'), rawHash: digest(out), byteLength: out.length });
      assert(!out.stderr?.length, 'Unexpected native diagnostic');
      const sets = parseXML(out); return { raw: out.toString('utf8'), sets };
    } catch (error) {
      if (Buffer.isBuffer(error.stdout)) await this.#record({ queryHash: digest(sql), status: 'transport-failed', rawEncoding: 'base64', rawBase64: error.stdout.toString('base64'), rawHash: digest(error.stdout), byteLength: error.stdout.length });
      throw new Error('Native MySQL read-only query failed; no retry/fallback (credential/client diagnostics withheld)');
    }
  }
  #identitySQL() { return 'SELECT VERSION() AS version, @@version_comment AS comment, @@server_uuid AS serverUUID, CURRENT_USER() AS principal, USER() AS authenticatedUser, @@GLOBAL.mandatory_roles AS mandatoryRoles, CAST(@@GLOBAL.partial_revokes AS CHAR) AS partialRevokes, CAST(@@lower_case_table_names AS CHAR) AS lowerCaseNames;\n'; }
  async preflight() {
    this.#proof = null;
    const client = await this.#transport.client(), connection = await this.#transport.connection();
    const read = await this.#query(this.#identitySQL(), connection);
    assert(read.sets.length === 1 && read.sets[0].rows.length === 1, 'Native identity result incomplete'); const identity = read.sets[0].rows[0];
    checkFields(identity, ['version', 'comment', 'serverUUID', 'principal', 'authenticatedUser', 'mandatoryRoles', 'partialRevokes', 'lowerCaseNames']);
    nativeVersion(identity.version, identity.comment);
    assert(identity.version === this.d.serverVersion && identity.serverUUID === this.d.identity && identity.principal === `${this.d.native.principal.user}@${this.d.native.principal.host}` && identity.lowerCaseNames === '0', 'Native version/UUID/principal/case semantics mismatch');
    const audit = await this.#query(permissionSQL(), connection); const permissions = provePermissions(parsePermissionSets(audit.sets), this.d, identity);
    const def = await this.#query(`SHOW CREATE PROCEDURE ${qualifiedName(this.d.native.reader.schema, this.d.native.reader.name)};\n`, connection);
    assert(def.sets.length === 1 && def.sets[0].rows.length === 1, 'Reader definition unavailable'); const r = def.sets[0].rows[0], prepared = prepareNativeReader(this.d);
    showDefinition('PROCEDURE', r, this.d.native.reader.name);
    assert(digest(r['Create Procedure']) === this.d.native.reader.definitionHash && r['Create Procedure'].endsWith(prepared.body) && r['Create Procedure'].startsWith(`CREATE DEFINER=${accountSQL(this.d.native.reader.definer).replaceAll("'", '`')} PROCEDURE ${nativeIdentifier(this.d.native.reader.name)}()`) && r['Create Procedure'].includes('READS SQL DATA') && !r['Create Procedure'].includes('SQL SECURITY INVOKER') && r.sql_mode.split(',').sort().join(',') === 'NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES' && r.character_set_client === 'utf8mb4', 'Reader definition/source/definer/SQL mode changed BEFORE CALL');
    this.#proof = { client, identity, permissions, definitionHash: digest(r['Create Procedure']), sourceHash: digest(await nativeSourceHashes()) };
    return { ...this.#proof, connection };
  }
  async collect() {
    const before = await this.preflight();
    const sql = `CALL ${qualifiedName(this.d.native.reader.schema, this.d.native.reader.name)}();\n`;
    const first = parseCatalogSets((await this.#query(sql, before.connection)).sets, this.d);
    // Fresh pre-CALL proof for each dispatch, then a second full native collection.
    const middle = await this.preflight(); assert(digest({ ...before, connection: undefined }) === digest({ ...middle, connection: undefined }), 'Native grants/client/reader changed during catalog collection');
    const second = parseCatalogSets((await this.#query(sql, middle.connection)).sets, this.d);
    const after = await this.preflight(); assert(digest({ ...middle, connection: undefined }) === digest({ ...after, connection: undefined }), 'Native authority changed after collection');
    const snapshot = catalogSnapshot(first, this.d, before.permissions), check = catalogSnapshot(second, this.d, after.permissions);
    assert(digest(snapshot) === digest(check), 'Native catalog changed during collection');
    return { snapshot, binding: { client: before.client, identity: before.identity, readerDefinitionHash: before.definitionHash, permissionHash: before.permissions.hash, sourceHash: before.sourceHash }, catalogHash: digest(snapshot), qualified: false };
  }
  async readTarget(fixture) {
    assert(this.d.test?.targets.some(t => t.schema === fixture.schema && t.table === fixture.table) && Object.keys(fixture).every(k => ['schema', 'table', 'key'].includes(k)), 'Read probe outside approved native fixture targets');
    const before = await this.collect(), policy = nativeFixturePolicy(before.snapshot, this.d), sql = nativeDataSQL(policy, fixture);
    const authority = await this.preflight();
    assert(before.binding.permissionHash === authority.permissions.hash && before.binding.readerDefinitionHash === authority.definitionHash && before.binding.sourceHash === authority.sourceHash, 'Native authority changed before fixture probe');
    let read;
    try { this.#dataSQL = sql; read = await this.#query(sql, authority.connection); }
    finally { this.#dataSQL = null; }
    const data = parseNativeData(read.sets, policy, fixture), after = await this.collect();
    assert(before.catalogHash === after.catalogHash && digest(before.binding) === digest(after.binding), 'Native schema/authority changed during fixture probe');
    const selector = { schema: fixture.schema, table: fixture.table };
    if (fixture.key) selector.key = Object.fromEntries(Object.entries(fixture.key).sort(([a], [b]) => { if (a < b) return -1; if (a > b) return 1; return 0; }));
    return { ...data, readHash: digest(read.raw), bindingHash: digest(before.binding), selectorHash: digest(selector), binding: before.binding, qualified: false };
  }
  async doctor() { const result = await this.collect(); return { version: 1, database: this.d.id, ...result.binding, catalogHash: result.catalogHash, completeCatalog: true, readerExecution: 'native-audited', permissionAudit: 'native-role-closure', ready: true, qualified: false, next: 'Human-approved native application qualification is separate; no write/publication/start authority from doctor' }; }
}
