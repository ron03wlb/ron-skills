#!/usr/bin/env node
// setup-workflow 正本（#178）：整台機器同時跑的 pilot worker 合計上限。同一台機器上的多個 coordinator（不同 repo 的 /issue-pilot、
// /issue-cycle）共用一本帳，每個 coordinator 每輪只改寫自己那一列，派工前合計所有 repo 的列再加上這次要派的人數。
// 上限依據：`bin/check` 的 node --test 預設開 availableParallelism()-1 個並行程序，worker 越多 load 疊得越高，
// 10 核的機器上 8 個 worker 時 load 約 90，計時測試會失敗（#178）。
//
// 帳本：$PILOT_WORKERS_LEDGER，沒設時 ~/.local/state/pilot-workers.tsv；每列 `<repo>\t<running>\t<ISO 時間>`。
//   超過 2 小時沒更新的列（coordinator 已經停了）與解析不了的列不算進合計，也不刪。改寫時先寫暫存檔再 rename，讀的一方不會讀到半份；
//   讀、改、寫整段持有 `<帳本>.lock` 目錄鎖（mkdir），兩個 coordinator 同時 report 也不會蓋掉對方的列；鎖超過 30 秒沒放（持有者被殺）視為遺留、拿掉重來，
//   等 10 秒還拿不到就失敗（exit 1）。
// 上限：$PILOT_MACHINE_WORKER_CAP，沒設時 4；CLI 的 report、check 這時先印 `CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP` 再用 4（#396）。
// 環境變數（#396）：Bash tool 的 shell 不讀 ~/.zshrc，寫在那裡的變數在 coordinator 那裡是空的，容量檢查會默默用預設值或略過別的 repo；
//   每台機器把這些變數設在 Bash tool 讀得到的地方（使用者層級 ~/.claude/settings.json 的 `env`）。
//   `env [<名稱>...]` 檢查 $PILOT_MACHINE_WORKER_CAP 與帶入的名稱（例如 INVESTING_DATA_ROOT），空白（未設或空字串）的各印一行
//   `CAPACITY_ENV_MISSING <名稱>`，都有值時印 `CAPACITY_ENV ok`；只回報，exit 0。
// 匯出的 report 另有 `add` 選項（#353，pilot-dispatch.mjs 派出後用）：寫入的是那一列的現值（2 小時內更新過才算）加上人數，讀寫在同一把鎖裡。
//
// 用法：node scripts/pilot-capacity.mjs report <repo> <running>
//       node scripts/pilot-capacity.mjs check <新增人數>
//       node scripts/pilot-capacity.mjs env [<環境變數名稱>...]
// stdout：$PILOT_MACHINE_WORKER_CAP 空白時 report、check 先印 `CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP`；env 見上；report 印 `REPORTED <repo> <running> <合計>/<上限>`；
//         check 在「合計＋新增人數」不超過上限時印 `CAPACITY ok <合計>/<上限>`，超過時印 `STOP capacity <合計>/<上限> [<repo>=<n>...] +<新增人數>`（合計已含新增人數；中間列出計入且 running 大於 0 的列，#408）。
// exit：0 report 完成、CAPACITY ok 或 env；4 STOP capacity；2 用法錯誤；1 其他失敗（讀寫帳本失敗）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/pilot-capacity.mjs report <repo> <running> | check <新增人數> | env [<環境變數名稱>...]（帳本 $PILOT_WORKERS_LEDGER，上限 $PILOT_MACHINE_WORKER_CAP，預設 4）';
export const DEFAULT_CAP = 4;
const FRESH_MS = 2 * 60 * 60 * 1000;
const COUNT = /^\d+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CAP_ENV = 'PILOT_MACHINE_WORKER_CAP';
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 10 * 1000;

/** repo 名稱寫進帳本的一格：不能空、不能有 tab 或換行。 */
export function validRepo(repo) {
  return typeof repo === 'string' && repo !== '' && !/[\t\n\r]/.test(repo);
}

