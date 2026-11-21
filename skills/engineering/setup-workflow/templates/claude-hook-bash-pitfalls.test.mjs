import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ghViewCommentsWithoutJson, unquotedHeredocs } from './claude-hook-bash-pitfalls.mjs';

const HOOK = fileURLToPath(new URL('./claude-hook-bash-pitfalls.mjs', import.meta.url));
const run = input => spawnSync('node', [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
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
