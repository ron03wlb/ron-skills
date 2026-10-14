import test from 'node:test';
import assert from 'node:assert/strict';
import { Batch } from '../../skills/in-progress/project-batch/scripts/lib/runtime.mjs';
import { main } from '../../skills/in-progress/project-batch/scripts/project-batch.mjs';
import { handoffSummary } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';
import { fixture, handoff } from './helpers.mjs';

test('large runtime summary is bounded while full includes plan, acceptance and recovery journals', async t => {
  const f = await fixture(t), result = await f.batch.status(f.ref);
  for (let n = 0; n < 1000; n++) {
    const key = `issue-${n}`;
    result.issues.push({ key, criteria: ['large'.repeat(2000)] });
    result.runtime.acceptance[key] = { passed: true, commit: 'a'.repeat(40), criteria: ['中'.repeat(10000)], verification: [{ log: '/private/full.log' }] };
  }
  result.runtime.handoff = { ...handoff(), fingerprint: { data: 'large'.repeat(20000) } };
  result.runtime.blocker = '中'.repeat(30000);
  result.operations.test = { status: 'attempted', text: 'large'.repeat(3000) };
  const summary = f.batch.view(result);
  assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 4096);
  assert.equal(summary.total, 1001); assert.equal(summary.latest.issue, 'issue-999');
  assert.ok(!JSON.stringify(summary).includes('fingerprint'));
  const full = f.batch.view(result, 'full'); assert.equal(full, result);
  assert.deepEqual(full.plan.verify, f.p.verify); assert.ok(full.operations.test); assert.ok(full.runtime.handoff.fingerprint);
  assert.match(summary.evidence.runtime, /batches\/demo.json/);
});

test('CLI defaults status/resume/step to summary, supports full and never shortens confirmation payloads', async t => {
  const f = await fixture(t), original = Batch.open;
  Batch.open = async () => f.execution; t.after(() => { Batch.open = original; });
  const summary = await main(['status', f.ref]); assert.equal(summary.runtime, undefined); assert.equal(summary.owner.generation, 1);
  const full = await main(['status', f.ref, '--view', 'full']); assert.ok(full.runtime); assert.deepEqual(full.plan, f.p); assert.ok(full.publication.descriptions);
  const resume = await main(['resume', f.ref, '--session', f.session]); assert.equal(resume.runtime, undefined);
  const begin = await main(['step', f.ref, '--session', f.session, '--generation', '1', '--action', 'begin']);
  assert.equal(begin.activeIssue, 'i1'); assert.equal(begin.issue, undefined);
  const detail = await main(['step', f.ref, '--session', f.session, '--generation', '1', '--action', 'sync', '--view', 'full']);
  assert.equal(detail.runtime.activeIssue.key, 'i1');
  for (const view of ['summary', 'full']) {
    assert.deepEqual(await main(['publish', 'demo', '--view', view]), await f.batch.publish('demo'));
    assert.deepEqual(await main(['start', f.ref, '--view', view]), await f.batch.start(f.ref));
  }
  await assert.rejects(main(['status', f.ref, '--view', 'invalid']), /View/);
});

test('entire handoff JSON, not merely summary string, shares the 4 KiB budget', () => {
  assert.throws(() => handoffSummary({ ...handoff(), remaining: ['中'.repeat(1400)] }), /4 KiB/);
  assert.throws(() => handoffSummary({ ...handoff(), remaining: [{ full: 'log' }] }), /string array/);
  assert.throws(() => handoffSummary({ ...handoff(), fingerprint: 'not a model summary field' }), /separate evidence/);
  const summary = { ...handoff(), remaining: ['詳細證據: /git/common/project-batch/evidence/demo/unfinished.json'] };
  assert.deepEqual(handoffSummary(summary), summary);
});
