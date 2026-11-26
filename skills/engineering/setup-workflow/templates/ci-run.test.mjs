// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciRun, jobVerdict, parseArgs, CI_PENDING_EXIT, CI_UNAVAILABLE_EXIT } from './ci-run.mjs';

const SHA = 'a'.repeat(40);
const job = (status, conclusion, steps = [{ name: 'Checks on upstream main', conclusion }]) =>
  ({ name: 'checks', status, conclusion, steps, startedAt: '2026-11-26T00:00:00Z', completedAt: '2026-11-26T00:04:30Z' });

/**
 * 假的 gh／git 與時鐘：runs 是 `gh run list` 依序回的陣列（用完停在最後一個），views 是 `gh run view` 依序回的物件。
 * 每次 sleep 前進 pollMs；記下呼叫過的 git 參數。
 */
function fakes({ runs = [[]], views = [], push = { status: 0, stdout: '', stderr: '' }, remote = `${SHA}\trefs/heads/ci/x\n`, ghFail = false } = {}) {
  let clock = Date.parse('2026-11-26T00:00:00Z');
  const calls = { git: [], gh: [] };
  let r = 0, v = 0;
  const gh = args => {
    calls.gh.push(args.join(' '));
    if (ghFail) return { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(runs[Math.min(r++, runs.length - 1)]), stderr: '' };
    return { status: 0, stdout: JSON.stringify(views[Math.min(v++, views.length - 1)]), stderr: '' };
  };
  const git = args => {
    calls.git.push(args.join(' '));
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${SHA}\n`, stderr: '' };
    if (args[0] === 'ls-remote') return { status: 0, stdout: remote, stderr: '' };
    if (args[0] === 'push' && args.includes('--delete')) return { status: 0, stdout: '', stderr: '' };
    return push;
  };
  return { calls, deps: { gh, git, now: () => clock, sleep: async ms => { clock += ms; }, log: () => {}, pollMs: 15_000 } };
}
const run = (id, extra = {}) => ({ databaseId: id, status: 'in_progress', conclusion: null, event: 'push', createdAt: '2026-11-26T00:00:00Z', url: `https://x/runs/${id}`, ...extra });
const view = (jobs, extra = {}) => ({ jobs, status: 'in_progress', conclusion: null, url: 'https://x/runs/1', ...extra });

test('jobVerdict：成功、失敗的 step、0 個 step、取消、startup_failure、還在跑', () => {
  assert.deepEqual(jobVerdict(job('completed', 'success')), { state: 'pass', detail: '270s' });
  assert.deepEqual(jobVerdict(job('completed', 'failure', [{ name: 'Set up', conclusion: 'success' }, { name: 'Checks on upstream main', conclusion: 'failure' }])), { state: 'fail', detail: 'Checks_on_upstream_main' });
  assert.deepEqual(jobVerdict(job('completed', 'failure', [])), { state: 'unavailable', detail: 'no-steps failure' });
  assert.equal(jobVerdict(job('completed', 'cancelled')).state, 'unavailable');
  assert.deepEqual(jobVerdict(undefined, { status: 'completed', conclusion: 'startup_failure' }), { state: 'unavailable', detail: 'startup_failure' });
  assert.equal(jobVerdict(job('in_progress', null)).state, 'pending');
  assert.equal(jobVerdict(undefined, { status: 'queued' }).state, 'pending');
});

test('parseArgs：預設值、選項、錯誤', () => {
  assert.deepEqual(parseArgs([], {}), { rev: 'HEAD', workflow: 'checks.yml', job: 'checks', timeoutSec: 540, startTimeoutSec: 300, queueTimeoutSec: 1200 });
  const o = parseArgs(['abc', '--ref', 'pilot/stage-x', '--timeout', '60', '--job', 'checks-macos'], { CI_RUN_TIMEOUT_S: '30' });
  assert.equal(o.rev, 'abc'); assert.equal(o.ref, 'pilot/stage-x'); assert.equal(o.timeoutSec, 60); assert.equal(o.job, 'checks-macos');
  assert.equal(parseArgs([], { CI_RUN_TIMEOUT_S: '30' }).timeoutSec, 30);
  assert.match(parseArgs(['--timeout']).error, /--timeout/);
  assert.match(parseArgs(['--timeout', '-1']).error, /--timeout/);
  assert.match(parseArgs(['--nope']).error, /--nope/);
  assert.match(parseArgs(['a', 'b']).error, /多出來/);
});

test('沒有現成的 run：push 到 ci/<sha 前 12>，等 job 通過印 CI_PASS，之後刪掉 ci 分支', async () => {
  const { calls, deps } = fakes({ runs: [[], [], [run(1)]], views: [view([job('in_progress', null)]), view([job('completed', 'success')], { status: 'completed', conclusion: 'success' })] });
  const result = await ciRun(parseArgs([], {}), deps);
  assert.deepEqual(result, { line: `CI_PASS ${SHA} https://x/runs/1 270s`, code: 0 });
  assert.ok(calls.git.includes(`push -q origin ${SHA}:refs/heads/ci/${SHA.slice(0, 12)}`));
  assert.ok(calls.git.includes(`push -q origin --delete ci/${SHA.slice(0, 12)}`), '有結論後刪掉自己推的 ci 分支');
});

test('SHA 上已有 run（例如 worker 分支的 push）：不再 push；job 失敗印 CI_FAIL exit 1', async () => {
  const failed = job('completed', 'failure', [{ name: 'Checks on upstream main', conclusion: 'failure' }]);
  const { calls, deps } = fakes({ runs: [[run(7)]], views: [view([failed], { status: 'completed', conclusion: 'failure' })] });
  const result = await ciRun(parseArgs(['--ref', 'feature/x'], {}), deps);
  assert.deepEqual(result, { line: `CI_FAIL ${SHA} https://x/runs/1 Checks_on_upstream_main`, code: 1 });
  assert.ok(!calls.git.some(c => c.startsWith('push')), '已有 run 不 push；--ref 不是 ci/ 開頭也不刪');
});

test('CI 不可用：push 失敗、沒有 run、0 個 step、排隊過久、gh 連續失敗都印 CI_UNAVAILABLE exit 76', async () => {
  const unavailable = async (opts, args = []) => (await ciRun(parseArgs(args, {}), fakes(opts).deps));
  let r = await unavailable({ push: { status: 1, stdout: '', stderr: 'remote: Permission denied\nfatal: unable to access' } });
  assert.equal(r.code, CI_UNAVAILABLE_EXIT); assert.match(r.line, /^CI_UNAVAILABLE \w+ push fatal:_unable_to_access$/);
  r = await unavailable({ runs: [[]] }, ['--timeout', '9999']);
  assert.equal(r.line, `CI_UNAVAILABLE ${SHA} no-run`);
  r = await unavailable({ runs: [[run(1)]], views: [view([job('completed', 'failure', [])], { status: 'completed', conclusion: 'failure' })] });
  assert.equal(r.line, `CI_UNAVAILABLE ${SHA} no-steps failure https://x/runs/1`);
  r = await unavailable({ runs: [[run(1)]], views: [view([job('queued', null, [])])] }, ['--timeout', '9999', '--queue-timeout', '60']);
  assert.equal(r.line, `CI_UNAVAILABLE ${SHA} queued https://x/runs/1`);
  r = await unavailable({ ghFail: true });
  assert.equal(r.line, `CI_UNAVAILABLE ${SHA} gh HTTP_502:_Bad_Gateway`);
});

test('時限內沒跑完：CI_PENDING exit 75、不刪 ci 分支；重跑時找到同一個 run 接著等', async () => {
  const { calls, deps } = fakes({ runs: [[run(3)]], views: [view([job('in_progress', null)], { url: 'https://x/runs/3' })] });
  const result = await ciRun(parseArgs(['--timeout', '60'], {}), deps);
  assert.deepEqual(result, { line: `CI_PENDING ${SHA} https://x/runs/3`, code: CI_PENDING_EXIT });
  assert.ok(!calls.git.some(c => c.includes('--delete')), 'pending 時留著 ci 分支，重跑才找得到 run');
});
