import { realpath } from 'node:fs/promises';
import { Batch } from '../scripts/lib/runtime.mjs';
import { nextSession } from '../scripts/lib/handoff.mjs';
import { assert, contextPolicy, issueURL } from '../scripts/lib/contracts.mjs';
import { contextHighWater, toolBoundary } from '../scripts/lib/execution-policy.mjs';

// Structural port for the documented Pi methods used here. No local Pi dependency or
// machine-specific type path is needed; load-time smoke checks the real host mapping.
type Context = {
  cwd: string;
  mode: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  getContextUsage(): { percent: number | null } | undefined;
  ui: { confirm?(title: string, message: string): Promise<boolean>; setStatus(key: string, text: string): void; setWidget(key: string, lines: string[] | undefined): void; notify(text: string, level: 'warning'): void };
};
type PiPort = {
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: Context): Promise<void> }): void;
  registerTool(tool: { name: string; label: string; description: string; parameters: object; execute(id: string, params: { ref: string; action: 'checkpoint' | 'sync' | 'cleanup' | 'schema-stop'; handoff?: object; reason?: string }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Context): Promise<unknown> }): void;
  on(event: 'session_start' | 'turn_end' | 'agent_end' | 'before_agent_start' | 'tool_call', handler: (event: unknown, ctx: Context) => Promise<unknown>): void;
};
export default function (pi: PiPort, { openBatch = (cwd: string) => Batch.open(cwd) } = {}) {
  pi.registerCommand('project-batch-next', {
    description: 'Confirmed same-terminal fresh session for a synchronized Project batch handoff',
    handler: async (args, ctx) => {
      try {
        const batch = await openBatch(ctx.cwd);
        await nextSession(ctx, args, batch);
      } catch (error) {
        // The command context may be invalid after replacement; log rather than reuse old UI.
        console.error(`project-batch-next: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  async function current(ctx: Context) {
    const batch = await openBatch(ctx.cwd);
    const session = ctx.sessionManager.getSessionId();
    const states: Array<{ plan: { id: string; origin: string; projectPath: string }; publication: { rootIID: number }; state: string; runtime?: { worktree?: { path: string }; owner?: { session: string; generation: number }; launchSession: string; generation: number; sessions?: Record<string, { generation: number; segment: number }>; contextPercent?: number | null; segment: number; sessionSegment?: number; acceptance?: Record<string, { passed: boolean }> } }> = await batch.store.all();
    const cwd = await realpath(ctx.cwd);
    const matches = states.filter(s => s.runtime?.worktree?.path === cwd || s.runtime?.owner?.session === session || s.runtime?.launchSession === session || s.runtime?.sessions?.[session]);
    assert(matches.length <= 1, 'Ambiguous batch session ownership; stop for recovery');
    if (!matches[0]?.runtime) return undefined;
    return { batch, state: { ...matches[0], runtime: matches[0].runtime }, session };
  }
  // Pi may dispatch sibling tool calls concurrently. Serialize only our local
  // metadata observations; tools themselves are not queued or force-killed.
  let boundaryTail: Promise<unknown> = Promise.resolve();
  function atBoundary(ctx: Context) {
    const next = boundaryTail.then(() => recordBoundary(ctx));
    boundaryTail = next.then(() => undefined, () => undefined);
    return next;
  }
  async function recordBoundary(ctx: Context) {
    const match = await current(ctx);
    if (!match) return;
    const usage = ctx.getContextUsage?.()?.percent;
    if (match.state.runtime.owner?.session === match.session && contextHighWater(usage, match.state.runtime.contextPercent) !== (match.state.runtime.contextPercent ?? null)) {
      await match.batch.store.locked(match.state.plan.id, async () => {
        const latest = await match.batch.store.load(match.state.plan.id);
        match.state = latest;
        if (latest.runtime.owner?.session !== match.session) return;
        latest.runtime.contextPercent = contextHighWater(usage, latest.runtime.contextPercent);
        await match.batch.save(latest);
      });
    }
    return match;
  }
  pi.registerTool({
    name: 'project_batch_claim', label: 'Batch session claim',
    description: 'Claim only this worktree’s recorded batch with the actual Pi session ID. A takeover requires a live human dialog confirming the prior executor is inactive; no feature edits or integration.',
    parameters: { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: { type: 'string' } } },
    execute: async (_id, params, signal, _update, ctx) => {
      assert(!signal?.aborted, 'Claim cancelled before dispatch');
      const match = await atBoundary(ctx);
      if (!match) throw new Error('No recorded batch in this execution worktree');
      assert(params.ref === issueURL(match.state.plan, match.state.publication.rootIID) || params.ref === `#${match.state.publication.rootIID}`, 'Claim requires this worktree’s root Issue');
      const evidence = 'Human confirms in the live claim dialog that the prior executor is inactive and this exact session may own the batch';
      const preview = await match.batch.resume(params.ref, { session: match.session, inactiveEvidence: evidence });
      let result = preview;
      if (preview.confirm) {
        const confirmUI = ctx.ui?.confirm;
        if (!confirmUI) throw new Error('Human claim confirmation UI unavailable; no takeover');
        const accepted = await confirmUI.call(ctx.ui, 'Claim batch — prior executor must be stopped', JSON.stringify(preview.payload, null, 2));
        if (!accepted || signal?.aborted) return { content: [{ type: 'text', text: 'Claim cancelled; ownership unchanged.' }] };
        result = await match.batch.resume(params.ref, { session: match.session, inactiveEvidence: evidence, confirm: preview.confirm });
      }
      const summary = match.batch.view(result);
      return { content: [{ type: 'text', text: JSON.stringify(summary) }], details: summary };
    },
  });
  pi.registerTool({
    name: 'project_batch_checkpoint', label: 'Project batch checkpoint',
    description: 'Checkpoint, synchronize, stop for a new schema requirement or reconcile owned test-data cleanup for the current batch owner only. Uses the actual Pi session/generation/context; no new session, implementation commit, integration or push. Supply the root Issue reference and, for checkpoint, a handoff whose entire JSON is ≤4 KiB.',
    // JSON Schema is also the wire shape of Pi TypeBox schemas; no package dependency.
    parameters: { type: 'object', additionalProperties: false, required: ['ref', 'action'], properties: {
      ref: { type: 'string' }, action: { type: 'string', enum: ['checkpoint', 'sync', 'cleanup', 'schema-stop'] }, reason: { type: 'string' },
      handoff: { type: 'object', additionalProperties: false, required: ['summary', 'completed', 'remaining', 'verification', 'blockers', 'decisions', 'next'], properties: {
        summary: { type: 'string' }, ...Object.fromEntries(['completed', 'remaining', 'verification', 'blockers', 'decisions', 'next'].map(key => [key, { type: 'array', items: { type: 'string' } }])),
      } },
    } },
    execute: async (_id, params, signal, _update, ctx) => {
      assert(!signal?.aborted, 'Checkpoint cancelled before dispatch');
      assert(['checkpoint', 'sync', 'cleanup', 'schema-stop'].includes(params.action), 'Only checkpoint/sync/owned cleanup/schema stop allowed');
      const match = await atBoundary(ctx);
      if (!match || match.state.runtime.owner?.session !== match.session) throw new Error('No matching current batch owner');
      assert(params.ref === issueURL(match.state.plan, match.state.publication.rootIID) || params.ref === `#${match.state.publication.rootIID}`, 'Controlled checkpoint requires this owner’s root Issue');
      const result = await match.batch.step(params.ref, { action: params.action, input: params.action === 'schema-stop' ? { reason: params.reason } : params.handoff, session: match.session, generation: match.state.runtime.generation, percent: match.state.runtime.contextPercent });
      const summary = match.batch.view(result);
      return { content: [{ type: 'text', text: JSON.stringify(summary) }], details: summary };
    },
  });
  async function observe(ctx: Context) {
    const match = await atBoundary(ctx);
    if (!match) return;
    const { state } = match;
    const policy = contextPolicy(contextHighWater(ctx.getContextUsage?.()?.percent, state.runtime.contextPercent));
    ctx.ui.setStatus('project-batch', `${state.plan.id}: ${state.state}; segment ${state.runtime.segment + 1}; ${policy}`);
    if (state.state === 'awaiting_integration' || state.state === 'done') {
      ctx.ui.setWidget('project-batch', ['Project batch execution complete: no next execution session.', 'Review and human-confirmed local integration belong in the target checkout. NOT pushed.']);
    } else if (policy === 'checkpoint' || state.state === 'handoff_ready') {
      ctx.ui.setWidget('project-batch', ['Project batch: use project_batch_checkpoint for checkpoint/sync, then stop.', `After synchronization, human: /project-batch-next ${issueURL(state.plan, state.publication.rootIID)}`]);
    } else if (policy === 'no_next_issue') {
      ctx.ui.setWidget('project-batch', ['Project batch context ≥60%: finish/checkpoint the active Issue; do not start another.']);
    } else ctx.ui.setWidget('project-batch', undefined);
  }
  for (const event of ['session_start', 'turn_end', 'agent_end'] as const) {
    pi.on(event, async (_event, ctx) => {
      try { await observe(ctx); } catch (error) {
        ctx.ui.notify(`Project batch observer unavailable: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    });
  }
  pi.on('tool_call', async (event, ctx) => {
    const toolName = (event as { toolName: string }).toolName;
    const match = await atBoundary(ctx);
    if (!match) return;
    return toolBoundary(match.state, match.session, ctx.getContextUsage?.()?.percent, toolName);
  });
  pi.on('before_agent_start', async (_event, ctx) => {
    const match = await atBoundary(ctx);
    if (!match) return;
    const { state, session } = match;
    return { message: {
      customType: 'project-batch-boundary', display: false,
      content: `project-batch ${state.plan.id}: session ${session}, generation ${state.runtime.owner?.generation ?? 'not claimed'}, state ${state.state}, segment ${state.runtime.segment}. Context policy ${contextPolicy(contextHighWater(ctx.getContextUsage?.()?.percent, state.runtime.contextPercent))}. Resume/claim through the batch script; read its execution reference. Execute only the recorded segment. Segment end and ≥70% require safe checkpoint and stop; ≥60% forbids another Issue. Unknown context is not spare budget; compaction does not extend authority. New-session, integration and push need their separate human boundaries.`,
    } };
  });
}
