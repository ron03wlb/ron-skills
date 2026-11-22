// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHits, findTemplateCopies, parseArgs, parseWorktrees } from './concurrent-edits.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./concurrent-edits.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const commit = (cwd, file, message) => { writeFileSync(join(cwd, file), message); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', message); };

test('parseArgs：至少一個檔案；--base 取值；--json 旗標；未知旗標回傳 null', () => {
  assert.deepEqual(parseArgs(['a.md', 'b.mjs']), { base: null, json: false, files: ['a.md', 'b.mjs'] });
  assert.deepEqual(parseArgs(['--json', '--base', 'abc', 'a.md']), { base: 'abc', json: true, files: ['a.md'] });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['--base']), null);
  assert.equal(parseArgs(['--force', 'a.md']), null);
});

test('parseWorktrees：第一筆是主 worktree；detached 的 branch 為 null', () => {
  assert.deepEqual(parseWorktrees('worktree /m\nHEAD aaa\nbranch refs/heads/integration\n\nworktree /w\nHEAD bbb\ndetached\n'),
    [{ path: '/m', branch: 'integration' }, { path: '/w', branch: null }]);
});

test('findHits：略過自己的 worktree；他人已提交、未提交與整合分支 commit 各成一筆，只算指定檔案', () => {
  const hits = findHits({
    files: ['a.md', 'b.mjs'], self: '/self', integration: 'integration',
    worktrees: [
      { path: '/self', branch: 'me', committed: ['a.md'], uncommitted: ['b.mjs'] },
      { path: '/other', branch: 'other', committed: ['a.md', 'c.txt'], uncommitted: ['b.mjs'] },
    ],
    integrationCommits: [{ sha: '0123456789abcdef', subject: 'chore: x', files: ['b.mjs', 'z.txt'] }],
  });
  assert.deepEqual(hits.map(hit => [hit.kind, hit.file]), [['COMMITTED', 'a.md'], ['UNCOMMITTED', 'b.mjs'], ['INTEGRATION', 'b.mjs']]);
  assert.equal(hits[2].detail, '012345678 chore: x');
});

/** 主 worktree 在 integration；other 分支改了 a.md（已提交）與 b.mjs（未提交）；整合分支在 base 之後又動了 c.txt。 */
const fixture = t => {
  const root = mkdtempSync(join(realTmpdir(), 'concurrent-edits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  git(root, 'init', '-q', '-b', 'integration', main);
  for (const file of ['a.md', 'b.mjs', 'c.txt']) commit(main, file, `base ${file}`);
  const base = git(main, 'rev-parse', 'HEAD');
  const mine = join(root, 'mine'); git(main, 'worktree', 'add', '-q', '-b', 'mine', mine, 'integration');
  const other = join(root, 'other'); git(main, 'worktree', 'add', '-q', '-b', 'other', other, 'integration');
  commit(other, 'a.md', 'other a');
  writeFileSync(join(other, 'b.mjs'), 'dirty');
  commit(main, 'c.txt', 'integration c');
  return { root, main, mine, base };
};
const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('CLI：從自己的 worktree 查，列出他人分支已提交、他人工作目錄未提交與整合分支 base 之後的 commit；exit 3', t => {
  const { mine } = fixture(t);
  const result = run(mine, 'a.md', 'b.mjs', 'c.txt');
  assert.equal(result.status, 3, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3, result.stdout);
  assert.match(lines[0], /^COMMITTED .*\/other a\.md other 已提交、未合入 integration$/);
  assert.match(lines[1], /^UNCOMMITTED .*\/other b\.mjs 工作目錄有未提交變更$/);
  assert.match(lines[2], /^INTEGRATION integration c\.txt [0-9a-f]{9} integration c$/);
});

test('CLI：沒有命中印 CLEAR 並 exit 0；--json 輸出 hits 陣列；路徑相對於 cwd 解析', t => {
  const { mine } = fixture(t);
  const clear = run(mine, 'z.txt');
  assert.equal(clear.status, 0, clear.stderr);
  assert.equal(clear.stdout.trim(), 'CLEAR');
  const json = JSON.parse(run(mine, '--json', './a.md').stdout);
  assert.equal(json.integration, 'integration');
  assert.deepEqual(json.hits.map(hit => hit.kind), ['COMMITTED']);
});

test('CLI：沒有檔案參數 exit 2', t => {
  const { mine } = fixture(t);
  assert.equal(run(mine).status, 2);
});

test('findTemplateCopies：只取清單 copies 有 template 的檔，依輸入順序；沒有清單時為空', () => {
  const copies = { 'scripts/b.mjs': { template: 'skills/engineering/setup-workflow/templates/b.mjs' }, 'scripts/a.mjs': { template: 'skills/engineering/setup-workflow/templates/a.mjs' } };
  assert.deepEqual(findTemplateCopies(['scripts/a.mjs', 'x.md', 'scripts/b.mjs'], copies).map(copy => copy.file), ['scripts/a.mjs', 'scripts/b.mjs']);
  assert.deepEqual(findTemplateCopies(['scripts/a.mjs'], undefined), []);
});

// retro spay2 ddc8bd0e#1：舊版對 workflow-templates.json 列出的副本 scripts/claude-hook-language.mjs 只印 CLEAR，
// 之後只改正本就 commit，ron-skills pre-commit 才報 CHECK_FAIL docs-rules。
test('CLI：檔案是 workflow-templates.json 列出的副本時，在 CLEAR／命中之前印 TEMPLATE_COPY 與下一步，不改 exit code；沒有清單不印', t => {
  const { mine } = fixture(t);
  const template = 'skills/engineering/setup-workflow/templates/claude-hook-language.mjs';
  assert.doesNotMatch(run(mine, 'scripts/claude-hook-language.mjs').stdout, /TEMPLATE_COPY/);
  mkdirSync(join(mine, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(mine, 'docs', 'agents', 'workflow-templates.json'), JSON.stringify({ copies: { 'scripts/claude-hook-language.mjs': { template } } }));
  const result = run(mine, 'scripts/claude-hook-language.mjs', 'z.txt');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines[0], `TEMPLATE_COPY scripts/claude-hook-language.mjs ${template}`);
  assert.match(lines[1], /^  下一步：改 ron-skills 正本 → .*copy-templates\.mjs <ron-skills> --no-tests --yes --staged claude-hook-language\.mjs → ron-skills commit 並 push → .*copy-templates\.mjs <本 worktree> --no-tests --yes claude-hook-language\.mjs$/);
  assert.equal(lines[2], 'CLEAR');
  assert.equal(lines.length, 3, result.stdout);
  assert.deepEqual(JSON.parse(run(mine, '--json', 'scripts/claude-hook-language.mjs').stdout).templateCopies, [{ file: 'scripts/claude-hook-language.mjs', template }]);
});
