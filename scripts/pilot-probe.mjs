#!/usr/bin/env node
// pilot 的 Reconcile 用這一支對帳（之後只剩整理母單要另外做）：主 checkout、`.scratch/pilot/` 的請求、gate、batch checkpoint
// 與每個 running 成員的 terminal，各印一行狀態，不必再手動拼 `orca-ide terminal read` 的 JSON（手拼時漏過 exited 卻沒有結果行的 worker，#23）。
//
// 用法：node scripts/pilot-probe.mjs <主 checkout>（讀 running 成員要 ORCA_CLI_COMMAND；沒有時其他檢查照跑）
// stdout 每行一項，沒事的項目不印（全部正常且沒有 batch 時不輸出）：
//   主 checkout：UNBARE <checkout>（Bare guard 剛還原 core.bare）｜NOT_MAIN <分支>｜HOLD｜DIRTY <git status --short 的一行>
//   開著的列：REQUEST <requests.md 原文>｜GATE <id> <Issue> <question 或段落標題>
//   running 成員：WORKER <n> DONE <sha>｜WORKER <n> STOP <cause>｜WORKER <n> RUNNING <分鐘>｜
//                 WORKER <n> STUCK exited|stuck-after <分鐘>|orca <錯誤碼>|no-orca|checkpoint <欄位> <值>
//                 （terminal 已結束卻沒有結果行、超過 stuck-after、讀不到 terminal、沒有 ORCA_CLI_COMMAND、checkpoint 的時間欄位解析不了）
//   batch：STAGEABLE <key>（dispatched 且每個成員都 done 或 stop；moved 的成員已移到別的 batch，不算）；
//          current 是 merged／pushed 的 batch 在 git fetch 後印 IN_MAIN <key>｜NOT_IN_MAIN <key>（no-sha：checkpoint 沒有 SHA）｜FETCH_FAILED <錯誤>；
//          還沒進 origin/main 的 merged batch 改印 RESUME_PUSH <key>（pilot/integration 的 tip 等於最後一次 regression SHA，#37），
//          不符合時印 NOT_IN_MAIN <key> no-regression｜NOT_IN_MAIN <key> tip <tip 前 7 碼或 none>
// exit：0 印完；2 用法錯誤；1 其他失敗（Bare guard 或 git status 失敗等）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orca } from './orca-session-send.mjs';

const USAGE = '用法：node scripts/pilot-probe.mjs <主 checkout>';

/** Markdown 表格一列的各欄（去掉首尾的 `|` 與空白）；不是表格列時回空陣列。 */
const tableCells = line => line.split('|').slice(1, -1).map(cell => cell.trim());

/**
 * 在主 checkout 跑 git；stdin 一律不給（逐一呼叫外部指令時被吃掉 stdin 會讓後面的步驟讀不到，#23 retro）。
 * 清掉繼承的 GIT_DIR 等，否則從 pre-commit hook 或 worktree 呼叫時會讀到別的 repo（見 pilot-unbare.sh）。
 */
