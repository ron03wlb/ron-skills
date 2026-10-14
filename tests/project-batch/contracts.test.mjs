import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, parseIssueRef, contextPolicy, handoffSummary, reviewResult, confirmation, digest } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';
import { orcaExecutable, localOrcaPath, supported, quote, run } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';
import { plan, handoff } from './helpers.mjs';

test('single and multi Issue plans; bounded domain segments', () => {
  assert.equal(validatePlan(plan()).issues.length, 1);
  assert.equal(validatePlan(plan(3)).segments.length, 2);
});
for (const [name, change] of [
  ['cycle', p => { p.issues[0].dependsOn = ['i2']; }],
  ['unknown dependency', p => { p.issues[0].dependsOn = ['missing']; }],
  ['duplicate mapping', p => { p.segments[1].issues.push('i1'); }],
  ['missing mapping', p => { p.segments[0].issues.pop(); }],
  ['cross-segment reversal', p => { p.issues[0].dependsOn = ['i3']; }],
  ['issue budget', p => { p.maxIssuesPerSegment = 1; }],
  ['missing costs', p => { delete p.segments[0].effort; }],
  ['missing verification', p => { p.verify = []; }],
  ['shell string command', p => { p.issues[0].verify = ['npm test']; }],
  ['path traversal batch id', p => { p.id = '../outside'; }],
]) test(`reject ${name}`, () => { const p = plan(3); change(p); assert.throws(() => validatePlan(p)); });
test('context 60/70/unknown and overshoot signals', () => {
  assert.equal(contextPolicy(59.9), 'continue'); assert.equal(contextPolicy(60), 'no_next_issue');
  assert.equal(contextPolicy(70), 'checkpoint'); assert.equal(contextPolicy(120), 'checkpoint');
  for (const n of [null, undefined, NaN, -1]) assert.equal(contextPolicy(n), 'unknown');
});
test('refs require explicit complete or verified binding', () => {
  assert.throws(() => parseIssueRef('#123', plan()), /verified/);
  assert.equal(parseIssueRef('#123', { ...plan(), verified: true }).iid, 123);
  assert.equal(parseIssueRef('https://gitlab.example/group/sub/app/-/issues/12').projectPath, 'group/sub/app');
  assert.throws(() => parseIssueRef('https://elsewhere/team/app/-/issues/1', plan()), /another/);
  assert.throws(() => parseIssueRef('https://gitlab.example/team/app/-/issues/1?x=2'));
});
test('handoff UTF-8 budget and exact confirmations', () => {
  assert.equal(handoffSummary(handoff()).summary, 'Bounded checkpoint');
  assert.throws(() => handoffSummary({ ...handoff(), summary: '中'.repeat(1400) }), /4 KiB/);
  const p = confirmation('integrate', { candidate: 'one' });
  assert.throws(() => confirmation('integrate', { candidate: 'two' }, p.confirm), /stale/);
});
test('review cannot pass with invalid identity, findings, or unparsable output', () => {
  const identity = { target: 't', candidate: 'c', shard: 'A' };
  const r = { version: 1, ...identity, status: 'pass', findings: [] };
  assert.equal(reviewResult(JSON.stringify(r), identity).status, 'pass');
  for (const input of ['bad', JSON.stringify({ ...r, target: 'x' }), JSON.stringify({ ...r, findings: [{}] }), JSON.stringify({ ...r, findings: [{ path: 'a', line: 1, explanation: 'bug' }] })]) assert.throws(() => reviewResult(input, identity));
});
test('macOS/Linux/WSL executable selection, no fallback or native Windows', () => {
  assert.equal(orcaExecutable({}, 'linux'), 'orca-ide'); assert.equal(orcaExecutable({}, 'darwin'), 'orca');
  assert.equal(orcaExecutable({ ORCA_TERMINAL_HANDLE: 'h' }, 'linux'), 'orca');
  assert.equal(orcaExecutable({ ORCA_CLI_COMMAND: '/path with space/orca', ORCA_DEV_REPO_ROOT: 'dev' }, 'linux'), '/path with space/orca');
  assert.equal(orcaExecutable({ ORCA_DEV_REPO_ROOT: 'dev' }, 'darwin'), 'orca-dev');
  assert.equal(localOrcaPath('\\\\wsl.localhost\\Ubuntu\\home\\ron\\中文 path', { WSL_DISTRO_NAME: 'Ubuntu' }), '/home/ron/中文 path');
  assert.throws(() => localOrcaPath('\\\\wsl.localhost\\Other\\home\\ron', { WSL_DISTRO_NAME: 'Ubuntu' }), /distro/);
  assert.throws(() => supported('win32', '24.0')); assert.throws(() => supported('linux', '22.18'));
  supported('darwin', '22.19');
  assert.equal(quote("a'b"), "'a'\\''b'"); assert.equal(digest('a'), digest(Buffer.from('a')));
});
test('process cancellation, bounded output and timeout', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 25 }), /timeout/);
  const c = new AbortController(); c.abort();
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: c.signal }), /cancelled/);
  const r = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '中文 path']); assert.equal(r.toString(), '中文 path');
});
