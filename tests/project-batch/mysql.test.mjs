import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { digest } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';
import { DatabaseGate } from '../../skills/in-progress/project-batch/scripts/lib/database.mjs';
import { validateProfile, sourceHashes } from '../../skills/in-progress/project-batch/scripts/lib/project.mjs';
import { identifier, nativeVersion, prepareReader, parseXML, parseFrames, MySQLPreflight, permissionCatalog, auditPermissions } from '../../skills/in-progress/project-batch/scripts/lib/mysql.mjs';
import { main } from '../../skills/in-progress/project-batch/scripts/project-batch.mjs';

const escape = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const xml = rows => Buffer.from(`<?xml version="1.0"?>\n<resultset statement="SELECT readback" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${rows.map(r => `<row>${Object.entries(r).map(([k, v]) => v === null ? `<field name="${escape(k)}" xsi:nil="true" />` : `<field name="${escape(k)}">${escape(v)}</field>`).join('')}</row>`).join('')}</resultset>\n`);
const frameXML = frames => xml(frames.map(f => ({ PB_FRAME: Buffer.from(JSON.stringify(f)).toString('hex').toUpperCase() })));
const database = () => ({ id: 'trial', engine: 'mysql', identity: '11111111-2222-3333-4444-555555555555', serverVersion: '8.3.0', scopes: ['app中文', 'scope`quote'], native: {
  version: 1, client: { path: '/approved/mysql', version: 'mysql  Ver 8.3.0 for Linux on x86_64 (MySQL Community Server - GPL)', sha256: 'a'.repeat(64) },
  endpoint: { host: 'db.example.test', port: 3306, serverUUID: '11111111-2222-3333-4444-555555555555', tlsMode: 'VERIFY_IDENTITY', caFile: '/approved/ca.pem' },
  credentials: { readerFileRef: 'PB_MYSQL_READER_TEST_FILE' }, principal: { user: 'reader', host: '%' },
  reader: { schema: 'control', name: 'read_catalog', definer: { user: 'locked_metadata', host: 'localhost' }, definitionHash: 'b'.repeat(64) },
  authorization: { scope: 'isolated-read-only', evidence: 'Human named this fictional isolated unit-test endpoint; no live authority' },
} });
const profile = d => ({ version: 1, id: 'sample', repositoryBase: 'a'.repeat(40), targetBranch: 'main', tracker: { provider: 'local', origin: 'local://sample', projectId: 'sample', projectPath: 'sample' }, standards: ['README.md'], databases: [d] });
function emptyFrames(d) {
  const p = prepareReader(d), names = [...p.sql.matchAll(/'kind', 'facet-end', 'catalog', '([^']+)'/g)].map(m => m[1]);
  return [{ version: 1, kind: 'begin', scopeHash: digest(d.scopes) }, ...names.map(catalog => ({ kind: 'facet-end', catalog })), { kind: 'end', scopeHash: digest(d.scopes), mandatoryRoles: '' }];
}
async function fixture(t, change = () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mysql preparation 中文 ')); t.after(() => rm(dir, { recursive: true, force: true }));
  const d = database(), client = path.join(dir, 'mysql'), credential = path.join(dir, 'reader.cnf');
  await writeFile(client, 'mock mysql client bytes', { mode: 0o700 }); await writeFile(credential, '[client]\nuser=reader\npassword=never-log-this-test-secret\n', { mode: 0o600 });
  d.native.client.path = client; d.native.client.sha256 = digest(await readFile(client));
  const prior = process.env.PB_MYSQL_READER_TEST_FILE; process.env.PB_MYSQL_READER_TEST_FILE = credential;
  t.after(() => { if (prior === undefined) delete process.env.PB_MYSQL_READER_TEST_FILE; else process.env.PB_MYSQL_READER_TEST_FILE = prior; });
  const proposal = prepareReader(d), body = proposal.sql.slice(proposal.sql.indexOf('BEGIN\n'), proposal.sql.indexOf('END$$') + 3);
  const definition = `CREATE DEFINER=\`locked_metadata\`@\`localhost\` PROCEDURE \`read_catalog\`()\nREADS SQL DATA\n${body}`;
  d.native.reader.definitionHash = digest(definition);
  const state = { grants: ['USAGE ON *.*', 'SHOW_ROUTINE ON *.*', 'SELECT, SHOW VIEW ON `app中文`.*', 'SELECT, SHOW VIEW ON `scope``quote`.*', 'EXECUTE ON PROCEDURE `control`.`read_catalog`'], identity: { version: '8.3.0', comment: 'MySQL Community Server - GPL', serverUUID: d.identity, principal: 'reader@%', authenticatedUser: 'reader@test-host', mandatoryRoles: '' }, definition, frames: emptyFrames(d), calls: [] };
  const pos = state.frames.findIndex(f => f.catalog === 'user');
  for (const a of [d.native.principal, d.native.reader.definer]) {
    const row = Object.fromEntries(permissionCatalog[0][1].map(k => [k, k === 'User' ? a.user : k === 'Host' ? a.host : k === 'account_locked' && a.user === 'locked_metadata' ? 'Y' : 'N']));
    state.frames.splice(pos, 0, { kind: 'permissions', catalog: 'user', row });
  }
  change(state, d);
  const runner = async (file, args, opts) => {
    state.calls.push({ file, args, opts });
    if (args.includes('--version')) return Buffer.from(d.native.client.version);
    if (opts.input.startsWith('SELECT VERSION')) return xml([state.identity]);
    if (opts.input.startsWith('SHOW GRANTS')) return xml(state.grants.map(s => ({ 'Grants for reader@%': `GRANT ${s} TO \`reader\`@\`%\`` })));
    if (opts.input.startsWith('SHOW CREATE')) return xml([{ Procedure: 'read_catalog', sql_mode: 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES', 'Create Procedure': state.definition, character_set_client: 'utf8mb4', collation_connection: 'utf8mb4_0900_ai_ci', 'Database Collation': 'utf8mb4_0900_ai_ci' }]);
    if (opts.input.startsWith('CALL')) return frameXML(state.frames);
    throw new Error('Unexpected query (secret never-log-this-test-secret)');
  };
  return { dir, d, credential, runner, state, adapter: new MySQLPreflight(d, runner, dir) };
}

test('native configuration is explicit, credential-free, and cannot use a custom inspector fallback', () => {
  const d = database(); validateProfile(profile(d));
  for (const alter of [
    d => { d.native.password = 'secret'; }, d => { d.native.credentials.readerFileRef = '/secret'; },
    d => { d.inspect = { file: 'fake', args: [] }; }, d => { d.native.certified = true; },
    d => { d.native.qualification = true; }, d => { d.native.reader.definer = d.native.principal; },
    d => { d.native.reader.schema = d.scopes[0]; }, d => { d.native.endpoint.tlsMode = 'DISABLED'; },
    d => { d.native.writer = { principal: { user: 'writer', host: '%' }, hookScript: '../escape', settleScript: 'settle.mjs' }; },
  ]) { const clone = structuredClone(d); alter(clone); assert.throws(() => validateProfile(profile(clone))); }
});

test('native version gate accepts exact 8.1–8.3, refuses compatibility/version guesses', () => {
  for (const v of ['8.1.0', '8.2.0', '8.3.0-commercial']) assert.equal(nativeVersion(v, 'MySQL Enterprise Server - Commercial'), v);
  for (const [v, c] of [['8.0.40', 'MySQL Community Server - GPL'], ['8.4.0', 'MySQL Community Server - GPL'], ['9.0.0', 'MySQL Community Server - GPL'], ['8.3', 'MySQL Community Server - GPL'], ['8.3.0', 'Percona Server'], ['8.3.0', 'TiDB'], ['8.3.0', 'MariaDB Server']]) assert.throws(() => nativeVersion(v, c));
});

test('candidate reader SQL has fixed scope, locked definer, no password, no writer grants or arbitrary SQL', () => {
  const d = database(), p = prepareReader(d);
  assert.equal(p.executable, false); assert.equal(p.qualified, false); assert.equal(p.sqlHash, digest(p.sql));
  assert.match(p.sql, /CREATE USER 'locked_metadata'@'localhost' ACCOUNT LOCK/);
  assert.match(p.sql, /PROCEDURE `control`.`read_catalog`\(\)/);
  assert.equal(identifier('scope`quote'), '`scope``quote`');
  assert.match(p.sql, /GRANT SELECT, SHOW VIEW ON `scope``quote`\.\*/);
  const body = p.sql.slice(p.sql.indexOf('BEGIN\n'), p.sql.indexOf('END$$') + 3);
  assert.doesNotMatch(body, /\b(?:PREPARE|EXECUTE|CALL|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\s/i);
  assert.doesNotMatch(p.sql, /authentication_string|IDENTIFIED BY|PASSWORD\s*=/i);
  assert.doesNotMatch(p.sql, /TABLE_ROWS|CARDINALITY|AUTO_INCREMENT|CREATE_TIME|UPDATE_TIME/);
  assert.match(p.sql, /PARTITION_DESCRIPTION/); assert.match(p.sql, /GENERATION_EXPRESSION/);
});

test('identifier controls fail closed; Unicode and backticks remain lossless', () => {
  for (const v of ['', 'a\0b', 'a\nb', 'a\tb', 'a'.repeat(65), '\ud800', '中文😀']) assert.throws(() => identifier(v));
  assert.equal(identifier('中文`'), '`中文```');
});

test('mysql XML retains Unicode, multiline/tab/backslash/NULL and precision as strings', () => {
  const rows = [{ name: '中文😀`\n\t\\<&"', default: null, precision: '18446744073709551615.123456', empty: '', '__proto__': 'ignored JS literal' }];
  const out = parseXML(xml(rows)); assert.deepEqual(out[0].rows, rows);
  assert.equal(parseXML(xml([]))[0].rows.length, 0);
  assert.equal(parseXML(Buffer.concat([xml(rows), xml([])])).length, 2);
  assert.equal(parseXML(xml([{ numeric: '&#x4e2d;' }]))[0].rows[0].numeric, '&#x4e2d;');
});

test('mysql XML rejects truncation, unknown entities/markup, duplicate fields and invalid UTF8', () => {
  const original = xml([{ name: 'value' }]).toString();
  for (const text of [original.slice(0, -15), original + 'warning', original.replace('value', '&other;'), original.replace('value', '<![CDATA[value]]>'), original.replace('<row>', '<!DOCTYPE row><row>'), original.replace('</row>', '<field name="name">duplicate</field></row>')]) assert.throws(() => parseXML(Buffer.from(text)));
  assert.throws(() => parseXML(Buffer.from([0xc3, 0x28])));
});

test('metadata framing proves all explicit empty facets and rejects missing, duplicated, unknown, reordered or truncated frames', () => {
  const d = database(), frames = emptyFrames(d); assert.equal(parseFrames(parseXML(frameXML(frames)), d).length, frames.length);
  for (const f of [frames.slice(0, -1), frames.slice(1), [frames[0], ...frames.slice(2)], [frames[0], frames[2], frames[1], ...frames.slice(3)], [...frames.slice(0, -1), { ...frames.at(-1), scopeHash: 'wrong' }], [...frames.slice(0, -1), { ...frames.at(-1), mandatoryRoles: 'dangerous' }], [frames[0], { kind: 'facet-end', catalog: 'unknown' }, ...frames.slice(1)]]) assert.throws(() => parseFrames(parseXML(frameXML(f)), d));
  assert.throws(() => parseFrames(parseXML(xml([{ PB_FRAME: 'ABCD0' }])), d));
});

test('native metadata unsafe numeric values or out-of-scope rows cannot claim complete facets', () => {
  const d = database(), frames = emptyFrames(d);
  for (const row of [{ TABLE_SCHEMA: 'foreign', TABLE_NAME: 't' }, { TABLE_SCHEMA: d.scopes[0], TABLE_NAME: 't', counter: 1.2 }, { TABLE_SCHEMA: d.scopes[0], TABLE_NAME: 't' }]) assert.throws(() => parseFrames(parseXML(frameXML([frames[0], { kind: 'tables', catalog: 'TABLES', row }, ...frames.slice(1)])), d));
});

test('native preflight pins client bytes/version and actual server/principal before reader calls', async t => {
  const f = await fixture(t); const result = await f.adapter.doctor();
  assert.equal(result.qualified, false); assert.equal(result.ready, false); assert.equal(result.identity.version, '8.3.0');
  assert.equal(result.rawEvidence.metadata, undefined); assert.equal(result.readerExecution, 'blocked'); assert.equal(result.permissionAudit, 'unverified'); assert.equal(f.state.calls[0].args.includes('--no-defaults'), true);
  for (const c of f.state.calls.slice(1)) { assert.equal(c.opts.input.includes('never-log-this-test-secret'), false); assert.equal(c.args.includes('--skip-reconnect'), true); assert.equal(c.args.includes('--binary-mode'), true); assert.equal(c.args.includes('--ssl-mode=VERIFY_IDENTITY'), true); assert.equal(Object.values(c.opts.env).includes('never-log-this-test-secret'), false); }
  await writeFile(f.d.native.client.path, 'changed client'); await assert.rejects(f.adapter.doctor(), /integrity/);
});

for (const [name, patch] of [
  ['server identity', s => { s.identity.serverUUID = 'foreign'; }], ['principal', s => { s.identity.principal = 'root@localhost'; }],
  ['version', s => { s.identity.version = '8.4.0'; }], ['mandatory role', s => { s.identity.mandatoryRoles = 'admin'; }],
  ['high privilege', s => { s.grants.push('ALL PRIVILEGES ON *.*'); }], ['reader trigger', s => { s.grants.push('TRIGGER ON `app中文`.*'); }],
  ['reader role', s => { s.grants.push('`admin`@`%`'); }], ['grant option', s => { s.grants.push('SELECT ON `app中文`.* TO `reader`@`%` WITH GRANT OPTION'); }],
  ['reader definition', s => { s.definition += '\nchanged'; }], ['unlocked definer', s => { s.frames.find(f => f.row?.User === 'locked_metadata').row.account_locked = 'N'; }],
  ['global definer grant', s => { s.frames.find(f => f.row?.User === 'locked_metadata').row.Super_priv = 'Y'; }],
  ['assigned role', s => { s.frames.splice(s.frames.findIndex(f => f.catalog === 'role_edges'), 0, { kind: 'permissions', catalog: 'role_edges', row: { FROM_USER: 'admin', FROM_HOST: '%', TO_USER: 'reader', TO_HOST: '%', WITH_ADMIN_OPTION: 'N' } }); }],
]) test(`native preflight rejects ${name}; no application effects`, async t => {
  const f = await fixture(t, patch);
  if (['unlocked definer', 'global definer grant', 'assigned role'].includes(name)) {
    assert.throws(() => auditPermissions(parseFrames(parseXML(frameXML(f.state.frames)), f.d), f.d)); // candidate audit only; cannot authorize CALL
    const result = await f.adapter.doctor(); assert.equal(result.readerExecution, 'blocked'); assert.equal(result.permissionAudit, 'unverified');
  } else await assert.rejects(f.adapter.doctor());
  assert.equal(f.state.calls.some(c => /^(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/.test(c.opts.input?.split('\n')[0] ?? '')), false);
  assert.equal(f.state.calls.some(c => c.opts.input?.startsWith('CALL')), false);
});

test('even a matching reader definition/flat grants cannot authorize CALL without pre-call definer proof', async t => {
  const f = await fixture(t), result = await f.adapter.doctor();
  assert.equal(f.state.calls.some(c => c.opts.input?.startsWith('CALL')), false);
  assert.equal(result.readerExecution, 'blocked'); assert.equal(result.permissionAudit, 'unverified');
  const c = await f.adapter.connection();
  await assert.rejects(f.adapter.query('CALL `control`.`read_catalog`();\n', c), /guard rejects/);
});

test('invalid UTF8 response is durably preserved as exact bytes before rejection', async t => {
  const f = await fixture(t), c = await f.adapter.connection(), raw = Buffer.from([0xc3, 0x28, 0, 255]);
  const recorded = []; f.adapter.record = async v => recorded.push(v); f.adapter.runner = async () => raw;
  await assert.rejects(f.adapter.query(f.adapter.statements().identity, c), /withheld/);
  assert.equal(recorded.length, 1); assert.deepEqual(Buffer.from(recorded[0].rawBase64, 'base64'), raw);
  assert.equal(recorded[0].rawHash, digest(raw)); assert.equal(recorded[0].raw, undefined);
});

test('credential file includes, init-command, permissions and principal mismatches stop locally', async t => {
  const f = await fixture(t);
  for (const text of ['!include /other', '[client]\nuser=reader\npassword=test\ninit-command=DROP TABLE t', '[client]\nuser=root\npassword=test', '[client]\nuser=reader\npassword=test\n[mysql]\n', '[client]\nuser=reader\npassword=test\npassword=test2']) {
    await writeFile(f.credential, text); await assert.rejects(f.adapter.doctor());
    assert.equal(f.state.calls.some(c => c.opts.input), false);
  }
  await writeFile(f.credential, '[client]\nuser=reader\npassword=test\n'); await chmod(f.credential, 0o644); await assert.rejects(f.adapter.doctor(), /owner-only/);
});

test('client connection failures with secrets are withheld, not copied into logs', async t => {
  const f = await fixture(t); const c = await f.adapter.connection();
  f.adapter.runner = async () => { throw new Error('never-log-this-test-secret password=test'); };
  await assert.rejects(f.adapter.query(f.adapter.statements().identity, c), e => !e.message.includes('never-log-this-test-secret') && /withheld/.test(e.message));
});

test('native local guard rejects DDL/arbitrary SQL without sending it to any client', async t => {
  const f = await fixture(t), c = await f.adapter.connection();
  for (const sql of ['CREATE TABLE t(id int);', 'ALTER TABLE t ADD x int;', 'DROP TABLE t;', 'INSERT INTO t VALUES (1);', 'DELETE FROM t;', 'SELECT 1;', 'CALL control.other();', 'CALL `control`.`read_catalog`();\nDELETE FROM t;']) await assert.rejects(f.adapter.query(sql, c), /guard rejects/);
  assert.equal(f.state.calls.length, 0);
});

test('native qualification cannot be forged by hash references, custom assertions or a fake certified boolean', async t => {
  const f = await fixture(t); f.d.native.qualification = 'fake.json'; await writeFile(path.join(f.dir, 'fake.json'), '{"certified":true}');
  const gate = new DatabaseGate({ databases: [f.d] }, f.runner, f.dir, f.dir, async () => {});
  await assert.rejects(gate.observe(), /qualification blocked/); assert.equal(f.state.calls.length, 0);
  f.d.test = { targets: [] };
  await assert.rejects(gate.execute({ runtime: { testRuns: [] } }, { database: f.d.id }, async () => {}, 'a'.repeat(64)), /qualification blocked/);
  assert.equal(f.state.calls.length, 0);
});

test('native doctor stores separate evidence, not a complete schema or passing qualification', async t => {
  const f = await fixture(t), gate = new DatabaseGate({ databases: [f.d] }, f.runner, f.dir, f.dir, async () => {});
  const [a] = await gate.doctor(), [b] = await gate.doctor();
  assert.notEqual(a.evidence, b.evidence); assert.equal(a.rawEvidence, undefined); assert.equal(a.ready, false);
  const saved = JSON.parse(await readFile(a.evidence, 'utf8')); assert.equal(saved.qualified, false); assert.ok(saved.rawEvidence);
});

test('failed native preflight keeps actual earlier readbacks and does not erase successful attempts', async t => {
  const f = await fixture(t), gate = new DatabaseGate({ databases: [f.d] }, f.runner, f.dir, f.dir, async () => {});
  const [good] = await gate.doctor(); const original = await readFile(good.evidence);
  f.state.definition += 'tampered'; await assert.rejects(gate.doctor(), /definition changed/);
  const names = (await readdir(f.dir)).filter(name => name.startsWith('mysql-preflight-'));
  assert.equal(names.length, 2); assert.deepEqual(await readFile(good.evidence), original);
  const failed = JSON.parse(await readFile(path.join(f.dir, names.find(name => name !== path.basename(good.evidence))), 'utf8'));
  assert.equal(failed.status, 'blocked'); assert.equal(failed.qualified, false); assert.equal(failed.observations.length, 3);
  assert.match(Buffer.from(failed.observations.at(-1).rawBase64, 'base64').toString('utf8'), /tampered/); assert.doesNotMatch(JSON.stringify(failed), /never-log-this-test-secret/);
});

test('reader preparation needs no pre-existing definition hash, but normal profile initialization still does', () => {
  const d = database(); delete d.native.reader.definitionHash;
  assert.equal(prepareReader(d).qualified, false); assert.throws(() => validateProfile(profile(d)), /definition hash/);
});

test('offline reader preparation works without a checkout/DB/client and refuses confirmation/options on wrong commands', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'input.json'); await writeFile(file, JSON.stringify({ databases: [database()] }));
  const out = await main(['init', '--prepare-reader', '--input', file, '--cwd', '/does-not-exist']);
  assert.equal(out.applied, false); assert.equal(out.profilesChanged, false); assert.equal(out.packages.length, 1);
  await assert.rejects(main(['init', '--prepare-reader', '--input', file, '--confirm', 'a'.repeat(64)]), /offline/);
  await assert.rejects(main(['doctor', '--prepare-reader', '--input', file]), /offline/);
  await assert.rejects(main(['schema', '--qualify', '--cwd', '/does-not-exist']), /qualification blocked/);
  await assert.rejects(main(['plan', '--qualify']), /only to schema/);
  await assert.rejects(main(['init', '--prepare-reader', '--prepare-reader', '--input', file]), /Duplicate/);
});

test('native writer and qualification sources remain part of confirmed repository source hashes', async t => {
  const f = await fixture(t), d = f.d; d.native.writer = { principal: { user: 'writer', host: '%' }, hookScript: 'writer.mjs', settleScript: 'settle.mjs' }; d.native.qualification = 'qualification.json';
  for (const name of ['README.md', 'writer.mjs', 'settle.mjs', 'qualification.json']) await writeFile(path.join(f.dir, name), name);
  const first = await sourceHashes(f.dir, profile(d)); assert.ok(first.some(s => s.path === 'writer.mjs'));
  await writeFile(path.join(f.dir, 'settle.mjs'), 'changed fence'); assert.notDeepEqual(await sourceHashes(f.dir, profile(d)), first);
});
