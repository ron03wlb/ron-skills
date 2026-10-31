import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { equalsWords, nomatchWords, usesPipestatus } from '../scripts/claude-hook-zsh-equals.mjs';

const HOOK = fileURLToPath(new URL('../scripts/claude-hook-zsh-equals.mjs', import.meta.url));
const run = input => spawnSync('node', [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
const bash = command => run({ tool_name: 'Bash', tool_input: { command } });

// session 2ebf77bf 的原指令形狀：`echo ===` 當分隔線，zsh 印 `(eval):1: == not found`，後面的 pilot-probe 沒跑（#203）。
test('未加引號、以 = 開頭的字被擋下，exit 2 並說明 EQUALS 展開與改法', () => {
  const result = bash('node scripts/pilot-register.mjs . ; echo ===; node scripts/pilot-probe.mjs . --apply --status');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /EQUALS/);
  assert.match(result.stderr, /`===`/);
  assert.match(result.stderr, /echo '==='/);
  assert.deepEqual(equalsWords('cat a.md; echo === ; grep x b'), ['===']);
  assert.deepEqual(equalsWords('for f in a b; do echo "$f"; echo ==; done'), ['==']);
  assert.deepEqual(equalsWords('ls =node'), ['=node']);
  assert.deepEqual(equalsWords('[ "$a" == b ]'), ['==']);
});

test('引號、heredoc、註解、[[ ]]、(( )) 裡的 == 與 VAR=x、--opt=x、單獨的 = 放行', () => {
  for (const command of [
    "echo '==='",
    'echo "==="',
    'echo ---',
    '[[ $a == b ]] && echo ok',
    'if [[ "$x" == y ]]; then echo ok; fi',
    'echo $((1 == 1)); (( a == b ))',
    'A=1 node x.mjs --opt=x a==b',
    '[ "$a" = b ]',
    "python3 - <<'EOF'\nif a == b:\n    print('===')\nEOF\necho done",
    'cat <<-END\n\t== x\n\tEND\necho ok',
    'echo ok # === 註解',
    'echo \\=\\=\\=',
  ]) {
    assert.deepEqual(equalsWords(command), [], command);
    assert.equal(bash(command).status, 0, command);
  }
});

test('heredoc 結束之後的字照樣檢查', () => {
  assert.deepEqual(equalsWords("cat <<'EOF'\n==\nEOF\necho ==="), ['===']);
});

test('不是 Bash、沒有 command 或輸入不是 JSON 時 exit 0 不輸出', () => {
  for (const input of [{ tool_name: 'Edit', tool_input: { command: 'echo ===' } }, { tool_name: 'Bash', tool_input: {} }, 'not json']) {
    const result = run(input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  }
});

// session 19341230 的原指令：zsh 對 `--include=*.md` 做檔名展開，找不到就印 `no matches found: --include=*.md`、exit 1，整串作廢（#209）。
test('未加引號、含 * 或 ? 的 --opt=pattern 被擋下，exit 2 並說明 NOMATCH 與改法', () => {
  const result = bash('git status --short; grep -rln "claude-hook-unbare\\|claude-hook-language" --include=*.md . | head');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NOMATCH/);
  assert.match(result.stderr, /`--include=\*\.md`/);
  assert.match(result.stderr, /--include='\*\.md'/);
  assert.deepEqual(nomatchWords('grep -r x --include=*.md --exclude=*.log .'), ['--include=*.md', '--exclude=*.log']);
  assert.deepEqual(nomatchWords('find . --name=a?.txt'), ['--name=a?.txt']);
});

test('加引號或跳脫的 pattern、一般的 *.md 參數、不含萬用字元的 --opt=x 放行', () => {
  for (const command of [
    "grep -r x --include='*.md' .",
    'grep -r x --include="*.md" .',
    'grep -r x --include=\\*.md .',
    'ls *.md docs/*.md',
    'node x.mjs --opt=x --base-branch=main',
    "cat <<'EOF'\n--include=*.md\nEOF\necho ok",
    'echo ok # --include=*.md',
    '[[ $a == --x=* ]] && echo ok',
  ]) {
    assert.deepEqual(nomatchWords(command), [], command);
    assert.equal(bash(command).status, 0, command);
  }
});

// session cbef7b39 的原指令：分支名稱不是檔案，zsh 把沒加引號的 `issue/193-*` 當 glob，印 `(eval):1: no matches found: issue/193-*`（#218）。
test('未加引號、含 * 或 ? 的 ref 字（issue/、pilot/、retro/、origin/ 開頭）被擋下，提示加引號或 git branch --list', () => {
  const result = bash('git merge-base issue/193-* pilot/integration 2>/dev/null || git branch --list "issue/193-*"');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NOMATCH/);
  assert.match(result.stderr, /`issue\/193-\*`/);
  assert.match(result.stderr, /'issue\/193-\*'/);
  assert.match(result.stderr, /git branch --list/);
  assert.deepEqual(nomatchWords('git log pilot/stage-* retro/10?1h origin/issue/*'), ['pilot/stage-*', 'retro/10?1h', 'origin/issue/*']);
});

test('加引號的 ref pattern、不含萬用字元的 ref、路徑裡的 issue/ 放行', () => {
  for (const command of [
    "git branch --list 'issue/193-*'",
    'git for-each-ref "refs/heads/pilot/*"',
    'git merge-base issue/193-land-sync-main pilot/integration',
    'ls .scratch/issue-run-*/state.md',
  ]) {
    assert.deepEqual(nomatchWords(command), [], command);
  }
});

// session 8d8ec702 jsonl 第 183 行的原指令：zsh 裡 `${PIPESTATUS[0]}` 展開成空字串，印 `exit=`（#238）。
test('雙引號或未加引號的 PIPESTATUS 被擋下，提示改用 zsh 的 pipestatus', () => {
  const result = bash('cd /Users/ron/Documents/Workspace/ron-skills; sysctl -n vm.loadavg; node scripts/pilot-land.mjs 227 </dev/null 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PIPESTATUS/);
  assert.match(result.stderr, /\$\{pipestatus\[1\]\}/);
  assert.equal(usesPipestatus('make | tee log; echo $PIPESTATUS'), true);
  for (const command of [
    'make | tee log; echo "exit=${pipestatus[1]}"',
    "bash -c 'make | tee log; exit ${PIPESTATUS[0]}'",
    "cat > run.sh <<'EOF'\nmake | tee log\nexit ${PIPESTATUS[0]}\nEOF",
  ]) assert.equal(usesPipestatus(command), false, command);
});
