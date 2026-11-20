import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_BACKGROUND_ONLY, backgroundJobReason, bypassReason, chainedHandoff, chainedLongWaitReason, chainedNote, exitGateReason, foregroundReason, probeFilterReason, selfMatchLoopReason, wideGrepReason, writesFile } from './claude-hook-git-bypass.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

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

// 真實指令：retro spay2 0cd3fdeb#3（jsonl 698）。唯讀查詢的輸出重導不是設定值；真的寫入照攔。
test('bypassReason：shell 重導不算 core.hooksPath 的值', () => {
  for (const command of ['git config core.hooksPath >/dev/null', 'git config core.hooksPath >/dev/null; git add -A && git commit -qm x',
    'git config core.hooksPath 2>/dev/null', 'git config core.hooksPath >> /tmp/log 2>&1', 'git config core.hooksPath &>/dev/null || echo none',
    'git config --get core.hooksPath']) assert.equal(bypassReason(command), null, command);
  for (const command of ['git config core.hooksPath /dev/null', 'git config core.hooksPath /dev/null >/dev/null 2>&1',
    'git config core.hooksPath >/dev/null /tmp/none', 'git config core.hooksPath .none 2>&1']) assert.equal(bypassReason(command), '改寫 core.hooksPath', command);
  const status = command => hook(JSON.stringify({ tool_input: { command } })).status;
  assert.equal(status('git config core.hooksPath >/dev/null'), 0);
  assert.equal(status('git config --get core.hooksPath'), 0);
  assert.equal(status('git config core.hooksPath /dev/null'), 2);
});

// 真實指令：retro spay2 8eaa8b41#4，驗收文字與 hook 的 JSON 測試輸入都只是提到旗標，沒有執行 git commit。
test('bypassReason：成對引號內的文字不算指令', () => {
  for (const command of [
    "node scripts/orca-session-send.mjs term_x --prompt '驗收：git commit --no-verify -m x 應被拒'",
    'node scripts/orca-session-send.mjs term_x --prompt "驗收：git -c core.hooksPath=/dev/null commit 應被拒"',
    `printf '{"tool_input":{"command":"git commit --no-verify -m x"}}' | node scripts/claude-hook-git-bypass.mjs`,
    'git commit -m "docs: 說明 git push --no-verify 為何被拒"',
    'git commit -m "feat: 加上 -n 選項"',
    `echo "don't run git commit --no-verify"`,
    `git commit -m "$(cat <<'EOF'\nfix: 拒絕 git commit --no-verify，that's it\nEOF\n)"`,
    "cat > note.md <<'EOF'\ngit commit --no-verify 會被拒\nEOF",
    "grep -e 'git commit --no-verify' docs/a.md",
    "node scripts/issue-create.mjs --body-file - <<'EOF'\ngit commit --no-verify 會被拒\nEOF",
    '# 註解提到 git commit --no-verify\ngit status',
  ]) assert.equal(bypassReason(command), null, command);
});

