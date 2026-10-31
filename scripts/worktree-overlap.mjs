#!/usr/bin/env node
// 各 worktree 的未合入改動碰到哪些檔、哪些條目（#194）。唯讀。
// /retro-collect 判斷候選 covered 或衝突、retro 的 concurrent-edit 步驟，原本各自手寫迴圈對每個 worktree 跑
// `git diff --name-only $(merge-base …)`，再另一個迴圈 grep 改到 pilot.md 哪些條目（1031c、1031d 各寫一次）。
//
// 做成獨立指令、不做成 pilot-probe.mjs 的子命令：pilot-probe 是 setup-workflow 正本的副本，介面是「對主 checkout 的 pilot 存檔對帳」，
// 這支看的是所有 worktree、不讀 `.scratch/pilot/`，呼叫者也不是 coordinator。條目判斷與 Probe 的 OVERLAP（#176）共用
// pilot-probe.mjs 的 changedUnits（`to` 給 null 時比工作樹），不另寫一份。
//
// 用法：node scripts/worktree-overlap.mjs [--main <分支>] [<檔案>…]（cwd 在 repo 任一 worktree 的任一目錄；檔案一律是 repo 根的相對路徑，
//   不隨 cwd 的子目錄改變，每個 worktree 才能用同一組 pathspec）
//   對 `git worktree list` 第一行（主 checkout）以外、目錄還在的每個 worktree，取它的 HEAD 與 <主分支>（預設 main）的 merge-base，
//   列出 merge-base 到工作樹之間的改動（已 commit、暫存、未暫存與未追蹤的新檔，ignore 的不算）碰到的檔；給了檔案時只列這些檔。
// stdout 一檔一行，依 worktree 清單順序、再依檔名：
//   OVERLAP_WT <分支> <檔案> [**<條目>.**…]
//   `.md` 檔附改到的 `- **<名稱>.**` 條目名稱（同 OVERLAP 的包法：名稱可能有空格，以 `**`…`.**` 切分）；條目以外的改動不另標，
//   所以附了條目也可能還改了標題或段落，沒附條目就是改動都不在條目裡。
//   呼叫者自己所在的 worktree 也列（它的分支名稱看得出來）；主 checkout 不列。
//   基準預設是 main：從 pilot/integration 開的 worktree，整合分支上還沒進 main 的改動也會算進去，只看各自的改動時帶 --main pilot/integration。
//   detached HEAD 的 worktree，<分支> 寫成 `detached@<HEAD 前 7 碼>`。和主分支沒有共同祖先、或還沒有 commit 的 worktree 略過。沒有命中時不輸出。
// exit：0 印完（不論有無命中）；2 用法錯誤；1 git 失敗。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changedUnits } from './pilot-probe.mjs';

const USAGE = '用法：node scripts/worktree-overlap.mjs [--main <分支>] [<檔案>…]';

/** 清掉繼承的 GIT_DIR 等再跑 git（從 hook 呼叫時會讀到別的 repo，同 pilot-probe.mjs）。 */
function spawnGit(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd, ...args) {
  const result = spawnGit(cwd, ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exit ${result.status}：${(result.stderr ?? '').trim()}`);
  return result.stdout;
}

/** `git worktree list --porcelain` → [{ path, branch, head }]；第一筆是主 checkout。 */
export function parseWorktrees(porcelain) {
  return porcelain.split(/\n\n+/).filter(block => block.trim()).map(block => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
    head: block.match(/^HEAD ([0-9a-f]+)$/m)?.[1] ?? '',
  }));
}

/** 每個非主 checkout worktree 的 OVERLAP_WT 行。`files` 是 repo 相對路徑，空陣列表示全部。 */
export function worktreeOverlaps(cwd, files = [], { main = 'main' } = {}) {
  const [, ...others] = parseWorktrees(git(cwd, 'worktree', 'list', '--porcelain'));
  const out = [];
  for (const tree of others) {
    // 目錄已不在，或還沒有任何 commit 的 orphan worktree（HEAD 解析不到，merge-base 會 exit 128）都略過。
    if (!tree.path || !existsSync(tree.path) || spawnGit(tree.path, 'rev-parse', '--verify', '-q', 'HEAD').status !== 0) continue;
    const base = spawnGit(tree.path, 'merge-base', 'HEAD', main);
    if (base.status === 1) continue;
    if (base.status !== 0) throw new Error(`git merge-base HEAD ${main} exit ${base.status}（${tree.path}）：${(base.stderr ?? '').trim()}`);
    const name = tree.branch ?? `detached@${tree.head.slice(0, 7)}`;
    for (const [path, { entries }] of changedUnits(tree.path, base.stdout.trim(), null, { paths: files, adjacent: false })) {
      out.push(['OVERLAP_WT', name, path, ...([...entries].map(entry => `**${entry}.**`))].join(' '));
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const files = [];
  let main = 'main';
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--main' && args[i + 1] && !args[i + 1].startsWith('--')) main = args[++i];
    else if (args[i] === '--') files.push(...args.splice(i + 1));
    else if (args[i].startsWith('--')) bad = true;
    else files.push(args[i]);
  }
  if (bad) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    for (const line of worktreeOverlaps(process.cwd(), files, { main })) console.log(line);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
