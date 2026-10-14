import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, handoff } from './helpers.mjs';
import { main } from '../../skills/in-progress/project-batch/scripts/project-batch.mjs';
import { Orca } from '../../skills/in-progress/project-batch/scripts/lib/adapters.mjs';
import { digest } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';

const previous = { executable: 'orca-ide', version: '1.4.219', guideHash: 'a'.repeat(64) };
const current = { ...previous, version: '1.4.220' };
const input = { version: 1, evidence: { source: 'human', description: 'Human delegates verification and confirmation until this exact scratch recovery is complete.' } };
async function ready(t) {
  const f = await fixture(t);
  await f.accept('i1'); await f.step('checkpoint', handoff()); await f.batch.review(f.ref);
  const s = await f.batch.store.load('demo'); s.runtime.orcaCapabilities = previous; await f.batch.save(s);
  f.options.orca.preflight = async () => current;
  return f;
}
const recover = (f, token, data = input) => f.batch.recoverOrca(f.ref, data, token);
const writes = f => f.tracker.calls.filter(c => c.method !== 'GET').length;

test('Orca recovery previews exact state without mutation, preserves review/owner/history and keeps integration separate', async t => {
  const f = await ready(t), before = await f.batch.store.load('demo'), count = writes(f);
  const integrate = await f.batch.integrate(f.ref);
  await assert.rejects(f.batch.integrate(f.ref, integrate.confirm), /capability recovery/);
  const preview = await recover(f);
  assert.equal(preview.action, 'recover-orca');
  assert.deepEqual(preview.payload.previous, previous); assert.deepEqual(preview.payload.current, current);
  assert.equal(preview.payload.git.candidate.head, before.runtime.candidate.candidate);
  assert.deepEqual(await f.batch.store.load('demo'), before);
  await assert.rejects(recover(f, 'stale'), /stale/);
  await recover(f, preview.confirm);
  const after = await f.batch.store.load('demo');
  assert.deepEqual(after.runtime.orcaCapabilities, current);
  assert.deepEqual(after.runtime.candidate, before.runtime.candidate);
  assert.deepEqual(after.runtime.owner, before.runtime.owner);
  assert.deepEqual(after.runtime.integration, before.runtime.integration);
  assert.deepEqual(after.operations.orcaCapabilityRecovery[0].payload, preview.payload);
  assert.equal(after.operations.orcaCapabilityRecovery[0].version, 1);
  const expected = structuredClone(after); expected.runtime.orcaCapabilities = previous; delete expected.operations.orcaCapabilityRecovery;
  assert.deepEqual(expected, before);
  assert.equal(writes(f), count); assert.equal(await f.git.head(), before.runtime.candidate.target);
  await assert.rejects(recover(f, preview.confirm), /forward patch/);
  const again = await f.batch.integrate(f.ref); assert.deepEqual(again, integrate);
  const done = await f.batch.integrate(f.ref, again.confirm);
  assert.equal(done.state, 'done'); assert.equal(done.pushed, false); assert.equal(f.worktrees.size, 0);
});

test('Orca recovery rejects executable/guide/major/minor/downgrade/unknown capability changes and missing authority', async t => {
  const f = await ready(t), before = await f.batch.store.load('demo');
  for (const caps of [{ ...current, executable: 'orca' }, { ...current, guideHash: 'b'.repeat(64) }, { ...current, version: '1.5.0' }, { ...current, version: '2.4.220' }, { ...current, version: '1.4.218' }, previous, { ...current, version: 'unknown' }, { ...current, extra: true }]) {
    f.options.orca.preflight = async () => caps;
    await assert.rejects(recover(f), /capability|executable|guide|forward patch/);
    assert.deepEqual(await f.batch.store.load('demo'), before);
  }
  f.options.orca.preflight = async () => current;
  for (const bad of [undefined, { version: 2 }, { ...input, extra: true }, { ...input, evidence: { source: 'agent', description: 'Self approved' } }, { ...input, evidence: { source: 'human', description: ' ' } }]) await assert.rejects(recover(f, undefined, bad ?? null), /human|input/);
});

test('Orca recovery rejects running/partial integration/future history and wrong checkout', async t => {
  const f = await ready(t), original = await f.batch.store.load('demo');
  await assert.rejects(f.execution.recoverOrca(f.ref, input), /target checkout/);
  for (const mutate of [s => { s.state = 'running'; }, s => { s.runtime.activeIssue = { key: 'i1' }; }, s => { s.runtime.pendingSync = {}; }, s => { s.runtime.acceptance.i1.passed = false; }, s => { s.runtime.integration.mergeAttempted = true; }, s => { s.runtime.integration.merged = true; }, s => { s.runtime.integration.noted = [101]; }, s => { s.runtime.integration.closed = [101]; }, s => { s.runtime.integration.cleanupAttempted = true; }, s => { s.operations.orcaCapabilityRecovery = [{ version: 2 }]; }]) {
    const s = structuredClone(original); mutate(s); await f.batch.save(s);
    await assert.rejects(recover(f), /unstarted|accepted|history|reopened/); assert.deepEqual(await f.batch.store.load('demo'), s);
  }
});