test('bypassReason：引號不掩蓋真正的繞過', () => {
  for (const [command, reason] of [
    ['git commit -m "fix: x" --no-verify', '--no-verify'],
    ['git commit -m "a; b" --no-verify', '--no-verify'],
    ['git commit "--no-verify" -m x', '--no-verify'],
    ["git commit -m 'x y' -n", 'git commit -n'],
    ['git -c "core.hooksPath=/tmp/a b" commit -m x', '改寫 core.hooksPath'],
    ['git config core.hooksPath "/tmp/a b"', '改寫 core.hooksPath'],
    ['git config core.hooksPath ""', '改寫 core.hooksPath'],
    // 引號內是會被執行的指令
    ["bash -c 'git commit --no-verify -m x'", '--no-verify'],
    ['sh -c "cd wt && git push --no-verify origin x"', '--no-verify'],
    ["bash -lc 'git -c core.hooksPath=/dev/null commit -m x'", '改寫 core.hooksPath'],
    ['sudo bash -c "git commit -m \\"a b\\" --no-verify"', '--no-verify'],
    [`bash -c "sh -c 'git commit --no-verify'"`, '--no-verify'],
    ["flock -w 10 /tmp/l -c 'git push --no-verify'", '--no-verify'],
    ['eval "git commit --no-verify"', '--no-verify'],
    ["ssh host 'git push --no-verify'", '--no-verify'],
    ["echo 'git commit --no-verify' | bash", '--no-verify'],
    ["bash <<< 'git commit --no-verify'", '--no-verify'],
    ["bash <<'EOF'\ngit commit --no-verify\nEOF", '--no-verify'],
    ["cat <<'EOF' | sh\ngit commit --no-verify\nEOF", '--no-verify'],
    ["python3 - <<'EOF'\nos.system('cd x && git commit --no-verify')\nEOF", '--no-verify'],
    ["ssh host <<'EOF'\ngit push --no-verify\nEOF", '--no-verify'],
    [`python3 -c "import os; os.system('git commit --no-verify')"`, '--no-verify'],
    [`node -e "execSync('cd x && git commit --no-verify')"`, '--no-verify'],
    // 雙引號內的 command substitution 會執行
    ['echo "結果 $(git commit --no-verify -m x)"', '--no-verify'],
    ['echo "結果 `git commit --no-verify -m x`"', '--no-verify'],
    ['echo `git commit --no-verify -m x`', '--no-verify'],
    // 引號以外的撇號不能吃掉後面的真實指令
    ["# don't\ngit commit --no-verify # it's", '--no-verify'],
    ["cat <<EOF\ndon't\nEOF\ngit commit --no-verify # it's", '--no-verify'],
    ["echo don\\'t; git commit --no-verify; echo it\\'s", '--no-verify'],
    // 引號不成對：其餘原樣比對，寧可攔
    ['echo "x; git commit --no-verify', '--no-verify'],
  ]) assert.equal(bypassReason(command), reason, command);
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

// 真實指令：retro spay2 c96f4bce#4，probe 長行後面正是要執行的指令，cut 會截掉。
test('probeFilterReason：--whole-output 指令以管線接 cut 時攔下', () => {
  assert.equal(probeFilterReason('node scripts/pilot-status.mjs --probe | cut -c1-900', ['pilot-status.mjs --probe']), 'cut');
  assert.equal(probeFilterReason('node scripts/job-status.mjs --probe 2>&1 | /usr/bin/cut -c1-700', WHOLE_OUTPUT), 'cut');
  const denied = hook(JSON.stringify({ tool_input: { command: 'node scripts/job-status.mjs --probe 2>&1 | cut -c1-900' } }), ARGS);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /以 cut 過濾/);
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

test('hook 參數：旗標後面緊接另一個旗標時不當成 spec', () => {
  const input = cmd => JSON.stringify({ tool_input: { command: cmd } });
  const args = ['--long-wait', '--whole-output', 'job-watch.mjs'];
  assert.equal(hook(input('node x.mjs --whole-output &'), args).status, 0);
  const denied = hook(input('node scripts/job-watch.mjs | grep x'), args);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /job-watch\.mjs 的輸出以 grep 過濾/);
});

const GATES = ['check-contracts.sh', 'fix-land.mjs', 'batch-land.mjs', 'close-issue.mjs', 'land.mjs'];

// 真實指令：retro spay2 b949589b#1，兩次都通知 exit 0，輸出卻是失敗（`STOP merge exit 9 HELD`）。
test('exitGateReason：長跑 gate 接 grep／head／tail 時攔下', () => {
  assert.deepEqual(exitGateReason('node scripts/fix-land.mjs ron.chang/feature-ron-fix-tab-state 2>&1 | tail -12 | cut -c1-260', GATES), { script: 'fix-land.mjs', filter: 'tail' });
  assert.deepEqual(exitGateReason('bash scripts/check-contracts.sh 2>&1 | tail -15', GATES), { script: 'check-contracts.sh', filter: 'tail' });
  assert.deepEqual(exitGateReason('cd /m && FOO=1 node /m/scripts/land.mjs x | head -3', GATES), { script: 'land.mjs', filter: 'head' });
  assert.deepEqual(exitGateReason('X=$(node scripts/batch-land.mjs c |& grep -c LANDED)', GATES), { script: 'batch-land.mjs', filter: 'grep' });
  assert.deepEqual(exitGateReason('scripts/check-contracts.sh | tee /tmp/x | rg FAIL', GATES), { script: 'check-contracts.sh', filter: 'rg' });
  assert.deepEqual(exitGateReason('bash scripts/check-contracts.sh 2>&1 | cut -c1-200', GATES), { script: 'check-contracts.sh', filter: 'cut' });
});

test('exitGateReason：沒執行 gate、結果看得到 exit code、未指定時不攔', () => {
  for (const command of ['cat scripts/fix-land.mjs | head -3', 'git log -- scripts/fix-land.mjs | head', 'sed -n 1,5p scripts/check-contracts.sh | tail -2',
    'grep -n "fix-land.mjs | tail" docs/a.md', 'node --test scripts/fix-land.test.mjs | tail -5', 'node scripts/fix-land.mjs x > f 2>&1; rc=$?; tail -n 20 f; exit $rc',
    'node scripts/fix-land.mjs x; git log | head -3', 'set -o pipefail; bash scripts/check-contracts.sh 2>&1 | tail -15']) assert.equal(exitGateReason(command, GATES), null, command);
  assert.equal(exitGateReason('node scripts/batch-land.mjs c | tail -1', ['land.mjs']), null, 'land.mjs 不比到 batch-land.mjs');
  assert.equal(exitGateReason('node scripts/fix-land.mjs x | tail -1'), null);
});

test('exitGateReason：引號內與跳脫的 `|` 不是分隔，grep 的搜尋字樣不算執行 gate', () => {
  // retro spay2 4799d53c#6：ps 查行程的樣式含 gate 名稱，後面還接管線。
  for (const command of ["ps -eo pid,ppid,etimes,cmd | grep -E 'check-before-push|batch-land|batch-merge.mjs tooling|check-contracts.sh|push-pinned'",
    "ps -eo pid,ppid,etimes,cmd | grep -E 'check-before-push|batch-land|check-contracts.sh|push-pinned' | grep -v grep | cut -c1-150"]) assert.equal(exitGateReason(command, ['check-contracts.sh']), null, command);
  // retro spay2 1d552915#3：雙引號內的 `\|` 是 grep 的 alternation。
  for (const command of [String.raw`grep -n "fix\|land.mjs" docs/agents/issue-run.md | cut -c1-200 | head -12`,
    String.raw`grep -n fix\|land.mjs docs/agents/issue-run.md | cut -c1-200`,
    "grep -n 'fix|land.mjs' docs/agents/issue-run.md | cut -c1-200"]) assert.equal(exitGateReason(command, ['land.mjs']), null, command);
  // 字串裡的 pipefail 不算開了 pipefail。
  assert.deepEqual(exitGateReason('echo "pipefail on"; node scripts/land.mjs 12 | tail -1', ['land.mjs']), { script: 'land.mjs', filter: 'tail' });
});

test('exitGateReason：命令位置的 gate 仍攔下，含引號內真的會執行的', () => {
  assert.deepEqual(exitGateReason('bash scripts/check-contracts.sh | tail', ['check-contracts.sh']), { script: 'check-contracts.sh', filter: 'tail' });
  assert.deepEqual(exitGateReason('node scripts/land.mjs 12 | cut -c1-200', ['land.mjs']), { script: 'land.mjs', filter: 'cut' });
  assert.deepEqual(exitGateReason('node "scripts/land.mjs" 12 | cut -c1-200', ['land.mjs']), { script: 'land.mjs', filter: 'cut' });
  assert.deepEqual(exitGateReason('X="$(node scripts/land.mjs 12 | tail -1)"', ['land.mjs']), { script: 'land.mjs', filter: 'tail' });
  assert.deepEqual(exitGateReason("bash -c 'node scripts/land.mjs 12 | cut -c1-200'", ['land.mjs']), { script: 'land.mjs', filter: 'cut' });
});

test('hook：--exit-gate 命中時 exit 2 並給改法，沒帶參數不攔', () => {
  const input = JSON.stringify({ tool_input: { command: 'bash scripts/check-contracts.sh 2>&1 | tail -15' } });
  const denied = hook(input, ['--exit-gate', 'check-contracts.sh']);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /rc=\$\?/);
  assert.equal(hook(input).status, 0);
});

// 真實指令：retro spay2 6d21b9cc#3。同一個 session 這條 for 迴圈通過，下一條沒包迴圈的才被拒。
test('exitGateReason：迴圈、條件與群組內的 gate 接過濾也攔下', () => {
  const gates = ['followups.mjs'];
  const denied = { script: 'followups.mjs', filter: 'tail' };
  for (const command of ['for n in 1; do node scripts/followups.mjs adopt $n b 2>&1 | tail -1; done',
    'for n in 1\ndo\n  node scripts/followups.mjs adopt $n b | tail -1\ndone',
    'if true; then node scripts/followups.mjs done 1 x | tail -1; fi',
    'if false; then :; else node scripts/followups.mjs done 1 x | tail -1; fi',
    'if node scripts/followups.mjs done 1 x | tail -1; then :; fi',
    'while node scripts/followups.mjs done 1 x | tail -1; do :; done',
    '{ node scripts/followups.mjs done 1 x | tail -1; }',
    '( node scripts/followups.mjs done 1 x | tail -1 )',
    '! node scripts/followups.mjs done 1 x | tail -1',
  ]) assert.deepEqual(exitGateReason(command, gates), denied, command);
  // 只是字樣：do、then 後面不是執行 gate。
  for (const command of ['for f in scripts/followups.mjs; do cat $f | tail -1; done', 'if true; then cat scripts/followups.mjs | tail -1; fi',
    'echo do node scripts/followups.mjs done 1 x | tail -1']) assert.equal(exitGateReason(command, gates), null, command);
});

// 真實指令：retro spay2 4a22bbe7#3（jsonl 678、838），都只印資料，拒絕訊息的理由不成立。
test('exitGateReason：唯讀形式放行，同一支 script 的寫入形式仍攔下', () => {
  const gates = ['followups.mjs', 'issue-create.mjs'];
  for (const command of ['node scripts/followups.mjs list --observation | cut -c1-60', 'node scripts/followups.mjs list | tail -3',
    'node scripts/issue-create.mjs --template | head', 'node scripts/issue-create.mjs --template --sql | head -40',
    'for k in a; do node scripts/followups.mjs list | grep x; done']) assert.equal(exitGateReason(command, gates), null, command);
  for (const [command, script, filter] of [['node scripts/followups.mjs done 1 x | tail -1', 'followups.mjs', 'tail'],
    ['node scripts/followups.mjs add "#1" list | tail -1', 'followups.mjs', 'tail'],
    ['node scripts/issue-create.mjs --title x --description-file f | head', 'issue-create.mjs', 'head'],
    // issue-create.mjs 只認第一個參數是 --template，排在後面的 --template 不是唯讀形式。
    ['node scripts/issue-create.mjs --title x --template | head', 'issue-create.mjs', 'head'],
    // 前面的唯讀形式不掩蓋同一條指令後面真正的 gate。
    ['node scripts/followups.mjs list | cut -c1-60; node scripts/followups.mjs done 1 x | tail -1', 'followups.mjs', 'tail'],
    // 唯讀形式的豁免不蓋過同一條管線後面的 gate（retro spay2 1104c 的 code review）。
    ['node scripts/followups.mjs list | xargs -n1 node scripts/followups.mjs done | tail -1', 'followups.mjs', 'tail'],
  ]) assert.deepEqual(exitGateReason(command, gates), { script, filter }, command);
});

test('hook：以 --exit-gate 的現行參數執行，迴圈內的 gate 與唯讀形式各得其所', () => {
  const args = ['--exit-gate', 'followups.mjs', '--exit-gate', 'issue-create.mjs'];
  const status = command => hook(JSON.stringify({ tool_input: { command } }), args).status;
  assert.equal(status('for n in 1; do node scripts/followups.mjs adopt $n b 2>&1 | tail -1; done'), 2);
  assert.equal(status('node scripts/followups.mjs done 1 x | tail -1'), 2);
  assert.equal(status('node scripts/issue-create.mjs --title x | head'), 2);
  assert.equal(status('node scripts/followups.mjs list --observation | cut -c1-60'), 0);
  assert.equal(status('node scripts/issue-create.mjs --template x | head'), 0);
  // 真實指令：retro spay2 2dc186b1#4（jsonl 450 被拒、360 放行）。--help 只印用法；排在寫入參數後面的不算。
  assert.equal(status('node scripts/issue-create.mjs --help 2>&1 | head -5'), 0);
  assert.equal(status('node scripts/issue-create.mjs --template --parent 999 2>&1 | head -60'), 0);
  assert.equal(status('node scripts/followups.mjs --help | head -5'), 0);
  // 真實指令：retro spay2 2df91b24#3（jsonl 1719，舊碼 rc=2）。不帶參數只印用法、不寫入；帶子命令的照攔。
  assert.equal(status('node scripts/followups.mjs 2>&1 | head -20'), 0);
  assert.equal(status('node scripts/followups.mjs | grep -i add'), 0);
  assert.equal(status('node scripts/followups.mjs done 754 x 2>&1 | head -20'), 2);
  assert.equal(status('node scripts/issue-create.mjs --title x --help | head'), 2);
});

// 真實指令：retro spay2 f5d852cf#7。drain、diff 與交接串在一個 Bash 呼叫，`DIFFERENT 1` 印出時已 HANDED_OFF，交接內容漏了最新結果。
const HANDOFF_CHAIN = `cd /home/ron/code/spay2 && node scripts/pilot-status.mjs --drain --apply --reap; node scripts/candidate-product-diff.mjs d0e4a4c12 c133a9fa2 | tail -n 4 | cut -c1-250; R='接手先做：依序 stage batch-i758'; node scripts/pilot-handoff.mjs --session s --pid 1 --reason "$R"`;

test('chainedHandoff：pilot-handoff.mjs 與其他指令串接時攔下', () => {
  for (const command of [HANDOFF_CHAIN, 'node scripts/pilot-status.mjs --drain; node scripts/pilot-handoff.mjs --reason r',
    'node scripts/pilot-status.mjs --drain && node scripts/pilot-handoff.mjs --reason r',
    'node scripts/pilot-status.mjs --drain || node scripts/pilot-handoff.mjs --reason r',
    'node scripts/pilot-status.mjs --drain\nnode scripts/pilot-handoff.mjs --reason r',
    'node scripts/pilot-handoff.mjs --reason r; echo done',
    'cd /m && git status && /m/scripts/pilot-handoff.mjs --reason r',
  ]) assert.equal(chainedHandoff(command), true, command);
});

test('chainedHandoff：單獨執行（前面可有 cd 與變數指派）、其他指令只是提到它時不攔', () => {
  for (const command of ['node scripts/pilot-handoff.mjs --session s --pid 1 --reason r',
    'cd /m && node scripts/pilot-handoff.mjs --reason r', "R='a; b'; node scripts/pilot-handoff.mjs --reason \"$R\"\n",
    "node scripts/pilot-handoff.mjs --reason 'a && b; c'",
    'cat scripts/pilot-handoff.mjs; git status', 'git add scripts/pilot-handoff.mjs && git commit -qm x',
    'node --test scripts/pilot-handoff.test.mjs; git status', "grep -n 'pilot-handoff.mjs' docs/a.md; git status",
    "cat > note.md <<'EOF'\nnode scripts/pilot-handoff.mjs; git status\nEOF\ngit status",
  ]) assert.equal(chainedHandoff(command), false, command);
});

// retro spay2 687eb996#4、a1d68426#4：唯讀的 `--review`／`--review-done` 不交接，串接也不會讓交接內容漏東西；真交接串接照攔。
test('chainedHandoff：--review／--review-done 串接放行，真交接串接仍攔', () => {
  for (const command of ['node scripts/pilot-handoff.mjs --review; echo ===; node scripts/pilot-status.mjs --decisions',
    'node scripts/periodic-acceptance.mjs tick; echo rc=$?; echo ---; node scripts/pilot-handoff.mjs --review',
    'node scripts/pilot-handoff.mjs --review-done --through 120 && node scripts/pilot-status.mjs --decisions',
  ]) assert.equal(chainedHandoff(command), false, command);
  for (const command of ['node scripts/pilot-handoff.mjs --review; echo ===; node scripts/pilot-handoff.mjs --session x --pid y --reason z',
    'node scripts/pilot-status.mjs --decisions; node scripts/pilot-handoff.mjs --session x --pid y --reason z',
    'node scripts/pilot-handoff.mjs --reviewer x; echo ok',
  ]) assert.equal(chainedHandoff(command), true, command);
});

test('hook：串接 pilot-handoff.mjs 不需要任何參數就攔下，並說明改法', () => {
  const input = command => JSON.stringify({ tool_input: { command } });
  const denied = hook(input(HANDOFF_CHAIN));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /pilot-handoff\.mjs/);
  assert.match(denied.stderr, /單獨/);
  assert.equal(hook(input('node scripts/pilot-handoff.mjs --reason r')).status, 0);
});

