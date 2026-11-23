#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 各 worktree 的未合入改動碰到哪些檔、哪些條目（#194）。唯讀。
// /retro-collect 判斷候選 covered 或衝突、retro 的 concurrent-edit 步驟，原本各自手寫迴圈對每個 worktree 跑
// `git diff --name-only $(merge-base …)`，再另一個迴圈 grep 改到 adapter 哪些條目（1031c、1031d 各寫一次）。
//
// setup-workflow 正本。做成獨立指令、不做成 pilot-probe.mjs 的子命令：pilot-probe 的介面是「對主 checkout 的 pilot 存檔對帳」，
// 這支看的是所有 worktree、不讀 `.scratch/pilot/`，呼叫者也不是 coordinator。條目判斷與 Probe 的 OVERLAP（#176）共用
// lib/changed-units.mjs 的 changedUnits（`to` 給 null 時比工作樹），試合併與 Probe 的 CONFLICT 共用 lib/merge-tree.mjs（#376），
// 不另寫一份；只靠這兩支，所以可以複製到沒有 pilot 腳本的 repo。
//
// 用法：node scripts/worktree-overlap.mjs [--main <分支>] [--mine [--near <N>] [--generated <glob>]… [--max-files <N>] | [--since <ISO 時間>] <檔案>…]（cwd 在 repo 任一 worktree 的任一目錄；檔案一律是 repo 根的相對路徑，
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
//                        後面再一個欄位 `merge=clean|conflict`（#376）：以 lib/merge-tree.mjs 拿兩邊的工作樹快照（含未 commit、未追蹤的新檔；
//                        乾淨時是 HEAD）跑 `git merge-tree --write-tree`，這個檔在不在衝突清單裡。conflict 是真的會衝突；clean 是 git 合得起來，
//                        仍可能語意相依。git 低於 2.38 或判斷不了時省略這個欄位。
//     generated          檔案符合 `--generated <glob>`（可重複；`*` 不跨 `/`、`**` 跨目錄）：由工具重新產生的檔（例如 spay2 的
//                        `scripts/workflow-doc-sync.json`），衝突時重跑產生器即可，不比 hunk。不 actionable。
//   行號取各自與 <主分支> 的 merge-base：兩邊 merge-base 不同時，主分支中間的改動會讓行號略有位移，所以 apart／near 是近似值。
//   OVERLAP_MAIN <檔案> <commit7> hunks=apart|near <行>|generated
//   --mine 時另比對 <主分支> 本身：merge-base..<主分支> 之間有 commit 改到本方的檔，就在所有 OVERLAP_WT 之後依本方檔名各印一行
//   （retro spay2 31d564a6#1：只比其他 worktree，整合分支在 merge-base 後已合入改同檔的批次，fix-land 才 STOP merge-conflict）。
//   <commit7> 是該區間最後一個改到這個檔的 commit 前 7 碼；hunk 欄位同 OVERLAP_WT 的判斷，兩邊都以本方 merge-base 的行號比，
//   所以這裡的 apart／near 是精確值。hunks=near 是 actionable：先 sync <主分支>（合入本分支並解衝突）再落地；apart、generated 不 actionable。
//   hunks=near 後同樣附 `merge=clean|conflict`（本方工作樹快照對 <主分支> 的 tip 試合併）。
//   OVERLAP_BASE_BEHIND <主分支> <N> --main <建議分支>
//   --mine 不帶 --main、自己的改動檔數超過上限（預設 200，`--max-files <N>` 調整）時，不比對任何 worktree，只印這一行、exit 3
//   （#365：investing 的 develop 領先 main 263 個 commit，每個檔對約 20 個 worktree 算 hunk，300 秒跑不完；帶 --main develop 0.09 秒）。
//   <N> 是 merge-base(HEAD, <主分支>)..HEAD 的 commit 數。<建議分支> 是本機與 remote-tracking 分支中、和 HEAD 的 merge-base 到 HEAD
//   最少 commit 的那一條（不含 <主分支>、自己的分支、其他 linked worktree 檢出的分支與這兩者的 remote-tracking 分身、`*/HEAD`，也不含已包含 HEAD 的分支：拿它當基準，
//   本方的 commit 會整個消失；同數取名稱排序第一個，本機分支排在 `origin/…` 之前），比 <主分支> 近才建議，否則印 `-`。
//   看到這行：帶 `--main <建議分支>`（或自己知道的整合分支）重跑；印 `-` 時基準沒有更近的分支，改動本來就這麼多，
//   帶 `--main <主分支>` 照常比對（或調高 --max-files）。帶了 --main 或在上限內時行為不變。
//   TEMPLATE_COPY <檔案> <正本路徑>
//   給了檔案（或 --mine 的自己改動）時，cwd 所在 worktree 有 docs/agents/workflow-templates.json（copy-templates.mjs 的副本清單）就逐一比對，
//   是清單裡的副本就在 OVERLAP_WT 之前印一行（依輸入順序），<正本路徑> 是清單的 template（ron-skills 內的路徑）。不改 exit code。
//   看到這行：不要直接改這個檔，改 ron-skills 的正本再以 copy-templates 帶回（retro spay2 0cd3fdeb#1：計畫把副本派給子代理直接改，
//   到 check-contracts --static 的 TEMPLATE_COPY_MISMATCH 才發現，多走兩輪 PR）。不帶檔案時不印。
//   正本不在本 repo（consumer）時，TEMPLATE_COPY 之後再印一行 `  開上游單前：<copy-templates --dry-run 指令>…`（SAME 才用範本重現、可能開上游
//   ron-skills 單；UPDATE 副本落後、DIFF 被手改，先同步副本），其中有 PreToolUse Bash hook 時多一行 `  hook 類：…`（把 fixture 送過範本每支
//   PreToolUse Bash hook，有一支已 exit 2 就同步那支）。#503：兩次開出範本早已修好的單，另一次真正擋住的是另一支 hook 範本。
//   LANDED_SINCE <檔案> <commit7> <subject>
//   帶 `--since <ISO 時間>`（要給檔案，不能和 --mine 併用）時，<主分支> 第一父線上 committer 時間不早於它、改到這個檔的 commit
//   各印一行，依輸入的檔案順序、同一檔新的在前，排在 TEMPLATE_COPY 之後、OVERLAP_WT 之前。以落地時間算：側分支較早的 commit
//   在之後才合入時印那個合併 commit。retro 候選寫下後（傳候選或 Issue 的建立時間）目標分支是否已改過這些檔：只看其他 worktree
//   看不到已落地的改動（#413 第 6 項，investing#505：#499 兩項被記成 adopted，其實 875275d4 已落地）。
// exit：0 印完（不論有無命中）；2 用法錯誤；1 git 失敗；3 印了 OVERLAP_BASE_BEHIND。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedUnits } from './lib/changed-units.mjs';
import { mergeConflicts, snapshot } from './lib/merge-tree.mjs';

