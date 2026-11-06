#!/usr/bin/env node
// 各 worktree 的未合入改動碰到哪些檔、哪些條目（#194）。唯讀。
// /retro-collect 判斷候選 covered 或衝突、retro 的 concurrent-edit 步驟，原本各自手寫迴圈對每個 worktree 跑
// `git diff --name-only $(merge-base …)`，再另一個迴圈 grep 改到 adapter 哪些條目（1031c、1031d 各寫一次）。
//
// setup-workflow 正本。做成獨立指令、不做成 pilot-probe.mjs 的子命令：pilot-probe 的介面是「對主 checkout 的 pilot 存檔對帳」，
// 這支看的是所有 worktree、不讀 `.scratch/pilot/`，呼叫者也不是 coordinator。條目判斷與 Probe 的 OVERLAP（#176）共用
// lib/changed-units.mjs 的 changedUnits（`to` 給 null 時比工作樹），不另寫一份；只靠它，所以可以複製到沒有 pilot 腳本的 repo。
//
// 用法：node scripts/worktree-overlap.mjs [--main <分支>] [--mine [--near <N>] [--generated <glob>]… | <檔案>…]（cwd 在 repo 任一 worktree 的任一目錄；檔案一律是 repo 根的相對路徑，
//   不隨 cwd 的子目錄改變，每個 worktree 才能用同一組 pathspec）
//   --mine：檔案清單改取 cwd 所在 worktree 自己從 merge-base（同一個 <主分支>）起的改動（含未 commit、未追蹤的新檔），
//   不列 cwd 所在的 worktree；自己沒有改動時不輸出。retro 合入前重查並行改動用：`git diff --name-only main HEAD` 在本機 main
//   被別的 session 推進後，會混進 main 自己改的檔，印出無關的重疊（#224）。不能和檔案一起給。
//   對 `git worktree list` 第一行（主 checkout）以外、目錄還在的每個 worktree，取它的 HEAD 與 <主分支>（預設 main）的 merge-base，
//   列出 merge-base 到工作樹之間的改動（已 commit、暫存、未暫存與未追蹤的新檔，ignore 的不算）碰到的檔；給了檔案時只列這些檔。
// stdout 一檔一行，依 worktree 清單順序、再依檔名：
//   OVERLAP_WT <分支> <檔案> [**<條目>.**…]
//   `.md` 檔附改到的 `- **<名稱>.**` 條目名稱（同 OVERLAP 的包法：名稱可能有空格，以 `**`…`.**` 切分）；條目以外的改動不另標，
//   所以附了條目也可能還改了標題或段落，沒附條目就是改動都不在條目裡。
//   沒帶 --mine 時，呼叫者自己所在的 worktree 也列（它的分支名稱看得出來）；主 checkout 不列。
//   基準預設是 main：從 pilot/integration 開的 worktree，整合分支上還沒進 main 的改動也會算進去，只看各自的改動時帶 --main pilot/integration。
//   沒有 main 這條分支的 repo（整合分支另有名稱）一律帶 --main <整合分支>。
//   detached HEAD 的 worktree，<分支> 寫成 `detached@<HEAD 前 7 碼>`。和主分支沒有共同祖先、或還沒有 commit 的 worktree 略過。沒有命中時不輸出。
//   --mine 時 OVERLAP_WT 行尾（條目之後）再多一個欄位，說明兩邊改的是不是同一段（retro spay2 e9234021#2：每個 hit 都要另跑
//   `git diff … | grep '^@@'` 比對 hunk 才敢落地）。前面的欄位不變，`grep '^OVERLAP_WT'` 與按空白切欄的既有解析照常可用：
//     hunks=apart        兩邊的 hunk 在各自 merge-base 的行號上相距超過 N 行（預設 5，`--near <N>` 調整；git 只在 hunk 重疊或相接時衝突）：
//                        git 可自動合併，不必再 diff；語意上是否相依仍由呼叫者判斷。不 actionable。
//     hunks=near <行>    有一對 hunk 相距 N 行以內（或重疊）；<行> 是本方那個 hunk 在本方 merge-base 的起始行（新檔、二進位或刪檔一律 1）。
//                        actionable：對那個 worktree 跑 `git diff <主分支>...<分支> -- <檔案>` 看那一段，決定先等它合入或改到別處。
//     generated          檔案符合 `--generated <glob>`（可重複；`*` 不跨 `/`、`**` 跨目錄）：由工具重新產生的檔（例如 spay2 的
//                        `scripts/workflow-doc-sync.json`），衝突時重跑產生器即可，不比 hunk。不 actionable。
//   行號取各自與 <主分支> 的 merge-base：兩邊 merge-base 不同時，主分支中間的改動會讓行號略有位移，所以 apart／near 是近似值。
//   TEMPLATE_COPY <檔案> <正本路徑>
//   給了檔案（或 --mine 的自己改動）時，cwd 所在 worktree 有 docs/agents/workflow-templates.json（copy-templates.mjs 的副本清單）就逐一比對，
//   是清單裡的副本就在 OVERLAP_WT 之前印一行（依輸入順序），<正本路徑> 是清單的 template（ron-skills 內的路徑）。不改 exit code。
//   看到這行：不要直接改這個檔，改 ron-skills 的正本再以 copy-templates 帶回（retro spay2 0cd3fdeb#1：計畫把副本派給子代理直接改，
//   到 check-contracts --static 的 TEMPLATE_COPY_MISMATCH 才發現，多走兩輪 PR）。不帶檔案時不印。
// exit：0 印完（不論有無命中）；2 用法錯誤；1 git 失敗。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedUnits } from './lib/changed-units.mjs';