// 真實指令：retro spay2 86eda4c4#3（jsonl 817）。python heredoc 的內容原樣進比對，`s="['node ` 被當成環境變數指派，後面的字串就成了 gate。
test('exitGateReason：直譯器 heredoc 的內容是程式，不算 gate', () => {
  const gates = ['followups.mjs'];
  for (const command of [
    `python3 - <<'E'\ns="['node scripts/followups.mjs done 1 x | tail -1', 'a']"\nE`,
    `python3 - <<'E'\nnode scripts/followups.mjs done 1 x | tail -1\nE`,
    `node - <<E\ns="node scripts/followups.mjs done 1 x | tail -1"\nE`,
    `cat > f.txt <<'E'\ns="['node scripts/followups.mjs done 1 x | tail -1', 'a']"\nE`,
  ]) assert.equal(exitGateReason(command, gates), null, command);
  // heredoc 之後真的 gate、餵給 shell 的 heredoc 仍攔。
  for (const command of [
    `python3 - <<'E'\nprint(1)\nE\nnode scripts/followups.mjs done 1 x | tail -1`,
    `bash <<'E'\nnode scripts/followups.mjs done 1 x | tail -1\nE`,
    `cat <<'E' | sh\nnode scripts/followups.mjs done 1 x | tail -1\nE`,
    // PR #314 的 review：-c／-e 是真的呼叫，#314 曾放寬成 rc=0。
    `python3 -c "import os;os.system('node scripts/followups.mjs done 1 x | tail -1')"`,
  ]) assert.deepEqual(exitGateReason(command, gates), { script: 'followups.mjs', filter: 'tail' }, command);
});

test('bypassReason：直譯器 heredoc 與 -c 內的 git 繞過仍攔（只放寬 exit-gate）', () => {
  assert.equal(bypassReason(`python3 - <<'E'\nos.system('cd x && git commit --no-verify')\nE`), '--no-verify');
  assert.equal(bypassReason(`python3 -c "os.system('git commit --no-verify')"`), '--no-verify');
});

test('hook：python -c 裡的 gate 接 tail、串接交接都拒絕，heredoc 字串放行', () => {
  const status = (command, args = []) => hook(JSON.stringify({ tool_input: { command } }), args).status;
  const gate = ['--exit-gate', 'followups.mjs'];
  assert.equal(status(`python3 -c "import os;os.system('node scripts/followups.mjs done 1 x | tail -1')"`, gate), 2);
  assert.equal(status(`python3 -c "import os;os.system('node scripts/pilot-handoff.mjs --reason r; echo x')"`), 2);
  assert.equal(status(`python3 - <<'E'\ns="['node scripts/followups.mjs done 1 x | tail -1', 'a']"\nE`, gate), 0);
});

// PR #314 的 review：long-wait 原本比對原始指令，字串與 heredoc 裡的字樣也算。
test('backgroundJobReason：字串、註解與直譯器 heredoc 不算，bash -c、python -c 裡的 `&` 照攔', () => {
  for (const command of ['echo "node scripts/job-watch.mjs &"', '# node scripts/job-watch.mjs &\ngit status',
    `python3 - <<'E'\ns="node scripts/job-watch.mjs &"\nE`, `cat > f <<'E'\nnode scripts/job-watch.mjs &\nE`,
  ]) assert.equal(backgroundJobReason(command, LONG_WAIT), null, command);
  for (const command of [`bash -c 'node scripts/job-watch.mjs &'`, `python3 -c "os.system('node scripts/job-watch.mjs &')"`,
  ]) assert.equal(backgroundJobReason(command, LONG_WAIT), 'job-watch.mjs', command);
});

test('chainedHandoff：直譯器 heredoc 裡的字串不算交接', () => {
  assert.equal(chainedHandoff(`python3 - <<'E'\ns="node scripts/pilot-handoff.mjs --reason r"\nE\ngit status`), false);
});

// 真實形狀：followups 394（retro 4a22bbe7#3、6d21b9cc#3 的剩餘範圍）。管線接在整個迴圈或群組之後，回報的一樣是 tail 的 exit code。
test('exitGateReason：管線接在整個迴圈或群組之後也攔', () => {
  const gates = ['followups.mjs', 'check-contracts.sh'];
  for (const [command, script, filter] of [
    ['for n in 1 2; do node scripts/followups.mjs adopt $n b; done | tail -1', 'followups.mjs', 'tail'],
    ['for n in 1 2; do node scripts/followups.mjs adopt $n b; done 2>&1 | tail -1', 'followups.mjs', 'tail'],
    ['for n in 1 2\ndo\n  node scripts/followups.mjs adopt $n b\ndone | grep x', 'followups.mjs', 'grep'],
    ['while read n; do node scripts/followups.mjs done $n x; done < f | head', 'followups.mjs', 'head'],
    ['{ node scripts/followups.mjs done 1 x; } | tail -1', 'followups.mjs', 'tail'],
    ['{ cd wt && bash scripts/check-contracts.sh; echo end; } 2>&1 | tail -15', 'check-contracts.sh', 'tail'],
    ['( cd wt && bash scripts/check-contracts.sh ) | tail -15', 'check-contracts.sh', 'tail'],
    ['if true; then node scripts/followups.mjs done 1 x; fi | tail -1', 'followups.mjs', 'tail'],
    ['for a in 1; do for b in 2; do node scripts/followups.mjs done $b x; done; done | tail -1', 'followups.mjs', 'tail'],
    ['{ node scripts/followups.mjs done 1 x; } | tee log | tail -1', 'followups.mjs', 'tail'],
    // 唯讀形式的豁免不蓋過同一個迴圈或群組裡真正的 gate。
    ['for n in 1; do node scripts/followups.mjs list; node scripts/followups.mjs done $n x; done | tail -1', 'followups.mjs', 'tail'],
    ['{ node scripts/followups.mjs list | xargs -n1 node scripts/followups.mjs done; } | tail -1', 'followups.mjs', 'tail'],
  ]) assert.deepEqual(exitGateReason(command, gates), { script, filter }, command);
});

test('exitGateReason：迴圈或群組的唯讀、無關形式不攔', () => {
  const gates = ['followups.mjs'];
  for (const command of [
    'for n in 1; do node scripts/followups.mjs list; done | tail -1',
    '{ node scripts/followups.mjs list --observation; } | cut -c1-60',
    '{ node scripts/followups.mjs list | grep x; } | tail -1',
    '{ node scripts/followups.mjs list || true; } | tail -1',
    // 迴圈結束後另一段才接管線。
    'for n in 1; do node scripts/followups.mjs done $n x; done; git log | tail -1',
    // gate 的 exit code 沒被管線蓋掉。
    'for n in 1; do node scripts/followups.mjs done $n x; done',
    '{ node scripts/followups.mjs done 1 x; } > log 2>&1',
    'for n in 1; do git log; done | tail -1',
    // 只是提到：參數、字串、不在指令位置的 done。
    'for n in 1; do echo node scripts/followups.mjs; done | tail -1',
    'for n in 1; do echo "node scripts/followups.mjs done"; done | tail -1',
    'echo done | tail -1',
    'echo $(node scripts/followups.mjs done 1 x; echo y) | tail -1',
  ]) assert.equal(exitGateReason(command, gates), null, command);
  assert.equal(exitGateReason('set -o pipefail; for n in 1; do node scripts/followups.mjs done $n x; done | tail -1', gates), null);
});

// 真實指令：retro spay2 1677d177#1（jsonl 269）。前景跑 batch-land.mjs，session 被擋 10 分鐘，worker 的 DONE 也晚了 5 分鐘才 drain；--long-wait 只看 shell `&`，攔不到。
const BATCH_LAND = 'node scripts/batch-land.mjs .scratch/batch-i751/state.md --result /var/tmp/batch-i751/w1; echo "exit=$?"';

test('foregroundReason：符合 spec 的前景呼叫才攔，run_in_background 為 true 放行', () => {
  const specs = ['batch-land.mjs'];
  for (const command of [BATCH_LAND, 'node scripts/batch-land.mjs x --result y', 'cd /m && node scripts/batch-land.mjs x',
    'for b in a; do node /m/scripts/batch-land.mjs $b; done', `bash -c 'node scripts/batch-land.mjs x'`]) {
    assert.equal(foregroundReason(command, specs, undefined), 'batch-land.mjs', command);
    assert.equal(foregroundReason(command, specs, false), 'batch-land.mjs', command);
    assert.equal(foregroundReason(command, specs, true), null, command);
  }
  assert.equal(foregroundReason('node scripts/batch-land.mjs x', [], false), null);
});

test('foregroundReason：提到它、不是執行它時不攔', () => {
  const specs = ['batch-land.mjs'];
  for (const command of ['# node scripts/batch-land.mjs x --result y\ngit status', 'echo "node scripts/batch-land.mjs x --result y"',
    "grep -n 'node scripts/batch-land.mjs' docs/a.md", 'cat scripts/batch-land.mjs', 'git add scripts/batch-land.mjs',
    'node --test scripts/batch-land.test.mjs', 'node scripts/orca-batch-land.mjs x', "git commit -m 'node scripts/batch-land.mjs 改背景'",
    "cat > note.md <<'E'\nnode scripts/batch-land.mjs x\nE", `python3 - <<'E'\ns="node scripts/batch-land.mjs x"\nE`,
  ]) assert.equal(foregroundReason(command, specs, false), null, command);
});

test('foregroundReason：spec 帶旗標時同段指令要有該旗標', () => {
  assert.equal(foregroundReason('node scripts/job.mjs x --wait', ['job.mjs --wait'], false), 'job.mjs --wait');
  assert.equal(foregroundReason('node scripts/job.mjs x; echo --wait', ['job.mjs --wait'], false), null);
});

