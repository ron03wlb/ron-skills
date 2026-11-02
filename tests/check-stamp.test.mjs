import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};
// 假 bin/check：和真的一樣開始時取樹、通過時記下，另外數跑了幾次。
const FAKE_CHECK = `#!/usr/bin/env bash
set -euo pipefail
tree=$(node scripts/check-stamp.mjs tree)
echo run >> "$CHECK_LOG"
if [[ -f fail ]]; then exit 1; fi
node scripts/check-stamp.mjs record "$tree"
`;

function fixture(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'check-stamp-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const log = join(repo, '.git-check.log');
  const childEnv = { ...env, CHECK_LOG: log };
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: childEnv });
  git('init', '-q');
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'bin'));
  mkdirSync(join(repo, '.githooks'));
  cpSync(join(root, 'scripts/check-stamp.mjs'), join(repo, 'scripts/check-stamp.mjs'));
  cpSync(join(root, '.githooks/pre-commit'), join(repo, '.githooks/pre-commit'));
  writeFileSync(join(repo, 'bin/check'), FAKE_CHECK);
  chmodSync(join(repo, 'bin/check'), 0o755);
  writeFileSync(join(repo, '.gitignore'), '.git-check.log\n');
  writeFileSync(join(repo, 'a.txt'), 'a0\n');
  writeFileSync(join(repo, 'b.txt'), 'b0\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('config', 'core.hooksPath', '.githooks');
  writeFileSync(log, '');
  const runs = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  const check = () => spawnSync('bin/check', { cwd: repo, encoding: 'utf8', env: childEnv });
  const write = (name, text) => writeFileSync(join(repo, name), text);
  return { git, runs, check, write };
}

test('bin/check 通過後 commit 同一棵樹：pre-commit 不再跑，commit 成功', t => {
  const { git, runs, check, write } = fixture(t);
  write('a.txt', 'a1\n');
  assert.equal(check().status, 0);
  assert.equal(git('add', 'a.txt').status, 0);
  const commit = git('commit', '-qm', 'x');
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(runs(), 1);
});

test('通過之後又改檔、或只暫存一部分：pre-commit 照跑', t => {
  const { git, runs, check, write } = fixture(t);
  write('a.txt', 'a1\n');
  check();
  write('a.txt', 'a2\n');
  git('add', 'a.txt');
  assert.equal(git('commit', '-qm', 'changed after check').status, 0);
  assert.equal(runs(), 2);

  write('a.txt', 'a3\n');
  write('b.txt', 'b3\n');
  check();
  git('add', 'a.txt');
  assert.equal(git('commit', '-qm', 'partial').status, 0);
  assert.equal(runs(), 4, '要 commit 的樹和通過的不同');
});

test('沒有通過的記錄：pre-commit 照跑，失敗就擋下 commit', t => {
  const { git, runs, write } = fixture(t);
  write('a.txt', 'a1\n');
  write('fail', '');
  git('add', '.');
  assert.notEqual(git('commit', '-qm', 'x').status, 0);
  assert.equal(runs(), 1);
});

test('失敗不留記錄；用法錯誤 exit 2', t => {
  const { git, check, runs, write } = fixture(t);
  write('fail', '');
  assert.notEqual(check().status, 0);
  git('add', '.');
  assert.notEqual(git('commit', '-qm', 'x').status, 0);
  assert.equal(runs(), 2);
  assert.equal(spawnSync('node', [join(root, 'scripts/check-stamp.mjs'), 'nope'], { env }).status, 2);
});