const USAGE = '用法：node scripts/worktree-overlap.mjs [--main <分支>] [--mine [--near <N>] [--generated <glob>]… | <檔案>…]';
// git 三方合併只在兩邊 hunk 重疊或相接（相距 0～1 行）時衝突；預設 5 行留一點餘裕，又不把隔了一段的改動也報成 near。
const NEAR = 5;

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

const MANIFEST = 'docs/agents/workflow-templates.json';

/** `files` 裡是 cwd 所在 worktree 副本清單（MANIFEST）列出的副本 → TEMPLATE_COPY 行；沒有清單或讀不懂時為空。 */
export function templateCopies(cwd, files) {
  const top = git(cwd, 'rev-parse', '--show-toplevel').trim();
  let copies;
  try {
    copies = JSON.parse(readFileSync(join(top, MANIFEST), 'utf8')).copies ?? {};
  } catch {
    return [];
  }
  return files.filter(file => copies[file]?.template).map(file => `TEMPLATE_COPY ${file} ${copies[file].template}`);
}

/** cwd 所在 worktree 的根目錄、merge-base，與它從 merge-base 起改過的檔（含工作樹）。 */
function ownChanges(cwd, main) {
  const top = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const base = git(top, 'merge-base', 'HEAD', main).trim();
  return { top, base, files: [...changedUnits(top, base, null, { adjacent: false }).keys()] };
}

/**
 * `checkout` 的 `path` 從 `base` 到工作樹的 hunk，以 base 那側的行號表示成 [起, 迄]（純插入是 [插入點, 插入點]）。
 * 未追蹤的新檔、二進位（diff 沒有 `@@`）一律當整檔 [1, Infinity]。
 */
export function hunkRanges(checkout, base, path) {
  const tracked = spawnGit(checkout, 'ls-files', '--error-unmatch', '--', path).status === 0;
  if (!tracked) return [[1, Infinity]];
  const diff = git(checkout, 'diff', '-U0', '--no-color', '--no-renames', '--diff-algorithm=histogram', base, '--', path);
  const ranges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map(([, start, count = '1']) => {
    const [from, n] = [Number(start), Number(count)];
    return n ? [from, from + n - 1] : [from, from];
  });
  return ranges.length ? ranges : [[1, Infinity]];
}