test('hook：--background-only 讀 tool_input.run_in_background，且與 --exit-gate 各自判定', () => {
  const args = ['--exit-gate', 'batch-land.mjs', '--background-only', 'batch-land.mjs'];
  const call = (command, extra = {}) => hook(JSON.stringify({ tool_input: { command, ...extra } }), args);
  const absent = call(BATCH_LAND);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /batch-land\.mjs/);
  assert.match(absent.stderr, /run_in_background/);
  assert.equal(call(BATCH_LAND, { run_in_background: false }).status, 2);
  assert.equal(call(BATCH_LAND, { run_in_background: true }).status, 0);
  assert.equal(call('echo "node scripts/batch-land.mjs x --result y"').status, 0);
  // 背景執行也不能接 tail：--exit-gate 照攔。
  const piped = call('node scripts/batch-land.mjs x --result y | tail -3', { run_in_background: true });
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /接 tail/);
});

// 真實指令：retro spay2 b0225c1b#1（jsonl 581）。`| head -0 &` 整條 pipeline 在背景，原本 `|` 切段而漏判。
test('backgroundJobReason：經管線後以 `&` 背景化整條 pipeline 也攔，`||` 仍切段', () => {
  for (const command of ['node scripts/job-watch.mjs --pilot --exit-on-finish 2>&1 | head -0 &',
    'node scripts/job-watch.mjs --pilot --exit-on-finish | tail -5 &',
    'node scripts/pilot-decision.mjs x | tail -1; node scripts/job-watch.mjs --pilot --exit-on-finish 2>&1 | head -0 &',
    'node scripts/job-watch.mjs | tee w.log | tail -1 & echo started',
  ]) assert.equal(backgroundJobReason(command, LONG_WAIT), 'job-watch.mjs', command);
  for (const command of ['node scripts/job-watch.mjs --pilot --exit-on-finish 2>&1 | tail -5', 'node scripts/job-watch.mjs |& tee log',
    'node scripts/job-watch.mjs || sleep 5 &', 'node scripts/job-watch.mjs | tail -5; sleep 5 &',
  ]) assert.equal(backgroundJobReason(command, LONG_WAIT), null, command);
  const status = command => hook(JSON.stringify({ tool_input: { command } }), ARGS).status;
  assert.equal(status('node scripts/job-watch.mjs --pilot --exit-on-finish 2>&1 | head -0 &'), 2);
  assert.equal(status('node scripts/job-watch.mjs --pilot --exit-on-finish 2>&1 | tail -5'), 0);
});

// 真實指令：retro spay2 e320267d#5。決策記錄與 watcher 串成一個背景呼叫，task notification 的摘要看不出是哪個 worker 交件。
test('chainedLongWaitReason：長等待指令前面串了其他指令時攔下，前面只有 cd 或變數指派時不攔', () => {
  for (const command of ['node scripts/pilot-decision.mjs x && node scripts/job-watch.mjs --pilot --exit-on-finish',
    'node scripts/pilot-decision.mjs x; node scripts/job-watch.mjs --pilot --exit-on-finish',
    'node scripts/pilot-decision.mjs x | tail -1\nnode scripts/job-watch.mjs --pilot',
    'cd /m && git status && node scripts/job-watch.mjs',
  ]) assert.equal(chainedLongWaitReason(command, LONG_WAIT), 'job-watch.mjs', command);
  assert.equal(chainedLongWaitReason('git status; node /m/scripts/job-queue.mjs --wait /r', LONG_WAIT), 'job-queue.mjs --wait');
  for (const command of ['node scripts/job-watch.mjs --pilot --exit-on-finish', 'cd /x && node scripts/job-watch.mjs --pilot --exit-on-finish',
    'cd /x; W=1 node scripts/job-watch.mjs', 'X=1; node scripts/job-watch.mjs', 'node scripts/job-watch.mjs && echo done',
    'git status; node scripts/job-queue.mjs --wait-status /r', 'git status; cat scripts/job-watch.mjs',
    "node scripts/pilot-decision.mjs --note 'a; node scripts/job-watch.mjs'",
  ]) assert.equal(chainedLongWaitReason(command, LONG_WAIT), null, command);
  assert.equal(chainedLongWaitReason('git status && node scripts/job-watch.mjs'), null);
  const denied = hook(JSON.stringify({ tool_input: { command: 'node scripts/pilot-decision.mjs x && node scripts/job-watch.mjs --pilot --exit-on-finish' } }), ARGS);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /單獨一個背景呼叫/); assert.match(denied.stderr, /job-watch\.mjs/);
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'cd /x && node scripts/job-watch.mjs --pilot --exit-on-finish' } }), ARGS).status, 0);
});

// 真實指令：retro spay2 a5403bfb#1。tick 以 `--once` 唯讀探查 watcher（不等待），串在 pilot-status 後面被誤擋。
test('chainedLongWaitReason／backgroundJobReason：帶 --once 的段落不算長等待，其他沒帶的長等待段落照攔', () => {
  const once = 'node scripts/pilot-status.mjs --drain; node scripts/job-watch.mjs --once term_x --lines 45';
  assert.equal(chainedLongWaitReason(once, LONG_WAIT), null);
  assert.equal(chainedLongWaitReason('git status && node scripts/job-watch.mjs --once-more', LONG_WAIT), 'job-watch.mjs');
  assert.equal(chainedLongWaitReason('node scripts/pilot-status.mjs --drain; node scripts/job-watch.mjs --pilot', LONG_WAIT), 'job-watch.mjs');
  assert.equal(chainedLongWaitReason(`${once}; node scripts/job-watch.mjs --pilot`, LONG_WAIT), 'job-watch.mjs');
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs --once term_x > /tmp/o.log 2>&1 &', LONG_WAIT), null);
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs --once term_x & node scripts/job-watch.mjs --pilot &', LONG_WAIT), 'job-watch.mjs');
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs --pilot &', LONG_WAIT), 'job-watch.mjs');
  // codex review P2：`--once` 只看執行該 watcher 的那一段，同一串背景化的其他 watcher 照攔。
  for (const command of ['node scripts/job-watch.mjs --pilot && node scripts/job-watch.mjs --once term_x &',
    'node scripts/job-watch.mjs --once term_x && node scripts/job-watch.mjs --pilot &',
    'node scripts/job-watch.mjs --pilot | node scripts/job-watch.mjs --once term_x &',
  ]) assert.equal(backgroundJobReason(command, LONG_WAIT), 'job-watch.mjs', command);
  assert.equal(backgroundJobReason('node scripts/job-watch.mjs --once term_x 2>&1 | tail -3 &', LONG_WAIT), null);
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'node scripts/job-watch.mjs --pilot && node scripts/job-watch.mjs --once term_x &' } }), ARGS).status, 2);
  assert.equal(hook(JSON.stringify({ tool_input: { command: once } }), ARGS).status, 0);
  const denied = hook(JSON.stringify({ tool_input: { command: 'node scripts/pilot-status.mjs --drain; node scripts/job-watch.mjs --pilot' } }), ARGS);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /單獨一個背景呼叫/);
});

// 真實指令：retro spay2 1112b followups 617（retro 1116a）。`node --check` 只檢查語法、不執行 watcher，原本被當成長等待串接而誤擋（舊碼 rc=2）。
test('chainedLongWaitReason／backgroundJobReason：只認執行該 script 的段落，node --check、grep 參數與 heredoc 字串不算', () => {
  const check = 'node --check scripts/x.mjs && node --check scripts/job-watch.mjs';
  for (const command of [check, 'node -c scripts/x.mjs; node -c scripts/job-watch.mjs', 'git status && node --help scripts/job-watch.mjs',
    'git status && grep -n job-watch.mjs docs/a.md', `git status\npython3 - <<'E'\ns="node scripts/job-watch.mjs --pilot"\nE`,
  ]) assert.equal(chainedLongWaitReason(command, LONG_WAIT), null, command);
  for (const command of ['node --check scripts/job-watch.mjs &', 'grep job-watch.mjs docs/a.md &', 'node -c scripts/job-watch.mjs > /tmp/o 2>&1 &',
  ]) assert.equal(backgroundJobReason(command, LONG_WAIT), null, command);
  // node 的其他選項之後照算執行。
  assert.equal(chainedLongWaitReason('node --check scripts/x.mjs && node --no-warnings scripts/job-watch.mjs --pilot', LONG_WAIT), 'job-watch.mjs');
  assert.equal(backgroundJobReason('node --check scripts/x.mjs && node scripts/job-watch.mjs --pilot &', LONG_WAIT), 'job-watch.mjs');
  assert.equal(hook(JSON.stringify({ tool_input: { command: check } }), ARGS).status, 0);
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'node scripts/pilot-status.mjs && node scripts/job-watch.mjs --pilot' } }), ARGS).status, 2);
});

// 真實指令：retro spay2 e9234021#4。heredoc 寫檔與 gate 接 tail 在同一呼叫，被拒後才發現檔案不存在。
test('writesFile／hook：被拒指令含 heredoc 或寫檔重導時，訊息說明寫檔也未執行', () => {
  const NOTE = '本指令中的寫檔也未執行；寫檔另開一個呼叫';
  for (const command of ["cat > i1.md <<'EOF'\nbody\nEOF", 'echo x > f', 'echo x >> f', 'node a.mjs 2> err.log', 'node a.mjs &> all.log',
    "node scripts/issue-create.mjs --body-file - <<'EOF'\nbody\nEOF"]) assert.equal(writesFile(command), true, command);
  for (const command of ['node a.mjs 2>&1 | tail -5', 'node a.mjs >/dev/null 2>&1', 'node a.mjs > /dev/null', 'node a.mjs >&2',
    'echo "a > b"', 'cat <<< x', 'git status']) assert.equal(writesFile(command), false, command);
  const gate = ['--exit-gate', 'issue-create.mjs'];
  const heredoc = "mkdir -p s/issues && cat > s/issues/i1.md <<'EOF'\nbody\nEOF\nnode scripts/issue-create.mjs --batch x --check 2>&1 | tail -20";
  const denied = hook(JSON.stringify({ tool_input: { command: heredoc } }), gate);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /issue-create\.mjs 接 tail/); assert.ok(denied.stderr.includes(NOTE));
  const plain = hook(JSON.stringify({ tool_input: { command: 'node scripts/issue-create.mjs --batch x --check 2>&1 | tail -20' } }), gate);
  assert.equal(plain.status, 2); assert.ok(!plain.stderr.includes(NOTE));
  const bypass = hook(JSON.stringify({ tool_input: { command: 'echo x > f; git commit --no-verify -m x' } }));
  assert.equal(bypass.status, 2); assert.ok(bypass.stderr.includes(NOTE));
});

