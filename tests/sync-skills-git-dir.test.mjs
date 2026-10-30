import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sync = new URL('../bin/sync-skills', import.meta.url).pathname;

// 重現真實歷史：pre-commit hook 匯出 GIT_DIR，sync-skills 的 `git -C <上游 checkout>` 繼承後讀到的是本 repo（#9 #11 worker 回報）。
test('hook 匯出的 GIT_DIR 不影響上游 checkout 的 branch 與 HEAD 檢查', t => {
  const repo = mkdtempSync(join(tmpdir(), 'sync-git-dir-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'hook-leak');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const head = git('rev-parse', 'HEAD').stdout.trim();

  const result = spawnSync(sync, ['--check'], { encoding: 'utf8', env: { ...process.env, GIT_DIR: join(repo, '.git') } });
  assert.doesNotMatch(result.stderr, /hook-leak/, result.stderr);
  assert.doesNotMatch(result.stderr, new RegExp(head.slice(0, 12)), result.stderr);
});
