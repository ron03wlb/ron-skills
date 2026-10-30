import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const hook = new URL('../scripts/claude-hook-unbare.sh', import.meta.url).pathname;
// 同 pilot-unbare.test.mjs：清掉 pre-commit 匯出的 GIT_*，否則暫存 repo 的 config 會寫進本 repo。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function checkoutWithWorktree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hook-unbare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'main');
  const worktree = join(dir, 'wt');
  const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
  spawnSync('git', ['init', '-q', main], { env });
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', worktree, '-b', 'x');
  return { main, worktree, git };
}

const run = projectDir => spawnSync(hook, [], { encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: projectDir } });

// 重現 retro 2026-10-30：主 checkout 的 session 進行中 core.bare 被設成 true。
test('session 在主 checkout：core.bare 為 true 時還原', t => {
  const { main, git } = checkoutWithWorktree(t);
  git(main, 'config', 'core.bare', 'true');

  const result = run(main);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `UNBARE ${main}\n`);
  assert.equal(git(main, 'rev-parse', '--is-bare-repository').stdout.trim(), 'false');
});

// worker 在 linked worktree：自己的 --is-bare-repository 回 false，主 checkout 卻已壞。
test('session 在 linked worktree：還原的是主 checkout', t => {
  const { main, worktree, git } = checkoutWithWorktree(t);
  git(main, 'config', 'core.bare', 'true');
  assert.equal(git(worktree, 'rev-parse', '--is-bare-repository').stdout.trim(), 'false');

  const result = run(worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `UNBARE ${main}\n`);
  assert.equal(git(main, 'rev-parse', '--is-bare-repository').stdout.trim(), 'false');
});

test('不是 bare 時不輸出', t => {
  const { main } = checkoutWithWorktree(t);

  const result = run(main);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
