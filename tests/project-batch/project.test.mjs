import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { Batch } from '../../skills/in-progress/project-batch/scripts/lib/runtime.mjs';
import { run, Git } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';
import { digest, issueURL, parseIssueRef } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';
import { engines, profilePath, validateProfile, commandEnvironment, sourceHashes } from '../../skills/in-progress/project-batch/scripts/lib/project.mjs';
import { DatabaseGate, snapshot, validateDatabasePlan } from '../../skills/in-progress/project-batch/scripts/lib/database.mjs';
import { GitHub } from '../../skills/in-progress/project-batch/scripts/lib/trackers.mjs';
import { plan, handoff } from './helpers.mjs';
import { executionPolicy } from '../../skills/in-progress/project-batch/scripts/lib/execution-policy.mjs';
import register from '../../skills/in-progress/project-batch/extensions/session-handoff.ts';
import { recordIntent, recordCreated } from '../../skills/in-progress/project-batch/scripts/lib/fixtures.mjs';

function observed(engine = 'postgresql', changed = false) {
  const na = engine === 'mysql' ? ['sequences', 'types'] : engine === 'mariadb' ? ['types'] : engine === 'sqlite' ? ['sequences', 'routines', 'types', 'permissions'] : [];
  const facets = Object.fromEntries(['tables', 'columns', 'constraints', 'indexes', 'views', 'triggers', 'sequences', 'routines', 'types', 'permissions'].map(f => [f, na.includes(f) ? 'not-applicable' : 'complete']));
  return { version: 1, engine, identity: 'owned-test-db', serverVersion: 'fixture-1', scopes: ['app'], readerReadOnly: true, permissionEvidence: 'Fixture of catalog privilege evidence (not real-engine validation)', testSchemaWrites: false, testIsolated: true, facets,
    objects: [{ kind: 'tables', schema: 'app', name: 'base', definition: { columns: [{ name: 'id', type: 'integer', nullable: false }] } }, ...(changed ? [{ kind: 'tables', schema: 'app', name: 'payments', definition: { columns: [{ name: 'id', type: 'integer', nullable: false }] } }] : [])] };
}
async function setup(t, { database = false, ddl = false, provider = 'local', untracked = false, schemaAfterTest = false } = {}) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batch project 中文 '))); t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); await run('git', ['init', '-b', 'main', repo]); const git = new Git(repo);
  await git.text(['config', 'user.name', 'Fixture']); await git.text(['config', 'user.email', 'fixture@example.test']);
  for (const file of ['README.md', 'inspect.js', 'cleanup.js', 'leftovers.js']) await writeFile(path.join(repo, file), `${file} fixture source\n`);
  await git.text(['add', '.']); await git.text(['commit', '-m', 'baseline']);
  if (provider === 'github') await git.text(['remote', 'add', 'origin', 'https://github.example/team/app.git']);
  const rows = new Map([['unrelated-run', ['sentinel']]]), calls = [], remote = new Map(), comments = new Map(); let next = 1;
  let current = observed(), failTest = false, failCleanup = false, unsettled = false;
  const runner = async (file, args, options = {}) => {
    calls.push({ file, args, env: options.env });
    const id = options.env?.GB_TEST_RUN_ID;
    if (file === 'inspect') return Buffer.from(JSON.stringify(current));
    if (file === 'app-test') {
      const fixture = { schema: 'app', table: 'base', key: { id } }, ledger = options.env.GB_FIXTURE_LEDGER_PATH;
      const intent = untracked ? null : await recordIntent(ledger, fixture); // durable BEFORE fake application effect
      rows.set(id, ['owned-fixture']);
      if (intent) await recordCreated(ledger, intent, fixture);
      if (schemaAfterTest) current = observed('postgresql', true);
      if (failTest) throw new Error('application failure'); return Buffer.from('tests passed');
    }
    if (file === 'cleanup' || file === 'leftovers') {
      const ledger = JSON.parse(await readFile(options.env.GB_FIXTURE_LEDGER_PATH, 'utf8'));
      const binding = { ledgerHash: digest(ledger), coveredIntents: ledger.intents.map(i => i.id).sort() };
      if (file === 'cleanup') {
        if (failCleanup) throw new Error('cleanup failed'); const removed = (rows.get(id) ?? []).length; rows.delete(id);
        return Buffer.from(JSON.stringify({ version: 1, testRunId: id, databaseId: 'test', identity: 'owned-test-db', scope: 'owned-test-data', removed, ...binding }));
      }
      return Buffer.from(JSON.stringify({ version: 1, testRunId: id, databaseId: 'test', identity: 'owned-test-db', readerReadOnly: true, quiescent: !unsettled, remaining: (rows.get(id) ?? []).length, ownershipEvidence: 'Mock exact run-key ownership (not native proof)', writerEvidence: 'Mock awaited writers (not live quiescence proof)', ...binding }));
    }
    if (file === 'gh') {
      const endpoint = args[1], method = args[args.indexOf('--method') + 1]; const data = options.input ? JSON.parse(options.input) : null;
      let result;
      if (endpoint === 'repos/team/app') result = { id: 17, full_name: 'team/app', html_url: 'https://github.example/team/app', has_issues: true };
      else if (endpoint.includes('/comments')) {
        const number = endpoint.match(/issues\/(\d+)\/comments/)?.[1], id = endpoint.match(/comments\/(\d+)/)?.[1];
        if (id) result = [...comments.values()].flat().find(n => n.id === Number(id));
        else { const list = comments.get(number) ?? []; comments.set(number, list); if (method === 'POST') { result = { id: next++, ...data }; list.push(result); } else result = list; }
      } else {
        const number = endpoint.match(/issues\/(\d+)/)?.[1];
        if (method === 'POST') { result = { number: next++, state: 'open', ...data }; remote.set(result.number, result); }
        else if (number) { result = remote.get(Number(number)); if (method === 'PATCH') Object.assign(result, data); }
        else { const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page') ?? 1); result = [...remote.values()].slice((page - 1) * 100, page * 100); }
      }
      return Buffer.from(`HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(result)}`);
    }
    return run(file, args, options);
  };
  const worktrees = new Map();
  const orca = {
    preflight: async () => ({ version: 'fixture', executable: 'fixture', guideHash: 'fixture' }),
    create: async s => { const wt = path.join(dir, `worktree-${s.plan.id}`); const branch = `batch-${s.plan.id}`; await git.text(['worktree', 'add', '-b', branch, wt, s.runtime.baseline]); const w = { path: wt, branch, id: 'fixture', repoId: 'fixture', identity: 'fixture' }; worktrees.set(w.id, w); return w; },
    verify: async w => { assert.equal(worktrees.get(w.id)?.path, w.path); },
    launch: async (s, _skill, prompt, save) => { s.operations.terminal = { status: 'accepted', prompt }; await save(s); return s.operations.terminal; },
  };
  const options = { runner, orca }, batch = await Batch.open(repo, options);
  const db = { id: 'test', engine: 'postgresql', identity: 'owned-test-db', serverVersion: 'fixture-1', scopes: ['app'], inspect: { file: 'inspect', args: [] }, inspectScript: 'inspect.js', test: { isolated: true, ownership: 'test-run-id', schemaWrites: false, targets: [{ schema: 'app', table: 'base', keyColumns: ['id'] }], cleanup: { file: 'cleanup', args: [] }, cleanupScript: 'cleanup.js', leftovers: { file: 'leftovers', args: [] }, leftoversScript: 'leftovers.js' } };
  const config = { id: 'sample', tracker: provider === 'local' ? { provider } : { provider, origin: 'https://github.example', projectPath: 'team/app' }, standards: ['README.md'], databases: database ? [db] : [] };
  const preview = await batch.init(config); assert.equal(await readFile(path.join(repo, profilePath)).catch(() => null), null);
  await batch.init(config, preview.confirm); await git.text(['add', profilePath]); await git.text(['commit', '-m', 'configure project once']);
  const p = plan(); delete p.origin; delete p.projectPath; delete p.projectId;
  p.planning = { requirements: 'Deliver observable behavior and all Issue criteria', design: 'Use project module boundaries and explicit schema design', boundaries: 'One shared worktree, no DDL execution or production writes', implementation: 'Implement dependency-ready Issues with their acceptance verification', testing: 'Offline and isolated application tests; run-owned cleanup', risks: 'Unknown schema changes stop before more implementation' };
  for (const c of [...p.issues.flatMap(i => i.verify), ...p.verify]) c.effect = 'offline';
  if (database) {
    p.database = { version: 1, targets: [{ id: 'test', before: observed(), after: observed('postgresql', ddl), ...(ddl ? { sql: { text: 'CREATE TABLE payments (id INTEGER NOT NULL PRIMARY KEY);', hash: digest('CREATE TABLE payments (id INTEGER NOT NULL PRIMARY KEY);') } } : {}) }] };
    p.issues[0].verify = [{ file: 'app-test', args: [], effect: 'application-write', database: 'test' }];
  }
  const draft = await batch.plan(p); await batch.publish(p.id, draft.confirm);
  const saved = await batch.store.load(p.id), ref = issueURL(saved.plan, saved.publication.rootIID);
  async function start() {
    const a = await batch.start(ref); await batch.start(ref, a.confirm);
    const state = await batch.store.load(p.id), execution = await Batch.open(state.runtime.worktree.path, options), session = state.runtime.launchSession;
    await execution.resume(ref, { session });
    const step = async (action, input, extra = {}) => { const s = await batch.store.load(p.id); return execution.step(ref, { action, input, ...s.runtime.owner, ...extra }); };
    return { execution, session, step };
  }
  return { repo, batch, config, db, draft, ref, p, rows, calls, remote, start, schema: value => { current = value; }, failure: (test, cleanup = false) => { failTest = test; failCleanup = cleanup; }, unsettled: v => { unsettled = v; } };
}

