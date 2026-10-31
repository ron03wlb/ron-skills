import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from '../skills/engineering/setup-workflow/templates/test/real-tmpdir.mjs';

// #173 的 restamp 測試在 fixture repo 裡 commit 沒帶 user.name：本機吃使用者的全域 git 設定，兩次 Regression 都過，CI 才
// `fatal: empty ident name`（#204）。bin/check 以 GIT_CONFIG_GLOBAL（含 useConfigOnly）與 GIT_CONFIG_NOSYSTEM 跑測試，這裡確認隔離還在：
// 拿掉隔離時這個測試會紅，直接 `node --test` 跑這個檔也會紅，要經 bin/check。
test('測試環境沒有全域 git identity：fixture repo 不自帶 user.name、user.email 就 commit 失敗', t => {
  const repo = mkdtempSync(join(realTmpdir(), 'git-isolation-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  assert.equal(git('add', 'a.txt').status, 0);
  const commit = git('commit', '-qm', 'no identity');
  assert.notEqual(commit.status, 0, '測試吃到了全域 git identity：請經 bin/check 跑（它設 GIT_CONFIG_GLOBAL、GIT_CONFIG_NOSYSTEM）');
  assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'with identity').status, 0);
});
