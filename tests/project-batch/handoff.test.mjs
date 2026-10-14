import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSession } from '../../skills/in-progress/project-batch/scripts/lib/handoff.mjs';
import register from '../../skills/in-progress/project-batch/extensions/session-handoff.ts';
import { fixture, handoff } from './helpers.mjs';

function context(f, { choice = '新 session 繼續', cancel = false, pending = false, fail = false } = {}) {
  const messages = [], calls = [];
  const ctx = {
    mode: 'tui', cwd: f.execution.git.cwd, waitForIdle: async () => { calls.push('idle'); }, hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => f.session, getSessionFile: () => 'old-session.jsonl', getBranch: () => { throw new Error('Transcript must never be copied'); } },
    ui: { select: async () => choice },
    newSession: async options => {
      calls.push({ newSession: options.parentSession });
      assert.equal(options.setup, undefined);
      if (cancel) return { cancelled: true };
      await options.withSession({ sessionManager: { getSessionId: () => 'replacement-session' }, sendUserMessage: async (text, opts) => { if (fail) throw new Error('mock initializer failed'); messages.push({ text, opts }); } });
      return { cancelled: false };
    },
  };
  return { ctx, messages, calls };
}
test('new same-terminal session uses withSession, carries only bounded authority and durable pointers', async t => {
  const f = await fixture(t); await f.step('begin'); await f.step('checkpoint', handoff());
  const c = context(f); const result = await nextSession(c.ctx, f.ref, f.execution);
  assert.equal(result.newSession, 'replacement-session'); assert.equal(c.messages.length, 1);
  assert.ok(c.messages[0].text.includes('generation 2')); assert.ok(c.messages[0].text.includes('segment 0'));
  assert.equal(c.messages[0].opts.expandPromptTemplates, false); assert.ok(Buffer.byteLength(c.messages[0].text) < 4096);
  await assert.rejects(nextSession(c.ctx, f.ref, f.execution), /handoff/);
});
for (const [name, options] of [['pause', { choice: '暫停' }], ['dialog cancelled', { choice: null }], ['Pi replacement cancelled', { cancel: true }]]) test(`next ${name} preserves checkpoint and generation`, async t => {
  const f = await fixture(t); await f.step('checkpoint', handoff()); const c = context(f, options);
  await nextSession(c.ctx, f.ref, f.execution);
  assert.equal((await f.batch.store.load('demo')).runtime.generation, 1); assert.equal((await f.batch.store.load('demo')).state, 'handoff_ready');
});
test('pending messages refuse switching; failed initializer retains resumable handoff', async t => {
  const f = await fixture(t); await f.step('checkpoint', handoff());
  await assert.rejects(nextSession(context(f, { pending: true }).ctx, f.ref, f.execution), /Pending/);
  await assert.rejects(nextSession(context(f, { fail: true }).ctx, f.ref, f.execution), /initializer failed/);
  const s = await f.batch.store.load('demo'); assert.equal(s.state, 'handoff_ready'); assert.equal(s.runtime.owner.session, 'replacement-session');
  assert.ok(s.runtime.handoff); assert.equal(s.runtime.activeIssue, null);
});
test('extension factory registers exactly one user command; lifecycle only observes and hints', async t => {
  const f = await fixture(t), commands = new Map(), events = new Map();
  register({ registerTool: () => {}, registerCommand: (name, spec) => commands.set(name, spec), on: (name, handler) => events.set(name, handler) });
  assert.deepEqual([...commands.keys()], ['project-batch-next']);
  let percent = 72; const notifications = [];
  const ctx = { cwd: f.execution.git.cwd, sessionManager: { getSessionId: () => f.session }, getContextUsage: () => ({ percent }), ui: { setStatus: (...a) => notifications.push(a), setWidget: (...a) => notifications.push(a), notify: (...a) => notifications.push(a) }, newSession: () => { throw new Error('Lifecycle must not switch'); } };
  await events.get('turn_end')({}, ctx); percent = 1; await events.get('turn_end')({}, ctx);
  assert.equal((await f.batch.store.load('demo')).runtime.contextPercent, 72);
  const message = await events.get('before_agent_start')({}, ctx); assert.match(message.message.content, /generation 1/);
  await assert.rejects(f.step('begin'), /Context/);
});