test('local project initialized once, no tracker CLI, shared plan binding and source pinning', async t => {
  const f = await setup(t); const s = await f.batch.store.load('demo'); assert.equal(s.plan.provider, 'local');
  assert.equal(parseIssueRef(f.ref).projectPath, 'sample'); assert.equal(f.calls.some(c => ['gh', 'glab'].includes(c.file)), false);
  const { step } = await f.start(); await step('begin');
  await writeFile(path.join(f.repo, 'README.md'), 'changed standards'); await assert.rejects(f.batch.projectFor(s), /standards/);
});

test('GitHub project publication, exact recovery, comments and closure normalize common tracker contract', async t => {
  const f = await setup(t, { provider: 'github' }); assert.match(f.ref, /team\/app\/issues\//); assert.equal(f.remote.size, 1);
  await f.batch.publish('demo', f.draft.confirm); assert.equal(f.remote.size, 1);
  const s = await f.batch.store.load('demo'), tracker = f.batch.tracker(s);
  const n = await tracker.note(s, s.publication.rootIID, 'proof', 'owned note', f.batch.save);
  assert.equal(await tracker.note(s, s.publication.rootIID, 'proof', 'owned note', f.batch.save), n);
  await tracker.update(s.publication.rootIID, { state_event: 'close' }); assert.equal((await tracker.issue(s.publication.rootIID)).state, 'closed');
  assert.equal(f.calls.some(c => c.file === 'glab'), false);
});

test('GitHub pagination continues past a full page of PRs and rejects malformed/non-HTTP success', async () => {
  let pages = 0;
  const tracker = new GitHub({ origin: 'https://github.example', projectId: 17, projectPath: 'team/app' }, '.', async (_file, args) => {
    pages++; const page = new URLSearchParams(args[1].split('?')[1]).get('page');
    const rows = page === '1' ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, pull_request: {}, body: '' })) : [{ number: 101, body: 'wanted marker', state: 'open' }];
    return Buffer.from(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(rows)}`);
  });
  assert.equal((await tracker.find('wanted marker'))[0].iid, 101); assert.equal(pages, 2);
  tracker.runner = async () => Buffer.from('{"number":1}'); await assert.rejects(tracker.issue(1), /HTTP/);
});

for (const engine of engines) test(`${engine} snapshot port preserves complete schema and rejects missing facets/roles/version`, () => {
  const d = { engine, identity: 'owned-test-db', serverVersion: 'fixture-1', scopes: ['app'], test: {} }, raw = observed(engine);
  assert.equal(snapshot(raw, d).hash, snapshot({ ...raw, objects: [...raw.objects].reverse() }, d).hash);
  for (const patch of [{ serverVersion: 'other' }, { readerReadOnly: false }, { testSchemaWrites: true }, { facets: { ...raw.facets, indexes: 'unknown' } }]) assert.throws(() => snapshot({ ...raw, ...patch }, d));
});

test('DDL stage blocks worktree/implementation until both actual schema and exact human SQL confirmation', async t => {
  const f = await setup(t, { database: true, ddl: true }); const s = await f.batch.store.load('demo');
  await assert.rejects(f.batch.start(f.ref, (await f.batch.start(f.ref)).confirm), /Schema gate/);
  assert.equal((await f.batch.store.load('demo')).runtime, null);
  f.schema(observed('postgresql', true));
  await assert.rejects(f.batch.start(f.ref, (await f.batch.start(f.ref)).confirm), /confirmation missing/);
  const evidence = { planHash: s.planHash, executions: [{ id: 'test', sqlHash: s.plan.database.targets[0].sql.hash, evidence: 'Human executed this exact SQL in fixture scenario' }] };
  await assert.rejects(f.batch.schema(f.ref, { ...evidence, executions: [{ ...evidence.executions[0], sqlHash: 'wrong' }] }), /content-bound/);
  const preview = await f.batch.schema(f.ref, evidence); assert.equal((await f.batch.store.load('demo')).databaseEvidence, undefined);
  await f.batch.schema(f.ref, evidence, preview.confirm); const { step } = await f.start(); await step('begin');
});

test('application tests clean only their own rows, including after failed tests; no human DB test step', async t => {
  const f = await setup(t, { database: true }), { execution, step } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate');
  const input = { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'automated application test' }] };
  f.failure(true); await assert.rejects(step('accept', input), /application failure/);
  let s = await f.batch.store.load('demo'); assert.equal(s.runtime.testRuns[0].cleanup.status, 'pass'); assert.equal(s.runtime.acceptance.i1, undefined);
  assert.deepEqual([...f.rows.keys()], ['unrelated-run']);
  f.failure(false); await step('accept', input); s = await f.batch.store.load('demo'); assert.equal(s.runtime.acceptance.i1.passed, true);
  assert.deepEqual([...f.rows.entries()], [['unrelated-run', ['sentinel']]]);
});

test('failed cleanup blocks new tests/acceptance and controlled retry uses the same durable run identity', async t => {
  const f = await setup(t, { database: true }), { execution, step, session } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate');
  const input = { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'test' }] };
  f.failure(false, true); await assert.rejects(step('accept', input), /cleanup blocked/);
  const s = await f.batch.store.load('demo'), id = s.runtime.testRuns[0].id;
  assert.equal(executionPolicy(s, session, 1).writable, false);
  await assert.rejects(step('accept', input), /Pending test-data/); assert.equal(f.calls.filter(c => c.file === 'app-test').length, 1);
  f.failure(false); await step('cleanup', {}, { percent: 75 }); assert.equal(f.rows.has(id), false);
  assert.equal((await f.batch.store.load('demo')).runtime.testRuns.length, 1);
});

test('asynchronous writers must settle before cleanup; new schema discovery cannot be cleared by old read-back', async t => {
  const f = await setup(t, { database: true }), { execution, step } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate');
  f.unsettled(true);
  await assert.rejects(step('accept', { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'test' }] }), /unsettled/);
  assert.equal(f.calls.filter(c => c.file === 'cleanup').length, 0);
  f.unsettled(false); await step('cleanup'); await step('schema-stop', { reason: 'New unplanned column required' });
  await assert.rejects(execution.resume(f.ref, { session: (await f.batch.store.load('demo')).runtime.owner.session }), /complete plan revision/);
  await step('checkpoint', handoff()); assert.equal(await readFile(path.join(execution.git.cwd, 'feature.txt'), 'utf8'), 'candidate');
});

test('profile rejects unsafe paths, duplicate databases, unclassified verification and missing cleanup', async t => {
  const f = await setup(t, { database: true }); const profile = JSON.parse(await readFile(path.join(f.repo, profilePath)));
  for (const patch of [{ standards: ['../escape'] }, { databases: [...profile.databases, ...profile.databases] }, { databases: [{ ...f.db, test: { ...f.db.test, cleanup: null } }] }]) assert.throws(() => validateProfile({ ...profile, ...patch }));
  const s = await f.batch.store.load('demo'); const p = structuredClone(s.plan); delete p.issues[0].verify[0].effect; assert.throws(() => validateDatabasePlan(p, profile), /Classify/);
  process.env.GB_TEST_SECRET = 'secret'; t.after(() => delete process.env.GB_TEST_SECRET);
  assert.equal(commandEnvironment({ envRefs: { PASSWORD: 'GB_TEST_SECRET' } }).PASSWORD, 'secret');
  await writeFile(path.join(f.repo, 'cleanup.js'), 'changed cleanup policy'); assert.notDeepEqual(await sourceHashes(f.repo, profile), s.plan.profileSources);
});

test('schema revision preserves dirty active Issue, renews SQL evidence and resumes in the same worktree', async t => {
  const f = await setup(t, { database: true }), { execution, step } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'preserved partial implementation');
  await step('schema-stop', { reason: 'Upfront design needs a new approved table' }); await step('checkpoint', handoff());
  const old = await f.batch.store.load('demo'), next = structuredClone(old.plan); next.revision++;
  next.database.targets[0].after = observed('postgresql', true);
  const text = 'CREATE TABLE payments (id INTEGER NOT NULL PRIMARY KEY);'; next.database.targets[0].sql = { text, hash: digest(text) };
  const preview = await f.batch.revise('demo', next); await f.batch.revise('demo', next, preview.confirm);
  const publication = await f.batch.publish('demo'); await f.batch.publish('demo', publication.confirm);
  assert.equal((await f.batch.store.load('demo')).runtime.activeIssue.key, 'i1');
  assert.equal(await readFile(path.join(execution.git.cwd, 'feature.txt'), 'utf8'), 'preserved partial implementation');
  f.schema(observed('postgresql', true)); const current = await f.batch.store.load('demo');
  const evidence = { planHash: current.planHash, executions: [{ id: 'test', sqlHash: digest(text), evidence: 'Human executed revision SQL' }] };
  const sql = await f.batch.schema(f.ref, evidence); await f.batch.schema(f.ref, evidence, sql.confirm);
  const claim = await execution.resume(f.ref, { session: 'fresh-after-ddl', inactiveEvidence: 'Prior owner stopped' });
  await execution.resume(f.ref, { session: 'fresh-after-ddl', inactiveEvidence: 'Prior owner stopped', confirm: claim.confirm });
  const s = await f.batch.store.load('demo'); assert.equal(s.schemaBlocked, undefined); assert.equal(s.runtime.activeIssue.key, 'i1'); assert.equal(s.runtime.worktree.path, execution.git.cwd);
});

test('controlled claim cancel preserves ownership; live human claim binds fresh actual session only', async t => {
  const f = await setup(t), { execution } = await f.start(); const tools = new Map(), events = new Map();
  register({ registerCommand: () => {}, registerTool: t => tools.set(t.name, t), on: (n, fn) => events.set(n, fn) }, { openBatch: async () => execution });
  const ctx = { cwd: execution.git.cwd, sessionManager: { getSessionId: () => 'actual-fresh-session' }, getContextUsage: () => ({ percent: 1 }), ui: { confirm: async () => false } };
  assert.equal((await events.get('tool_call')({ toolName: 'bash' }, ctx)).block, true);
  assert.equal(await events.get('tool_call')({ toolName: 'project_batch_claim' }, ctx), undefined);
  const old = (await f.batch.store.load('demo')).runtime.owner;
  await tools.get('project_batch_claim').execute('id', { ref: f.ref }, undefined, undefined, ctx);
  assert.deepEqual((await f.batch.store.load('demo')).runtime.owner, old);
  ctx.ui.confirm = async () => true;
  await tools.get('project_batch_claim').execute('id', { ref: f.ref }, undefined, undefined, ctx);
  assert.equal((await f.batch.store.load('demo')).runtime.owner.session, 'actual-fresh-session');
});

test('complete planning and lossless schema values are mandatory; no-profile database plan rejected', async t => {
  const f = await setup(t, { database: true }); const s = await f.batch.store.load('demo'); const profile = JSON.parse(await readFile(path.join(f.repo, profilePath)));
  const p = structuredClone(s.plan); delete p.planning.design; assert.throws(() => validateDatabasePlan(p, profile), /requires design/);
  assert.throws(() => validateDatabasePlan(s.plan, null), /requires a ProjectProfile/);
  const raw = observed(); raw.objects[0].definition.lossy = 9223372036854775807; assert.throws(() => snapshot(raw, f.db), /lossless/);
  assert.throws(() => validateProfile({ ...profile, password: 'never-store-this' }), /credentials/);
});

test('unfinished old trial is blocked and preserved, without alias or marker adoption', async t => {
  const f = await setup(t); const directory = path.join(await f.batch.git.common(), 'gitlab-batch', 'batches');
  await mkdir(directory, { recursive: true }); const file = path.join(directory, 'old.json'); const original = JSON.stringify({ state: 'running', legacy: 'untouched' }); await writeFile(file, original);
  await assert.rejects(Batch.open(f.repo), /Unfinished legacy/);
  await assert.rejects(f.batch.publish('demo'), /Unfinished legacy/);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('cleanup initial dispatch plus two retries exhausts authority before a fourth deletion', async t => {
  const f = await setup(t, { database: true }), { execution, step } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate'); f.failure(false, true);
  const input = { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'test' }] };
  await assert.rejects(step('accept', input), /cleanup blocked/);
  for (let i = 0; i < 2; i++) await assert.rejects(step('cleanup'), /cleanup failed/);
  await assert.rejects(step('cleanup'), /retry budget exhausted/);
  assert.equal(f.calls.filter(c => c.file === 'cleanup').length, 3);
  assert.equal((await f.batch.store.load('demo')).runtime.testRuns[0].cleanupAttempts, 3);
});

test('schema stop remains controlled at high context and profile rejects nested credential values', async t => {
  const f = await setup(t, { database: true }), { step } = await f.start(); await step('begin');
  await step('schema-stop', { reason: 'Unapproved new column at context boundary' }, { percent: 75 });
  assert.equal((await f.batch.store.load('demo')).schemaBlocked.requiresRevision, true);
  const profile = JSON.parse(await readFile(path.join(f.repo, profilePath)));
  for (const change of [{ password: 'secret' }, { inspect: { ...f.db.inspect, password: 'secret' } }, { inspect: { ...f.db.inspect, args: ['--password=secret'] } }, { inspect: { ...f.db.inspect, args: ['postgresql://user:secret@host/db'] } }]) {
    assert.throws(() => validateProfile({ ...profile, databases: [{ ...f.db, ...change }] }), /credentials|Credential/);
  }
});

test('observed unapproved schema drift remains revision-sticky after old schema is restored', async t => {
  const f = await setup(t, { database: true }), { execution, session } = await f.start();
  f.schema(observed('postgresql', true)); await assert.rejects(execution.resume(f.ref, { session }), /Schema/);
  f.schema(observed()); await assert.rejects(execution.resume(f.ref, { session }), /complete plan revision/);
  assert.equal((await f.batch.store.load('demo')).schemaBlocked.requiresRevision, true);
});

test('acceptance refuses test-created rows with no durable exact fixture intents before deletion', async t => {
  const f = await setup(t, { database: true, untracked: true }), { execution, step } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate');
  await assert.rejects(step('accept', { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'test' }] }), /ledger|intent/i);
  assert.equal(f.calls.filter(c => c.file === 'cleanup').length, 0);
});

test('application acceptance has explicit source/plan/schema/run/cleanup verification receipt', async t => {
  const f = await setup(t, { database: true }), { execution, step } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate');
  await step('accept', { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'test' }] });
  const s = await f.batch.store.load('demo'), receipt = s.runtime.acceptance.i1.verification[0].receipt;
  assert.equal(receipt.version, 1); assert.equal(receipt.planHash, s.planHash); assert.equal(receipt.profileHash, s.plan.profileHash);
  assert.equal(receipt.testRunId, s.runtime.testRuns[0].id); assert.equal(receipt.cleanup.status, 'pass');
  assert.match(receipt.sourceFingerprint, /^[a-f0-9]{64}$/); assert.match(receipt.schemaHash, /^[a-f0-9]{64}$/); assert.match(receipt.sqlPackageHash, /^[a-f0-9]{64}$/);
});

test('confirmed drift in one target persists before a later target inspector can fail', async () => {
  for (const failure of ['transport', 'json', 'facets']) {
    const databases = ['a', 'b'].map(id => ({ id, engine: 'postgresql', identity: 'owned-test-db', serverVersion: 'fixture-1', scopes: ['app'], inspect: { file: `inspect-${id}`, args: [] } }));
    const s = { planHash: 'fixed', state: 'running', plan: { database: { targets: databases.map(d => ({ id: d.id, before: observed(), after: observed() })) } } };
    let changed = true, laterCalls = 0, saved;
    const gate = new DatabaseGate({ databases }, async file => {
      if (file === 'inspect-a') return Buffer.from(JSON.stringify(observed('postgresql', changed)));
      laterCalls++; if (failure === 'transport') throw new Error('later transport failure');
      return Buffer.from(failure === 'json' ? '{' : JSON.stringify({ ...observed(), facets: {} }));
    }, '', '', async value => { saved = structuredClone(value); });
    await assert.rejects(gate.observe(s), /Schema drift/);
    assert.equal(saved.schemaBlocked.requiresRevision, true, failure); assert.equal(laterCalls, 0, failure);
    changed = false; await assert.rejects(gate.observe(s), /complete plan revision/);
  }
});
test('schema-report observation itself persists drift authority before old readback can resume', async t => {
  const f = await setup(t, { database: true }), { execution, session } = await f.start();
  f.schema(observed('postgresql', true)); await assert.rejects(f.batch.schema(f.ref), /Schema drift/);
  f.schema(observed()); await assert.rejects(execution.resume(f.ref, { session }), /complete plan revision/);
});

test('drift first detected inside verification readback persists before test dispatch', async t => {
  const f = await setup(t, { database: true }), { execution, step, session } = await f.start(); await step('begin');
  const database = execution.database.bind(execution); let reads = 0;
  execution.database = (...args) => {
    const gate = database(...args), ready = gate.ready.bind(gate);
    gate.ready = async s => { if (++reads === 2) f.schema(observed('postgresql', true)); return ready(s); }; return gate;
  };
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate');
  await assert.rejects(step('accept', { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'test' }] }), /Schema drift/);
  assert.equal(f.calls.filter(c => c.file === 'app-test').length, 0);
  f.schema(observed()); await assert.rejects(execution.resume(f.ref, { session }), /complete plan revision/);
});
test('drift first detected inside test cleanup remains sticky through wrapped test errors', async t => {
  const f = await setup(t, { database: true, schemaAfterTest: true }), { execution, step, session } = await f.start(); await step('begin');
  await writeFile(path.join(execution.git.cwd, 'feature.txt'), 'candidate');
  await assert.rejects(step('accept', { key: 'i1', paths: ['feature.txt'], message: 'feature', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'test' }] }), /Schema drift/);
  assert.equal(f.calls.filter(c => c.file === 'cleanup').length, 0);
  f.schema(observed()); await assert.rejects(execution.resume(f.ref, { session }), /complete plan revision/);
});