const USAGE = '用法：node scripts/worktree-overlap.mjs [--main <分支>] [--mine [--near <N>] [--generated <glob>]… [--max-files <N>] | [--since <ISO 時間>] <檔案>…]\n'
  + '  --mine 不帶 --main、自己的改動檔超過 --max-files（預設 200）時只印 OVERLAP_BASE_BEHIND <主分支> <N> --main <建議分支>，exit 3';
// git 三方合併只在兩邊 hunk 重疊或相接（相距 0～1 行）時衝突；預設 5 行留一點餘裕，又不把隔了一段的改動也報成 near。
const NEAR = 5;
// investing 落後 263 個 commit 時改動檔數以千計；一般 worktree 的改動在幾十個以內，200 留足餘裕。
const MAX_FILES = 200;
export const BEHIND = 'OVERLAP_BASE_BEHIND';

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
  const hits = files.filter(file => copies[file]?.template);
  const upstream = hits.map(file => copies[file].template).filter(template => !existsSync(join(top, template)));
  return [
    ...hits.map(file => `TEMPLATE_COPY ${file} ${copies[file].template}`),
    ...(upstream.length ? upstreamCheckLines(upstream.map(template => template.replace(/^.*\/setup-workflow\/templates\//, ''))) : []),
  ];
}

/** 範本裡掛在 `PreToolUse` matcher `Bash` 的 hook（setup-workflow SKILL.md 的表）；hook 類問題要把 fixture 送過每一支。 */
const PRE_TOOL_USE_BASH_HOOKS = ['zsh-equals', 'bash-pitfalls', 'git-bypass', 'main-checkout'];

/**
 * consumer 為副本開上游 ron-skills 單之前的比對（#503，同 concurrent-edits.mjs）：
 * copy-templates --dry-run 對每個副本印 SAME（與範本相同）／UPDATE（與清單 sha256 相同的舊版）／DIFF（被手改）。
 */
function upstreamCheckLines(names) {
  const lines = [`  開上游單前：node <ron-skills>/skills/engineering/setup-workflow/scripts/copy-templates.mjs <本 worktree> --dry-run --no-tests ${names.join(' ')}`
    + '（<ron-skills> 先更新到 origin/main）；SAME 才用範本重現、可能是上游問題；UPDATE（副本落後）或 DIFF（副本的 sha256 和 workflow-templates.json 記的不同，被手改過）'
    + '先在本 repo 重跑 copy-templates 同步再重現，不開上游單'];
  if (names.some(name => PRE_TOOL_USE_BASH_HOOKS.some(hook => name === `claude-hook-${hook}.mjs`))) {
    lines.push(`  hook 類：把重現的 fixture 送過範本每支 PreToolUse Bash hook：for h in ${PRE_TOOL_USE_BASH_HOOKS.join(' ')}; do`
      + ' node <ron-skills>/skills/engineering/setup-workflow/templates/claude-hook-$h.mjs < <fixture.json>; echo "$h exit=$?"; done'
      + '；有一支已 exit 2 就是本 repo 該同步（或裝上）那支，不開上游單');
  }
  return lines;
}

/**
 * `--since`：<主分支> 第一父線上 committer 時間不早於 `since`、改到 `files` 各檔的 commit → `LANDED_SINCE <檔> <commit7> <subject>`（#413）。
 * 第一父線讓側分支合入時以合併 commit（落地時間）出現，不以側分支上較早的 commit 時間被濾掉。
 */
export function landedSince(cwd, files, since, main = 'main') {
  return files.flatMap(file => git(cwd, 'log', '--first-parent', `--since=${since}`, '--format=%H %s', main, '--', file)
    .split('\n').filter(Boolean).map(line => `LANDED_SINCE ${file} ${line.slice(0, 7)} ${line.slice(41)}`));
}

/** cwd 所在 worktree 的根目錄、merge-base，與它從 merge-base 起改過的檔（含工作樹）。 */
function ownChanges(cwd, main) {
  const top = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const base = git(top, 'merge-base', 'HEAD', main).trim();
  return { top, base, files: [...changedUnits(top, base, null, { adjacent: false }).keys()] };
}

/**
 * --mine 的基準落後：`OVERLAP_BASE_BEHIND <main> <N> --main <建議分支>`（#365）。
 * 建議分支：本機與 remote-tracking 分支中 merge-base(HEAD, 它)..HEAD 最少、但不是 0（已含 HEAD）的一條，
 * 排除 `main`、HEAD 自己的分支、`checkedOut`（其他 linked worktree 檢出的分支）、後兩者的 remote-tracking 分身與 `<remote>/HEAD`；
 * 不比 `main` 近時為 `-`。
 */
export function baseBehind(top, base, main, checkedOut = []) {
  const count = from => Number(git(top, 'rev-list', '--count', `${from}..HEAD`).trim());
  const behind = count(base);
  const own = spawnGit(top, 'symbolic-ref', '-q', '--short', 'HEAD').stdout?.trim();
  const skip = new Set([main, own, ...checkedOut]);
  let best = null;
  // 本機分支在前、remote-tracking 在後，各自依名稱排序：同數時本機的 develop 勝過 origin/develop。
  // remote-tracking 略過 `<remote>/HEAD`，也略過自己與其他 worktree 分支的分身（origin/issue/…）：推過之後它離 HEAD 很近，
  // 當基準會藏掉本方改動。origin/<主分支> 不略過：本機主分支過期時它仍可能比較近。
  const refs = prefix => git(top, 'for-each-ref', '--format=%(refname:short)', prefix).split('\n').filter(Boolean).sort();
  const twin = ref => [own, ...checkedOut].includes(ref.slice(ref.indexOf('/') + 1));
  const remotes = refs('refs/remotes/').filter(ref => ref.includes('/') && !ref.endsWith('/HEAD') && !twin(ref));
  for (const branch of [...refs('refs/heads/').filter(ref => !skip.has(ref)), ...remotes]) {
    const fork = spawnGit(top, 'merge-base', 'HEAD', branch);
    if (fork.status !== 0) continue;
    const n = count(fork.stdout.trim());
    if (n > 0 && n < behind && (!best || n < best.n)) best = { branch, n };
  }
  return `${BEHIND} ${main} ${behind} --main ${best?.branch ?? '-'}`;
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

/**
 * 主分支從 `base` 到 `to`（commit）改 `path` 的 hunk，以 base 那側的行號表示（同 hunkRanges）。
 * 二進位（diff 沒有 `@@`）一律當整檔。
 */
export function commitRanges(checkout, base, to, path) {
  const diff = git(checkout, 'diff', '-U0', '--no-color', '--no-renames', '--diff-algorithm=histogram', base, to, '--', path);
  const ranges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map(([, start, count = '1']) => {
    const [from, n] = [Number(start), Number(count)];
    return n ? [from, from + n - 1] : [from, from];
  });
  return ranges.length ? ranges : [[1, Infinity]];
}

/**
 * hunks=near 時以 lib/merge-tree.mjs 試合併，行尾再加 `merge=clean|conflict`（#376）；`conflicts()` 傳回那一對的衝突檔（null：git 判斷不了，不加）。
 * apart 不跑合併：git 只在 hunk 重疊或相接時衝突。
 */
function withMerge(proximity, path, conflicts) {
  if (!proximity.startsWith('hunks=near')) return [proximity];
  const files = conflicts();
  return files ? [proximity, `merge=${files.includes(path) ? 'conflict' : 'clean'}`] : [proximity];
}

/** 一對 commit 的衝突檔只算一次：第一次呼叫才跑 merge-tree。 */
function lazyConflicts(cwd, ours, theirs) {
  let files;
  return () => (files === undefined ? (files = mergeConflicts(cwd, ours(), theirs())) : files);
}

/** --mine：<主分支> 在本方 merge-base 之後改到本方檔案的 OVERLAP_MAIN 行（retro spay2 31d564a6#1）。 */
function mainOverlaps(own, main, near, isGenerated, mineRanges) {
  const tip = git(own.top, 'rev-parse', '--verify', `${main}^{commit}`).trim();
  if (tip === own.base) return [];
  const out = [];
  const conflicts = lazyConflicts(own.top, own.snapshot, () => tip);
  for (const path of own.files) {
    const last = git(own.top, 'log', '-1', '--format=%H', `${own.base}..${tip}`, '--', path).trim();
    if (!last) continue;
    const fields = ['OVERLAP_MAIN', path, last.slice(0, 7)];
    if (isGenerated(path)) fields.push('generated');
    else {
      if (!mineRanges.has(path)) mineRanges.set(path, hunkRanges(own.top, own.base, path));
      fields.push(...withMerge(hunkProximity(mineRanges.get(path), commitRanges(own.top, own.base, tip, path), near), path, conflicts));
    }
    out.push(fields.join(' '));
  }
  return out;
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
export function worktreeOverlaps(cwd, files = [], { main = 'main', mine = false, near = NEAR, generated = [], maxFiles = null, since } = {}) {
  let self = null;
  let own = null;
  const isGenerated = path => generated.some(glob => globRegExp(glob).test(path));
  const mineRanges = new Map();
  if (mine) {
    own = ownChanges(cwd, main);
    if (!own.files.length) return [];
    let commit;
    own.snapshot = () => (commit ??= snapshot(own.top));
    self = realpathSync(own.top);
    files = own.files;
  }
  const isSelf = tree => Boolean(self && tree.path && existsSync(tree.path) && realpathSync(tree.path) === self);
  const [, ...others] = parseWorktrees(git(cwd, 'worktree', 'list', '--porcelain'));
  // `maxFiles` 是 null 時不檢查（呼叫者帶了 --main）；超過時在比對任何 worktree 之前就回傳（#365）。
  if (own && maxFiles !== null && own.files.length > maxFiles) {
    const checkedOut = others.filter(tree => tree.branch && !isSelf(tree)).map(tree => tree.branch);
    return [baseBehind(own.top, own.base, main, checkedOut)];
  }
  const out = files.length ? templateCopies(cwd, files) : [];
  if (since !== undefined) out.push(...landedSince(cwd, files, since, main));
  for (const tree of others) {
    if (isSelf(tree)) continue;
    // 目錄已不在，或還沒有任何 commit 的 orphan worktree（HEAD 解析不到，merge-base 會 exit 128）都略過。
    if (!tree.path || !existsSync(tree.path) || spawnGit(tree.path, 'rev-parse', '--verify', '-q', 'HEAD').status !== 0) continue;
    const base = spawnGit(tree.path, 'merge-base', 'HEAD', main);
    if (base.status === 1) continue;
    if (base.status !== 0) throw new Error(`git merge-base HEAD ${main} exit ${base.status}（${tree.path}）：${(base.stderr ?? '').trim()}`);
    const name = tree.branch ?? `detached@${tree.head.slice(0, 7)}`;
    const conflicts = own && lazyConflicts(own.top, own.snapshot, () => snapshot(tree.path));
    for (const [path, { entries }] of changedUnits(tree.path, base.stdout.trim(), null, { paths: files, adjacent: false })) {
      const fields = ['OVERLAP_WT', name, path, ...([...entries].map(entry => `**${entry}.**`))];
      if (own && isGenerated(path)) fields.push('generated');
      else if (own) {
        if (!mineRanges.has(path)) mineRanges.set(path, hunkRanges(own.top, own.base, path));
        fields.push(...withMerge(hunkProximity(mineRanges.get(path), hunkRanges(tree.path, base.stdout.trim(), path), near), path, conflicts));
      }
      out.push(fields.join(' '));
    }
  }
  if (own) out.push(...mainOverlaps(own, main, near, isGenerated, mineRanges));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const files = [];
  let main = 'main';
  let mainGiven = false;
  let maxFiles = MAX_FILES;
  let maxFilesGiven = false;
  let mine = false;
  let near = NEAR;
  let nearGiven = false;
  const generated = [];
  let since;
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--main' && args[i + 1] && !args[i + 1].startsWith('--')) { main = args[++i]; mainGiven = true; }
    else if (args[i] === '--max-files' && /^\d+$/.test(args[i + 1] ?? '')) { maxFiles = Number(args[++i]); maxFilesGiven = true; }
    else if (args[i] === '--mine') mine = true;
    else if (args[i] === '--since' && args[i + 1] && !args[i + 1].startsWith('--')) since = args[++i];
    else if (args[i] === '--near' && /^\d+$/.test(args[i + 1] ?? '')) { near = Number(args[++i]); nearGiven = true; }
    else if (args[i] === '--generated' && args[i + 1] && !args[i + 1].startsWith('--')) generated.push(args[++i]);
    else if (args[i] === '--') files.push(...args.splice(i + 1));
    else if (args[i].startsWith('--')) bad = true;
    else files.push(args[i]);
  }
  // --near、--generated 只影響 --mine 的 hunk 欄位，--max-files 只影響 --mine 的基準檢查，不帶 --mine 時給了等於沒作用，當用法錯誤。
  // --since 只對給的檔案有意義，時間要是 Date.parse 讀得懂的 ISO 寫法（git 的 approxidate 會把讀不懂的字串猜成某個時間，不報錯）。
  const badSince = since !== undefined && (mine || !files.length || Number.isNaN(Date.parse(since)));
  if (bad || badSince || (mine && files.length) || (!mine && (nearGiven || generated.length || maxFilesGiven))) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const lines = worktreeOverlaps(process.cwd(), files, { main, mine, near, generated, maxFiles: mainGiven ? null : maxFiles, since });
    for (const line of lines) console.log(line);
    if (lines[0]?.startsWith(`${BEHIND} `)) process.exit(3);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
