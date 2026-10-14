import test from 'node:test';
import assert from 'node:assert/strict';
import register from '../../skills/in-progress/project-batch/extensions/session-handoff.ts';
import { executionPolicy, toolBoundary, contextHighWater } from '../../skills/in-progress/project-batch/scripts/lib/execution-policy.mjs';
import { fixture, handoff } from './helpers.mjs';

function extension(f, percent = 1, session = f.session) {
  const tools = new Map(), events = new Map();
  register({ registerCommand: () => {}, registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => events.set(name, handler) }, { openBatch: async () => f.execution });
  const ctx = { cwd: f.execution.git.cwd, sessionManager: { getSessionId: () => session }, getContextUsage: () => ({ percent }) };
  return { events, tools, ctx, percent: value => { percent = value; } };
}

for (const boundary of ['high-context', 'segment-complete', 'handoff_ready', 'awaiting_integration']) test(`current owner refuses edit/write/bash at ${boundary} but can checkpoint/sync`, async t => {
  const f = await fixture(t);
  if (boundary === 'segment-complete' || boundary === 'awaiting_integration') await f.accept('i1');
  if (boundary === 'handoff_ready' || boundary === 'awaiting_integration') await f.step('checkpoint', handoff());
  const e = extension(f, boundary === 'high-context' ? 70 : 1);
  for (const toolName of ['edit', 'write', 'bash', 'ctx_execute', 'mcp']) {
    assert.equal((await e.events.get('tool_call')({ toolName }, e.ctx)).block, true);
  }
  assert.equal(await e.events.get('tool_call')({ toolName: 'read' }, e.ctx), undefined);
  assert.equal(await e.events.get('tool_call')({ toolName: 'project_batch_checkpoint' }, e.ctx), undefined);
  const tool = e.tools.get('project_batch_checkpoint');
  const result = await tool.execute('test', { ref: f.ref, action: 'checkpoint', handoff: handoff() }, undefined, undefined, e.ctx);
  assert.ok(result.content[0].text.includes('pendingSync'));
  await tool.execute('test', { ref: f.ref, action: 'sync' }, undefined, undefined, e.ctx);
  const state = await f.batch.store.load('demo'); assert.ok(state.runtime.handoff);
  assert.equal(state.runtime.generation, 1);
});

test('tool boundary captures high-water immediately; compaction and script input cannot reset it', async t => {
  const f = await fixture(t, 2), e = extension(f, 60);
  assert.equal(await e.events.get('tool_call')({ toolName: 'write' }, e.ctx), undefined);
  e.percent(1); await assert.rejects(f.step('begin', {}, { percent: 1 }), /Context/);
  // Simulate an already active Issue before context reaches the exit signal.
  const s = await f.batch.store.load('demo'); s.runtime.activeIssue = { key: 'i1', start: await f.execution.git.head() }; s.state = 'blocked'; await f.batch.save(s);
  assert.equal(await e.events.get('tool_call')({ toolName: 'edit' }, e.ctx), undefined);
  e.percent(71); assert.equal((await e.events.get('tool_call')({ toolName: 'bash' }, e.ctx)).block, true);
  e.percent(0); assert.equal((await e.events.get('tool_call')({ toolName: 'write' }, e.ctx)).block, true);
  await assert.rejects(f.step('accept', { key: 'i1' }, { percent: 1 }), /70%/);
  assert.equal((await f.batch.store.load('demo')).runtime.contextPercent, 71);
});

test('parallel read-only boundaries serialize metadata without lock collisions', async t => {
  const f = await fixture(t), e = extension(f, 72);
  const results = await Promise.all(['read', 'grep', 'find', 'ls'].map(toolName => e.events.get('tool_call')({ toolName }, e.ctx)));
  assert.deepEqual(results, [undefined, undefined, undefined, undefined]);
  assert.equal((await f.batch.store.load('demo')).runtime.contextPercent, 72);
});

test('same-segment blocked owner can repair before exhausting budget; stale generation/segment is read-only', async t => {
  const f = await fixture(t, 3), s = await f.batch.store.load('demo'); s.state = 'blocked';
  assert.equal(executionPolicy(s, f.session, 59).writable, true);
  s.runtime.owner.generation++; assert.equal(toolBoundary(s, f.session, 1, 'edit').block, true);
  s.runtime.owner.generation--; s.runtime.segment++;
  assert.equal(toolBoundary(s, f.session, 1, 'bash').block, true);
  assert.equal(toolBoundary(s, f.session, 1, 'read'), undefined);
  assert.equal(contextHighWater(1, 80), 80); assert.equal(contextHighWater(undefined, null), null);
});

test('controlled tool rejects foreign root, forged operation, stale owner and cancellation', async t => {
  const f = await fixture(t), e = extension(f), tool = e.tools.get('project_batch_checkpoint');
  for (const params of [{ ref: '#999', action: 'sync' }, { ref: f.ref, action: 'integrate' }]) await assert.rejects(tool.execute('test', params, undefined, undefined, e.ctx));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tool.execute('test', { ref: f.ref, action: 'sync' }, abort.signal, undefined, e.ctx), /cancelled/);
  await f.step('checkpoint', handoff()); await f.execution.claimNext(await f.execution.prepareNext(f.ref, f.session), 'fresh');
  assert.equal((await e.events.get('tool_call')({ toolName: tool.name }, e.ctx)).block, true);
  await assert.rejects(tool.execute('test', { ref: f.ref, action: 'sync' }, undefined, undefined, e.ctx), /owner/);
});
