import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backgroundJobReason, bypassReason, chainedHandoff, chainedLongWaitReason, chainedNote, exitGateReason, foregroundReason, probeFilterReason, writesFile } from './claude-hook-git-bypass.mjs';

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
  assert.equal(hook(JSON.stringify({ tool_input: { command: once } }), ARGS).status, 0);
  const denied = hook(JSON.stringify({ tool_input: { command: 'node scripts/pilot-status.mjs --drain; node scripts/job-watch.mjs --pilot' } }), ARGS);
  assert.equal(denied.status, 2); assert.match(denied.stderr, /單獨一個背景呼叫/);
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