function git(checkout, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
  return spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 主 checkout 的狀態行：Bare guard（pilot-unbare.sh，時機 probe）、不在 main、hold 檔、`git status --short` 的每一行。 */
export function checkoutState(checkout) {
  const unbare = spawnSync(join(dirname(fileURLToPath(import.meta.url)), 'pilot-unbare.sh'), [checkout, 'probe'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (unbare.status !== 0) throw new Error(`pilot-unbare.sh exit ${unbare.status}：${unbare.stderr.trim()}`);
  const out = unbare.stdout.split('\n').filter(Boolean);
  const current = git(checkout, 'branch', '--show-current');
  if (current.status !== 0) throw new Error(`git branch --show-current exit ${current.status}：${current.stderr.trim()}`);
  const branch = current.stdout.trim();
  if (branch !== 'main') out.push(`NOT_MAIN ${branch || '(detached)'}`);
  if (existsSync(join(checkout, '.scratch/pilot/hold'))) out.push('HOLD');
  const status = git(checkout, 'status', '--short');
  if (status.status !== 0) throw new Error(`git status exit ${status.status}：${status.stderr.trim()}`);
  for (const line of status.stdout.split('\n').filter(Boolean)) out.push(`DIRTY ${line}`);
  return out;
}

/**
 * requests.md 與 gates.md 還開著的列。請求是最後一個 `source` 欄之後沒標 `applied`／`declined` 的行（請求內文提到這兩個字或 source 都不算）；
 * gate 是表格 status 欄不以 `resolved` 開頭的列，或 `## G<n>` 段落裡沒有 `resolved` 那一行的 gate。
 */
export function openRows(pilot) {
  const read = name => (existsSync(join(pilot, name)) ? readFileSync(join(pilot, name), 'utf8') : '');
  const out = read('requests.md').split('\n')
    .filter(line => line.trim() && !line.startsWith('#') && !/\s(?:applied|declined)\s+\S/.test(line.split(/\ssource\s/).slice(1).at(-1) ?? ''))
    .map(line => `REQUEST ${line.trim()}`);
  for (const line of read('gates.md').split('\n')) {
    const cells = tableCells(line);
    if (/^G\d+$/.test(cells[0] ?? '') && !/^resolved\b/.test(cells.at(-1))) out.push(`GATE ${cells[0]} ${cells[1]} ${cells[2]}`);
  }
  for (const [, title, body] of read('gates.md').matchAll(/^## (G\d+\b.*)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
    if (!/^- (?:G\d+ )?resolved\b/m.test(body)) out.push(`GATE ${title.trim()}`);
  }
  return out;
}

/**
 * 解析 batch checkpoint：`current:`、成員表格、最後一行 `regression: <sha>` 的 SHA，
 * 與合入的 SHA（`current: merged|pushed <sha>`，沒有就取 regression 的 SHA）。
 */
export function parseBatch(text) {
  const current = text.match(/^current:\s*(.*)$/m)?.[1].trim() ?? '';
  const regression = [...text.matchAll(/^regression: ([0-9a-f]{7,40})\b/gm)].at(-1)?.[1];
  const sha = current.match(/^(?:merged|pushed) ([0-9a-f]{7,40})\b/)?.[1] ?? regression;
  const members = [];
  for (const line of text.split('\n')) {
    const cells = tableCells(line);
    if (cells.length < 8 || !/^\d+$/.test(cells[0])) continue;
    const [n, branch, worktree, handle, started, stuckAfter, state, candidate] = cells;
    members.push({ n, branch, worktree, handle, started, stuckAfter, state, candidate });
  }
  return { current, members, regression, sha };
}

/**
 * terminal 畫面裡這個 worker 的結果行：取最後一行 `DONE <n> <sha>` 或 `STOP <n> <cause>`。
 * TUI 畫框線時行首、行尾會帶 `│` 與空白，行首也可能是 Claude Code 的 bullet（`●`、`⏺`、`⎿`），比對前先去掉。
 */
export function resultLine(tail, n) {
  for (const raw of [...tail].reverse()) {
    const line = raw.replace(/^[\s│●⏺⎿]+|[\s│]+$/g, '');
    const done = line.match(new RegExp(`^DONE ${n} ([0-9a-f]{7,40})$`));
    if (done) return `DONE ${done[1]}`;
    const stop = line.match(new RegExp(`^STOP ${n} (.+)$`));
    if (stop) return `STOP ${stop[1]}`;
  }
  return null;
}

/** 一個 running 成員的狀態行（不含 `WORKER <n> ` 前綴）。`ctx.cli` 缺省時（沒有 ORCA_CLI_COMMAND）讀不到 terminal。 */
export async function workerState(ctx, member, now = Date.now()) {
  if (!ctx.cli) return 'STUCK no-orca';
  let terminal;
  try {
    terminal = (await orca(ctx, 'terminal', 'read', '--terminal', member.handle, '--screen')).terminal ?? {};
  } catch (error) {
    return `STUCK orca ${error.message}`;
  }
  const result = resultLine(terminal.tail ?? [], member.n);
  if (result) return result;
  if (terminal.status === 'exited') return 'STUCK exited';
  const started = Date.parse(member.started);
  if (Number.isNaN(started)) return `STUCK checkpoint started ${member.started}`;
  const limit = member.stuckAfter.match(/^(\d+)m$/)?.[1];
  if (!limit) return `STUCK checkpoint stuck-after ${member.stuckAfter}`;
  const minutes = Math.floor((now - started) / 60000);
  return minutes > Number(limit) ? `STUCK stuck-after ${minutes}` : `RUNNING ${minutes}`;
}

/**
 * 還沒進 origin/main 的 `merged` batch：Push gate 的前提是 pilot/integration 的 tip 等於最後一次 Regression SHA（#37）。
 * 符合時 coordinator 從 Push gate 第 1 步接著做；Integrate 之後又有 commit、或沒有 regression 行時，直接推會送出沒驗過的內容。
 */
function resumePush(checkout, key, regression) {
  if (!regression) return `NOT_IN_MAIN ${key} no-regression`;
  const rev = ref => git(checkout, 'rev-parse', '--verify', '-q', ref).stdout.trim();
  const tip = rev('refs/heads/pilot/integration');
  return tip && tip === rev(`${regression}^{commit}`) ? `RESUME_PUSH ${key}` : `NOT_IN_MAIN ${key} tip ${tip.slice(0, 7) || 'none'}`;
}

export async function probe(ctx, checkout) {
  const pilot = join(checkout, '.scratch/pilot');
  const out = [...checkoutState(checkout), ...openRows(pilot)];
  const batches = (existsSync(pilot) ? readdirSync(pilot) : []).filter(file => /^batch-.+\.md$/.test(file)).sort();
  const landing = [];
  for (const file of batches) {
    const key = file.slice('batch-'.length, -'.md'.length);
    const { current, members, regression, sha } = parseBatch(readFileSync(join(pilot, file), 'utf8'));
    const active = members.filter(m => m.state !== 'moved');
    const finished = active.filter(m => m.state === 'done' || m.state === 'stop').length;
    let read = 0;
    for (const member of members.filter(m => m.state === 'running')) {
      const state = await workerState(ctx, member);
      if (/^(DONE|STOP) /.test(state)) read++;
      out.push(`WORKER ${member.n} ${state}`);
    }
    if (/^dispatched\b/.test(current) && active.length && finished + read === active.length) out.push(`STAGEABLE ${key}`);
    if (/^(merged|pushed)\b/.test(current)) landing.push({ key, sha, regression, merged: /^merged\b/.test(current) });
  }
  if (landing.length) {
    const fetch = git(checkout, 'fetch', '-q', 'origin');
    if (fetch.status !== 0) out.push(`FETCH_FAILED ${fetch.stderr.trim().split('\n').find(line => line.startsWith('fatal:')) ?? fetch.stderr.trim().split('\n')[0]}`);
    else for (const { key, sha, regression, merged } of landing) {
      if (!sha) out.push(`NOT_IN_MAIN ${key} no-sha`);
      else if (git(checkout, 'merge-base', '--is-ancestor', sha, 'origin/main').status === 0) out.push(`IN_MAIN ${key}`);
      else out.push(merged ? resumePush(checkout, key, regression) : `NOT_IN_MAIN ${key}`);
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const cli = process.env.ORCA_CLI_COMMAND;
  if (args.length !== 1) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    for (const line of await probe({ cli }, args[0])) console.log(line);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