// 真實指令：retro spay2 b20cba58#3（jsonl 1077／1088）。followups.mjs 接 tail 與另一個 tail 串在一起被拒，之後沒有重送，兩段都沒執行；
// retro spay2 3eccd274#4：heredoc 寫 reason 檔再串 pilot-handoff.mjs 被拒，試錯一次才改成 Write ＋單獨呼叫。
test('chainedNote／hook：被拒的是串接指令時說明整個呼叫都沒執行；帶 --reason-file 時指明先 Write 再單獨執行', () => {
  const WHOLE = '被拒的整個 Bash 呼叫都沒有執行（含串在一起的其他指令與寫檔），改寫後全部重送。';
  const followups = "node scripts/followups.mjs add '#fix-batch-watch' --tooling 'brief 範本驗證指令不符' 2>&1 | tail -2; tail -5 /tmp/t/b30u2618x.output";
  const gated = hook(JSON.stringify({ tool_input: { command: followups } }), ['--exit-gate', 'followups.mjs']);
  assert.equal(gated.status, 2);
  assert.match(gated.stderr, /followups\.mjs 接 tail/);
  assert.ok(gated.stderr.includes(WHOLE), gated.stderr);
  assert.ok(!gated.stderr.includes('--reason-file'), gated.stderr);
  // 單一指令（或只多了 cd）不加。
  const single = hook(JSON.stringify({ tool_input: { command: "cd /m && node scripts/followups.mjs add x 2>&1 | tail -2" } }), ['--exit-gate', 'followups.mjs']);
  assert.equal(single.status, 2);
  assert.ok(!single.stderr.includes(WHOLE), single.stderr);
  const handoff = "cat > /tmp/s/reason.md <<'EOF'\n交接原因：context 將滿\nEOF\nnode scripts/pilot-handoff.mjs --session s1 --pid 42 --reason-file /tmp/s/reason.md";
  const denied = hook(JSON.stringify({ tool_input: { command: handoff } }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /pilot-handoff\.mjs 與其他指令串在同一個 Bash 呼叫/);
  assert.ok(denied.stderr.includes('本指令中的寫檔也未執行'), denied.stderr);
  assert.ok(denied.stderr.includes(WHOLE), denied.stderr);
  assert.ok(denied.stderr.includes('先用 Write 寫 reason 檔，再單獨執行 `pilot-handoff.mjs --reason-file /tmp/s/reason.md`'), denied.stderr);
  assert.equal(chainedNote('node scripts/pilot-handoff.mjs --reason-file /tmp/r.md'), '');
  assert.equal(chainedNote('X=1; cd /m && git status'), '');
});

// 真實指令：retro spay2 31d564a6#2（jsonl 696）。verify-unit.test.mjs 實測 228 秒，前景跑超過 120 秒被移到背景，管線緩衝讓輸出檔一直是空的。
// 原本 runs 只認 `node <script>`，`node --test <其他測試檔> <script>` 攔不到。
test('foregroundReason：node 選項與前面的其他測試檔之後的 spec 也算執行', () => {
  const specs = ['verify-unit.test.mjs'];
  for (const command of ['node --test scripts/verify-unit.test.mjs | head',
    'cd /m && node --test scripts/verify-record.test.mjs scripts/verify-unit.test.mjs 2>&1 | grep -B2 -A12 "^✖" | head -60',
    'node --test --test-name-pattern=x scripts/verify-unit.test.mjs',
  ]) assert.equal(foregroundReason(command, specs, false), 'verify-unit.test.mjs', command);
  for (const command of ['node --test scripts/verify-record.test.mjs', 'cat scripts/verify-unit.test.mjs | head', 'node --test scripts/verify-unit.test.mjs.bak']) {
    assert.equal(foregroundReason(command, specs, false), null, command);
  }
  const denied = hook(JSON.stringify({ tool_input: { command: 'node --test scripts/verify-unit.test.mjs | head' } }), ['--background-only', 'verify-unit.test.mjs']);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /verify-unit\.test\.mjs 在前景執行/);
  assert.match(denied.stderr, /先寫進 log/);
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'node --test scripts/verify-unit.test.mjs | head', run_in_background: true } }), ['--background-only', 'verify-unit.test.mjs']).status, 0);
});

// retro spay2 bdabcbed#1：session bdabcbed jsonl 第 231／816 行的原指令，ugrep 報 `exceeds complexity limits`、exit 2（第 233／824 行）。
const WIDE_GREP = String.raw`grep -n -o '.\{0,120\}\(STOP_INTEGRATED\|MERGED_OPEN\).\{0,120\}' docs/agents/*.md | head; sed -n 1,40p scripts/followups.mjs | grep -E '^\s*\*|//' | head -30`;
const WIDE_GREP_2 = String.raw`cd /w/feature-ron-retro-collect-1118b && grep -n -o '.\{0,200\}PREMERGE_REJECTED FROZEN.\{0,300\}' docs/agents/issue-pilot-branches.md | head -3; grep -n -o 'running each ${'`'}DOC_TEST <test file>${'`'}.\{0,250\}' docs/agents/issue-pilot-retro.md`;

test('wideGrepReason：grep -o 前後都有寬範圍 `.{0,n}` 時攔下', () => {
  for (const command of [WIDE_GREP, WIDE_GREP_2,
    "grep -noE '.{0,120}x.{0,120}' a.md",
    "grep -e '.{0,60}x.{0,60}' --only-matching a.md",
    String.raw`grep -n -o "landed[^.]\{0,250\}HANDOFF_DUE\|HANDOFF_DUE[^.]\{0,250\}" docs/agents/issue-pilot.md`,
    "for f in a b; do grep -o '.{0,80}x.{0,80}' $f; done",
  ]) assert.equal(wideGrepReason(command), true, command);
});

test('wideGrepReason：沒有 -o、單邊、範圍小、固定次數、-P、GNU grep 與字串裡的字樣不攔', () => {
  for (const command of ["grep -o 'foo' a.md", "grep -n 'foo' a.md", "grep -E 'a.{0,3}b.{0,3}' a.md",
    String.raw`grep -n -o 'running each.\{0,250\}' a.md`, "grep -o 'x.{0,250}' a.md", "grep -oE '.{0,20}x.{0,900}' a.md",
    String.raw`grep -o '.\{120\}x.\{200\}' a.md`, "grep -oP '.{0,120}x.{0,120}' a.md", "command grep -oE '.{0,120}x.{0,120}' a.md",
    "/usr/bin/grep -oE '.{0,120}x.{0,120}' a.md", "grep -A3 -e '.{0,120}x.{0,120}' a.md",
    "echo \"grep -o '.{0,120}x.{0,120}' a.md\"", "python3 - <<'EOF'\nimport os\nos.system(\"grep -o '.{0,120}x.{0,120}' a.md\")\nEOF",
    "git grep -oE '.{0,120}x.{0,120}' a.md",
  ]) assert.equal(wideGrepReason(command), false, command);
});

test('hook：寬範圍 grep -o 被拒；專案有 scripts/doc-excerpt.mjs 時指向它，否則指向 Python', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'git-bypass-grep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = command => spawnSync('node', [script], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  const python = run(WIDE_GREP);
  assert.equal(python.status, 2);
  assert.match(python.stderr, /grep -o 的 pattern 前後都有 `\.\{0,n\}`.*exceeds complexity limits/);
  assert.match(python.stderr, /改用 Python/);
  assert.match(python.stderr, /被拒的整個 Bash 呼叫都沒有執行/);
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'doc-excerpt.mjs'), '');
  const excerpt = run(WIDE_GREP);
  assert.equal(excerpt.status, 2);
  assert.match(excerpt.stderr, /改用 `node scripts\/doc-excerpt\.mjs '<詞>' <檔案>…`/);
  assert.equal(run("grep -o 'foo' a.md").status, 0);
  assert.equal(run("grep -E 'a.{0,3}b' a.md").status, 0);
});

// 2282a2a4#3(b)：update-issue-body.mjs 只要在 settings 加 `--exit-gate update-issue-body.mjs` 就攔，不需改 hook。
test('hook：--exit-gate update-issue-body.mjs 攔下 `--check … | tail`', () => {
  const command = 'node scripts/update-issue-body.mjs 1 --check x | tail';
  const denied = hook(JSON.stringify({ tool_input: { command } }), ['--exit-gate', 'issue-create.mjs', '--exit-gate', 'update-issue-body.mjs']);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /update-issue-body\.mjs 接 tail/);
  assert.equal(hook(JSON.stringify({ tool_input: { command } }), ['--exit-gate', 'issue-create.mjs']).status, 0);
});

