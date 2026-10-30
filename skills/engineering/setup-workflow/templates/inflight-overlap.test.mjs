import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { source, run, git, repoFixture } from './test/repo-fixture.mjs';

const script = join(source, 'inflight-overlap.mjs');
const put = (dir, file, content) => { mkdirSync(join(dir, dirname(file)), { recursive: true }); writeFileSync(join(dir, file), content); };

// 主 checkout 在 main；每個分支各自一個 worktree，依 files 寫入並 commit。
function fixture(t) {
  const f = repoFixture(t);
  const branch = (name, files) => {
    const wt = join(f.temp, `wt-${name}`);
    git(f.repo, 'worktree', 'add', '-q', '-b', name, wt, 'main');
    for (const [file, content] of Object.entries(files)) put(wt, file, content);
    git(wt, 'add', '-A'); git(wt, 'commit', '-qm', name);
    return wt;
  };
  return { ...f, branch };
}
const overlap = (cwd, ...args) => run(cwd, ['node', script, ...args]);

test('shared：雙方都改的產品／ADR 檔案（含未提交變更）列出；生成頁面不列；無重疊為 NONE', t => {
  const f = fixture(t);
  const card = f.branch('issue-1', { 'src/A.java': 'a1', 'docs/pages/x.html': 'c' });
  put(card, 'docs/adr/x.md', 'dirty');
  f.branch('retro-r', { 'src/A.java': 'a2', 'docs/pages/x.html': 'r', 'docs/adr/x.md': 'r' });
  const result = overlap(f.repo, 'retro-r', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').sort(),
    ['INFLIGHT_OVERLAP', 'issue-1 shared docs/adr/x.md', 'issue-1 shared src/A.java'].sort());
  f.branch('retro-q', { 'scripts/y.mjs': 'y' });
  assert.equal(overlap(f.repo, 'retro-q', 'main').stdout.trim(), 'NONE');
});

test('缺參數：exit 2', t => {
  const f = fixture(t);
  assert.equal(overlap(f.repo, 'only-one').status, 2);
});

test('worktree 的分支已刪除：stderr 印 SKIP gone <branch> 並略過，其餘照常比對', t => {
  const f = fixture(t);
  f.branch('tool-fix-1', { 'src/A.java': 'g' });
  git(f.repo, 'update-ref', '-d', 'refs/heads/tool-fix-1');
  f.branch('issue-2', { 'src/A.java': 'b' });
  f.branch('retro-s', { 'src/A.java': 's' });
  const result = overlap(f.repo, 'retro-s', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'INFLIGHT_OVERLAP\nissue-2 shared src/A.java');
  assert.match(result.stderr, /^SKIP gone tool-fix-1$/m);
});

test('--watched <regex>：只比對符合的路徑，取代預設的 src／sql／docs/adr', t => {
  const f = fixture(t);
  f.branch('issue-3', { 'app/B.kt': 'a', 'src/A.java': 'a' });
  f.branch('retro-t', { 'app/B.kt': 'b', 'src/A.java': 'b' });
  assert.equal(overlap(f.repo, 'retro-t', 'main', '--watched', '^app/').stdout.trim(), 'INFLIGHT_OVERLAP\nissue-3 shared app/B.kt');
  assert.equal(overlap(f.repo, 'retro-t', 'main', '--watched').status, 2);
  assert.equal(overlap(f.repo, 'retro-t', 'main', '--watched', '(').status, 2);
});
