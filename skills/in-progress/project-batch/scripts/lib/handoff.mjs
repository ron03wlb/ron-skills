import path from 'node:path';
import { assert } from './contracts.mjs';

// Called only by the user command handler; lifecycle observers never replace sessions.
export async function nextSession(ctx, ref, batch) {
  assert(ctx.mode === 'tui', 'project-batch-next requires the interactive batch terminal');
  assert(ref.trim(), 'Usage: /project-batch-next <root-issue-ref>');
  await ctx.waitForIdle();
  assert(!ctx.hasPendingMessages(), 'Pending messages: drain/cancel them before session handoff');
  const oldSession = ctx.sessionManager.getSessionId();
  const packet = await batch.prepareNext(ref.trim(), oldSession);
  const parentSession = ctx.sessionManager.getSessionFile();
  const choice = await ctx.ui.select('工作段交接', ['新 session 繼續', '暫停']);
  if (choice !== '新 session 繼續') return { paused: true };
  await ctx.waitForIdle();
  assert(!ctx.hasPendingMessages(), 'Messages queued during confirmation; handoff cancelled');
  // Revalidate after the human dialog; a duplicate command cannot consume an old ticket.
  const current = await batch.prepareNext(ref.trim(), oldSession);
  assert(current.generation === packet.generation && current.handoffHash === packet.handoffHash, 'Handoff changed during confirmation');
  let replacementSession;
  try {
    const result = await ctx.newSession({
      parentSession,
      withSession: async fresh => {
        replacementSession = fresh.sessionManager.getSessionId();
        const execution = await batch.claimNext(packet, replacementSession);
        const prompt = `Read ${path.join(batch.skillPath, 'SKILL.md')} and its execution reference. Human confirmed a new session for batch ${packet.id}, plan ${packet.planHash}. Resume ${packet.ref}, owner session ${replacementSession}, generation ${execution.runtime.generation}. Read the durable BatchRuntime/Handoff under Git common directory; do not copy the old transcript. Continue only segment ${execution.runtime.segment}, including any unfinished active Issue. Stop at its handoff boundary. Integration and push are not authorized.`;
        assert(Buffer.byteLength(prompt, 'utf8') <= 4096, 'Continuation prompt exceeds 4 KiB; retain checkpoint for recovery');
        await fresh.sendUserMessage(prompt, { expandPromptTemplates: false });
      },
    });
    return { cancelled: result.cancelled, newSession: result.cancelled ? undefined : replacementSession };
  } catch (error) {
    if (replacementSession) await batch.failNext(packet, replacementSession, error.message);
    throw error;
  }
}
