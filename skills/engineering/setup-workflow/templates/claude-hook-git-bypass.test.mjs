import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backgroundJobReason, bypassReason, probeFilterReason } from './claude-hook-git-bypass.mjs';

const script = fileURLToPath(new URL('./claude-hook-git-bypass.mjs', import.meta.url));
const hook = (input, args = []) => spawnSync('node', [script, ...args], { input, encoding: 'utf8' });
// 專案以參數指定的長等待指令與要整份讀的指令（spec 是「script 名稱[ 旗標]」）。
const LONG_WAIT = ['job-watch.mjs', 'job-queue.mjs --wait'];
const WHOLE_OUTPUT = ['job-status.mjs --probe'];
const ARGS = ['--long-wait', 'job-watch.mjs', '--long-wait', 'job-queue.mjs --wait', '--whole-output', 'job-status.mjs --probe'];

test('bypassReason：攔下改寫 core.hooksPath、--no-verify 與 commit -n', () => {
  assert.equal(bypassReason('git -c core.hooksPath=/dev/null commit -qm x'), '改寫 core.hooksPath');
  assert.equal(bypassReason('cd wt && git config core.hooksPath /tmp/none'), '改寫 core.hooksPath');
  assert.equal(bypassReason('git -C wt -c "core.hooksPath=/dev/null" merge x'), '改寫 core.hooksPath');
  assert.equal(bypassReason('git config --local core.hooksPath .none'), '改寫 core.hooksPath');
  assert.equal(bypassReason('git commit --no-verify -m x'), '--no-verify');
  assert.equal(bypassReason('git push --no-verify origin x'), '--no-verify');
  assert.equal(bypassReason('git commit -nm x'), 'git commit -n');
});

test('bypassReason：一般 git 指令與內容裡的字樣不攔', () => {
  for (const command of ['git commit -qm "fix"', 'git merge --no-ff x -m "merge"', 'git log -n 3', 'git status --porcelain',
    'grep -rn "no-verify" scripts', 'git commit -am "x" && git log -n 1',
    // 曾經誤判：只是提到設定名稱的唯讀指令與字串。
    'grep -rn "core.hooksPath" scripts docs', 'git config core.hooksPath', 'git config --get core.hooksPath',
    'git config --unset core.hooksPath', `echo '{"tool_input":{"command":"git -c core.hooksPath=/dev/null status"}}' | node hook.mjs`,
  ]) assert.equal(bypassReason(command), null, command);
});

test('hook：命中時 exit 2 並說明，未命中或輸入不合法時 exit 0 無輸出', () => {
  const denied = hook(JSON.stringify({ tool_input: { command: 'git -c core.hooksPath=/dev/null commit -m x' } }));
  assert.equal(denied.status, 2); assert.match(denied.stderr, /繞過 git hook/);
  const allowed = hook(JSON.stringify({ tool_input: { command: 'git commit -m x' } }));
  assert.equal(allowed.status, 0); assert.equal(allowed.stdout + allowed.stderr, '');
  assert.equal(hook('not json').status, 0);
});

test('backgroundJobReason：以 shell & 背景化 job-watch／job-queue --wait 時攔下', () => {
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs --pilot --exit-on-finish > /tmp/w.log 2>&1 &', LONG_WAIT), 'job-watch.mjs');
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs --pilot & echo started', LONG_WAIT), 'job-watch.mjs');
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs&', LONG_WAIT), 'job-watch.mjs');
  assert.equal(backgroundJobReason('node scripts/job-queue.mjs --wait /var/tmp/batch-x/w1 >out 2>&1 &', LONG_WAIT), 'job-queue.mjs --wait');
  assert.equal(backgroundJobReason('cd wt && node /m/scripts/job-queue.mjs --wait /r & sleep 1', LONG_WAIT), 'job-queue.mjs --wait');
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs && echo done &', LONG_WAIT), 'job-watch.mjs');
});

