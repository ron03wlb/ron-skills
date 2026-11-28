#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（#178）：整台機器同時跑的 pilot worker 合計上限。同一台機器上的多個 coordinator（不同 repo 的 /issue-pilot、
// /issue-cycle）共用一本帳，每個 coordinator 每輪只改寫自己那一列，派工前合計所有 repo 的列再加上這次要派的人數。
// 上限依據：`bin/check` 的 node --test 預設開 availableParallelism()-1 個並行程序，worker 越多 load 疊得越高，
// 10 核的機器上 8 個 worker 時 load 約 90，計時測試會失敗（#178）。
//
// 帳本：$PILOT_WORKERS_LEDGER，沒設時 ~/.local/state/pilot-workers.tsv；每列 `<repo>\t<running>\t<ISO 時間>`。
//   超過 2 小時沒更新的列（coordinator 已經停了）與解析不了的列不算進合計，也不刪。改寫時先寫暫存檔再 rename，讀的一方不會讀到半份；
//   讀、改、寫整段持有 `<帳本>.lock` 目錄鎖（mkdir），兩個 coordinator 同時 report 也不會蓋掉對方的列；鎖超過 30 秒沒放（持有者被殺）視為遺留、拿掉重來，
//   等 10 秒還拿不到就失敗（exit 1）。
// 上限：$PILOT_MACHINE_WORKER_CAP，沒設時 4；CLI 的 report、check 這時先印 `CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP default 4 → 告訴人：設在 ~/.claude/settings.json 的 env` 再用 4（#396）。
// 環境變數（#396）：Bash tool 的 shell 不讀 ~/.zshrc，寫在那裡的變數在 coordinator 那裡是空的，容量檢查會默默用預設值或略過別的 repo；
//   每台機器把這些變數設在 Bash tool 讀得到的地方（使用者層級 ~/.claude/settings.json 的 `env`）。
//   `env [<名稱>...]` 檢查 $PILOT_MACHINE_WORKER_CAP 與帶入的名稱（例如 INVESTING_DATA_ROOT），空白（未設或空字串）的各印一行
//   `CAPACITY_ENV_MISSING <名稱>[ default <預設>] → 告訴人：設在 ~/.claude/settings.json 的 env`（#494：處理方式寫在行裡，coordinator 看到行就知道要在 Report 告訴人設哪裡，
//   不自己改使用者的設定；有預設值的變數附 `default <預設>`），都有值時印 `CAPACITY_ENV ok`；只回報，exit 0。
// 匯出的 report 另有 `add` 選項（#353，pilot-dispatch.mjs 派出後用）：寫入的是那一列的現值（2 小時內更新過才算）加上人數，讀寫在同一把鎖裡。
// session 列（#622）：batch 成員以外、同樣跑完整檢查的分頁（tooling fix unit、`/retro-collect` 收集者）各記一列
//   `session\t<repo>\t<kind>\t<handle>\t<ISO 時間>`（kind 是 fix 或 retro），每列算 1 個，和 repo 列同一本帳、同一把鎖；
//   orca-session-split.mjs `--capacity <repo> --kind <kind>` 開分頁成功後 open，pilot-probe.mjs `--capacity <repo>` 每輪對自己 repo 的 session 列
//   讀 terminal：已 exited 或分頁已不在就 close，還在跑就刷新時間。超過 2 小時沒刷新的 session 列不計，任何一次改寫帳本時順手刪掉。
//   第一欄 `session` 是保留字，不能當 repo 名稱；還沒同步這一版的副本把 session 列當成解析不了的列（不計、原樣保留）。
//
// 用法：node scripts/pilot-capacity.mjs report <repo> <running>
//       node scripts/pilot-capacity.mjs check <新增人數>
//       node scripts/pilot-capacity.mjs open <repo> fix|retro <handle>
//       node scripts/pilot-capacity.mjs close <handle>
//       node scripts/pilot-capacity.mjs env [<環境變數名稱>...]
// stdout：$PILOT_MACHINE_WORKER_CAP 空白時 report、check 先印 `CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP default 4 → 告訴人：…`（同上）；env 見上；report 印 `REPORTED <repo> <running> <合計>/<上限>`；
//         check 在「合計＋新增人數」不超過上限時印 `CAPACITY ok <合計>/<上限>`，超過時印 `STOP capacity <合計>/<上限> [<repo>=<n>...] +<新增人數>`（合計已含新增人數；中間列出計入且 running 大於 0 的列，#408；
//         session 列依 repo 與 kind 合成 `<repo>:<kind>=<n>`，#622）；
//         open 印 `SESSION_OPENED <handle> <repo> <kind> <合計>/<上限>`（同一個 handle 再 open 只刷新那一列）；close 印 `SESSION_CLOSED <handle>`，沒有這列時 `SESSION_NONE <handle>`。
//         open 只記帳、不檢查上限：開之前先 check 1（orca-session-split.mjs 的 --capacity 這樣做）。
// exit：0 report、open、close 完成、CAPACITY ok 或 env；4 STOP capacity；2 用法錯誤；1 其他失敗（讀寫帳本失敗）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/pilot-capacity.mjs report <repo> <running> | check <新增人數> | open <repo> fix|retro <handle> | close <handle> | env [<環境變數名稱>...]（帳本 $PILOT_WORKERS_LEDGER，上限 $PILOT_MACHINE_WORKER_CAP，預設 4）';
export const DEFAULT_CAP = 4;
const FRESH_MS = 2 * 60 * 60 * 1000;
const COUNT = /^\d+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CAP_ENV = 'PILOT_MACHINE_WORKER_CAP';
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 10 * 1000;
/** session 列的第一欄（#622）。 */
export const SESSION = 'session';
/** session 列的 kind：tooling fix unit 與 /retro-collect 收集者。 */
export const SESSION_KINDS = ['fix', 'retro'];
const HANDLE = /^[^\s]+$/;

