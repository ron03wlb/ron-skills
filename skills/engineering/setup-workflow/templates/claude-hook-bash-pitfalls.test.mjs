// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnHook, unfinishedExports, unfinishedHookRuns } from './test/hook-timeout.mjs';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { join } from 'node:path';
import { checkPiped, ghViewCommentsWithoutJson, hashSubjectCommits, truncatedDocGrep, unquotedHeredocs } from './claude-hook-bash-pitfalls.mjs';

const HOOK = fileURLToPath(new URL('./claude-hook-bash-pitfalls.mjs', import.meta.url));
const run = input => spawnHook('node', [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
const bash = command => run({ tool_name: 'Bash', tool_input: { command } });

// retro-418.md 的原指令形狀（#444）：內文是 Markdown，行內碼被 bash 當命令替換執行。
const RETRO_BODY = [
  '## 候選',
  '- 先 `git cherry-pick 84554ca`，衝突時 `git cherry-pick -n 4a434c4`',
  '- 驗證 `node --test …`',
].join('\n');
const retro = tag => `cat > .scratch/issue-run-399/retro-418.md <<${tag}\n${RETRO_BODY}\nEOF`;

test('分隔字沒加引號、內文含反引號：exit 2 並說明命令替換與改法（#444）', () => {
  const result = bash(retro('EOF'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /命令替換/);
  assert.match(result.stderr, /<<'EOF'/);
  assert.match(result.stderr, /Write/);
  assert.equal(unquotedHeredocs(retro('EOF')).length, 1);
  assert.equal(bash('cat <<-EOF\n\tuse $(date)\n\tEOF').status, 2);
  assert.equal(bash('cat <<EOF\nx\nEOF\ncat <<B\n`id`\nB').status, 2, '第二個 heredoc 才有命令替換');
  assert.equal(bash('echo "$(cat <<EOF\n`id`\nEOF\n)"').status, 2, '命令替換裡的 heredoc');
});

test('分隔字有任何引號、內文只有 $VAR、here-string、引號或註解裡的 << 放行', () => {
  for (const command of [
    retro("'EOF'"), retro('"EOF"'), retro('\\EOF'), retro('E"OF"'),
    'cat <<EOF\nhome is $HOME\nEOF',
    'cat <<EOF\n\\`escaped\\`\nEOF',
    'cat <<EOF\nplain text\nEOF',
    'cat <<<"$x"',
    "echo '<<EOF'",
    'echo "<<EOF `x`"',
    'echo ok # cat <<EOF',
    'echo $((1<<2))\necho `date`',
  ]) assert.equal(bash(command).status, 0, command);
});

test('gh issue view／pr view 帶 --comments 沒有 --json：exit 2（#428）', () => {
  const result = bash('gh issue view 399 --comments');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--json number,title,body,labels,comments/);
  assert.equal(bash('gh issue view 433 --comments; echo ---; cat x').status, 2);
  assert.equal(bash('cd x && gh pr view 5 -c | head').status, 2);
  assert.deepEqual(ghViewCommentsWithoutJson('echo a; GH_PAGER=cat gh pr view 5 --comments'), ['GH_PAGER=cat gh pr view 5 --comments']);
});

test('有 --json、在引號裡、別的子指令放行', () => {
  for (const command of [
    "gh issue view 399 --json body,comments --jq '.body'",
    'gh issue view 399 --comments --json comments',
    'echo "gh issue view 1 --comments"',
    "echo 'gh pr view 1 --comments'",
    'gh issue view 399',
    'gh issue list --comments',
  ]) assert.equal(bash(command).status, 0, command);
});

// #479：#408 worker 第 219 行以 run_in_background 跑這條，通知 exit 0、輸出只有 `[exited with code 0]`，結果行與 bin/check 的 exit 都拿不到。
test('bin/check 接管線、沒有 pipefail：exit 2，說明 exit 是 tail 的並給導到 log 的寫法（#479）', () => {
  const result = bash('bin/check 2>&1 | tail -3');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /bin\/check 2>&1 \| tail|`bin\/check`/);
  assert.match(result.stderr, /bin\/check > <log> 2>&1; echo exit=\$\?; tail -1 <log>/);
  assert.match(result.stderr, /pipefail/);
  for (const command of [
    'kill 506539; cd /home/ron/orca/workspaces/ron-skills/issue-356 && bin/check 2>&1 | tail -1',
    'bash bin/check 2>&1 | tail -15',
    './bin/check --upstream |& tee log',
    'timeout 600 bin/check | tail',
    'CI=1 bin/check >> log | cat',
    'timeout -k 5 30 bin/check | tail -1',
    'nice -n 5 bin/check 2>&1 | tail',
    'env -u FOO X=1 bin/check | tee log',
  ]) assert.equal(bash(command).status, 2, command);
  assert.deepEqual(checkPiped('cd x && bin/check 2>&1 | tail -3'), ['bin/check']);
});

test('bin/check 導到 log、有 pipefail／PIPESTATUS、|| 或只是讀 bin/check 檔案時放行', () => {
  for (const command of [
    'bin/check > .scratch/check.log 2>&1; echo exit=$?; tail -1 .scratch/check.log',
    'set -o pipefail; bin/check 2>&1 | tail -3',
    'bin/check | tail -3; echo "${PIPESTATUS[0]}"',
    'bin/check || echo failed',
    'bin/check --upstream &> log',
    'grep -n step bin/check | head',
    'sed -n 1,20p bin/check | cat',
    'timeout 5 cat bin/check | head',
    'echo "bin/check | tail"',
  ]) assert.equal(bash(command).status, 0, command);
});

// #571：#402 worker（session 6c132d80 第 243 行）跑這條，issue-run-landing.md:16 真正命中的 `STOP local-checks-timeout` 在第 160 字元之後被切掉，判定沒有殘留。
const ISSUE_571 = 'grep -rn "local-checks\\|ci-not-started" docs/agents GLOSSARY.md docs/adr 2>/dev/null | cut -c1-160';

test('grep 文件後接 cut -c／head -c／awk substr：exit 2，改用 doc-excerpt（#571）', () => {
  const result = bash(ISSUE_571);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /#571/);
  assert.match(result.stderr, /node scripts\/doc-excerpt\.mjs '<regex>' <檔案或目錄>\.\.\./);
  assert.deepEqual(truncatedDocGrep(ISSUE_571), ['grep -rn local-checks\\|ci-not-started docs/agents GLOSSARY.md docs/adr']);
  for (const command of [
    "grep -n foo docs/agents/issue-run.md | cut -c 1-200",
    "cd x && grep -rn foo docs | sort | cut -b1-120",
    "grep -rn -e foo -e bar README.md | head -c 2000",
    "LC_ALL=C grep -rn foo . --include=*.md | cut -c1-100",
    "rg -n foo skills/x/SKILL.md | awk '{print substr($0, 1, 160)}'",
    "grep -n foo -- GLOSSARY.md | cut --characters=1-80",
  ]) assert.equal(bash(command).status, 2, command);
});

test('欄位切、head -n、grep 程式碼、沒截斷、引號裡的字放行（#571 反例）', () => {
  for (const command of [
    'grep -rn "local-checks" docs/agents GLOSSARY.md docs/adr',
    'grep -rln foo docs/agents | cut -d: -f1',
    "grep -rn foo docs/agents | cut -d':' -f1,2 | sort -u",
    'grep -rn foo docs/agents | head -n 20',
    'grep -rn foo scripts src | cut -c1-160',
    'grep -rn docs scripts | cut -c1-160',
    'grep -e README.md scripts/x.mjs | cut -c1-80',
    "grep -rn foo docs/agents; echo x | cut -c1-3",
    'echo "grep -rn foo docs | cut -c1-160"',
    "node scripts/doc-excerpt.mjs 'local-checks' docs/agents/*.md | cut -c1-300",
  ]) assert.equal(bash(command).status, 0, command);
});

// #636 兩次真實再現：#395 worker（session 88d4ebfb jsonl 第 451 行）以 -F 讀訊息檔，#560 worker（session fbf1a134）以 -F - heredoc。
// 兩次都是 pre-commit 跑完檢查子集後，commit-msg 才以 COMMIT_MSG_SECOND_LINE 擋下、提示加空行。
const COMMIT_395 = 'git commit -q -F .scratch/issue-run-395/commit-msg.txt';
const MSG_395 = '#395 Push gate 單一入口：x\n\n內文第一行\n內文第二行\n';
const COMMIT_560 = [
  "HEAVY_CHECK_TIMEOUT=0 git commit -q -F - <<'EOF'",
  '#560 Stage conflict：integration 來源的 code/other 重派前先查例外',
  '',
  '一項命中就開 gate，都沒命中才照 Fresh redispatch 重派；測試斷言',
  '',
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  'EOF',
].join('\n');

/** 建一個暫存 cwd，放 #395 的訊息檔（與改好的版本）。 */
function repo395(t) {
  const cwd = mkdtempSync(join(realTmpdir(), 'bash-pitfalls-636-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.scratch/issue-run-395'), { recursive: true });
  writeFileSync(join(cwd, '.scratch/issue-run-395/commit-msg.txt'), MSG_395);
  writeFileSync(join(cwd, '.scratch/issue-run-395/fixed.txt'), MSG_395.replace('#395 Push gate 單一入口', 'Push gate 單一入口（#395）'));
  return cwd;
}

test('git commit 主旨以 # 開頭：#395 的 -F 訊息檔與 #560 的 -F - heredoc 都在 commit 前擋下（#636）', t => {
  const cwd = repo395(t);
  const r395 = run({ tool_name: 'Bash', cwd, tool_input: { command: COMMIT_395 } });
  assert.equal(r395.status, 2, r395.stderr);
  assert.match(r395.stderr, /#636/);
  assert.match(r395.stderr, /`#395 Push gate 單一入口：x`/);
  assert.match(r395.stderr, /Push gate（#395）/);
  const r560 = bash(COMMIT_560);
  assert.equal(r560.status, 2, r560.stderr);
  assert.match(r560.stderr, /`#560 Stage conflict：/);
  assert.deepEqual(hashSubjectCommits(COMMIT_560).map(hit => hit.subject), ['#560 Stage conflict：integration 來源的 code/other 重派前先查例外']);
  for (const command of [
    "git commit -m '#395 Push gate：x'",
    'git commit -q -m "#395 Push gate：x" -m "內文"',
    "git commit -am '#395 x'",
    "git commit --message='#395 x'",
    "git -C sub -c user.name=t commit -m '#395 x'",
    `git commit -m "$(cat <<'EOF'\n#395 Push gate：x\n\n內文\nEOF\n)"`,
    "cd x && git add . && git commit -F - <<'EOF'\n\n#395 x\nEOF",
  ]) assert.equal(bash(command).status, 2, command);
  assert.equal(run({ tool_name: 'Bash', cwd, tool_input: { command: 'git -C .scratch commit -F issue-run-395/commit-msg.txt' } }).status, 2, 'git -C 下的相對路徑');
});

test('主旨不以 # 開頭、只有內文行以 # 開頭、讀不到訊息檔或不是 git commit 放行（#636 反例）', t => {
  const cwd = repo395(t);
  for (const command of [
    "git commit -m 'Push gate（#395）：x'",
    COMMIT_560.replace('#560 Stage conflict：integration 來源的 code/other 重派前先查例外', 'Stage conflict：重派前先查例外（#560）'),
    "git commit -F - <<'EOF'\nPush gate（#395）：x\n\n#395 內文行以 # 開頭\n# 這行也是\nEOF",
    "git commit -m 'Push gate（#395）：x' -m '#395 內文段落'",
    'git commit -q -F .scratch/issue-run-395/fixed.txt',
    'git commit -q -F .scratch/missing.txt',
    "git commit -C HEAD -m 'x'",
    "git log --grep '#395'",
    "echo \"git commit -m '#395 x'\"",
    "git commit -m \"$(printf '#395 x')\"",
  ]) assert.equal(run({ tool_name: 'Bash', cwd, tool_input: { command } }).status, 0, command);
});

test('非 Bash 工具、輸入不合法、沒有 command 時 exit 0 不輸出', () => {
  for (const input of [
    { tool_name: 'Edit', tool_input: { command: 'gh issue view 1 --comments' } },
    { tool_name: 'Bash', tool_input: {} },
    'not json',
  ]) {
    const result = run(input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  }
});

// #687-1：切字迴圈不前進時 hook 會卡死（git-bypass 3dae65e）；每個解析指令的 export 與整支 hook 都以 shell 形狀語料跑過，必須在逾時內結束。
test('shell 形狀語料：每個解析指令的 export 與整支 hook 都在逾時內結束', async () => {
  const dir = mkdtempSync(join(realTmpdir(), 'bash-pitfalls-shapes-'));
  try {
    assert.deepEqual(unfinishedExports(new URL('./claude-hook-bash-pitfalls.mjs', import.meta.url), {
      unquotedHeredocs: [], ghViewCommentsWithoutJson: [], checkPiped: [], truncatedDocGrep: [], hashSubjectCommits: [],
    }, { cwd: dir }), []);
    assert.deepEqual(await unfinishedHookRuns(HOOK, { cwd: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