test('backgroundJobReason：前景執行、&&、重導向與其他指令不攔', () => {
  for (const command of ['node scripts/job-watch.mjs --pilot --exit-on-finish', 'node scripts/job-watch.mjs > log 2>&1',
    'node scripts/job-watch.mjs &>log', 'node scripts/job-watch.mjs |& tee log', 'node scripts/job-watch.mjs && echo done',
    'node scripts/job-queue.mjs --wait /r 2>&1 | tail -3', 'node scripts/job-queue.mjs --wait-status /r &',
    'node scripts/job-queue.mjs --artifacts-root /r --detach &', 'node scripts/job-watch.mjs; sleep 5 &',
    'sleep 5 & node scripts/job-watch.mjs', 'git log -n 3 &',
  ]) assert.equal(backgroundJobReason(command, LONG_WAIT), null, command);
});

test('hook：背景化長等待指令時 exit 2 並指向 run_in_background', () => {
  const denied = hook(JSON.stringify({ tool_input: { command: 'node scripts/job-watch.mjs --pilot > w.log 2>&1 &' } }), ARGS);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /run_in_background/); assert.match(denied.stderr, /job-watch\.mjs/);
  const allowed = hook(JSON.stringify({ tool_input: { command: 'node scripts/job-watch.mjs --pilot' } }), ARGS);
  // 沒帶 --long-wait 時不攔背景化。
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'node scripts/job-watch.mjs --pilot > w.log 2>&1 &' } })).status, 0);
  assert.equal(allowed.status, 0); assert.equal(allowed.stdout + allowed.stderr, '');
});

test('probeFilterReason：--whole-output 指令以管線接 grep／head／tail 時攔下', () => {
  assert.equal(probeFilterReason('node scripts/job-status.mjs --probe | grep -E "^(STAGEABLE|STALE|GATED|INPUTS)"', WHOLE_OUTPUT), 'grep');
  assert.equal(probeFilterReason('node scripts/job-status.mjs --probe 2>&1 | head -40', WHOLE_OUTPUT), 'head');
  assert.equal(probeFilterReason('cd /m && node /m/scripts/job-status.mjs --probe |& tail -5', WHOLE_OUTPUT), 'tail');
  assert.equal(probeFilterReason('node scripts/job-status.mjs --probe | tee /tmp/p | grep STALE', WHOLE_OUTPUT), 'grep');
  assert.equal(probeFilterReason('node scripts/job-status.mjs --probe | /usr/bin/egrep X', WHOLE_OUTPUT), 'egrep');
});

test('probeFilterReason：整份讀、其他旗標與其他指令不攔', () => {
  for (const command of ['node scripts/job-status.mjs --probe', 'node scripts/job-status.mjs --probe 2>&1',
    'node scripts/job-status.mjs --probe > /tmp/p.txt', 'node scripts/job-status.mjs --coordinator | grep ACTIVE',
    'node scripts/job-status.mjs | head -3', 'node scripts/job-status.mjs --probe; git log | head -3',
    'node scripts/job-status.mjs --probe && grep -n x f', 'grep -n "job-status.mjs --probe | grep" docs/x.md',
  ]) assert.equal(probeFilterReason(command, WHOLE_OUTPUT), null, command);
});

test('hook：probe 被過濾時 exit 2，說明要整份讀', () => {
  const denied = hook(JSON.stringify({ tool_input: { command: 'node scripts/job-status.mjs --probe | grep STALE' } }), ARGS);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /整份讀/); assert.match(denied.stderr, /grep/);
  const allowed = hook(JSON.stringify({ tool_input: { command: 'node scripts/job-status.mjs --probe' } }), ARGS);
  // 沒帶 --whole-output 時不攔過濾。
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'node scripts/job-status.mjs --probe | grep STALE' } })).status, 0);
  assert.equal(allowed.status, 0); assert.equal(allowed.stdout + allowed.stderr, '');
});
