// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（#376）：兩個 commit 以 `git merge-tree --write-tree` 試合併，傳回會衝突的檔。唯讀：不動任何 ref、index 或工作樹。
// worktree-overlap.mjs --mine 的 `merge=clean|conflict` 與 pilot-probe.mjs 的 `CONFLICT` 共用這一份，不另寫。
// 只依賴 node 內建模組，可以和 worktree-overlap.mjs 一起複製到沒有 pilot 腳本的 repo。
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 清掉繼承的 GIT_DIR 等再跑 git（從 hook 呼叫時會讀到別的 repo）；`env` 另外加的變數（暫時 index）。 */
function spawnGit(cwd, args, env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd, args, env) {
  const result = spawnGit(cwd, args, env);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exit ${result.status}（${cwd}）：${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * `checkout` 工作樹目前內容的 commit：工作樹與 HEAD 相同時是 HEAD，否則是以 HEAD 為 parent、收進暫存、未暫存與未追蹤新檔
 * （ignore 的不算；標了 skip-worktree 的檔取 index 裡的版本）的一個 dangling commit。用法同 `git stash create`，但它不收未追蹤檔：兩個 worktree 各自新增同名檔時
 * 會漏掉 add/add 衝突，worktree-overlap 又把未追蹤檔算成改動，所以改用複製出來的暫時 index（真的 index、ref、stash 清單都不動）。
 * git 失敗時 throw。
 */
export function snapshot(checkout) {
  const head = git(checkout, ['rev-parse', '--verify', 'HEAD']);
  const dir = mkdtempSync(join(tmpdir(), 'merge-tree-'));
  try {
    const index = join(dir, 'index');
    const real = git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    // 從真的 index 起算，沒改過的檔沿用它的 stat 資訊，不必整個工作樹重新 hash。mtime 要設回原檔的：git 以 index 檔自己的 mtime
    // 判斷 racy entry（和 index 同一刻改過、大小沒變的檔要重新 hash），複製出來的新 mtime 會讓這種改動被當成沒改。
    if (existsSync(real)) {
      copyFileSync(real, index);
      const { atime, mtime } = statSync(real);
      utimesSync(index, atime, mtime);
    }
    else git(checkout, ['read-tree', head], { GIT_INDEX_FILE: index });
    git(checkout, ['add', '-A', '--', '.'], { GIT_INDEX_FILE: index });
    const tree = git(checkout, ['write-tree'], { GIT_INDEX_FILE: index });
    if (tree === git(checkout, ['rev-parse', `${head}^{tree}`])) return head;
    return git(checkout, ['-c', 'user.name=merge-tree', '-c', 'user.email=merge-tree@localhost', 'commit-tree', tree, '-p', head, '-m', 'worktree snapshot']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 在 `cwd` 的 repo 裡試合併 `ours` 與 `theirs`（commit 或 ref，merge-base 由 git 找）：傳回會衝突的檔（repo 相對路徑，排序、去重），
 * 合得起來時是空陣列。git 低於 2.38（沒有 `--write-tree`）、兩邊沒有共同祖先等 git 判斷不了的情況傳回 null，由呼叫者略過，不當成衝突或乾淨。
 */
export function mergeConflicts(cwd, ours, theirs) {
  const result = spawnGit(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs]);
  if (result.status === 0) return [];
  if (result.status !== 1) return null;
  // -z：第一段是合併結果的 tree，之後每段一個衝突檔，最後是空段。
  const [, ...files] = result.stdout.split('\0');
  return [...new Set(files.filter(Boolean))].sort();
}
