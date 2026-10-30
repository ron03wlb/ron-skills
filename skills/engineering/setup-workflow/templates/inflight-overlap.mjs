#!/usr/bin/env node
// 合入整合分支前，找出來源分支與其他進行中 worktree（未合入的分支或未提交變更）的重疊，避免剛合入的變更
// 和進行中的單互相抵觸，直到該單合併整合分支時才發現。
//
// 用法：node scripts/inflight-overlap.mjs <source-branch> <integration> [--watched <regex>]（在任一 checkout 執行）
//   --watched：要比對 shared 的路徑（JavaScript regex，對 repo 相對路徑），預設 `^(src|sql|docs/adr)/`；依專案的產品程式目錄改寫。
// stdout 第一行：NONE，或 INFLIGHT_OVERLAP，其後每行一筆：
//   <branch> removes <file>：該分支刪除的 Java 類別，來源分支新增的程式碼仍引用它
//   <branch> shared <file>：雙方都改了同一個 --watched 範圍內的檔案（產品程式或 ADR／SQL；不含生成頁面與共用登錄檔）
// 比對的分支已不存在（例如剛合入並刪掉的分支，worktree 目錄還在）時在 stderr 印 `SKIP gone <branch>` 並略過，
//   不整支失敗（否則呼叫端會在回歸通過後才因此合併失敗）；stdout 格式不變。
// exit code：0（不論是否重疊）、2 用法錯誤、1 其他失敗。是否擋下由呼叫端決定。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

const WATCHED = /^(src|sql|docs\/adr)\//;

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失敗：${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
const lines = text => text.split('\n').filter(Boolean);

/** 其他 worktree：{ path, branch }，略過來源分支、整合分支、detached HEAD 與目錄已不存在的 worktree。 */
function worktrees(cwd, source, integration) {
  const found = [];
  let path = null;
  for (const line of lines(git(cwd, 'worktree', 'list', '--porcelain'))) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('branch ')) {
      const branch = line.slice(7).replace(/^refs\/heads\//, '');
      if (branch !== source && branch !== integration && existsSync(path)) found.push({ path, branch });
    }
  }
  return found;
}

const exists = (cwd, branch) => spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;

/** skip(branch)：分支已不存在而略過時呼叫；watched：要比對 shared 的路徑。 */
export function overlaps(cwd, source, integration, skip = () => {}, watched = WATCHED) {
  const sourceFiles = new Set(lines(git(cwd, 'diff', '--name-only', `${integration}...${source}`)));
  const added = lines(git(cwd, 'diff', '--unified=0', `${integration}...${source}`))
    .filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  const found = [];
  for (const { path, branch } of worktrees(cwd, source, integration)) {
    if (!exists(cwd, branch)) { skip(branch); continue; }
    const committed = lines(git(cwd, 'diff', '--name-only', `${integration}...${branch}`));
    const dirty = lines(git(path, 'status', '--porcelain', '--untracked-files=all')).map(line => line.slice(3).replace(/^.* -> /, ''));
    const removed = lines(git(cwd, 'diff', '--name-only', '--diff-filter=D', `${integration}...${branch}`))
      .filter(file => file.endsWith('.java'));
    for (const file of removed) {
      const stem = basename(file, '.java');
      if (new RegExp(`\\b${stem}\\b`).test(added)) found.push(`${branch} removes ${file}`);
    }
    for (const file of new Set([...committed, ...dirty])) {
      if (watched.test(file) && sourceFiles.has(file)) found.push(`${branch} shared ${file}`);
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--watched');
  const pattern = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
  const [source, integration] = args;
  const usage = () => { console.error('用法：node scripts/inflight-overlap.mjs <source-branch> <integration> [--watched <regex>]'); process.exit(2); };
  if (!source || !integration || (flag >= 0 && !pattern)) usage();
  let watched = WATCHED;
  try { if (pattern) watched = new RegExp(pattern); } catch (error) { console.error(error.message); usage(); }
  try {
    const found = overlaps(process.cwd(), source, integration, branch => console.error(`SKIP gone ${branch}`), watched);
    console.log(found.length ? ['INFLIGHT_OVERLAP', ...found].join('\n') : 'NONE');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