/** 兩組 hunk 最近的一對相距 `near` 行以內時回 `near <本方起始行>`，否則 `apart`。 */
export function hunkProximity(mine, theirs, near = NEAR) {
  let best = null;
  for (const [a0, a1] of mine) {
    for (const [b0, b1] of theirs) {
      const gap = Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
      if (gap <= near && (!best || gap < best.gap)) best = { gap, line: Math.max(1, a0) };
    }
  }
  return best ? `hunks=near ${best.line}` : 'hunks=apart';
}

/** `--generated` 的 glob → RegExp：`**` 跨目錄、`*` 不跨 `/`、`?` 一個字元，其餘照字面。 */
export function globRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * 每個非主 checkout worktree 的 OVERLAP_WT 行。`files` 是 repo 相對路徑，空陣列表示全部。
 * `mine` 時 `files` 改成 cwd 所在 worktree 自己的改動，並跳過那個 worktree。
 */
export function worktreeOverlaps(cwd, files = [], { main = 'main', mine = false, near = NEAR, generated = [] } = {}) {
  let self = null;
  let own = null;
  const isGenerated = path => generated.some(glob => globRegExp(glob).test(path));
  const mineRanges = new Map();
  if (mine) {
    own = ownChanges(cwd, main);
    if (!own.files.length) return [];
    self = realpathSync(own.top);
    files = own.files;
  }
  const [, ...others] = parseWorktrees(git(cwd, 'worktree', 'list', '--porcelain'));
  const out = files.length ? templateCopies(cwd, files) : [];
  for (const tree of others) {
    if (self && tree.path && existsSync(tree.path) && realpathSync(tree.path) === self) continue;
    // 目錄已不在，或還沒有任何 commit 的 orphan worktree（HEAD 解析不到，merge-base 會 exit 128）都略過。
    if (!tree.path || !existsSync(tree.path) || spawnGit(tree.path, 'rev-parse', '--verify', '-q', 'HEAD').status !== 0) continue;
    const base = spawnGit(tree.path, 'merge-base', 'HEAD', main);
    if (base.status === 1) continue;
    if (base.status !== 0) throw new Error(`git merge-base HEAD ${main} exit ${base.status}（${tree.path}）：${(base.stderr ?? '').trim()}`);
    const name = tree.branch ?? `detached@${tree.head.slice(0, 7)}`;
    for (const [path, { entries }] of changedUnits(tree.path, base.stdout.trim(), null, { paths: files, adjacent: false })) {
      const fields = ['OVERLAP_WT', name, path, ...([...entries].map(entry => `**${entry}.**`))];
      if (own && isGenerated(path)) fields.push('generated');
      else if (own) {
        if (!mineRanges.has(path)) mineRanges.set(path, hunkRanges(own.top, own.base, path));
        fields.push(hunkProximity(mineRanges.get(path), hunkRanges(tree.path, base.stdout.trim(), path), near));
      }
      out.push(fields.join(' '));
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const files = [];
  let main = 'main';
  let mine = false;
  let near = NEAR;
  let nearGiven = false;
  const generated = [];
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--main' && args[i + 1] && !args[i + 1].startsWith('--')) main = args[++i];
    else if (args[i] === '--mine') mine = true;
    else if (args[i] === '--near' && /^\d+$/.test(args[i + 1] ?? '')) { near = Number(args[++i]); nearGiven = true; }
    else if (args[i] === '--generated' && args[i + 1] && !args[i + 1].startsWith('--')) generated.push(args[++i]);
    else if (args[i] === '--') files.push(...args.splice(i + 1));
    else if (args[i].startsWith('--')) bad = true;
    else files.push(args[i]);
  }
  // --near、--generated 只影響 --mine 的 hunk 欄位，不帶 --mine 時給了等於沒作用，當用法錯誤。
  if (bad || (mine && files.length) || (!mine && (nearGiven || generated.length))) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    for (const line of worktreeOverlaps(process.cwd(), files, { main, mine, near, generated })) console.log(line);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
