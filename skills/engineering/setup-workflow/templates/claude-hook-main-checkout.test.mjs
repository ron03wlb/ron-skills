import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirtiesMainCheckout } from './claude-hook-main-checkout.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = fileURLToPath(new URL('./claude-hook-main-checkout.mjs', import.meta.url));
// 預設不帶 CLAUDE_PROJECT_DIR：測試本身可能跑在 Claude Code 底下，繼承到的值指向真正的 repo，不是 fixture。
const hook = (input, projectDir, extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv };
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
  return spawnSync('node', [script], { input, encoding: 'utf8', env });
};
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

/** 暫存 repo：主 checkout 有追蹤檔 docs/a.md 與 gitignored .scratch/，另建一個 worktree。 */
function fixture() {
  const root = mkdtempSync(join(realTmpdir(), 'claude-hook-main-checkout-'));
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

// Bash 也擋：曾有 session 在主 checkout 用 sed -i 改了三支追蹤檔，Edit|Write hook 擋不到。
test('Bash：sed -i／perl -i／重導向／tee 寫主 checkout 追蹤檔或新檔 exit 2；worktree、gitignored、唯讀指令、heredoc 內文放行', () => {
  const { main, worktree } = fixture();
  for (const name of ['seed', 'teardown', 'check']) writeFileSync(join(main, 'docs', `${name}-flow.sql`), 'x\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'sql');
  const bash = (command, cwd = main) => hook(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }));
  // 當時的指令形狀：cd 進主 checkout、sed -i 搭 brace expansion 改三支追蹤檔
  const real = `cd ${main} && sed -i "s|^  -- host；待補|  UNION ALL SELECT 'a', 'b'|" docs/{seed,teardown,check}-flow.sql && git diff --stat`;
  for (const command of [
    real,
    'sed -i "183s|.*|- x|" docs/a.md',
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
    ["echo don't > docs/a.md", main], // 引號沒閉合：解析失敗一律放行（fail-open）
  ]) {
    const allowed = bash(command, cwd);
    assert.equal(allowed.status, 0, command);
    assert.equal(allowed.stdout + allowed.stderr, '', command);
  }
});

// 真實發生過的錯（retro 2026-10-30）：在主 checkout `git switch -c` 開分支後，另一個 session 也在主 checkout 開分支，commit 落到對方分支。
test('Bash：主 checkout 切換或新開分支 exit 2；切回預設分支、還原檔案、worktree 內切分支放行', () => {
  const { main, worktree } = fixture();
  git(main, 'branch', 'other');
  const bash = (command, cwd = main) => hook(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }));
  const real = 'git switch -c daily-summary/day-sessions && git add README.md && git commit -q -m x';
  for (const command of [
    real,
    'git checkout -b retro/x',
    'git switch other',
    'git checkout other',
    `git -C ${main} switch --detach HEAD`,
    `cd /tmp && cd ${main} && git switch -C x`,
    'R=$(git rev-parse --show-toplevel); git -C "$R" switch -c x', // -C 解析不了時照原本的目錄判斷
  ]) {
    const denied = bash(command, command.startsWith('cd /tmp') ? '/tmp' : main);
    assert.equal(denied.status, 2, command);
    assert.match(denied.stderr, /主 checkout 防護/, command);
  }
  for (const [command, cwd] of [
    ['git switch main', main],
    ['git checkout main', main],
    ['git checkout -- docs/a.md', main],
    ['git switch -c y', worktree],
    [`git -C ${worktree} checkout -b z`, main],
    ['git status && git log -1', main],
  ]) {
    const allowed = bash(command, cwd);
    assert.equal(allowed.status, 0, command);
    assert.equal(allowed.stdout + allowed.stderr, '', command);
  }
});

