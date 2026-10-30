import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirtiesMainCheckout } from './claude-hook-main-checkout.mjs';

const script = fileURLToPath(new URL('./claude-hook-main-checkout.mjs', import.meta.url));
const hook = input => spawnSync('node', [script], { input, encoding: 'utf8' });
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

/** 暫存 repo：主 checkout 有追蹤檔 docs/a.md 與 gitignored .scratch/，另建一個 worktree。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-hook-main-checkout-'));
  const main = join(root, 'main');
  mkdirSync(join(main, 'docs'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'docs', 'a.md'), 'a\n');
  writeFileSync(join(main, '.gitignore'), '.scratch/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  mkdirSync(join(main, '.scratch'));
  writeFileSync(join(main, '.scratch', 'note.md'), 'n\n');
  const worktree = join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'fix', worktree);
  return { root, main, worktree };
}

// 新檔也要擋：曾有互動 session 在 pilot 執行時把未追蹤的 GLOSSARY.md 寫進主 checkout，Probe 看到 git status 有改動就停止合併。
test('dirtiesMainCheckout：會出現在主 checkout git status 的路徑為 true（追蹤檔與未 gitignore 的新檔）', () => {
  const { root, main, worktree } = fixture();
  assert.equal(dirtiesMainCheckout(join(main, 'docs', 'a.md')), true, '追蹤檔');
  assert.equal(dirtiesMainCheckout(join(main, 'GLOSSARY.md')), true, '新檔');
  assert.equal(dirtiesMainCheckout(join(main, 'new-dir', 'deep', 'x.md')), true, '目錄尚未建立的新檔');
  assert.equal(dirtiesMainCheckout(join(main, '.scratch', 'note.md')), false, 'gitignored');
  assert.equal(dirtiesMainCheckout(join(main, '.scratch', 'new', 'plan.md')), false, 'gitignored 目錄下尚未建立的新檔');
  assert.equal(dirtiesMainCheckout(join(worktree, 'docs', 'a.md')), false, 'worktree 內追蹤檔');
  assert.equal(dirtiesMainCheckout(join(worktree, 'GLOSSARY.md')), false, 'worktree 內新檔');
  assert.equal(dirtiesMainCheckout(join(root, 'outside.md')), false, 'repo 外');
});

test('hook：主 checkout 追蹤檔與新檔 exit 2；其他情況與輸入不合法時 exit 0 無輸出', () => {
  const { main, worktree } = fixture();
  for (const input of [
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(main, 'docs', 'a.md') } }),
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(main, 'GLOSSARY.md') } }),
  ]) {
    const denied = hook(input);
    assert.equal(denied.status, 2, input);
    assert.match(denied.stderr, /worktree/);
  }
  for (const input of [
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(main, '.scratch', 'plan.md') } }),
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(worktree, 'docs', 'a.md') } }),
    JSON.stringify({ tool_name: 'Edit', tool_input: {} }),
    'not json',
  ]) {
    const allowed = hook(input);
    assert.equal(allowed.status, 0, input);
    assert.equal(allowed.stdout + allowed.stderr, '', input);
  }
});

// Bash 也擋：曾有 session 在主 checkout 用 sed -i 改了三支追蹤 SQL 與 README，Edit|Write hook 擋不到。
test('Bash：sed -i／perl -i／重導向／tee 寫主 checkout 追蹤檔或新檔 exit 2；worktree、gitignored、唯讀指令、heredoc 內文放行', () => {
  const { main, worktree } = fixture();
  for (const name of ['seed', 'teardown', 'check']) writeFileSync(join(main, 'docs', `${name}-flow.sql`), 'x\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'sql');
  const bash = (command, cwd = main) => hook(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }));
  // 當時的指令形狀：cd 進主 checkout、sed -i 搭 brace expansion 改三支追蹤檔
  const real = `cd ${main} && sed -i "s|^  -- dev：執行 SELECT @@hostname; 後|  UNION ALL SELECT 'dev', 'HOST01'|" docs/{seed,teardown,check}-flow.sql && git diff --stat`;
  for (const command of [
    real,
    'sed -i "183s|.*|- dev 的 hostname|" docs/a.md',
    `perl -pi -e 's/a/b/' ${join(main, 'docs', 'a.md')}`,
    'echo hi > docs/a.md',
    'printf x >>docs/a.md',
    'echo hi | tee -a docs/a.md',
    `cd /tmp && cd ${main} && sed -i.bak 's/a/b/' docs/a.md`,
    'echo hi > docs/new.md 2>/dev/null',
    'echo hi > GLOSSARY.md',
  ]) {
    const denied = bash(command, command === real ? '/tmp' : main);
    assert.equal(denied.status, 2, command);
    assert.match(denied.stderr, /主 checkout 防護/, command);
  }
  for (const [command, cwd] of [
    ['sed -i "s/a/b/" docs/a.md', worktree],
    ['echo hi > GLOSSARY.md', worktree],
    ['sed -n "1,5p" docs/a.md && grep -n x docs/*.sql', main],
    ['echo plan > .scratch/plan.md && tee .scratch/{a,b}.md < /dev/null', main],
    ["cat > /tmp/x.md <<'EOF'\nsed -i 's/a/b/' docs/a.md\necho y > docs/a.md\nEOF", main],
    ['git diff > /tmp/d.patch', main],
    ["echo 'a > docs/a.md'", main],
  ]) {
    const allowed = bash(command, cwd);
    assert.equal(allowed.status, 0, command);
    assert.equal(allowed.stdout + allowed.stderr, '', command);
  }
});
