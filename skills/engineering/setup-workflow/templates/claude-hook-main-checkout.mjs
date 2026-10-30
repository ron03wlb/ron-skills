#!/usr/bin/env node
// Claude Code PreToolUse hook（Edit|Write）：退回對主 checkout 內 git 追蹤檔的修改，要求改在 worktree 進行。
// 主 checkout 的未提交追蹤檔會擋住每一次 integration 合併；事後才偵測曾兩度卡住合併，所以改在修改當下擋。
// 主 checkout 判定：目標所在 repo 的 git-dir 等於 git-common-dir（worktree 兩者不同）；新檔、未追蹤／gitignored 檔、repo 外檔案放行。
// 輸入不合法、git 失敗等任何無法判定的情況 exit 0 不輸出（fail-open），避免卡住正常工作；Bash 寫檔不在此 hook 範圍。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** 目標路徑最近的既有目錄（Write 新檔時目錄可能尚未建立）。 */
function existingDir(path) {
  let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/**
 * 目標檔是否為主 checkout 內的 git 追蹤檔。
 * @param {string} filePath 絕對路徑
 * @returns {boolean} 無法判定時為 false
 */
export function isTrackedInMainCheckout(filePath) {
  const dir = existingDir(resolve(filePath));
  const dirs = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  if (dirs.status !== 0) return false;
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  if (!gitDir || gitDir !== commonDir) return false;
  return git(dir, 'ls-files', '--error-unmatch', '--', resolve(filePath)).status === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) process.exit(0);
  if (isTrackedInMainCheckout(filePath)) {
    process.stderr.write(`主 checkout 防護：${filePath} 是主 checkout 內的 git 追蹤檔，未提交的修改會擋住 integration 合併。`
      + '請改在該任務的 worktree 修改後合併（沒有 worktree 時用 `node scripts/orca-worktree-create.mjs --name <name> --base-branch <integration>` 開一個）；確需在主 checkout 修改時交由使用者手動處理。\n');
    process.exit(2);
  }
}