// retro spay2 db0c0090#2：retro collect 1119a 子代理回報「指令字面含 batch-land／pilot-handoff 檔名就被擋」。重現原指令（subagents 的 G8、G2）後真正原因是
// `node --check <path>` 被當成執行（--background-only、pilot-handoff 串接）與 `F="scripts/batch-la""nd.mjs"` 的變數指派被當成路徑；heredoc 內文與 `sed -i` 原本就不算。舊碼三筆皆 rc=2。
const G8_HANDOFF_CHECK = "cd /home/ron/orca/workspaces/spay2/feature-ron-retro-collect-1119a/scripts; python3 - <<'EOF'\np='pilot-handoff.mjs'; s=open(p,encoding='utf-8').read()\ndef rep(old,new):\n    global s\n    assert s.count(old)==1, old[:60]\n    s=s.replace(old,new,1)\nhdr = r\"\"\"// 自主裁定回顧（retro 638a12d1#4、followups 711 (b)、preferences 第 27 條 (b)：coordinator 依第 26 條自行確認的裁定不逐條問，累積到交接時一次問使用者）：\n//   decisions.md 中上次回顧點（`.scratch/pilot/decision-review.json` 的 line）之後的「coordinator 自主確認」列：decision 欄含 `自主確認`\n//   （pilot-status DECISION_SELF_CONFIRM 的 `自主確認 #<iid> <N> 條 [需確認]`、手寫的 `G145 #943 兩條 [需確認] 自主確認`），或 reason 欄引用 `preferences 第 26 條`／`preferences 26`\n//   （`觀察 714 715 各開一張 Issue（照 --decisions 預設）`）。使用者自己選的列（reason 寫使用者裁定、AskUserQuestion）與 worker 的 `自主決策 #<iid> …` 列不算。\n//   含 `自主確認` 且帶 #<iid> 的列展開成該 iid 在其前（同 iid 上一筆自主確認之後）的 `自主決策 #<iid> [需確認] <裁定>` 列，每條取第一段（`；` 之前）；其餘列取 decision 欄原文。\n//   一句一條：`  - #<iid> <裁定>（decisions 第 <行> 行）`，沒有 iid 時省略 `#<iid> `。\n//   交接成功（HANDED_OFF）時回顧點的 handoffs 加一，stdout 在 HANDED_OFF 之前印 `DECISION_REVIEW <n> 條（decisions.md 第 <a>–<b> 行；上次回顧 <ISO|無>；距上次回顧交接 <k> 次）` 與清單\n//   （不可動手，資訊）；sessions.md 的 handoff 行尾加 `   decision-review <n>[ due]`。沒有待回顧的列時不印。\n//   n ≥ 10 或 k ≥ 2（且 n > 0）時另印可動手的 `DECISION_REVIEW_DUE <n> → 新 coordinator 首個 tick 以 AskUserQuestion 一題問「這些自主裁定可以嗎、要不要調整」（清單：node scripts/pilot-handoff.mjs --review），回顧後 node scripts/pilot-handoff.mjs --review-done --through <b>`。\n//   `--review`（不交接、不需 ORCA_CLI_COMMAND）：印同一份清單與（到期時）DUE 行，沒有待回顧的列時印 `DECISION_REVIEW 0`；exit 0。\n//   `--review-done [--through <行號>]`：回顧點記為該行（預設 decisions.md 目前最後一行）、handoffs 歸零，印 `DECISION_REVIEW_DONE <行號>`（不可動手）；exit 0。\n//   使用者要改的裁定照常開修正單，回顧點只記「問過了」。\n\"\"\"\nrep(\"// exit：0 交接完成；4 STOP；2 用法錯誤；1 其他失敗。需要 ORCA_CLI_COMMAND。\\n\",\n    \"// exit：0 交接完成；4 STOP；2 用法錯誤；1 其他失敗。需要 ORCA_CLI_COMMAND。\\n\"+hdr)\nrep(\"import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';\",\n    \"import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';\")\nrep(\"const USAGE = '用法：node scripts/pilot-handoff.mjs --session <id> --pid <pid> --reason <原因>|--reason-file <path> [--to <session 名稱|handle>] [--force-handoff <理由>]（cwd 為主 checkout，需要 ORCA_CLI_COMMAND）';\",\n    \"const USAGE = '用法：node scripts/pilot-handoff.mjs --session <id> --pid <pid> --reason <原因>|--reason-file <path> [--to <session 名稱|handle>] [--force-handoff <理由>]（cwd 為主 checkout，需要 ORCA_CLI_COMMAND）'\\n  + ' ｜ --review ｜ --review-done [--through <decisions.md 行號>]';\")\n\ncode = r\"\"\"\n/** 自主裁定回顧點（retro 638a12d1#4）：`.scratch/pilot/` 下的 JSON `{ line, at, handoffs }`。 */\nexport const REVIEW_FILE = 'decision-review.json';\n/** 累積幾條就到期。 */\nexport const REVIEW_MIN_ITEMS = 10;\n/** 距上次回顧幾次交接就到期。 */\nexport const REVIEW_EVERY_HANDOFFS = 2;\n\n/** decisions.md 資料列 → 儲存格（同 lib/auto-decisions.mjs：未跳脫的 `|` 切分，`\\|` 還原）。 */\nconst decisionCells = line => line.trim().replace(/^\\|/, '').replace(/(?<!\\\\)\\|$/, '').split(/(?<!\\\\)\\|/).map(cell => cell.trim().replaceAll('\\\\|', '|'));\nconst SELF_CONFIRM = /自主確認/;\nconst PREFERENCE_26 = /preferences\\s*(?:第\\s*)?26(?!\\d)/;\nconst WORKER_RULING = /^自主決策 #(\\d+) \\[需確認\\] (\\S.*)$/;\n\n/**\n * decisions.md 中 after 行之後 coordinator 自主確認的裁定 → { items: [{ line, iid, text }], from, to, last }（規則見檔頭「自主裁定回顧」）。\n * from／to 為命中列的最小／最大行號（沒有時 null），last 為檔案最後一行的行號。\n */\nexport function selfDecisions(text, after = 0) {\n  const rows = String(text ?? '').split('\\n').map((line, index) => ({ no: index + 1, line }))\n    .filter(({ line }) => /^\\|/.test(line) && !/^\\|\\s*:?-{3,}/.test(line))\n    .map(({ no, line }) => { const [, decision = '', reason = ''] = decisionCells(line); return { no, decision, reason }; });\n  const last = String(text ?? '').replace(/\\n$/, '').split('\\n').length;\n  const items = [];\n  const seen = new Set();\n  const add = (line, iid, body) => {\n    const key = `${iid ?? ''} ${body}`;\n    if (seen.has(key)) return;\n    seen.add(key);\n    items.push({ line, iid, text: body });\n  };\n  const confirmedAt = new Map();\n  for (const { no, decision, reason } of rows) {\n    if (WORKER_RULING.test(decision)) continue;\n    const self = SELF_CONFIRM.test(decision);\n    if (!self && !PREFERENCE_26.test(reason)) continue;\n    const iid = /#(\\d+)/.exec(decision)?.[1] ?? null;\n    const since = iid ? confirmedAt.get(iid) ?? 0 : 0;\n    if (self && iid) confirmedAt.set(iid, no);\n    if (no <= after) continue;\n    const rulings = self && iid ? rows.filter(row => row.no > since && row.no < no && WORKER_RULING.exec(row.decision)?.[1] === iid) : [];\n    if (rulings.length) for (const row of rulings) add(row.no, iid, WORKER_RULING.exec(row.decision)[2].split('；')[0]);\n    else add(no, iid, decision);\n  }\n  const lines = items.map(item => item.line);\n  return { items, from: lines.length ? Math.min(...lines) : null, to: lines.length ? Math.max(...lines) : null, last };\n}\n\n/** 回顧點檔 → { line, at, handoffs }；沒有或壞掉時從頭算（line 0、at null、handoffs 0）。 */\nexport function readReview(file) {\n  try {\n    const data = JSON.parse(readFileSync(file, 'utf8'));\n    return { line: Number.isInteger(data.line) ? data.line : 0, at: typeof data.at === 'string' ? data.at : null, handoffs: Number.isInteger(data.handoffs) ? data.handoffs : 0 };\n  } catch { return { line: 0, at: null, handoffs: 0 }; }\n}\n\n/** 回顧點檔寫入（tmp + rename）。 */\nexport function writeReview(file, review) {\n  const temp = `${file}.tmp-${process.pid}`;\n  writeFileSync(temp, `${JSON.stringify(review)}\\n`);\n  renameSync(temp, file);\n}\n\n/**\n * 清單與到期判定 → { count, due, lines }：lines 為 `DECISION_REVIEW …` 標頭、每條 `  - …`、到期時 `DECISION_REVIEW_DUE …`；沒有待回顧的列時 lines 空。\n * @param {string} decisions decisions.md 內容\n * @param {{ line: number, at: string|null, handoffs: number }} review 回顧點（handoffs 為已含本次交接的次數）\n */\nexport function reviewLines(decisions, review) {\n  const { items, from, to } = selfDecisions(decisions, review.line);\n  if (!items.length) return { count: 0, due: false, lines: [] };\n  const due = items.length >= REVIEW_MIN_ITEMS || review.handoffs >= REVIEW_EVERY_HANDOFFS;\n  return { count: items.length, due, lines: [\n    `DECISION_REVIEW ${items.length} 條（decisions.md 第 ${from}–${to} 行；上次回顧 ${review.at ?? '無'}；距上次回顧交接 ${review.handoffs} 次）`,\n    ...items.map(({ line, iid, text }) => `  - ${iid ? `#${iid} ` : ''}${text}（decisions 第 ${line} 行）`),\n    ...(due ? [`DECISION_REVIEW_DUE ${items.length} → 新 coordinator 首個 tick 以 AskUserQuestion 一題問「這些自主裁定可以嗎、要不要調整」（清單：node scripts/pilot-handoff.mjs --review），回顧後 node scripts/pilot-handoff.mjs --review-done --through ${to}`] : []),\n  ] };\n}\n\n/** 主 checkout 的 decisions.md 與回顧點檔路徑。 */\nconst reviewPaths = main => ({ decisions: join(main, '.scratch/pilot/decisions.md'), review: join(main, '.scratch/pilot', REVIEW_FILE) });\nconst readText = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };\n\n/** --review：不改任何檔，印清單（沒有時 `DECISION_REVIEW 0`）。 */\nexport function reviewReport(main) {\n  const paths = reviewPaths(main);\n  const { lines } = reviewLines(readText(paths.decisions), readReview(paths.review));\n  return lines.length ? lines : ['DECISION_REVIEW 0'];\n}\n\n/** --review-done：回顧點記為 through（預設 decisions.md 最後一行）、handoffs 歸零 → `DECISION_REVIEW_DONE <行號>`。 */\nexport function reviewDone(main, through = null, now = new Date().toISOString()) {\n  const paths = reviewPaths(main);\n  const line = through ?? selfDecisions(readText(paths.decisions)).last;\n  writeReview(paths.review, { line, at: now, handoffs: 0 });\n  return `DECISION_REVIEW_DONE ${line}`;\n}\n\n/** 交接成功後：回顧點 handoffs 加一 → reviewLines 的結果（寫入失敗不擋交接，照樣回傳清單）。 */\nexport function reviewAfterHandoff(main) {\n  const paths = reviewPaths(main);\n  const review = readReview(paths.review);\n  const next = { ...review, handoffs: review.handoffs + 1 };\n  try { writeReview(paths.review, next); } catch { /* 回顧點只是提醒，不擋交接 */ }\n  return reviewLines(readText(paths.decisions), next);\n}\n\"\"\"\nanchor = \"function handoff(cli, main, { session, pid, reason, to, force }, self = process.env.ORCA_TERMINAL_HANDLE) {\"\ns = s.replace(anchor, code.lstrip('\\n') + \"\\n\" + anchor, 1)\nrep(\"\"\"  const { handle } = opened;\n  appendFileSync(join(pilot, 'sessions.md'), `${at}   handoff from-session ${session} → terminal ${handle}   reason ${reason}${target ? `   existing ${to}` : ''}${force ? `   force-handoff ${force}` : ''}\\\\n`);\n  return `HANDED_OFF ${handle}`;\"\"\",\n\"\"\"  const { handle } = opened;\n  const review = reviewAfterHandoff(main);\n  appendFileSync(join(pilot, 'sessions.md'), `${at}   handoff from-session ${session} → terminal ${handle}   reason ${reason}${target ? `   existing ${to}` : ''}${force ? `   force-handoff ${force}` : ''}${review.count ? `   decision-review ${review.count}${review.due ? ' due' : ''}` : ''}\\\\n`);\n  return [...review.lines, `HANDED_OFF ${handle}`].join('\\\\n');\"\"\")\nrep(\"\"\"  const args = process.argv.slice(2);\n  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };\n\"\"\",\"\"\"  const args = process.argv.slice(2);\n  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };\n  if (args[0] === '--review' || args[0] === '--review-done') {\n    const through = value('--through');\n    if ((args[0] === '--review' && args.length > 1) || (args[0] === '--review-done' && (args.length > 1 && (args.length !== 3 || !/^\\\\d+$/.test(through ?? ''))))) {\n      console.error(USAGE);\n      process.exit(2);\n    }\n    try {\n      console.log(args[0] === '--review' ? reviewReport(mainCheckout()).join('\\\\n') : reviewDone(mainCheckout(), through ? Number(through) : null));\n      process.exit(0);\n    } catch (error) {\n      console.error(error.message);\n      process.exit(1);\n    }\n  }\n\"\"\")\nopen(p,'w',encoding='utf-8').write(s)\nEOF\nnode --check pilot-handoff.mjs && echo ok; grep -n \"line.startsWith('HANDED_OFF')\\|split('\\\\\\\\n').at(-1)\" pilot-handoff.mjs";
const G2_LAND_CHECK = "cd /home/ron/orca/workspaces/spay2/feature-ron-retro-collect-1119a; python3 - <<'EOF'\np='scripts/batch-land.mjs'\ns=open(p,encoding='utf-8').read()\nold=\"\"\"  // 每次寫入前重讀 checkpoint、只改本列：推送與 close 期間 coordinator 可能已寫其他列（retro 1024b：push 期間 `batch-fix --sync` 把 #510 設 running、\n  // 寫 handle，落地以開頭讀到的舊內容整份寫回，#510 變回 stop、handle 消失，drain 對不上它的 DONE）\n  const save = edit => { text = edit(readFileSync(stateFile, 'utf8')); writeFileSync(stateFile, text); };\"\"\"\nnew=\"\"\"  // 每次寫入前重讀 checkpoint、只改本列：推送與 close 期間 coordinator 可能已寫其他列（retro 1024b：push 期間 `batch-fix --sync` 把 #510 設 running、\n  // 寫 handle，落地以開頭讀到的舊內容整份寫回，#510 變回 stop、handle 消失，drain 對不上它的 DONE）；\n  // 重讀與寫回在 batch-state.mjs updateCheckpoint 的 `<state.md>.lock` 內（retro 0cbb37be#2：只重讀不加鎖，平行寫入者仍可插在讀與寫之間）\n  const save = edit => { text = updateCheckpoint(stateFile, edit); };\"\"\"\nassert old in s\ns=s.replace(old,new,1)\ns=s.replace(\"import { setCurrent, setRow } from './batch-state.mjs';\",\"import { setCurrent, setRow, updateCheckpoint } from './batch-state.mjs';\",1)\nopen(p,'w',encoding='utf-8').write(s)\nEOF\nnode --check scripts/batch-land.mjs && grep -n \"writeFileSync(stateFile\\|stateFile, \" scripts/batch-land.mjs | head";
const G2_LAND_ASSIGN = "cd /home/ron/orca/workspaces/spay2/feature-ron-retro-collect-1119a; F=\"scripts/batch-la\"\"nd.mjs\"; P=\"$F\" python3 - <<'EOF'\nimport os\np=os.environ['P']\ns=open(p,encoding='utf-8').read()\nold=\"\"\"  // 每次寫入前重讀 checkpoint、只改本列：推送與 close 期間 coordinator 可能已寫其他列（retro 1024b：push 期間 `batch-fix --sync` 把 #510 設 running、\n  // 寫 handle，落地以開頭讀到的舊內容整份寫回，#510 變回 stop、handle 消失，drain 對不上它的 DONE）\n  const save = edit => { text = edit(readFileSync(stateFile, 'utf8')); writeFileSync(stateFile, text); };\"\"\"\nnew=\"\"\"  // 每次寫入前重讀 checkpoint、只改本列：推送與 close 期間 coordinator 可能已寫其他列（retro 1024b：push 期間 `batch-fix --sync` 把 #510 設 running、\n  // 寫 handle，落地以開頭讀到的舊內容整份寫回，#510 變回 stop、handle 消失，drain 對不上它的 DONE）；\n  // 重讀與寫回在 batch-state.mjs updateCheckpoint 的 `<state.md>.lock` 內（retro 0cbb37be#2：只重讀不加鎖，平行寫入者仍可插在讀與寫之間）\n  const save = edit => { text = updateCheckpoint(stateFile, edit); };\"\"\"\nassert old in s\ns=s.replace(old,new,1)\na=\"import { setCurrent, setRow } from './batch-state.mjs';\"\nassert a in s\ns=s.replace(a,\"import { setCurrent, setRow, updateCheckpoint } from './batch-state.mjs';\",1)\nopen(p,'w',encoding='utf-8').write(s)\nEOF\nnode --check \"$F\" && grep -n \"writeFileSync(stateFile\\|landParent\\b.*text\\|stateFile\" \"$F\" | head -20";
const PROJECT_ARGS = ['--exit-gate', 'batch-land.mjs', '--exit-gate', 'update-issue-body.mjs', '--background-only', 'batch-land.mjs'];