/** 持有 `<file>.lock` 目錄鎖執行 fn。 */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      // 先改名成自己的名稱再刪：兩個等待者同時判定遺留時，只有一個 rename 得到，另一個不會刪掉對方剛拿到的新鎖。
      if (age > LOCK_STALE_MS) {
        const stale = `${lock}.stale.${process.pid}`;
        try { renameSync(lock, stale); } catch { continue; }
        rmSync(stale, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`帳本鎖 ${lock} 等了 ${LOCK_WAIT_MS / 1000} 秒還在`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** 帳本路徑。 */
export function ledgerPath(env = process.env) {
  return env.PILOT_WORKERS_LEDGER || join(homedir(), '.local/state/pilot-workers.tsv');
}

/** names 裡值空白（未設或空字串）的環境變數名稱，順序不變（#396）。 */
export function missingEnv(names, env = process.env) {
  return names.filter(name => env[name] === undefined || env[name] === '');
}

/** names（預設只有 $PILOT_MACHINE_WORKER_CAP）裡空白的各一行 `CAPACITY_ENV_MISSING <名稱>`，都有值時是空陣列（#396：不再默默用預設值）。 */
export function envMissingLines(names = [CAP_ENV], env = process.env) {
  return missingEnv(names, env).map(name => `CAPACITY_ENV_MISSING ${name}`);
}

/** 上限；設了卻不是正整數時傳回 undefined（用法錯誤）。 */
export function machineCap(env = process.env) {
  const value = env[CAP_ENV];
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

/** 算進合計的列：2 小時內更新過、格式正確。 */
const counted = (rows, now) => rows.filter(row => Number.isFinite(row.running) && Number.isFinite(row.time) && now.getTime() - row.time <= FRESH_MS);

/** 合計：只算 2 小時內更新過、格式正確的列。 */
export function machineTotal(rows, now = new Date()) {
  return counted(rows, now).reduce((sum, row) => sum + row.running, 0);
}

/** STOP capacity 行：合計之後列出計入的列（running 大於 0 的 `<repo>=<n>`，依帳本順序）與這次新增的人數，一眼看出佔名額的是誰（#408）。 */
export function stopLine({ total, cap, rows, add }) {
  return ['STOP capacity', `${total}/${cap}`, ...rows.map(row => `${row.repo}=${row.running}`), `+${add}`].join(' ');
}

/**
 * 改寫 <repo> 那一列（沒有就加在最後），其他列原樣保留；傳回改寫後的 `{ running, total, cap }`。
 * `add` 為真時寫入的是那一列的現值（2 小時內更新過才算，否則 0）加上 `running`，讀與寫在同一把鎖裡（#353：dispatch 派出後加上派出人數）。
 */
export function report(file, repo, running, { now = new Date(), cap = machineCap(), add = false } = {}) {
  if (cap === undefined) throw new Error('上限不是正整數（$PILOT_MACHINE_WORKER_CAP）');
  if (!validRepo(repo)) throw new Error(`repo 名稱不能空、不能有 tab 或換行：${JSON.stringify(repo)}`);
  mkdirSync(dirname(file), { recursive: true });
  const rows = withLock(file, () => {
    const before = readLedger(file);
    if (add) running += machineTotal(before.filter(row => row.repo === repo), now);
    const mine = `${repo}\t${running}\t${now.toISOString()}`;
    const lines = before.some(row => row.repo === repo) ? before.map(row => (row.repo === repo ? mine : row.line)) : [...before.map(row => row.line), mine];
    const temp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${lines.join('\n')}\n`);
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    return readLedger(file);
  });
  return { running, total: machineTotal(rows, now), cap };
}

/** 派工前檢查：`{ ok, total, cap, rows, add }`，total 已含新增人數，rows 是計入且 running 大於 0 的列。 */
export function check(file, add, { now = new Date(), cap = machineCap() } = {}) {
  const ledger = readLedger(file);
  const total = machineTotal(ledger, now) + add;
  return { ok: total <= cap, total, cap, rows: counted(ledger, now).filter(row => row.running > 0), add };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const cap = machineCap();
  // env 只檢查名稱，上限寫壞也照跑；report、check 要上限是正整數。
  const validators = {
    env: () => rest.every(name => ENV_NAME.test(name)),
    report: () => cap !== undefined && rest.length === 2 && validRepo(rest[0]) && COUNT.test(rest[1]),
    check: () => cap !== undefined && rest.length === 1 && COUNT.test(rest[0]),
  };
  const valid = Object.hasOwn(validators, command) && validators[command]();
  if (!valid) {
    console.error(USAGE);
    process.exit(2);
  }
  if (command === 'env') {
    const lines = envMissingLines([...new Set([CAP_ENV, ...rest])]);
    console.log(lines.length ? lines.join('\n') : 'CAPACITY_ENV ok');
    process.exit(0);
  }
  for (const line of envMissingLines()) console.log(line);
  try {
    const file = ledgerPath();
    if (command === 'report') {
      const { total } = report(file, rest[0], Number(rest[1]), { cap });
      console.log(`REPORTED ${rest[0]} ${rest[1]} ${total}/${cap}`);
    } else {
      const result = check(file, Number(rest[0]), { cap });
      console.log(result.ok ? `CAPACITY ok ${result.total}/${cap}` : stopLine(result));
      if (!result.ok) process.exit(4);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
