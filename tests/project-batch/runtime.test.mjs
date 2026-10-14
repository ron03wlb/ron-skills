import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Batch } from '../../skills/in-progress/project-batch/scripts/lib/runtime.mjs';
import { fixture, handoff, plan, MockTracker } from './helpers.mjs';
import { atomicJSON, readJSON } from '../../skills/in-progress/project-batch/scripts/lib/store.mjs';
import { digest, marker } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';

test('single Issue has no parent, repeat start retains worktree/terminal', async t => {
  const f = await fixture(t), s = await f.batch.store.load('demo');
  assert.equal(f.tracker.rows.size, 1); assert.equal(s.publication.rootIID, s.publication.members.i1);
  const token = (await f.batch.start(f.ref)).confirm; await f.batch.start(f.ref, token);
  assert.equal(f.worktrees.size, 1); assert.equal((await f.batch.status('#101')).runtime.worktree.path, s.runtime.worktree.path);
});
test('multi Issue parent, child entry redirects without partial execution', async t => {
  const f = await fixture(t, 3), s = await f.batch.store.load('demo');
  assert.equal(f.tracker.rows.size, 4);
  const child = `https://gitlab.example/team/app/-/issues/${s.publication.members.i1}`;
  for (const [op, call] of [['start', () => f.batch.start(child)], ['resume', () => f.execution.resume(child, { session: f.session })], ['review', () => f.batch.review(child)], ['integrate', () => f.batch.integrate(child)], ['next', () => f.execution.prepareNext(child, f.session)]]) await assert.rejects(call(), new RegExp(op));
  assert.equal((await f.batch.status(child)).root, f.ref);
});
test('domain segment executes multiple Issues then stops even at low context', async t => {
  const f = await fixture(t, 3);
  assert.equal((await f.accept('i1')).boundary, 'unknown');
  assert.equal((await f.accept('i2')).boundary, 'checkpoint_and_stop');
  await assert.rejects(f.step('begin', {}, { percent: 1 }), /segment complete/);
  await f.step('checkpoint', handoff());
  await assert.rejects(f.step('begin'), /stopped|segment changed/);
  const p = await f.execution.prepareNext(f.ref, f.session);
  const next = await f.execution.claimNext(p, 'new-session'); assert.equal(next.segment.id, 'B');
  await assert.rejects(f.execution.step(f.ref, { action: 'begin', session: f.session, generation: 1 }), /Stale/);
  await assert.rejects(f.execution.claimNext(p, 'another-session'), /stale|consumed/);
  await f.accept('i3'); await f.step('checkpoint', handoff());
  assert.equal((await f.batch.status(f.ref)).state, 'awaiting_integration');
});
test('context signals disallow next Issue and unknown usage retains segment bound', async t => {
  const f = await fixture(t, 2);
  await assert.rejects(f.step('begin', {}, { percent: 60 }), /Context/);
  await assert.rejects(f.step('begin', {}, { percent: 70 }), /Context/);
  await f.step('checkpoint', handoff());
  await f.execution.claimNext(await f.execution.prepareNext(f.ref, f.session), 'fresh-context');
  await f.accept('i1');
  const s = await f.batch.store.load('demo'); s.runtime.contextPercent = 71; await f.batch.save(s);
  await assert.rejects(f.step('begin', {}, { percent: 1 }), /Context/);
});
test('dirty unaccepted checkpoint remains on disk and resumes same active Issue', async t => {
  const f = await fixture(t);
  await f.step('begin'); await writeFile(path.join(f.execution.git.cwd, 'unfinished 中文.txt'), 'not accepted');
  await f.step('checkpoint', handoff());
  const p = await f.execution.prepareNext(f.ref, f.session), r = await f.execution.claimNext(p, 'new-session');
  assert.equal(r.runtime.activeIssue.key, 'i1'); assert.equal(r.runtime.segment, 0);
  assert.equal(await readFile(path.join(f.execution.git.cwd, 'unfinished 中文.txt'), 'utf8'), 'not accepted');
  assert.equal(r.runtime.acceptance.i1, undefined);
});
test('fingerprint drift and takeover require exact checks, not lock timeout', async t => {
  const f = await fixture(t);
  const preview = await f.execution.resume(f.ref, { session: 'recovery' });
  await assert.rejects(f.execution.resume(f.ref, { session: 'recovery', confirm: preview.confirm }), /inactive/);
  const args = { session: 'recovery', inactiveEvidence: 'Human verified previous Pi terminal exited' };
  const take = await f.execution.resume(f.ref, args); await f.execution.resume(f.ref, { ...args, confirm: take.confirm });
  await f.step('checkpoint', handoff());
  await writeFile(path.join(f.execution.git.cwd, 'drift.txt'), 'drift');
  await assert.rejects(f.execution.prepareNext(f.ref, 'recovery'), /fingerprint/);
});
test('same-batch accepted dependency does not require tracker closure', async t => {
  const f = await fixture(t, 2); await f.accept('i1');
  const s = await f.batch.store.load('demo'); assert.equal((await f.tracker.issue(s.publication.members.i1)).state, 'opened');
  assert.equal((await f.step('begin')).issue.key, 'i2');
});
test('external dependencies need closed tracker state and baseline commit', async t => {
  const f = await fixture(t, 1, async (p, { tracker, git }) => {
    tracker.rows.set(900, { iid: 900, project_id: 17, state: 'opened', title: 'external', description: '' });
    p.issues[0].external = [{ url: 'https://gitlab.example/team/app/-/issues/900', commit: await git.head() }];
  });
  await assert.rejects(f.step('begin'), /External dependency open/);
  f.tracker.rows.get(900).state = 'closed'; assert.equal((await f.step('begin')).issue.key, 'i1');
});
test('manual prerequisite confirmation and transitive regression invalidate acceptance', async t => {
  const f = await fixture(t, 3, async p => { p.issues[0].prerequisites = [{ id: 'access', description: 'Grant test environment access' }]; });
  await assert.rejects(f.step('begin'), /prerequisite/);
  const input = { key: 'i1', id: 'access', evidence: 'Human verified access' };
  const p = await f.step('prerequisite', input); await f.step('prerequisite', input, { confirm: p.confirm });
  await f.accept('i1'); await f.accept('i2');
  await f.step('regress', { keys: ['i1'], reason: 'Later change breaks i1' });
  const after = await f.batch.store.load('demo'); for (const k of ['i1', 'i2', 'i3']) assert.equal(after.runtime.acceptance[k].passed, false);
});
test('offline checkpoint saves local handoff; sync read-back required before next', async t => {
  const f = await fixture(t);
  f.tracker.fail = (endpoint, method) => endpoint.includes('/notes') && method === 'GET';
  const result = await f.step('checkpoint', handoff()); assert.match(result.synchronizationError, /offline/);
  await assert.rejects(f.execution.prepareNext(f.ref, f.session), /synchronized/);
  f.tracker.fail = null; await f.step('sync');
  assert.ok(await f.execution.prepareNext(f.ref, f.session));
});
test('partially published batches retry markers without duplicate Issue creation', async t => {
  const f = await fixture(t); const p = plan(3); p.id = 'partial';
  const draft = await f.batch.plan(p);
  f.tracker.fail = (endpoint, method, data) => method === 'POST' && data.title === 'i2';
  await assert.rejects(f.batch.publish(p.id, draft.confirm), /offline/);
  const count = f.tracker.rows.size; f.tracker.fail = null;
  await assert.rejects(f.batch.publish(p.id, draft.confirm), /uncertain/);
  assert.equal(f.tracker.rows.size, count);
  const s = await f.batch.store.load(p.id);
  // Human reconciles the exact failed attempt by finding its server-side marker.
  const iid = 990; f.tracker.rows.set(iid, { iid, project_id: 17, state: 'opened', title: 'i2', description: `${marker(p.id, 'issue-i2')}\nserver result` });
  await f.batch.publish(p.id, draft.confirm); assert.equal(f.tracker.rows.size, count + 2);
  assert.equal((await f.batch.store.load(p.id)).state, 'ready');
});
test('review freezes versions and restricts tools; shards all bind identical T..C', async t => {
  const f = await fixture(t, 3); await f.accept('i1'); await f.accept('i2'); await f.step('checkpoint', handoff());
  await f.execution.claimNext(await f.execution.prepareNext(f.ref, f.session), 'next');
  await f.accept('i3'); await f.step('checkpoint', handoff()); await f.batch.review(f.ref);
  const s = await f.batch.store.load('demo'), c = s.runtime.candidate;
  assert.equal(c.status, 'pass'); assert.deepEqual(c.reviews.map(r => r.shard), ['A', 'B', 'cross-domain']);
  for (const r of c.reviews) { assert.equal(r.target, c.target); assert.equal(r.candidate, c.candidate); }
  for (const call of f.calls.filter(c => c.file === 'pi')) {
    for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']) assert.ok(call.args.includes(flag));
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'read,grep,find,ls'); assert.ok(!call.args.includes('bash'));
  }
});
test('invalid/incomplete reviewer does not pass; changed candidate invalidates integration', async t => {
  const f = await fixture(t); await f.accept('i1'); await f.step('checkpoint', handoff());
  f.setReview('invalid'); await assert.rejects(f.batch.review(f.ref), /invalid JSON/);
  await assert.rejects(f.batch.integrate(f.ref), /review required/);
  f.setReview('incomplete'); await f.batch.review(f.ref); await assert.rejects(f.batch.integrate(f.ref), /review required/);
  f.setReview('pass'); await f.batch.review(f.ref); const token = (await f.batch.integrate(f.ref)).confirm;
  await writeFile(path.join(f.execution.git.cwd, 'unreviewed.txt'), 'x'); await f.execution.git.text(['add', '.']); await f.execution.git.text(['commit', '-m', 'unreviewed']);
  await assert.rejects(f.batch.integrate(f.ref, token), /candidate changed/); assert.equal((await f.tracker.issue(101)).state, 'opened');
});
test('dirty target or target drift prevent closure and cleanup', async t => {
  const f = await fixture(t); await f.accept('i1'); await f.step('checkpoint', handoff()); await f.batch.review(f.ref);
  const token = (await f.batch.integrate(f.ref)).confirm;
  await writeFile(path.join(f.git.cwd, 'dirty.txt'), 'dirty'); await assert.rejects(f.batch.integrate(f.ref, token), /Dirty/);
  await f.git.text(['add', '.']); await f.git.text(['commit', '-m', 'target advancement']);
  await assert.rejects(f.batch.integrate(f.ref, token), /Target advanced/);
  assert.equal((await f.tracker.issue(101)).state, 'opened'); assert.equal(f.worktrees.size, 1);
  await f.execution.git.text(['merge', 'main', '--no-edit']);
  await f.batch.review(f.ref); const fresh = (await f.batch.integrate(f.ref)).confirm;
  assert.notEqual(fresh, token); await assert.rejects(f.batch.integrate(f.ref, token), /stale/);
});
test('fast-forward integration, note/close recovery, cleanup retry and zero push', async t => {
  const f = await fixture(t); await f.accept('i1'); await f.step('checkpoint', handoff()); await f.batch.review(f.ref);
  const token = (await f.batch.integrate(f.ref)).confirm;
  f.tracker.fail = (e, m) => m === 'PUT'; await assert.rejects(f.batch.integrate(f.ref, token), /offline/);
  const merged = await f.batch.store.load('demo'); assert.equal(merged.runtime.integration.merged, true); assert.equal(await f.git.head(), merged.runtime.candidate.candidate);
  f.tracker.fail = null; f.setRemoveFails(true); await assert.rejects(f.batch.integrate(f.ref, token), /cleanup failure/);
  assert.equal((await f.tracker.issue(101)).state, 'closed');
  f.setRemoveFails(false); const done = await f.batch.integrate(f.ref, token); assert.equal(done.state, 'done'); assert.equal(done.pushed, false);
  assert.equal(f.calls.filter(c => c.file === 'git' && c.args.includes('merge')).length, 1);
  assert.equal(f.calls.filter(c => c.args.includes('push')).length, 0); await assert.rejects(access(merged.runtime.worktree.path));
  assert.equal((await f.batch.integrate(f.ref, token)).state, 'done');
});
test('atomic JSON and operation locks reject concurrent writers without expiry adoption', async t => {
  const f = await fixture(t), file = path.join(f.root, 'atomic 中文', 'state.json');
  await atomicJSON(file, { generation: 1 }); await atomicJSON(file, { generation: 2 }); assert.equal((await readJSON(file)).generation, 2);
  let release, entered; const gate = new Promise(r => { release = r; });
  const acquired = new Promise(r => { entered = r; });
  const held = f.batch.store.locked('demo', async () => { entered(); await gate; });
  await acquired;
  await assert.rejects(f.batch.store.locked('demo', async () => {}), /lock held/); release(); await held;
});
test('acceptance requires all criteria and exact paths; failing tests never mark accepted', async t => {
  const f = await fixture(t, 1, async p => { p.issues[0].verify = [{ file: process.execPath, args: ['-e', 'process.exit(1)'] }]; });
  await f.step('begin'); await writeFile(path.join(f.execution.git.cwd, 'i1.txt'), 'impl');
  await assert.rejects(f.step('accept', { key: 'i1', criteria: [] }), /Every criterion/);
  const s = await f.batch.store.load('demo');
  await assert.rejects(f.step('accept', { key: 'i1', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'claim' }], paths: ['i1.txt'], message: 'implement' }), /failed/);
  assert.equal((await f.batch.store.load('demo')).runtime.acceptance.i1, undefined);
  assert.equal(await f.execution.git.head(), s.runtime.baseline);
});
