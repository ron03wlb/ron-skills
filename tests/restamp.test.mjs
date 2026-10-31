import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { STAMP_FILES, restamp } from '../scripts/restamp.mjs';

const SYNC = new URL('../scripts/check-workflow-sync.mjs', import.meta.url).pathname;
const SYNC_SOURCES = Object.keys(JSON.parse(readFileSync(new URL('../scripts/workflow-doc-sync.json', import.meta.url), 'utf8')).sources);
const STAMPS = 'scripts/workflow-doc-sync.json';
const MANIFEST = 'docs/agents/workflow-templates.json';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const entry = (name, commit, content) => ({ template: `skills/engineering/setup-workflow/templates/${name}`, commit, sha256: sha256(content) });
const C0 = Array.from({ length: 10 }, (_, i) => `c${i}\n`).join('');
const C_FEATURE = C0.replace('c0\n', 'cf\n');
const C_MAIN = C0.replace('c9\n', 'cm\n');
const C_MERGED = C0.replace('c0\n', 'cf\n').replace('c9\n', 'cm\n');
const manifest = copies => `${JSON.stringify({ source: 'ron03wlb/ron-skills', copies }, null, 2)}\n`;

/**
 * 真的 git 合併：base 有 check-workflow-sync 的來源、戳記與 workflow-templates.json；feature 與 main 各改一個來源並 restamp，
 * 都改了 c.mjs 副本的不同行（副本合得起來、清單同一條目的 sha256 衝突），另外各自新增一個副本，兩個戳記檔都衝突（retro 1031b、PR #168 的形狀）。
 * 回傳停在合併中途的 tree 與衝突檔。
 */
function conflict(t) {
  const tree = mkdtempSync(join(realTmpdir(), 'restamp-'));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const stampNow = () => {
    const result = spawnSync('node', [join(tree, 'scripts/check-workflow-sync.mjs'), '--restamp'], { cwd: tree, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(tree, 'init', '-q', '-b', 'main');
  write(tree, {
    ...Object.fromEntries(SYNC_SOURCES.map(path => [path, `# ${path}\n`])),
    'scripts/a.mjs': 'a0\n',
    'scripts/c.mjs': C0,
    [MANIFEST]: manifest({ 'scripts/a.mjs': entry('a.mjs', 'base', 'a0\n'), 'scripts/c.mjs': entry('c.mjs', 'base', C0) }),
  });
  mkdirSync(join(tree, 'scripts'), { recursive: true });
  cpSync(SYNC, join(tree, 'scripts/check-workflow-sync.mjs'));
  stampNow();
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'base');

  git(tree, 'switch', '-q', '-c', 'feature');
  write(tree, {
    [SYNC_SOURCES[0]]: '# feature\n',
    'scripts/a.mjs': 'a1\n',
    'scripts/b1.mjs': 'b1\n',
    'scripts/c.mjs': C_FEATURE,
    [MANIFEST]: manifest({ 'scripts/a.mjs': entry('a.mjs', 'feature', 'a1\n'), 'scripts/b1.mjs': entry('b1.mjs', 'feature', 'b1\n'), 'scripts/c.mjs': entry('c.mjs', 'feature', C_FEATURE) }),
  });
  stampNow();
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'feature');

  git(tree, 'switch', '-q', 'main');
  write(tree, {
    [SYNC_SOURCES[1]]: '# main\n',
    'scripts/b2.mjs': 'b2\n',
    'scripts/c.mjs': C_MAIN,
    [MANIFEST]: manifest({ 'scripts/a.mjs': entry('a.mjs', 'base', 'a0\n'), 'scripts/b2.mjs': entry('b2.mjs', 'main', 'b2\n'), 'scripts/c.mjs': entry('c.mjs', 'main', C_MAIN) }),
  });
  stampNow();
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'main');

  git(tree, 'switch', '-q', 'feature');
  // 合併會衝突、exit 非 0，不能用 git()；identity 照 git() 帶，沒有全域 identity 的 CI 也合得出衝突（#197）。
  const merge = spawnSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'main'], { encoding: 'utf8', env });
  assert.notEqual(merge.status, 0, '要有衝突');
  const conflicted = git(tree, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  assert.deepEqual(conflicted, [MANIFEST, STAMPS]);
  return { tree, conflicted };
}

test('STAMP_FILES 是 workflow-doc-sync.json 與 workflow-templates.json', () => {
  assert.deepEqual([...STAMP_FILES].sort(), [MANIFEST, STAMPS]);
});

test('兩個戳記檔都衝突：restamp 解完並 add，戳記與合併後的來源一致，清單保留兩邊的條目', t => {
  const { tree, conflicted } = conflict(t);

  assert.equal(restamp(tree, conflicted), true);
  assert.equal(git(tree, 'diff', '--name-only', '--diff-filter=U'), '');
  git(tree, 'commit', '-q', '--no-edit');
  assert.equal(git(tree, 'status', '--porcelain'), '');
  const check = spawnSync('node', [join(tree, 'scripts/check-workflow-sync.mjs')], { cwd: tree, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout);
  // 每個條目取 sha256 等於合併後副本的那一邊；兩邊各自新增的 b1.mjs 與 b2.mjs 都在，依路徑排序（同 copy-templates）。
  assert.deepEqual(JSON.parse(readFileSync(join(tree, MANIFEST), 'utf8')).copies, {
    'scripts/a.mjs': entry('a.mjs', 'feature', 'a1\n'),
    'scripts/b1.mjs': entry('b1.mjs', 'feature', 'b1\n'),
    'scripts/b2.mjs': entry('b2.mjs', 'main', 'b2\n'),
    // 兩邊的 sha256 都不等於合併後的副本：依檔案重算；正本不在這個 repo 的歷史裡，commit 沿用目標分支（--theirs）那邊的。
    'scripts/c.mjs': entry('c.mjs', 'main', C_MERGED),
  });
});

test('只有 workflow-doc-sync.json 衝突時不動清單', t => {
  const { tree } = conflict(t);
  git(tree, 'checkout', '--ours', '--', MANIFEST);
  git(tree, 'add', MANIFEST);
  const before = readFileSync(join(tree, MANIFEST), 'utf8');

  assert.equal(restamp(tree, [STAMPS]), true);
  assert.equal(readFileSync(join(tree, MANIFEST), 'utf8'), before);
  assert.equal(git(tree, 'diff', '--name-only', '--diff-filter=U'), '');
});
