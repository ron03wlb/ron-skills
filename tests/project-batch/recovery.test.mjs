import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, handoff, plan } from './helpers.mjs';
import { run } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';
import register from '../../skills/in-progress/project-batch/extensions/session-handoff.ts';

const acceptance = () => ({ key: 'i1', paths: ['i1.txt'], message: 'Deliver i1', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'observable test result' }] });
test('lost successful commit response recovers exact prepared tree without second commit', async t => {
  const f = await fixture(t); await f.step('begin'); await writeFile(path.join(f.execution.git.cwd, 'i1.txt'), 'accepted');
  const runner = f.execution.runner; let lost = false;
  f.execution.runner = async (file, args, options) => {
    const output = await runner(file, args, options);
    if (!lost && file === 'git' && args[0] === 'commit') { lost = true; throw new Error('lost commit response'); }
    return output;
  };
  await assert.rejects(f.step('accept', acceptance()), /lost commit/);
  const committed = await f.execution.git.head();
  const r = await f.step('accept', acceptance()); assert.equal(r.runtime.acceptance.i1.commit, committed);
  assert.equal(await f.execution.git.text(['rev-list', '--count', 'HEAD']), '2');
});
test('no-change revalidation records existing commit and does not fabricate implementation', async t => {
  const f = await fixture(t); await f.step('begin'); const input = { ...acceptance(), paths: [], noChangeEvidence: 'Behavior is already present and its verification was rerun' };
  const before = await f.execution.git.head(); const r = await f.step('accept', input);
  assert.equal(r.runtime.acceptance.i1.noChange, true); assert.equal(await f.execution.git.head(), before);
});
test('offline checkpoint can synchronize after confirmed fresh-session crash recovery', async t => {
  const f = await fixture(t);
  f.tracker.fail = (endpoint, method) => endpoint.includes('/notes') && method === 'GET'; await f.step('checkpoint', handoff()); f.tracker.fail = null;
  const args = { session: 'recovered', inactiveEvidence: 'Previous terminal verified exited' }, preview = await f.execution.resume(f.ref, args);
  await f.execution.resume(f.ref, { ...args, confirm: preview.confirm });
  const s = await f.batch.store.load('demo'); assert.equal(s.runtime.pendingSync, null); assert.equal(s.runtime.owner.session, 'recovered');
});
test('version mismatch blocks execution and preserves state', async t => {
  const f = await fixture(t); f.options.orca.preflight = async () => ({ version: 'different', executable: 'mock' });
  await assert.rejects(f.step('begin'), /version\/executable\/guide/);
  assert.equal((await f.batch.store.load('demo')).runtime.activeIssue, null);
});
test('old intermediate session remains read-only after later handoffs', async t => {
  const f = await fixture(t); await f.step('checkpoint', handoff());
  await f.execution.claimNext(await f.execution.prepareNext(f.ref, f.session), 'intermediate');
  await f.step('checkpoint', handoff()); await f.execution.claimNext(await f.execution.prepareNext(f.ref, 'intermediate'), 'latest');
  const events = new Map(); register({ registerTool: () => {}, registerCommand: () => {}, on: (name, handler) => events.set(name, handler) });
  const ctx = { cwd: f.execution.git.cwd, sessionManager: { getSessionId: () => 'intermediate' } };
  assert.equal((await events.get('tool_call')({ toolName: 'write' }, ctx)).block, true);
  assert.equal(await events.get('tool_call')({ toolName: 'read' }, ctx), undefined);
});
test('single-to-multi revision reuses member and worktree, adding only parent/new member', async t => {
  const f = await fixture(t); await f.step('checkpoint', handoff()); const p = plan(2); p.revision = 2;
  const preview = await f.batch.revise('demo', p), publication = await f.batch.revise('demo', p, preview.confirm);
  await f.batch.publish('demo', publication.confirm); const s = await f.batch.store.load('demo');
  assert.equal(s.publication.members.i1, 101); assert.notEqual(s.publication.rootIID, 101); assert.equal(f.tracker.rows.size, 3); assert.equal(f.worktrees.size, 1);
  assert.match((await f.tracker.issue(101)).description, /"role":"child"/); assert.equal((await f.batch.status(f.ref)).root, `https://gitlab.example/team/app/-/issues/${s.publication.rootIID}`);
});
test('retargeting requires exact confirmed baseline merge in the same worktree', async t => {
  const f = await fixture(t); await f.step('checkpoint', handoff());
  await writeFile(path.join(f.git.cwd, 'next-base.txt'), 'new target'); await f.git.text(['add', '.']); await f.git.text(['commit', '-m', 'target advances']); await f.git.text(['branch', 'new-target']);
  const p = structuredClone(f.p); p.revision = 2; p.targetBranch = 'new-target';
  const preview = await f.batch.revise('demo', p); await assert.rejects(f.batch.revise('demo', p, preview.confirm), /Revision confirmed/);
  assert.equal((await f.batch.store.load('demo')).plan.revision, 1);
  await f.execution.git.text(['merge', 'new-target', '--no-edit']);
  const publication = await f.batch.revise('demo', p, preview.confirm); await f.batch.publish('demo', publication.confirm);
  assert.equal((await f.batch.store.load('demo')).runtime.baseline, await f.git.head()); assert.equal(f.worktrees.size, 1);
});
test('lost local FF response reads back the same candidate without second merge', async t => {
  const f = await fixture(t); await f.accept('i1'); await f.step('checkpoint', handoff()); await f.batch.review(f.ref);
  const token = (await f.batch.integrate(f.ref)).confirm, runner = f.batch.git.runner; let lost = false;
  f.batch.git.runner = async (file, args, options) => { const output = await runner(file, args, options); if (!lost && file === 'git' && args.includes('--ff-only')) { lost = true; throw new Error('lost FF response'); } return output; };
  await assert.rejects(f.batch.integrate(f.ref, token), /lost FF/); assert.equal((await f.batch.store.load('demo')).runtime.integration.merged, false);
  assert.equal((await f.batch.integrate(f.ref, token)).state, 'done'); assert.equal(f.calls.filter(c => c.args.includes('--ff-only')).length, 1);
});
test('symlinked local harness script remains an executable CLI', async t => {
  const f = await fixture(t), link = path.join(f.root, 'skill script 中文.mjs');
  await symlink(path.resolve(import.meta.dirname, '../../skills/in-progress/project-batch/scripts/project-batch.mjs'), link);
  const output = await run(process.execPath, [link, '--help']); assert.match(output.toString(), /No push/);
});
