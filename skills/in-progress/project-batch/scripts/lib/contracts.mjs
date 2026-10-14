import { createHash } from 'node:crypto';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const marker = (id, operation) => `<!-- project-batch:v1:${id}:${operation} -->`;
export const safeId = id => {
  assert(typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id), 'Invalid local identifier');
  return id;
};
export function contextPolicy(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return 'unknown';
  if (percent >= 70) return 'checkpoint';
  if (percent >= 60) return 'no_next_issue';
  return 'continue';
}
export function validatePlan(p) {
  assert(p?.version === 1, 'BatchPlan version must be 1');
  safeId(p.id);
  assert(Number.isSafeInteger(p.revision) && p.revision > 0, 'Invalid revision');
  assert(p.provider === undefined || ['github', 'gitlab', 'local'].includes(p.provider), 'Choose one supported tracker provider');
  let u; try { u = new URL(p.origin); } catch { throw new Error('Invalid tracker origin'); }
  if (p.provider === 'local') {
    safeId(p.projectId);
    assert(p.origin === `local://${p.projectId}` && p.projectPath === p.projectId, 'Invalid local project identity');
  } else {
    assert(['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && u.origin === p.origin, 'Use a credential-free tracker origin');
    assert(typeof p.projectPath === 'string' && /^[^/\s]+(?:\/[^/\s]+)+$/.test(p.projectPath) && !p.projectPath.includes('..'), 'Complete tracker project path required');
    assert(Number.isSafeInteger(p.projectId) && p.projectId > 0, 'Verified numeric projectId required');
    assert(p.provider !== 'github' || u.protocol === 'https:' && p.projectPath.split('/').length === 2, 'GitHub requires HTTPS and owner/repository');
  }
  assert(typeof p.targetBranch === 'string' && p.targetBranch && !p.targetBranch.startsWith('-'), 'Target branch required');
  assert(typeof p.title === 'string' && p.title.trim(), 'Batch title required');
  assert(Array.isArray(p.issues) && p.issues.length > 0, 'At least one Issue required');
  assert(Array.isArray(p.segments) && p.segments.length > 0, 'At least one work segment required');
  const keys = new Set();
  const command = c => assert(c && typeof c.file === 'string' && c.file && Array.isArray(c.args) && c.args.every(a => typeof a === 'string') && (!c.timeoutMs || Number.isSafeInteger(c.timeoutMs) && c.timeoutMs > 0), 'Verification requires {file,args,timeoutMs?}; no shell string');
  const max = p.maxIssuesPerSegment ?? 3;
  assert(Number.isSafeInteger(max) && max > 0, 'Invalid segment limit');
  const segmentIds = new Set();
  const placement = new Map();
  for (const [index, s] of p.segments.entries()) {
    safeId(s.id);
    assert(!['cross-domain', 'whole-batch'].includes(s.id), 'Segment ID reserved for aggregate review');
    assert(!segmentIds.has(s.id), 'Duplicate segment'); segmentIds.add(s.id);
    for (const field of ['domain', 'effort', 'verificationCost', 'handoffCondition']) assert(typeof s[field] === 'string' && s[field].trim(), `Segment requires ${field}`);
    assert(Array.isArray(s.issues) && s.issues.length > 0 && s.issues.length <= max, 'Segment exceeds Issue budget');
    for (const [order, key] of s.issues.entries()) {
      assert(!placement.has(key), 'Each Issue must belong to exactly one segment');
      placement.set(key, [index, order]);
    }
  }
  for (const i of p.issues) {
    safeId(i.key); assert(!keys.has(i.key), 'Duplicate Issue key'); keys.add(i.key);
    for (const f of ['title', 'goal', 'scope', 'exclusions']) assert(typeof i[f] === 'string' && i[f].trim(), `Issue requires ${f}`);
    assert(Array.isArray(i.criteria) && i.criteria.length > 0 && i.criteria.every(c => typeof c === 'string' && c.trim()) && new Set(i.criteria).size === i.criteria.length, 'Distinct Acceptance Criteria required');
    assert(Array.isArray(i.verify) && i.verify.length > 0, 'Issue verification required'); i.verify.forEach(command);
    assert(Array.isArray(i.dependsOn) && Array.isArray(i.external) && Array.isArray(i.prerequisites), 'Explicit dependencies and prerequisites required (empty arrays allowed)');
    for (const e of i.external) {
      parseIssueRef(e.url, p); assert(/^[a-f0-9]{40,64}$/.test(e.commit), 'External dependency needs baseline commit');
    }
    for (const r of i.prerequisites) { safeId(r.id); assert(typeof r.description === 'string' && r.description, 'Manual prerequisite description required'); }
    assert(new Set(i.prerequisites.map(r => r.id)).size === i.prerequisites.length, 'Duplicate prerequisite');
    assert(placement.has(i.key), 'Issue missing segment');
  }
  assert(placement.size === keys.size, 'Segment contains unknown Issue');
  for (const i of p.issues) {
    assert(new Set(i.dependsOn).size === i.dependsOn.length, 'Duplicate dependency');
    for (const dep of i.dependsOn) {
      assert(keys.has(dep), 'Unknown dependency');
      const [a, b] = placement.get(dep), [c, d] = placement.get(i.key);
      assert(a < c || a === c && b < d, 'Dependency cycle or invalid segment/order direction');
    }
  }
  assert(Array.isArray(p.verify) && p.verify.length > 0, 'Aggregate verification required'); p.verify.forEach(command);
  return p;
}
export function parseIssueRef(ref, binding) {
  if (/^#[1-9]\d*$/.test(ref)) {
    assert(binding?.verified === true, '#IID requires a freshly verified unique GitLab binding');
    return { origin: binding.origin, projectPath: binding.projectPath, iid: Number(ref.slice(1)), ...(binding.provider && binding.provider !== 'gitlab' ? { provider: binding.provider } : {}) };
  }
  let u; try { u = new URL(ref); } catch { throw new Error('Use a complete GitLab Issue URL'); }
  const local = u.protocol === 'local:', github = !local && !u.pathname.includes('/-/issues/');
  const m = local ? u.pathname.match(/^\/issues\/([1-9]\d*)\/?$/) : github ? u.pathname.match(/^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/) : u.pathname.match(/^\/(.+)\/-\/issues\/([1-9]\d*)\/?$/);
  assert(m && (local || ['http:', 'https:'].includes(u.protocol)) && !u.username && !u.password && !u.search && !u.hash, 'Invalid Issue reference');
  if (local) safeId(u.host);
  const result = local ? { origin: `local://${u.host}`, projectPath: u.host, iid: Number(m[1]), provider: 'local' } : { origin: u.origin, projectPath: decodeURIComponent(m[1]), iid: Number(m[2]), ...(github ? { provider: 'github' } : {}) };
  assert(Number.isSafeInteger(result.iid), 'Unsafe Issue number');
  if (binding) assert(result.origin === binding.origin && result.projectPath === binding.projectPath && (result.provider ?? 'gitlab') === (binding.provider ?? 'gitlab'), 'Issue belongs to another project/provider');
  return result;
}
export const issueURL = (p, iid) => p.provider === 'local' ? `${p.origin}/issues/${iid}` : `${p.origin}/${p.projectPath}/${p.provider === 'github' ? '' : '-/'}issues/${iid}`;
export const metadata = (p, role, key, rootIID) => `<!-- project-batch:v1 ${JSON.stringify({ id: p.id, revision: p.revision, projectId: p.projectId, role, key, rootIID })} -->`;
export function readMetadata(description) {
  const matches = [...(description ?? '').matchAll(/<!-- project-batch:v1 (\{[^\n]+\}) -->/g)];
  assert(matches.length === 1, 'Not an unambiguous project-batch v1 Issue');
  let m; try { m = JSON.parse(matches[0][1]); } catch { throw new Error('Invalid batch metadata JSON'); }
  safeId(m.id);
  assert(['single', 'parent', 'child'].includes(m.role) && Number.isSafeInteger(m.revision), 'Invalid batch metadata');
  return m;
}
export function confirmation(action, payload, supplied) {
  const token = digest({ action, payload });
  if (supplied !== undefined) assert(supplied === token, 'Confirmation is stale or does not match the displayed operation');
  return { action, payload, confirm: token };
}
export function handoffSummary(data) {
  const fields = ['summary', 'completed', 'remaining', 'verification', 'blockers', 'decisions', 'next'];
  assert(data && typeof data.summary === 'string' && Buffer.byteLength(JSON.stringify(data), 'utf8') <= 4096, 'Entire Handoff summary exceeds 4 KiB');
  assert(Object.keys(data).every(f => fields.includes(f)), 'Handoff details belong in separate evidence files');
  for (const f of fields.slice(1)) assert(Array.isArray(data[f]) && data[f].every(v => typeof v === 'string'), `Handoff requires ${f} string array`);
  return data;
}
export function reviewResult(text, expected) {
  let r; try { r = JSON.parse(text.trim()); } catch { throw new Error('Reviewer returned invalid JSON; review incomplete'); }
  assert(r?.version === 1 && r.target === expected.target && r.candidate === expected.candidate && r.shard === expected.shard, 'Reviewer result identity mismatch');
  assert(['pass', 'changes_requested', 'incomplete'].includes(r.status) && Array.isArray(r.findings), 'Invalid reviewer result');
  for (const f of r.findings) assert(typeof f.path === 'string' && typeof f.explanation === 'string' && f.explanation.trim() && Number.isSafeInteger(f.line) && f.line > 0, 'Invalid review finding');
  assert(r.status !== 'pass' || r.findings.length === 0, 'Pass cannot contain findings');
  return r;
}
