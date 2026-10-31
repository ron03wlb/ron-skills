import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./check-conflict-markers.mjs', import.meta.url).pathname;

// 暫存 git repo，把 files 加進 index 後跑檢查。
function fixture(t, files) {
  const dir = mkdtempSync(join(realTmpdir(), 'conflict-markers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', dir]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  spawnSync('git', ['-C', dir, 'add', '.']);
  return spawnSync('node', [script, dir], { encoding: 'utf8' });
}

const mark = (char, label) => `${char.repeat(7)}${label ? ` ${label}` : ''}`;

test('40bd917 的情況：pilot.md 留著 HEAD 與分支的衝突標記，exit 1 並印出行號', t => {
  const pilot = ['# Pilot：ron-skills', '', mark('<', 'HEAD'), '本 repo 的 pilot 腳本有 A', '=======', '本 repo 的 pilot 腳本有 B', mark('>', 'issue/58-probe-dispatch-canonical'), ''].join('\n');
  const result = fixture(t, { 'pilot.md': pilot });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^CONFLICT_MARKER pilot\.md:3$/m);
  assert.match(result.stdout, /^CONFLICT_MARKER pilot\.md:7$/m);
});

test('只有 setext 標題底線的 ======= 與行中的箭頭：exit 0', t => {
  const result = fixture(t, { 'doc.md': '標題\n=======\n\n比較 a >>>>>>> b 不在行首\n' });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, '');
});

test('git grep 本身失敗（不是 git repo）：exit 2', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'conflict-markers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync('node', [script, dir], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});
