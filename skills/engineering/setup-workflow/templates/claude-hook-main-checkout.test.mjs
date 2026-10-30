import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrackedInMainCheckout } from './claude-hook-main-checkout.mjs';

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

test('isTrackedInMainCheckout：只有主 checkout 內的追蹤檔為 true', () => {
  const { root, main, worktree } = fixture();
  assert.equal(isTrackedInMainCheckout(join(main, 'docs', 'a.md')), true);
  assert.equal(isTrackedInMainCheckout(join(main, 'docs', 'new.md')), false, '新檔');
  assert.equal(isTrackedInMainCheckout(join(main, 'new-dir', 'deep', 'x.md')), false, '目錄尚未建立的新檔');
  assert.equal(isTrackedInMainCheckout(join(main, '.scratch', 'note.md')), false, 'gitignored');
  assert.equal(isTrackedInMainCheckout(join(worktree, 'docs', 'a.md')), false, 'worktree 內追蹤檔');
  assert.equal(isTrackedInMainCheckout(join(root, 'outside.md')), false, 'repo 外');
});

test('hook：主 checkout 追蹤檔 exit 2；其他情況與輸入不合法時 exit 0 無輸出', () => {
  const { main, worktree } = fixture();
  const denied = hook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(main, 'docs', 'a.md') } }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /worktree/);
  for (const input of [
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(main, 'docs', 'new.md') } }),
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(worktree, 'docs', 'a.md') } }),
    JSON.stringify({ tool_name: 'Edit', tool_input: {} }),
    'not json',
  ]) {
    const allowed = hook(input);
    assert.equal(allowed.status, 0, input);
    assert.equal(allowed.stdout + allowed.stderr, '', input);
  }
});