test('foregroundReason／chainedHandoff：node --check 與變數指派不算執行；真正執行照攔（retro spay2 db0c0090#2）', () => {
  for (const command of [G8_HANDOFF_CHECK, G2_LAND_CHECK, G2_LAND_ASSIGN]) assert.equal(hook(JSON.stringify({ tool_input: { command } }), PROJECT_ARGS).status, 0, command.slice(0, 80));
  const specs = ['batch-land.mjs'];
  for (const command of ['node --check scripts/batch-land.mjs && echo ok', 'node -c scripts/batch-land.mjs', 'F=scripts/batch-land.mjs; echo $F',
    "sed -i 's/a/b/' scripts/batch-land.mjs; echo ok", "cat > /tmp/x <<'EOF'\nnode scripts/batch-land.mjs x\nEOF\necho ok",
  ]) assert.equal(foregroundReason(command, specs, undefined), null, command);
  for (const command of ['node scripts/batch-land.mjs x', 'X=1 node scripts/batch-land.mjs x', 'node --check scripts/x.mjs && node scripts/batch-land.mjs x',
    'F=1 scripts/batch-land.mjs x', 'node --no-warnings scripts/batch-land.mjs x',
  ]) assert.equal(foregroundReason(command, specs, undefined), 'batch-land.mjs', command);
  assert.equal(chainedHandoff('node --check pilot-handoff.mjs && echo ok'), false);
  assert.equal(chainedHandoff('node --check scripts/x.mjs && node scripts/pilot-handoff.mjs --reason r'), true);
  assert.equal(chainedLongWaitReason('ARGS=(--long-wait job-watch.mjs --exit-gate x.mjs); echo ok', LONG_WAIT), null, '陣列指派不是執行');
  assert.equal(exitGateReason('node --check scripts/batch-land.mjs | tail -3', ['batch-land.mjs']), null, 'node --check 不是 gate');
  const denied = hook(JSON.stringify({ tool_input: { command: 'node scripts/batch-land.mjs x' } }), PROJECT_ARGS);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /batch-land\.mjs 在前景執行/);
});

// retro spay2 05f4385f#3：jsonl:488 `update-issue-body.mjs --help 2>&1 | head -15` 被拒（它把 `--help` 當 iid、印 USAGE、exit 2，不寫入）。舊碼 rc=2。
test('exitGateReason：update-issue-body.mjs／fix-land.mjs／check-contracts.sh 的 --help 接管線放行，寫入形式照攔（retro spay2 05f4385f#3）', () => {
  const gates = ['update-issue-body.mjs', 'fix-land.mjs', 'check-contracts.sh'];
  for (const command of ['node scripts/update-issue-body.mjs --help 2>&1 | head -15', 'node scripts/update-issue-body.mjs -h | head',
    'node scripts/fix-land.mjs --help | head -5', 'bash scripts/check-contracts.sh --help 2>&1 | tail -2',
  ]) assert.equal(exitGateReason(command, gates), null, command);
  for (const [command, script] of [['node scripts/update-issue-body.mjs 1 --append f --since t | tail', 'update-issue-body.mjs'],
    ['node scripts/update-issue-body.mjs 1 --check x --help | tail', 'update-issue-body.mjs'], ['node scripts/fix-land.mjs x | tail', 'fix-land.mjs'],
    ['bash scripts/check-contracts.sh | tail -15', 'check-contracts.sh'], ['node scripts/update-issue-body.mjs --help | xargs node scripts/update-issue-body.mjs | tail', 'update-issue-body.mjs'],
  ]) assert.equal(exitGateReason(command, gates)?.script, script, command);
  const command = 'node scripts/update-issue-body.mjs --help 2>&1 | head -15; grep -n x scripts/update-issue-body.mjs | head -15';
  assert.equal(hook(JSON.stringify({ tool_input: { command } }), PROJECT_ARGS).status, 0, '05f4385f jsonl:488');
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'node scripts/update-issue-body.mjs 1 --append f --since t | tail' } }), PROJECT_ARGS).status, 2);
});

