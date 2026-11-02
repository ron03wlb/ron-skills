#!/usr/bin/env node
// bin/check 通過的那棵樹記在本 worktree 的 git 目錄（`git rev-parse --git-path check-pass`），pre-commit 遇到同一棵樹就不再跑一次（#297：一張單完整檢查跑七次，第一個 commit 的 hook 跑的樹和剛通過的 bin/check 相同）。
// 只有 pre-commit 讀它：bin/check、acceptance、land 與 CI 永遠真的跑。
// 用法：node scripts/check-stamp.mjs tree            印工作樹（含未暫存與沒被 ignore 的新檔）的 tree hash，不動真正的 index
//       node scripts/check-stamp.mjs record <tree>   工作樹還是 <tree> 時記下（檢查途中有人改檔就不記）
//       node scripts/check-stamp.mjs fresh <tree>    <tree>（要 commit 的 index）、工作樹、記錄三者相同時 exit 0，否則 exit 1
// exit：2 用法錯誤。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// hook 帶入的 GIT_DIR、GIT_INDEX_FILE 不算：這裡只看目前目錄的 repo。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(args, extraEnv = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', env: { ...env, ...extraEnv } });
  if (result.status !== 0) throw new Error(`git ${args[0]} exit ${result.status}：${result.stderr.trim()}`);
  return result.stdout.trim();
}

const gitPath = name => resolve(git(['rev-parse', '--git-path', name]));

function workTree() {
  const temp = mkdtempSync(join(tmpdir(), 'check-stamp-'));
  try {
    // 從空 index 開始，每個檔都重新 hash。不複製真正的 index：複製後它的 mtime 變新，git 的 racy 判定失效，
    // 同一秒內改過、大小相同的檔會被當成沒變，算出舊內容（24 個並行裡 19 個算錯）。
    const index = join(temp, 'index');
    git(['add', '-A'], { GIT_INDEX_FILE: index });
    return git(['write-tree'], { GIT_INDEX_FILE: index });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const [command, tree] = process.argv.slice(2);
if (command === 'tree' && !tree) console.log(workTree());
else if (command === 'record' && tree) {
  if (workTree() === tree) writeFileSync(gitPath('check-pass'), `${tree}\n`);
} else if (command === 'fresh' && tree) {
  const stamp = gitPath('check-pass');
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== tree || workTree() !== tree) process.exit(1);
} else {
  console.error('用法：node scripts/check-stamp.mjs tree｜record <tree>｜fresh <tree>');
  process.exit(2);
}
