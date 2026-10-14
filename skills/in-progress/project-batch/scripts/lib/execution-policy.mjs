import { contextPolicy } from './contracts.mjs';

export const readOnlyTools = new Set(['read', 'grep', 'find', 'ls', 'ffgrep', 'fffind', 'symbol_search', 'module_report', 'project_report', 'read_symbol', 'read_enclosing', 'effective_config', 'lens_diagnostics']);
export function contextHighWater(current, saved) {
  const values = [current, saved].filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return values.length ? Math.max(...values) : null;
}

// A mistake-prevention policy at tool boundaries, not an OS sandbox. Shell and
// unknown tools are never classified by their argument strings as read-only.
export function executionPolicy(state, session, percent) {
  const r = state.runtime;
  const policy = contextPolicy(contextHighWater(percent, r.contextPercent));
  const initialClaim = r.launchSession === session && r.generation === 0 && !r.owner;
  const owning = r.owner?.session === session && r.owner.generation === r.generation;
  const sameSegment = r.sessionSegment === r.segment && (!r.sessions?.[session] || r.sessions[session].generation === r.generation && r.sessions[session].segment === r.segment);
  let reason;
  if (!initialClaim && (!owning || !sameSegment)) reason = 'Superseded generation or work segment: read-only inspection only.';
  else if (['handoff_ready', 'awaiting_integration', 'done', 'draft', 'ready'].includes(state.state)) reason = 'Execution stopped at its handoff/delivery boundary.';
  else if (state.schemaBlocked) reason = 'Schema change/gate blocked: checkpoint preserved work and return to complete planning; no feature writes.';
  else if ((r.testRuns ?? []).some(t => t.cleanup?.status !== 'pass')) reason = 'Owned test-data cleanup pending: controlled cleanup only, no new tests or feature writes.';
  else if (policy === 'checkpoint') reason = 'Context high-water ≥70%: checkpoint/sync and stop; ordinary writes and shell are disabled.';
  else if (state.plan.segments[r.segment]?.issues.every(k => r.acceptance?.[k]?.passed)) reason = 'Work segment complete: checkpoint and stop.';
  return { policy, owning, reason, controlled: owning, writable: !reason };
}
export function toolBoundary(state, session, percent, toolName) {
  if (readOnlyTools.has(toolName)) return undefined;
  const policy = executionPolicy(state, session, percent);
  if (toolName === 'project_batch_checkpoint' && policy.controlled) return undefined;
  if (toolName === 'project_batch_claim' && (policy.owning || !state.runtime.sessions?.[session])) return undefined;
  if (!policy.writable) return { block: true, reason: `${policy.reason} Use project_batch_checkpoint for controlled checkpoint/sync when still the recorded owner; use a human-confirmed fresh session for execution.` };
}