/** repo 名稱寫進帳本的一格：不能空、不能有 tab 或換行，也不能是 session 列的保留字。 */
export function validRepo(repo) {
  return typeof repo === 'string' && repo !== '' && repo !== SESSION && !/[\t\n\r]/.test(repo);
}

/** session 列的 handle：不能空、不能有空白。 */
export const validHandle = handle => typeof handle === 'string' && HANDLE.test(handle);

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

/** 缺變數時告訴人的處理方式（#494）：設定位置見檔頭的環境變數段。 */
export const ENV_HOWTO = '→ 告訴人：設在 ~/.claude/settings.json 的 env';

/**
 * names（預設只有 $PILOT_MACHINE_WORKER_CAP）裡空白的各一行 `CAPACITY_ENV_MISSING <名稱>[ default <預設>] <ENV_HOWTO>`，都有值時是空陣列
 * （#396：不再默默用預設值；#494：行裡自帶預設值與處理方式）。
 */
export function envMissingLines(names = [CAP_ENV], env = process.env) {
  return missingEnv(names, env).map(name => ['CAPACITY_ENV_MISSING', name, ...(name === CAP_ENV ? ['default', DEFAULT_CAP] : []), ENV_HOWTO].join(' '));
}

/** 上限；設了卻不是正整數時傳回 undefined（用法錯誤）。 */
export function machineCap(env = process.env) {
  const value = env[CAP_ENV];
  if (value === undefined || value === '') return DEFAULT_CAP;
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

/**
 * 帳本的每一列 `{ repo, running, time, line }`；解析不了的列 running 是 NaN，原文留在 line。
 * session 列另有 `session: true`、`kind`、`handle`，running 是 1（kind 或 handle 不合法時 NaN）。
 */
export function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    const cells = line.split('\t');
    if (cells[0] === SESSION) {
      const [, repo, kind, handle, time] = cells;
      const ok = cells.length === 5 && validRepo(repo) && SESSION_KINDS.includes(kind) && validHandle(handle);
      return { session: true, repo, kind, handle, running: ok ? 1 : NaN, time: Date.parse(time ?? ''), line };
    }
    const [repo, running, time] = cells;
    return { repo, running: COUNT.test(running ?? '') ? Number(running) : NaN, time: Date.parse(time ?? ''), line };
  });
}

const fresh = (row, now) => Number.isFinite(row.time) && now.getTime() - row.time <= FRESH_MS;

/** 算進合計的列：2 小時內更新過、格式正確。 */
const counted = (rows, now) => rows.filter(row => Number.isFinite(row.running) && fresh(row, now));

/** 帳本裡的 session 列（不論新舊）。 */
export const sessionRows = rows => rows.filter(row => row.session);

/** 寫回帳本（先寫暫存檔再 rename）；超過 2 小時沒刷新的 session 列不寫回（#622）。 */
function writeLedger(file, rows, now) {
  const lines = rows.filter(row => !row.session || fresh(row, now)).map(row => row.line);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, lines.length ? `${lines.join('\n')}\n` : '');
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** 合計：只算 2 小時內更新過、格式正確的列。 */
export function machineTotal(rows, now = new Date()) {
  return counted(rows, now).reduce((sum, row) => sum + row.running, 0);
}

