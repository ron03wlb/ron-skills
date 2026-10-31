#!/usr/bin/env node
// setup-workflow 正本（#178）：整台機器同時跑的 pilot worker 合計上限。同一台機器上的多個 coordinator（不同 repo 的 /issue-pilot、
// /issue-cycle）共用一本帳，每個 coordinator 每輪只改寫自己那一列，派工前合計所有 repo 的列再加上這次要派的人數。
// 上限依據：`bin/check` 的 node --test 預設開 availableParallelism()-1 個並行程序，worker 越多 load 疊得越高，
// 10 核的機器上 8 個 worker 時 load 約 90，計時測試會失敗（#178）。
//
// 帳本：$PILOT_WORKERS_LEDGER，沒設時 ~/.local/state/pilot-workers.tsv；每列 `<repo>\t<running>\t<ISO 時間>`。
//   超過 2 小時沒更新的列（coordinator 已經停了）與解析不了的列不算進合計，也不刪。改寫時先寫暫存檔再 rename，讀的一方不會讀到半份。
// 上限：$PILOT_MACHINE_WORKER_CAP，沒設時 4。
//
// 用法：node scripts/pilot-capacity.mjs report <repo> <running>
//       node scripts/pilot-capacity.mjs check <新增人數>
// stdout：report 印 `REPORTED <repo> <running> <合計>/<上限>`；
//         check 在「合計＋新增人數」不超過上限時印 `CAPACITY ok <合計>/<上限>`，超過時印 `STOP capacity <合計>/<上限>`（合計已含新增人數）。
// exit：0 report 完成或 CAPACITY ok；4 STOP capacity；2 用法錯誤；1 其他失敗（讀寫帳本失敗）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/pilot-capacity.mjs report <repo> <running> | check <新增人數>（帳本 $PILOT_WORKERS_LEDGER，上限 $PILOT_MACHINE_WORKER_CAP，預設 4）';
export const DEFAULT_CAP = 4;
const FRESH_MS = 2 * 60 * 60 * 1000;
const COUNT = /^\d+$/;

/** 帳本路徑。 */
export function ledgerPath(env = process.env) {
  return env.PILOT_WORKERS_LEDGER || join(homedir(), '.local/state/pilot-workers.tsv');
}

/** 上限；設了卻不是正整數時傳回 undefined（用法錯誤）。 */
export function machineCap(env = process.env) {
  const value = env.PILOT_MACHINE_WORKER_CAP;
  if (value === undefined || value === '') return DEFAULT_CAP;
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

/** 帳本的每一列 `{ repo, running, time, line }`；解析不了的列 running 是 NaN，原文留在 line。 */
export function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    const [repo, running, time] = line.split('\t');
    return { repo, running: COUNT.test(running ?? '') ? Number(running) : NaN, time: Date.parse(time ?? ''), line };
  });
}

/** 合計：只算 2 小時內更新過、格式正確的列。 */
export function machineTotal(rows, now = new Date()) {
  return rows.filter(row => Number.isFinite(row.running) && Number.isFinite(row.time) && now.getTime() - row.time <= FRESH_MS)
    .reduce((sum, row) => sum + row.running, 0);
}

/** 改寫 <repo> 那一列（沒有就加在最後），其他列原樣保留；傳回改寫後的 `{ total, cap }`。 */
export function report(file, repo, running, { now = new Date(), cap = machineCap() } = {}) {
  if (cap === undefined) throw new Error(`PILOT_MACHINE_WORKER_CAP 不是正整數：${process.env.PILOT_MACHINE_WORKER_CAP}`);
  const rows = readLedger(file);
  const mine = `${repo}\t${running}\t${now.toISOString()}`;
  const lines = rows.some(row => row.repo === repo) ? rows.map(row => (row.repo === repo ? mine : row.line)) : [...rows.map(row => row.line), mine];
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${lines.join('\n')}\n`);
  renameSync(temp, file);
  return { total: machineTotal(readLedger(file), now), cap };
}

/** 派工前檢查：`{ ok, total, cap }`，total 已含新增人數。 */
export function check(file, add, { now = new Date(), cap = machineCap() } = {}) {
  const total = machineTotal(readLedger(file), now) + add;
  return { ok: total <= cap, total, cap };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const cap = machineCap();
  const valid = cap !== undefined && (command === 'report'
    ? rest.length === 2 && rest[0] && !/[\t\n]/.test(rest[0]) && COUNT.test(rest[1])
    : command === 'check' && rest.length === 1 && COUNT.test(rest[0]));
  if (!valid) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const file = ledgerPath();
    if (command === 'report') {
      const { total } = report(file, rest[0], Number(rest[1]), { cap });
      console.log(`REPORTED ${rest[0]} ${rest[1]} ${total}/${cap}`);
    } else {
      const { ok, total } = check(file, Number(rest[0]), { cap });
      console.log(ok ? `CAPACITY ok ${total}/${cap}` : `STOP capacity ${total}/${cap}`);
      if (!ok) process.exit(4);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
