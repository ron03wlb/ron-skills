import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fixture, handoff } from './helpers.mjs';
import register from '../../skills/in-progress/project-batch/extensions/session-handoff.ts';

// Real temporary Git repositories; tracker, Orca and Pi ports are fault-injected.
// These cases do not claim live external-adapter or TUI acceptance.
test('total tracker outage still saves the owned dirty checkpoint and exact pending evidence locally', async t => {
  const f = await fixture(t); await f.step('begin');
  await writeFile(path.join(f.execution.git.cwd, 'unfinished.bin'), Buffer.from([0, 255, 3]));
  const before = await f.execution.git.fingerprint();
  f.tracker.fail = () => true;
  const result = await f.step('checkpoint', handoff());
  const s = await f.batch.store.load('demo');
  assert.equal(result.state, 'handoff_ready'); assert.ok(result.synchronizationError);
  assert.deepEqual(s.runtime.handoff.fingerprint, before);
  assert.equal(s.runtime.activeIssue.key, 'i1'); assert.ok(s.runtime.pendingSync);
  assert.deepEqual(await f.execution.git.fingerprint(), before);
  f.tracker.fail = null; await f.step('sync');
  assert.equal((await f.batch.store.load('demo')).runtime.pendingSync, null);
});

test('crash takeover without a saved handoff binds actual dirty fingerprint into its confirmation', async t => {
  const f = await fixture(t); await f.step('begin');
  const file = path.join(f.execution.git.cwd, 'unfinished.txt'); await writeFile(file, 'original unfinished work');
  const args = { session: 'new-recovery-session', inactiveEvidence: 'Fault fixture: prior executor inactive' };
  const preview = await f.execution.resume(f.ref, args);
  await writeFile(file, 'changed after the preview');
  await assert.rejects(f.execution.resume(f.ref, { ...args, confirm: preview.confirm }), /confirmation|fingerprint|changed/i);
  assert.equal((await f.owner()).session, f.session);
});

test('a previously closed Issue reopened during partial closeout blocks cleanup instead of trusting its journal', async t => {
  const f = await fixture(t); await f.accept('i1'); await f.step('checkpoint', handoff()); await f.batch.review(f.ref);
  const preview = await f.batch.integrate(f.ref); f.setRemoveFails(true);
  await assert.rejects(f.batch.integrate(f.ref, preview.confirm), /cleanup failure/);
  const s = await f.batch.store.load('demo'); assert.deepEqual(s.runtime.integration.closed, [s.publication.rootIID]);
  f.tracker.rows.get(s.publication.rootIID).state = 'opened'; f.setRemoveFails(false);
  await assert.rejects(f.batch.integrate(f.ref, preview.confirm), /reopened|closure.*drift|tracker state|closed.*changed/i);
  await access(s.runtime.worktree.path);
  assert.equal((await f.batch.store.load('demo')).runtime.integration.cleaned, false);
  assert.equal(f.tracker.rows.get(s.publication.rootIID).state, 'opened');
});

test('review snapshot keeps the full NUL-delimited filename including tabs and newlines', async t => {
  const f = await fixture(t), name = 'review\tname\n中文.bin', bytes = Buffer.from([0, 255, 128, 13, 10]);
  await f.step('begin'); await writeFile(path.join(f.execution.git.cwd, name), bytes);
  await f.step('accept', { key: 'i1', paths: [name], message: 'Accept unusual Git path', criteria: [{ criterion: 'i1 works', passed: true, evidence: 'Fault fixture binary path' }] });
  const destination = path.join(f.root, 'snapshot'); await f.batch.snapshot(f.execution.git, await f.execution.git.head(), destination);
  assert.deepEqual(await readFile(path.join(destination, name)), bytes);
});

test('an unrelated unclaimed Pi session in the execution Git identity cannot write before controlled claim', async t => {
  const f = await fixture(t), events = new Map(), tools = new Map();
  register({ registerCommand: () => {}, registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => events.set(name, handler) }, { openBatch: async () => f.execution });
  const ctx = { cwd: f.execution.git.cwd, sessionManager: { getSessionId: () => 'unclaimed-new-session' }, getContextUsage: () => ({ percent: 1 }) };
  for (const toolName of ['write', 'edit', 'bash', 'ctx_execute']) assert.equal((await events.get('tool_call')({ toolName }, ctx))?.block, true);
  assert.equal(await events.get('tool_call')({ toolName: 'read' }, ctx), undefined);
  assert.ok(tools.has('project_batch_claim'));
});