test('Orca recovery refuses dirty Git, tracker state/spec drift, review coverage drift and immutable identity loss', async t => {
  const f = await ready(t), original = await f.batch.store.load('demo');
  for (const mutate of [s => { s.runtime.candidate.reviews = []; }, s => { s.runtime.candidate.reviews[0].candidate = '0'.repeat(40); }, s => { s.runtime.candidate.verification[0].passed = false; }]) {
    const s = structuredClone(original); mutate(s); await f.batch.save(s);
    await assert.rejects(recover(f), /review|verification|identity/i); assert.deepEqual(await f.batch.store.load('demo'), s);
  }
  await f.batch.save(original);
  await writeFile(path.join(f.execution.git.cwd, 'dirty.txt'), 'unfinished'); await assert.rejects(recover(f), /Dirty/);
  const { unlink } = await import('node:fs/promises'); await unlink(path.join(f.execution.git.cwd, 'dirty.txt'));
  const row = f.tracker.rows.get(original.publication.rootIID); row.state = 'closed'; await assert.rejects(recover(f), /opened/); row.state = 'opened';
  const description = row.description; row.description += '\nchanged'; await assert.rejects(recover(f), /specification/); row.description = description;
  f.options.orca.verify = async () => { throw new Error('immutable identity changed'); }; await assert.rejects(recover(f), /identity/);
  assert.deepEqual(await f.batch.store.load('demo'), original);
});

test('Orca confirmation becomes stale after journal, target, candidate or capability changes', async t => {
  for (const changed of ['journal', 'target', 'candidate', 'capabilities']) {
    const f = await ready(t), preview = await recover(f), original = await f.batch.store.load('demo');
    if (changed === 'journal') { original.operations.newFact = 'verified'; await f.batch.save(original); }
    else if (changed === 'capabilities') f.options.orca.preflight = async () => ({ ...current, version: '1.4.221' });
    else { const g = changed === 'target' ? f.git : f.execution.git; await g.text(['commit', '--allow-empty', '-m', 'drift']); }
    const before = await f.batch.store.load('demo');
    await assert.rejects(recover(f, preview.confirm), /stale|changed/);
    assert.deepEqual(await f.batch.store.load('demo'), before);
  }
});

test('Orca changed again during confirmed recovery does not save; lost atomic-save acknowledgement resumes normally', async t => {
  const f = await ready(t), preview = await recover(f), before = await f.batch.store.load('demo');
  let probes = 0; f.options.orca.preflight = async () => ++probes === 1 ? current : { ...current, version: '1.4.221' };
  await assert.rejects(recover(f, preview.confirm), /changed/); assert.deepEqual(await f.batch.store.load('demo'), before);
  f.options.orca.preflight = async () => current;
  const save = f.batch.save; f.batch.save = async s => { await save(s); throw new Error('lost save acknowledgement'); };
  await assert.rejects(recover(f, preview.confirm), /lost save/);
  f.batch.save = save;
  const after = await f.batch.store.load('demo'); assert.deepEqual(after.runtime.orcaCapabilities, current); assert.equal(after.operations.orcaCapabilityRecovery.length, 1);
  const integrate = await f.batch.integrate(f.ref); assert.equal((await f.batch.integrate(f.ref, integrate.confirm)).state, 'done');
});

async function productionPreflight(t) {
  const f = await ready(t), guide = 'worktree terminal', probes = [];
  let version = '1.4.220';
  const adapter = new Orca(f.git.cwd, { env: { ORCA_CLI_COMMAND: 'orca-ide' }, runner: async (file, args) => {
    assert.equal(file, 'orca-ide');
    if (args.includes('--version')) { probes.push(version); return Buffer.from(version); }
    if (args.includes('--help')) return Buffer.from('--base-branch --no-parent --setup --comment --command --worktree --timeout-ms --for --wait-submit --retry-request');
    assert.deepEqual(args, ['skills', 'get', 'orca-cli', '--json']);
    return Buffer.from(JSON.stringify({ markdown: guide }));
  } });
  const s = await f.batch.store.load('demo'); s.runtime.orcaCapabilities = { ...previous, guideHash: digest(guide) }; await f.batch.save(s);
  f.options.orca.preflight = adapter.preflight.bind(adapter);
  return { ...f, adapter, probes, setVersion: value => { version = value; } };
}

test('production adapter cached preflight cannot hide drift during recovery confirmation', async t => {
  const f = await productionPreflight(t), preview = await recover(f), before = await f.batch.store.load('demo');
  const verify = f.options.orca.verify;
  f.options.orca.verify = async address => { await verify(address); f.setVersion('1.4.221'); };
  await assert.rejects(recover(f, preview.confirm), /capabilities changed/);
  assert.deepEqual(await f.batch.store.load('demo'), before);
  assert.deepEqual(f.probes, ['1.4.220', '1.4.220', '1.4.221']);
});

test('production adapter fresh recovery probe invalidates a warmed cache between preview and confirmation', async t => {
  const f = await productionPreflight(t), preview = await recover(f), before = await f.batch.store.load('demo');
  f.setVersion('1.4.221');
  assert.equal((await f.adapter.preflight()).version, '1.4.220', 'Default discovery remains cached');
  await assert.rejects(recover(f, preview.confirm), /stale/);
  assert.deepEqual(await f.batch.store.load('demo'), before);
  const latest = await recover(f); assert.equal(latest.payload.current.version, '1.4.221');
  await recover(f, latest.confirm);
  assert.equal((await f.batch.store.load('demo')).runtime.orcaCapabilities.version, '1.4.221');
});

test('public CLI rejects Orca reconciliation on unrelated operations before opening a batch', async () => {
  for (const args of [['status', '--reconcile-orca', 'x'], ['integrate', '--input', 'x', '--reconcile-orca', 'y'], ['integrate', '--reconcile-create', 'x', '--reconcile-orca', 'y']]) await assert.rejects(main(args), /Orca reconciliation/);
});
