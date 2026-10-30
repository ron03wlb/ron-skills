#!/usr/bin/env node
// Claude Code PreToolUse hook（Edit|Write）：退回會讓主 checkout 的 git status 不乾淨的修改，要求改在 worktree 進行。
// 主 checkout 的未提交改動會擋住每一次 integration 合併；事後才偵測曾兩度卡住合併，所以改在修改當下擋。
// 新檔也擋：曾有互動 session 在 pilot 執行時把未追蹤的 GLOSSARY.md 寫進主 checkout，Probe 看到改動就停止合併。
// 主 checkout 判定：目標所在 repo 的 git-dir 等於 git-common-dir（worktree 兩者不同）；gitignored 檔（如 .scratch/）與 repo 外檔案放行。
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
 * 寫入目標檔是否會讓主 checkout 的 git status 不乾淨：主 checkout 內的追蹤檔，或未被 gitignore 的新檔。
 * @param {string} filePath 絕對路徑
 * @returns {boolean} 無法判定時為 false
 */
export function dirtiesMainCheckout(filePath) {
  const dir = existingDir(resolve(filePath));
  const dirs = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  if (dirs.status !== 0) return false;
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  if (!gitDir || gitDir !== commonDir) return false;
  if (git(dir, 'ls-files', '--error-unmatch', '--', resolve(filePath)).status === 0) return true;
  // check-ignore：0 為 gitignored、1 為未忽略，其他（git 失敗）無法判定
  return git(dir, 'check-ignore', '-q', '--no-index', '--', resolve(filePath)).status === 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) process.exit(0);
  if (dirtiesMainCheckout(filePath)) {
    process.stderr.write(`主 checkout 防護：${filePath} 在主 checkout 內且未被 gitignore，未提交的修改或新檔會擋住 integration 合併。`
      + '請改在該任務的 worktree 修改後合併（沒有 worktree 時用 `node scripts/orca-worktree-create.mjs --name <name> --base-branch <integration>` 開一個）；確需在主 checkout 修改時交由使用者手動處理。\n');
    process.exit(2);
  }
}