// 動態 import 字樣以拼接產生：copy-templates 會把字面的動態 import 相對路徑當成範本相依
const DYN_IMPORT = 'imp' + 'ort';
// retro spay2 db0c0090#2（1119b GB 子代理實例）：python heredoc 編輯 batch-watch.mjs 後 `node -e` 字串內以動態 import 載入 batch-watch，
// -e 內 `import(` 的括號被當成段落開頭，判成 watcher 前面串了其他指令（舊碼 rc=2）。--whole-output 同樣只認被執行的 script。
const GB_WATCH_IMPORT = "cd /home/ron/orca/workspaces/spay2/feature-ron-retro-collect-1119b; python3 - <<'EOF'\np='scripts/batch-watch.mjs'\ns=open(p).read()\nold=\"\"\"//   才結束，coordinator 每個 worker DONE 後都乾等 1200 秒的備援喚醒）。只配 --pilot；單獨 --pilot 行為不變。\n\"\"\"\nnew=\"\"\"//   才結束，coordinator 每個 worker DONE 後都乾等 1200 秒的備援喚醒）。只配 --pilot；單獨 --pilot 行為不變。\n//   FINISHED idle 時 worker 的卡片 worktree（terminal list 的 worktreePath；iid 取 checkpoint 列或 issueOf）已有 `.scratch/deliver-<iid>/result`（worker-result.mjs 寫的\n//   DONE／STOP 行）時不附整個畫面尾段，只印三部分：`FINISHED <handle> idle`、結果行原樣（`DONE <iid> <sha>`／`STOP <iid> <cause>`）、worker 最後摘要段\n//   （畫面上回合結束頁尾之前最後一個 `●` 訊息起，去掉結果行，上限 10 行）。可行動：照常 `pilot-status.mjs --drain --apply --reap`（drain 自己讀 result 檔）；\n//   要看完整畫面用 `--once <handle> --lines <n>`（照舊）。沒有 result 檔、api-error、exited 與其他模式照舊附畫面尾段\n//   （retro b0cd7ce1#9：FINISHED 紀錄 2,036–3,863 字、約 45 行，多是 diff 預覽；coordinator 只用來向使用者轉述，close-note.md 也有）。\n\"\"\"\nassert s.count(old)==1; s=s.replace(old,new)\nold=\"import { isOpen, parseBatch } from './pilot-status.mjs';\\n\"\nnew=\"import { isOpen, parseBatch } from './pilot-status.mjs';\\nimport { readResult } from './worker-result.mjs';\\n\"\nassert s.count(old)==1; s=s.replace(old,new)\nold=\"const ONCE_LINES = 8;\\n\"\nnew=\"const ONCE_LINES = 8;\\nconst SUMMARY_LINES = 10;\\n\"\nassert s.count(old)==1; s=s.replace(old,new)\nold=\"\"\"/** 選單區塊在 report() 行中的範圍\"\"\"\nnew=\"\"\"/**\n * worker 最後摘要段（retro b0cd7ce1#9）：report() 行中回合結束頁尾（沒有時提示列 `❯`）之前最後一個 `●` 訊息行起到該處為止，\n * 去掉結果行（`DONE|STOP <iid> …`，另行印出），最多 limit 行；找不到 `●` 時空陣列。\n */\nexport function lastSummary(lines, limit = SUMMARY_LINES) {\n  const shown = report(lines);\n  const footer = shown.findLastIndex(line => TURN_END.test(line));\n  const stop = footer >= 0 ? footer : (index => (index >= 0 ? index : shown.length))(shown.findLastIndex(line => PROMPT.test(line)));\n  const start = shown.slice(0, stop).findLastIndex(line => /^\\\\s*●/.test(line));\n  return start < 0 ? [] : shown.slice(start, stop).filter(line => !/^\\\\s*(DONE|STOP) \\\\d+ /.test(line)).slice(0, limit);\n}\n\n/** --pilot --exit-on-finish 有 result 檔時的 FINISHED 紀錄：`FINISHED <handle> idle`、結果行、最後摘要段（retro b0cd7ce1#9）。 */\nexport function finishedWithResult(handle, resultLine, lines) {\n  return [`FINISHED ${handle} idle`, resultLine, ...lastSummary(lines)].join('\\\\n');\n}\n\n/** 選單區塊在 report() 行中的範圍\"\"\"\nassert s.count(old)==1; s=s.replace(old,new)\nold=\"\"\"      if (count >= 2) { done(handle, [`FINISHED ${handle} ${errored ? 'api-error' : 'idle'}`, ...report(screen.lines)].join('\\\\n')); continue; }\"\"\"\nnew=\"\"\"      if (count >= 2) {\n        // retro b0cd7ce1#9：--pilot --exit-on-finish 且卡片已有 result 檔時只印結果行與最後摘要段，不附整個畫面尾段\n        const terminal = pilot && exitOnFinish && !errored ? listed(cli, handle) : undefined;\n        const iid = joined.get(handle) ?? issueOf(terminal);\n        const resultLine = terminal?.worktreePath && iid !== '?' ? readResult(terminal.worktreePath, iid) : null;\n        done(handle, resultLine ? finishedWithResult(handle, resultLine, screen.lines)\n          : [`FINISHED ${handle} ${errored ? 'api-error' : 'idle'}`, ...report(screen.lines)].join('\\\\n'));\n        continue;\n      }\"\"\"\nassert s.count(old)==1; s=s.replace(old,new)\nopen(p,'w').write(s)\nEOF\nnode --check scripts/batch-watch.mjs && node -e \"" + DYN_IMPORT + "('./scripts/batch-watch.mjs').then(m=>console.log(typeof m.lastSummary))\"";

test('--long-wait／--whole-output：直譯器 -e 的 import(…)／require(…)、陣列與變數指派不算執行；真正執行照攔（retro spay2 db0c0090#2）', () => {
  const args = ['--long-wait', 'batch-watch.mjs', '--whole-output', 'pilot-status.mjs --probe', '--exit-gate', 'batch-land.mjs'];
  assert.equal(hook(JSON.stringify({ tool_input: { command: GB_WATCH_IMPORT } }), args).status, 0, '1119b GB 原指令');
  for (const command of [`node -e "${DYN_IMPORT}('./scripts/batch-watch.mjs').then(m=>m)" && echo ok`, `git status && node -e "require('./scripts/batch-watch.mjs')"`,
    'ARGS=(--long-wait batch-watch.mjs); echo ok', 'node --check scripts/batch-watch.mjs && echo ok',
  ]) assert.equal(chainedLongWaitReason(command, ['batch-watch.mjs']), null, command);
  assert.equal(chainedLongWaitReason('git status && node scripts/batch-watch.mjs --pilot', ['batch-watch.mjs']), 'batch-watch.mjs');
  assert.equal(exitGateReason(`python3 -c "import os; os.system('node scripts/batch-land.mjs x | tail')"`, ['batch-land.mjs'])?.script, 'batch-land.mjs', '-c 內真正的呼叫照攔');
  const probe = ['pilot-status.mjs --probe'];
  for (const command of ['P=scripts/pilot-status.mjs --probe | head', 'node --check scripts/pilot-status.mjs --probe | head',
    `python3 - <<'E'\nprint('node scripts/pilot-status.mjs --probe | head')\nE\necho ok | head`,
  ]) assert.equal(probeFilterReason(command, probe), null, command);
  for (const command of ['node scripts/pilot-status.mjs --probe | head', 'cd x && node /a/scripts/pilot-status.mjs --probe 2>&1 | grep STAGEABLE',
  ]) assert.ok(probeFilterReason(command, probe), command);
});

// 真實指令：retro spay2 1a01bf03#1（#961 worker 卡 2 小時；舊碼 rc=0）。pattern 也在執行迴圈的 shell 自己的命令列，pgrep -f 永遠找得到。
const SELF_MATCH_WAIT = 'until ! pgrep -f "impacted-tests.mjs c1e9348e3" >/dev/null; do sleep 30; done';

test('selfMatchLoopReason：while／until 迴圈條件或內文的 pgrep -f 攔下', () => {
  for (const command of [SELF_MATCH_WAIT, `cd /x && ${SELF_MATCH_WAIT}; tail -12 log`,
    'while [ -n "$(pgrep -af foo)" ]; do sleep 5; done', 'while true; do pgrep --full x || break; sleep 1; done',
    'until ! kill -0 $(pgrep -f "copy-templates|run-checks" | head -1) 2>/dev/null; do sleep 2; done',
    'until grep -q x log || ! pgrep -fl "run-codex-review.mjs 6a" >/dev/null; do sleep 5; done',
  ]) assert.equal(selfMatchLoopReason(command), true, command);
});

test('selfMatchLoopReason：迴圈外單獨的 pgrep、沒有 -f、for 迴圈、kill -0 與字串不攔', () => {
  for (const command of ['pgrep -af foo', 'pgrep -f foo; echo done', 'until ! pgrep foo; do sleep 1; done', 'for i in 1 2; do pgrep -f x; done',
    'while kill -0 123 2>/dev/null; do sleep 30; done', 'grep "while pgrep -f" x', 'while read l; do echo "$l"; done < f; pgrep -af foo',
  ]) assert.equal(selfMatchLoopReason(command), false, command);
});

test('hook：迴圈內 pgrep -f 不需參數就 exit 2，訊息指向 run_in_background 與 kill -0', () => {
  const denied = hook(JSON.stringify({ tool_input: { command: SELF_MATCH_WAIT } }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /^拒絕：while／until 迴圈裡的 `pgrep -f` 會比對到執行這個迴圈的 shell 本身/);
  assert.match(denied.stderr, /run_in_background: true/);
  assert.match(denied.stderr, /`while kill -0 <pid> 2>\/dev\/null; do sleep 30; done`/);
  assert.equal(hook(JSON.stringify({ tool_input: { command: 'pgrep -af foo' } })).status, 0);
});

// 真實指令：retro spay2 1a01bf03#8（前景 --when-idle 跑滿 300 秒才被移到背景；舊碼 rc=0）。
const WHEN_IDLE = 'cd /home/ron/code/spay2 && node scripts/orca-session-send.mjs --terminal term_83f036bf --when-idle --prompt "coordinator：x"';

test('hook：orca-session-send.mjs --when-idle 是內建 background-only，前景拒絕、背景與不帶 --when-idle 放行', () => {
  assert.deepEqual(BUILTIN_BACKGROUND_ONLY, ['orca-session-send.mjs --when-idle']);
  const call = (command, extra = {}) => hook(JSON.stringify({ tool_input: { command, ...extra } }));
  const denied = call(WHEN_IDLE);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /^拒絕：orca-session-send\.mjs --when-idle 在前景執行/);
  assert.match(denied.stderr, /run_in_background: true/);
  assert.equal(call(WHEN_IDLE, { run_in_background: true }).status, 0);
  assert.equal(call('node scripts/orca-session-send.mjs --terminal t --prompt x').status, 0);
  assert.equal(call('grep -n -- "--when-idle" scripts/orca-session-send.mjs').status, 0);
});