/** 計入且 running 大於 0 的列，依帳本順序；session 列依 repo 與 kind 合成一列 `{ repo: '<repo>:<kind>', running: <列數> }`（#622）。 */
export function holders(rows, now = new Date()) {
  const out = [];
  const merged = new Map();
  for (const row of counted(rows, now).filter(row => row.running > 0)) {
    if (!row.session) { out.push({ repo: row.repo, running: row.running }); continue; }
    const label = `${row.repo}:${row.kind}`;
    if (merged.has(label)) merged.get(label).running++;
    else { const entry = { repo: label, running: 1 }; merged.set(label, entry); out.push(entry); }
  }
  return out;
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
    const own = row => !row.session && row.repo === repo;
    if (add) running += machineTotal(before.filter(own), now);
    const mine = { line: `${repo}\t${running}\t${now.toISOString()}` };
    writeLedger(file, before.some(own) ? before.map(row => (own(row) ? mine : row)) : [...before, mine], now);
    return readLedger(file);
  });
  return { running, total: machineTotal(rows, now), cap };
}

/** 持有帳本鎖改寫 session 列：fn(rows) 回新的列；沒有帳本時建出來。傳回改寫後的列。 */
function rewrite(file, now, fn) {
  mkdirSync(dirname(file), { recursive: true });
  return withLock(file, () => {
    writeLedger(file, fn(readLedger(file)), now);
    return readLedger(file);
  });
}

const sessionLine = ({ repo, kind, handle }, now) => [SESSION, repo, kind, handle, now.toISOString()].join('\t');

/** 記一筆 session（同一個 handle 已有就改寫那一列）；傳回 `{ total, cap }`（#622）。不檢查上限，開分頁前由呼叫者先 check。 */
export function openSession(file, { repo, kind, handle }, { now = new Date(), cap = machineCap() } = {}) {
  if (cap === undefined) throw new Error('上限不是正整數（$PILOT_MACHINE_WORKER_CAP）');
  if (!validRepo(repo)) throw new Error(`repo 名稱不能空、不能有 tab 或換行、不能是 ${SESSION}：${JSON.stringify(repo)}`);
  if (!SESSION_KINDS.includes(kind)) throw new Error(`kind 只能是 ${SESSION_KINDS.join('|')}：${JSON.stringify(kind)}`);
  if (!validHandle(handle)) throw new Error(`handle 不能空、不能有空白：${JSON.stringify(handle)}`);
  const mine = { session: true, repo, kind, handle, line: sessionLine({ repo, kind, handle }, now), time: now.getTime() };
  const rows = rewrite(file, now, rows => (rows.some(row => row.session && row.handle === handle)
    ? rows.map(row => (row.session && row.handle === handle ? mine : row)) : [...rows, mine]));
  return { total: machineTotal(rows, now), cap };
}

/** 刪掉 handle 的 session 列；有刪到時 true。 */
export function closeSession(file, handle, { now = new Date() } = {}) {
  let found = false;
  rewrite(file, now, rows => rows.filter(row => {
    const hit = row.session && row.handle === handle;
    found ||= hit;
    return !hit;
  }));
  return found;
}

/** 把 handles 的 session 列時間刷新成 now；傳回刷新到的 handle（依帳本順序）。 */
export function touchSessions(file, handles, { now = new Date() } = {}) {
  const touched = [];
  rewrite(file, now, rows => rows.map(row => {
    if (!row.session || !handles.includes(row.handle)) return row;
    touched.push(row.handle);
    return { ...row, time: now.getTime(), line: sessionLine(row, now) };
  }));
  return touched;
}

/** 派工前檢查：`{ ok, total, cap, rows, add }`，total 已含新增人數，rows 是計入且 running 大於 0 的列（session 列合成 `<repo>:<kind>`，見 holders）。 */
export function check(file, add, { now = new Date(), cap = machineCap() } = {}) {
  const ledger = readLedger(file);
  const total = machineTotal(ledger, now) + add;
  return { ok: total <= cap, total, cap, rows: holders(ledger, now), add };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const cap = machineCap();
  // env 只檢查名稱，上限寫壞也照跑；report、check 要上限是正整數。
  const validators = {
    env: () => rest.every(name => ENV_NAME.test(name)),
    report: () => cap !== undefined && rest.length === 2 && validRepo(rest[0]) && COUNT.test(rest[1]),
    check: () => cap !== undefined && rest.length === 1 && COUNT.test(rest[0]),
    open: () => cap !== undefined && rest.length === 3 && validRepo(rest[0]) && SESSION_KINDS.includes(rest[1]) && validHandle(rest[2]),
    close: () => rest.length === 1 && validHandle(rest[0]),
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
  try {
    const file = ledgerPath();
    if (command === 'close') {
      console.log(`${closeSession(file, rest[0]) ? 'SESSION_CLOSED' : 'SESSION_NONE'} ${rest[0]}`);
      process.exit(0);
    }
    for (const line of envMissingLines()) console.log(line);
    if (command === 'open') {
      const { total } = openSession(file, { repo: rest[0], kind: rest[1], handle: rest[2] }, { cap });
      console.log(`SESSION_OPENED ${rest[2]} ${rest[0]} ${rest[1]} ${total}/${cap}`);
    } else if (command === 'report') {
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
