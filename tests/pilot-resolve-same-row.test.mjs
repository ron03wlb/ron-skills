import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, write, env } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { resolveFile, KINDS } from '../scripts/pilot-resolve.mjs';

// 同一個 markdown table row 兩邊都改（PILOT-STORE.md 的 `pilot-land.mjs` 列，sync-main 實際衝突：
// ours=pilot/integration 64b3535 只在一句加括號說明，theirs=origin/main 在同一格的另一句加括號說明）。
const AT = name => readFileSync(new URL(`fixtures/pilot-resolve-same-row/${name}.md`, import.meta.url), 'utf8');

/** base 提交在 main，ours、theirs 各自改一份，在 ours 上 merge theirs 留下衝突的 index；傳回 tree。 */
function conflicted(t, base, ours, theirs) {
  const tree = mkdtempSync(join(realTmpdir(), 'resolve-row-'));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  git(tree, 'init', '-q', '-b', 'main');
  write(tree, { 'doc.md': base });
  git(tree, 'add', '.');
  git(tree, 'commit', '-qm', 'base');
  git(tree, 'switch', '-qc', 'theirs');
  write(tree, { 'doc.md': theirs });
  git(tree, 'commit', '-qam', 'theirs');
  git(tree, 'switch', '-q', 'main');
  write(tree, { 'doc.md': ours });
  git(tree, 'commit', '-qam', 'ours');
  const merge = spawnSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-commit', 'theirs'], { encoding: 'utf8', env });
  assert.equal(merge.status, 1, merge.stdout + merge.stderr);
  return tree;
}

test('同一列兩邊都改、改在同一格的不重疊處（真實 PILOT-STORE 列）：逐字合併，兩邊的修改都在，RESOLVED rows', t => {
  const kinds = new Set();
  const merged = resolveFile(conflicted(t, AT('base'), AT('ours'), AT('theirs')), 'doc.md', kinds);
  assert.ok(merged, '解得開');
  assert.deepEqual([...kinds], ['rows']);
  assert.ok(KINDS.includes('rows'));
  assert.ok(merged.includes('a pushed batch keeps its old regression line'), '保留 ours 的修改');
  assert.ok(merged.includes('a rerun of a `merged` batch prints only its `MERGED` again'), '保留 theirs 的修改');
  assert.equal(merged.trimEnd().split('\n').length, 3, '仍是一列');
});

test('同一列兩邊改同一處成不同內容：仍解不了', t => {
  const base = '| a | x one two three |\n';
  const merged = resolveFile(conflicted(t, base, '| a | x ONE two three |\n', '| a | x uno two three |\n'), 'doc.md', new Set());
  assert.equal(merged, undefined);
});

test('同一列兩邊改相鄰的字：保守不解', t => {
  const base = '| a | x one two three |\n';
  const merged = resolveFile(conflicted(t, base, '| a | x ONE two three |\n', '| a | x one TWO three |\n'), 'doc.md', new Set());
  assert.equal(merged, undefined);
});

test('同一列兩邊改不同格：各取各的，RESOLVED rows', t => {
  const base = '| a | one | two |\n';
  const merged = resolveFile(conflicted(t, base, '| a | ONE | two |\n', '| a | one | TWO |\n'), 'doc.md', new Set());
  assert.equal(merged, '| a | ONE | TWO |\n');
});
