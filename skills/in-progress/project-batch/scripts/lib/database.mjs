import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assert, digest } from './contracts.mjs';
import { command, commandEnvironment, redact } from './project.mjs';
import { atomicJSON } from './store.mjs';
import { loadLedger } from './fixtures.mjs';
import { MySQLPreflight, requireNativeQualification } from './mysql.mjs';
import { MySQLDatabase } from './mysql-catalog.mjs';

export class SchemaDriftError extends Error {
  constructor(id) { super(`Schema drift: ${id}; confirm a complete plan revision before continuation`); this.code = 'SCHEMA_DRIFT'; }
}
export const sqlPackageHash = p => digest((p.database?.targets ?? []).map(t => ({ id: t.id, hash: t.sql?.hash ?? null })));

const facets = ['tables', 'columns', 'constraints', 'indexes', 'views', 'triggers', 'sequences', 'routines', 'types', 'permissions'];
const notApplicable = { mysql: ['sequences', 'types'], mariadb: ['types'], sqlite: ['sequences', 'routines', 'types', 'permissions'] };
export function canonical(value) {
  if (typeof value === 'number') assert(Number.isSafeInteger(value), 'Schema numbers require safe integers or lossless strings');
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function snapshot(v, d) {
  assert(v?.version === 1 && v.engine === d.engine && v.identity === d.identity && v.serverVersion === d.serverVersion, 'Schema engine/version/database identity mismatch');
  assert(Array.isArray(v.scopes) && digest([...v.scopes].sort()) === digest([...d.scopes].sort()), 'Schema scope mismatch');
  assert(v.readerReadOnly === true && typeof v.permissionEvidence === 'string' && v.permissionEvidence.trim(), 'Read-only account permission evidence required');
  if (d.test) assert(v.testSchemaWrites === false && v.testIsolated === true, 'Application tests require isolated DB and schema-write denial/guard');
  for (const f of facets) assert(v.facets?.[f] === 'complete' || v.facets?.[f] === 'not-applicable' && notApplicable[d.engine]?.includes(f), `Incomplete schema facet: ${f}`);
  assert(Array.isArray(v.objects), 'Complete schema objects required');
  const keys = new Set();
  const objects = v.objects.map(o => {
    assert(o && facets.includes(o.kind) && d.scopes.includes(o.schema) && typeof o.name === 'string' && o.name && o.definition !== undefined && o.definition !== null, 'Invalid schema object');
    const key = JSON.stringify([o.kind, o.schema, o.name]); assert(!keys.has(key), 'Duplicate schema object'); keys.add(key);
    return canonical(o);
  }).sort((a, b) => { const x = JSON.stringify([a.kind, a.schema, a.name]), y = JSON.stringify([b.kind, b.schema, b.name]); return x < y ? -1 : x > y ? 1 : 0; });
  // Permission assertions are verified separately; hash only stable logical schema, not timing, row counts or sequence counters.
  const logical = canonical({ engine: v.engine, identity: v.identity, serverVersion: v.serverVersion, scopes: [...v.scopes].sort(), facets: v.facets, objects });
  return { ...logical, hash: digest(logical) };
}
export function validateDatabasePlan(p, profile) {
  if (!profile) { assert(!p.database, 'Database plan requires a ProjectProfile'); return; }
  for (const field of ['requirements', 'design', 'boundaries', 'implementation', 'testing', 'risks']) assert(typeof p.planning?.[field] === 'string' && p.planning[field].trim(), `Complete planning requires ${field}`);
  assert(p.database?.version === 1 && Array.isArray(p.database.targets) && p.database.targets.length === profile.databases.length, 'Declare every database target, including [] for no DB');
  const ids = new Set();
  for (const t of p.database.targets) {
    const d = profile.databases.find(d => d.id === t.id); assert(d && !ids.has(t.id), 'Unknown/duplicate schema target'); ids.add(t.id);
    const before = snapshot(t.before, d), after = snapshot(t.after, d);
    if (t.sql) assert(typeof t.sql.text === 'string' && t.sql.text.trim() && t.sql.hash === digest(t.sql.text), 'Complete immutable SQL text and SHA256 required');
    else assert(before.hash === after.hash, 'Schema changes require upfront human-executed SQL');
  }
  for (const c of [...p.issues.flatMap(i => i.verify), ...p.verify]) {
    command(c); assert(['offline', 'read-only', 'application-write'].includes(c.effect), 'Classify every verification command before publication');
    if (c.effect === 'application-write') assert(profile.databases.some(d => d.id === c.database && d.test), 'Application-write tests require configured isolated database cleanup');
  }
}
function parse(bytes, label) { try { return JSON.parse(bytes.toString()); } catch { throw new Error(`${label} returned invalid JSON`); } }
export class DatabaseGate {
  constructor(profile, runner, cwd, evidenceRoot, save) { this.profile = profile; this.runner = runner; this.cwd = cwd; this.root = evidenceRoot; this.save = save; }
  async invoke(c, extra = {}) {
    try { return await this.runner(c.file, c.args, { cwd: this.cwd, timeoutMs: c.timeoutMs ?? 300000, env: commandEnvironment(c, extra) }); }
    catch (e) { throw new Error(redact(e.message, c)); }
  }
  async doctor() {
    const rows = [];
    for (const d of this.profile.databases) {
      if (!d.native) { rows.push({ id: d.id, ...snapshot(parse(await this.invoke(d.inspect), 'Read-only schema inspector'), d), nativeQualified: false }); continue; }
      const evidence = path.join(this.root, `mysql-preflight-${randomUUID()}.json`);
      const attempt = { version: 1, database: d.id, targetHash: digest(d), status: 'pending', observations: [], qualified: false };
      await atomicJSON(evidence, attempt);
      try {
        const record = async observation => { attempt.observations.push(observation); await atomicJSON(evidence, attempt); };
        const Adapter = d.native.protocol === 'mysql-cli-v1' ? MySQLDatabase : MySQLPreflight;
        const result = await new Adapter(d, this.runner, this.cwd, { record }).doctor();
        await atomicJSON(evidence, { ...attempt, ...result, status: d.native.protocol === 'mysql-cli-v1' ? 'native-read-only' : 'preflight-only' });
        const { rawEvidence: _rawEvidence, ...summary } = result;
        rows.push({ ...summary, evidence });
      } catch (error) {
        // Native adapter withholds credential/client diagnostics. Each attempt
        // retains prior readbacks even when a later check/target fails.
        await atomicJSON(evidence, { ...attempt, status: 'blocked', error: error.message });
        throw new Error(`${error.message}; native preflight evidence: ${evidence}`);
      }
    }
    return rows;
  }
  async observe(s) {
    if (s) assert(!s.schemaBlocked?.requiresRevision || s.schemaBlocked.planHash !== s.planHash, 'Schema drift needs a confirmed complete plan revision; old read-back cannot clear it');
    const rows = [];
    for (const d of this.profile.databases) {
      if (d.native) requireNativeQualification(); // never use custom assertions as native catalog/qualification
      const raw = parse(await this.invoke(d.inspect), 'Read-only schema inspector');
      const row = { id: d.id, ...snapshot(raw, d) }; rows.push(row);
      const t = s?.plan.database.targets.find(t => t.id === d.id);
      // Persist each complete readback before a later inspector can fail.
      if (t && row.hash !== snapshot(t.after, d).hash && (!t.sql || s.databaseEvidence?.planHash === s.planHash)) {
        const error = new SchemaDriftError(t.id);
        s.schemaBlocked = { planHash: s.planHash, reason: error.message, requiresRevision: true }; s.state = 'blocked';
        if (s.runtime) { s.runtime.blocker = error.message; if (!s.runtime.integration?.merged) s.runtime.candidate = null; }
        assert(typeof this.save === 'function', 'Schema observation requires durable drift persistence'); await this.save(s);
        throw error;
      }
    }
    return rows;
  }
  async ready(s) {
    validateDatabasePlan(s.plan, this.profile);
    const observations = await this.observe(s);
    for (const t of s.plan.database.targets) {
      const d = this.profile.databases.find(d => d.id === t.id);
      if (observations.find(o => o.id === t.id)?.hash !== snapshot(t.after, d).hash) {
        // A pending human SQL package may be incomplete, not unapproved drift.
        // Once SQL is attested (or no DDL was planned), mismatches are sticky.
        if (!t.sql || s.databaseEvidence?.planHash === s.planHash) throw new SchemaDriftError(t.id);
        throw new Error(`Schema gate blocked: ${t.id}; execute/reconcile approved DDL before implementation`);
      }
      if (t.sql) assert(s.databaseEvidence?.planHash === s.planHash && s.databaseEvidence.executions.some(e => e.id === t.id && e.sqlHash === t.sql.hash), `Human SQL execution confirmation missing: ${t.id}`);
    }
    return observations;
  }
  async cleanup(s, run, save) {
    const d = this.profile.databases.find(d => d.id === run.database);
    assert(d?.test && run.planHash === s.planHash && run.profileHash === s.plan.profileHash && run.identity === d.identity, 'Pending cleanup authority/identity changed; preserve ledger for explicit recovery');
    const env = { GB_TEST_RUN_ID: run.id, GB_TEST_DATABASE_ID: d.id, GB_TEST_DATABASE_IDENTITY: d.identity, GB_FIXTURE_LEDGER_PATH: run.ledger };
    await this.ready(s);
    const owned = await loadLedger(run.ledger, run, d);
    const probeValid = p => p.version === 1 && p.testRunId === run.id && p.databaseId === d.id && p.identity === d.identity && p.readerReadOnly === true && p.quiescent === true && p.ledgerHash === owned.hash && Array.isArray(p.coveredIntents) && digest(p.coveredIntents) === digest(owned.intentIds) && typeof p.ownershipEvidence === 'string' && p.ownershipEvidence.trim() && typeof p.writerEvidence === 'string' && p.writerEvidence.trim();
    const settled = parse(await this.invoke(d.test.leftovers, env), 'Read-only quiescence check');
    assert(probeValid(settled) && Number.isSafeInteger(settled.remaining) && settled.remaining >= 0, 'Test writers unsettled or fixture ledger ownership probe invalid; do not delete');
    assert(owned.intentIds.length || settled.remaining === 0, 'Owned rows without durable fixture ledger intents; no deletion authority');
    assert((await loadLedger(run.ledger, run, d)).hash === owned.hash, 'Fixture ledger changed during writer/ownership probe');
    let removal = { version: 1, testRunId: run.id, databaseId: d.id, identity: d.identity, scope: 'owned-test-data', ledgerHash: owned.hash, coveredIntents: [], removed: 0, status: 'no-fixtures-no-dispatch' };
    if (owned.intentIds.length) {
      assert((run.cleanupAttempts ?? 0) < 3, 'Cleanup retry budget exhausted; preserve ledger and stop for explicit recovery');
      run.cleanupAttempts = (run.cleanupAttempts ?? 0) + 1; await save(s); // consume before destructive dispatch; response loss is not a free retry
      removal = parse(await this.invoke(d.test.cleanup, env), 'Owned test-data cleanup');
    }
    assert(removal.version === 1 && removal.testRunId === run.id && removal.databaseId === d.id && removal.identity === d.identity && removal.scope === 'owned-test-data' && removal.ledgerHash === owned.hash && Array.isArray(removal.coveredIntents) && digest(removal.coveredIntents) === digest(owned.intentIds) && Number.isSafeInteger(removal.removed) && removal.removed >= 0, 'Cleanup receipt ownership mismatch');
    const remaining = parse(await this.invoke(d.test.leftovers, env), 'Read-only leftover check');
    assert(probeValid(remaining) && remaining.remaining === 0, 'Cleanup incomplete: owned rows remain or asynchronous writers are not settled');
    assert((await loadLedger(run.ledger, run, d)).hash === owned.hash, 'Fixture ledger changed during cleanup; evidence invalid');
    const after = await this.ready(s);
    run.cleanup = { status: 'pass', ledgerHash: owned.hash, removal, remaining, schemaHash: digest(after) }; await save(s);
  }
  async recoverCleanup(s, save) {
    for (const r of s.runtime.testRuns ?? []) if (r.cleanup?.status !== 'pass') await this.cleanup(s, r, save);
  }
  async execute(s, c, save, sourceFingerprint) {
    assert(typeof sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(sourceFingerprint), 'Verification source fingerprint required');
    assert(!(s.runtime.testRuns ?? []).some(r => r.cleanup?.status !== 'pass'), 'Pending test-data cleanup blocks new tests');
    const d = this.profile.databases.find(d => d.id === c.database);
    assert(d?.test, 'Unknown application-write test database');
    if (d.native) requireNativeQualification(); // before journaling/dispatch; no native writer exists yet
    const before = await this.ready(s);
    const id = randomUUID(), ledger = path.join(this.root, `fixtures-${id}.json`);
    const r = { id, purpose: 'delivery', database: d.id, identity: d.identity, planHash: s.planHash, profileHash: s.plan.profileHash, commandHash: digest(c), sourceFingerprint, sqlPackageHash: sqlPackageHash(s.plan), before, ledger, cleanup: { status: 'pending' }, test: 'attempted' };
    await atomicJSON(ledger, { version: 1, testRunId: id, databaseId: d.id, identity: d.identity, scope: 'owned-test-data', targets: d.test.targets, intents: [], created: [] });
    (s.runtime.testRuns ??= []).push(r); await save(s); // durable BEFORE effects; also supplies crash/timeout cleanup identity
    let output, failure;
    try {
      output = await this.invoke(c, { GB_TEST_RUN_ID: id, GB_TEST_DATABASE_ID: d.id, GB_TEST_DATABASE_IDENTITY: d.identity, GB_FIXTURE_LEDGER_PATH: ledger });
      r.test = 'pass';
    } catch (e) { failure = e; r.test = 'fail'; }
    await save(s);
    try { await this.cleanup(s, r, save); }
    catch (e) { r.cleanup = { status: 'blocked', error: e.message }; await save(s); throw new Error(`Test-data cleanup blocked (${id}): ${e.message}${failure ? '; test also failed' : ''}`, { cause: e }); }
    r.receipt = { version: 1, sourceFingerprint, profileHash: r.profileHash, planHash: r.planHash, sqlPackageHash: r.sqlPackageHash, schemaHash: digest(before), commandHash: r.commandHash, testRunId: id, passed: r.test === 'pass', cleanup: r.cleanup, outputHash: output ? digest(output) : null };
    await save(s);
    if (failure) throw failure;
    return { output, receipt: r.receipt };
  }
}
