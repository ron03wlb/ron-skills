#!/usr/bin/env node
// commit 進去的檔案不能留著衝突標記：stage-58 手解衝突時斷言失敗，後面以 `;` 串接的 git commit 照樣執行，40bd917 帶著 pilot.md 的 `<<<<<<< HEAD` 進了 stage 分支（retro ron-skills-91）。
// 掃 git 追蹤的文字檔，行首是 `<<<<<<<` 或 `>>>>>>>`（後面接空白或行尾）就算；`=======` 會撞到 setext 標題底線，不看。
// 用法：node scripts/check-conflict-markers.mjs [repo]（預設本 repo）
// stdout：每個命中一行 `CONFLICT_MARKER <檔案>:<行>`，最後一行是修正提示；exit 0 沒有、1 有命中、2 git grep 失敗。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const grep = spawnSync('git', ['-C', repo, 'grep', '-nIE', '^(<<<<<<<|>>>>>>>)( |$)'], { encoding: 'utf8' });
if (grep.status === 1) process.exit(0);
if (grep.status !== 0) {
  process.stderr.write(grep.stderr);
  process.exit(2);
}

for (const line of grep.stdout.trim().split('\n')) console.log(`CONFLICT_MARKER ${line.split(':').slice(0, 2).join(':')}`);
console.log('修正：解掉這些衝突 hunk 再 commit；stage 分支可以 git switch -C 重來。');
process.exit(1);
