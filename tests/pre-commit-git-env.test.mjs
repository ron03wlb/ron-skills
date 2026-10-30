import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const hook = new URL('../.githooks/pre-commit', import.meta.url).pathname;
// 本檔自己也會在 pre-commit hook 裡跑：先清掉繼承來的 GIT_*，每個情境再明確帶入要模擬的變數。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function scratchRepo(t, prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  git('init', '-q');
  return { repo, git };
}

// 重現真實歷史：worktree 裡 commit 時 hook 帶著 GIT_DIR、GIT_INDEX_FILE 跑 bin/check，測試裡的 git init 把主 checkout 設成 bare（#20 #25）。
test('pre-commit 跑 bin/check 前清掉 hook 帶入的 repo 區域 GIT_* 變數', t => {
  const { repo } = scratchRepo(t, 'pre-commit-env-');
  mkdirSync(join(repo, '.githooks'));
  mkdirSync(join(repo, 'bin'));
  copyFileSync(hook, join(repo, '.githooks/pre-commit'));
  writeFileSync(join(repo, 'bin/check'), `#!/usr/bin/env bash\nenv | grep ^GIT_ > "${repo}/seen-env" || true\n`);
  chmodSync(join(repo, 'bin/check'), 0o755);

  const leaked = { GIT_DIR: join(repo, '.git'), GIT_INDEX_FILE: join(repo, '.git/index'), GIT_PREFIX: '' };
  const result = spawnSync(join(repo, '.githooks/pre-commit'), { cwd: repo, encoding: 'utf8', env: { ...env, ...leaked } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(repo, 'seen-env'), 'utf8'), '');
});

// 修正前，worktree 裡 commit 時 GIT_DIR 指向 .git/worktrees/<name>，sync-skills-git-dir 測試的 `git -C <暫存 repo> init` 繼承後重新 init 那個 worktree，主 checkout 的 core.bare 變 true（#20 worker 實測；GIT_DIR 指向一般 repo 時不會）。
test('worktree 的 GIT_DIR 洩漏給 sync-skills-git-dir 測試時，主 checkout 不會變成 bare', t => {
  const { repo: main, git } = scratchRepo(t, 'leaked-git-dir-');
  const worktree = `${main}-wt`;
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('worktree', 'add', '-q', worktree);
  const gitDir = spawnSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', env }).stdout.trim();
  const target = new URL('./sync-skills-git-dir.test.mjs', import.meta.url).pathname;

  // 去掉外層 node --test 帶入的 NODE_TEST_CONTEXT，否則子行程不會真的跑 target 裡的測試。
  const { NODE_TEST_CONTEXT, ...childEnv } = env;
  const result = spawnSync(process.execPath, ['--test', target], { encoding: 'utf8', env: { ...childEnv, GIT_DIR: gitDir } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('config', 'core.bare').stdout.trim(), 'false');
});