// 真實發生過的錯（#71）：沒展開的 `$變數` 被接在 cwd 底下，當成主 checkout 內未 gitignore 的路徑擋下。
test('Bash：無法解析的 $變數 不當成主 checkout 路徑；同一條指令裡賦值的變數先代換再判斷', () => {
  const { root, main } = fixture();
  const bash = command => hook(JSON.stringify({ tool_name: 'Bash', cwd: main, tool_input: { command } }), undefined, { HOME: root });
  for (const command of [
    'f=docs/a.md; sed -i "s/a/b/" $f',
    `D=${main}/docs; echo hi > "$D/new.md"`,
    `D=${main}; mkdir -p $D && cd $D\ncat > GLOSSARY.md <<'X'\nx\nX`,
    'export F=docs/a.md && echo hi >> ${F}',
    "echo hi > '$f'.md", // 單引號裡的 $ 是字面
    'declare F=docs/a.md; sed -i "s/a/b/" $F',
    'cd docs && echo hi > $PWD/new.md', // $PWD 是指令當下的目錄，不是 hook 行程的
    'D=$PWD; echo hi > $D/new.md',
    'echo hi > "$(pwd)/new.md"',
    // cd 到解析不了的目錄時，後面的相對路徑仍依原本的目錄判斷：在主 checkout 常見這種寫法
    'cd "$(git rev-parse --show-toplevel)" && sed -i "s/a/b/" docs/a.md',
    'cd $D && echo hi > GLOSSARY.md',
  ]) {
    const denied = bash(command);
    assert.equal(denied.status, 2, command);
    assert.match(denied.stderr, /主 checkout 防護/, command);
  }
  for (const command of [
    'sed -i "s/a/b/" $f',
    `cat > "$SP/79.md" <<'EOF'\nbody\nEOF`,
    'echo hi > ${OUT:-docs/a.md}',
    'echo hi > "$(mktemp)"',
    'D=~/scratch; echo hi > $D/x.md && echo hi > ~/y.md', // ~ 是 HOME（測試裡指到 repo 外）
    // retro 2026-10-31 的指令形狀：變數賦值成 repo 外的絕對路徑後 cd 進去寫檔
    `D=${join(root, 'scratchpad', 'issues')}; mkdir -p $D && cd $D\ncat > parent.md <<'X'\nx\nX`,
    'f=.scratch/x.md; echo hi > $f',
  ]) {
    const allowed = bash(command);
    assert.equal(allowed.status, 0, command);
    assert.equal(allowed.stdout + allowed.stderr, '', command);
  }
});

// 真實發生過的錯（retro 2026-10-30）：在 ron-skills session 用 Edit 改 ~/.claude/settings.json 被擋；~/.claude 本身是 git repo，settings.json 是追蹤檔。
test('hook：目標檔所在 repo 不是 CLAUDE_PROJECT_DIR 的 repo 時放行；本專案主 checkout 照擋（從 worktree 開的 session 也擋）', () => {
  const { root, main, worktree } = fixture();
  const other = join(root, 'dot-claude');
  mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  writeFileSync(join(other, 'settings.json'), '{}\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'init');
  const edit = (filePath, projectDir) => hook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }), projectDir);
  const bash = (command, projectDir) => hook(JSON.stringify({ tool_name: 'Bash', cwd: main, tool_input: { command } }), projectDir);
  for (const [result, label] of [
    [edit(join(other, 'settings.json'), main), 'Edit 另一個 repo 的追蹤檔'],
    [edit(join(other, 'new.md'), main), 'Write 另一個 repo 的新檔'],
    [bash(`sed -i "s/a/b/" ${join(other, 'settings.json')}`, main), 'Bash 改另一個 repo 的追蹤檔'],
  ]) {
    assert.equal(result.status, 0, label);
    assert.equal(result.stdout + result.stderr, '', label);
  }
  for (const [result, label] of [
    [edit(join(main, 'docs', 'a.md'), main), 'Edit 本專案主 checkout'],
    [edit(join(main, 'docs', 'a.md'), worktree), 'session 開在 worktree 時 Edit 主 checkout'],
    [bash('echo hi > GLOSSARY.md', main), 'Bash 寫本專案主 checkout 新檔'],
    [edit(join(other, 'settings.json')), '沒有 CLAUDE_PROJECT_DIR 時照舊：任何主 checkout 都擋'],
    [edit(join(main, 'docs', 'a.md'), join(root, 'missing')), 'CLAUDE_PROJECT_DIR 無法判定時照舊'],
  ]) {
    assert.equal(result.status, 2, label);
    assert.match(result.stderr, /主 checkout 防護/, label);
  }
});
