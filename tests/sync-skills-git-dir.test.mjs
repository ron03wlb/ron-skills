import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const sync = new URL('../bin/sync-skills', import.meta.url).pathname;
// pre-commit hook 會匯出 GIT_DIR；不清掉的話在 worktree 裡 commit 時，`git -C <暫存 repo> init` 會重新 init 那個 worktree，把主 checkout 設成 bare（#25）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// 重現真實歷史：pre-commit hook 匯出 GIT_DIR，sync-skills 的 `git -C <上游 checkout>` 繼承後讀到的是本 repo（#9 #11 worker 回報）。
test('hook 匯出的 GIT_DIR 不影響上游 checkout 的 branch 與 HEAD 檢查', t => {
  const repo = mkdtempSync(join(realTmpdir(), 'sync-git-dir-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'hook-leak');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const head = git('rev-parse', 'HEAD').stdout.trim();

  const result = spawnSync(sync, ['--check'], { encoding: 'utf8', env: { ...env, GIT_DIR: join(repo, '.git') } });
  assert.doesNotMatch(result.stderr, /hook-leak/, result.stderr);
  assert.doesNotMatch(result.stderr, new RegExp(head.slice(0, 12)), result.stderr);
});
