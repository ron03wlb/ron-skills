#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（CoS item 67）：全機共用的重型檢查 slot。同一台機器上的每個 repo（ron-skills、spay2…）跑重型檢查（bin/check、
// check-contracts…）前都經它拿 slot，全機同時最多 N 支；各 repo 自己限流擋不住彼此（WSL 16 核 load 到 110、OOM 三次）。
// 實作：每個 slot 一個鎖檔 `<dir>/slot-<i>.lock`，以 perl 的 flock(2) 拿排他鎖（macOS 沒有 flock(1)，perl 兩邊都有）。
// 鎖由一支 perl 子行程持有，它的 stdin 接本行程：本行程結束（含被 SIGKILL）時 stdin 關閉，perl 讀到 EOF 就結束，核心隨即釋放 flock；
// perl 自己被殺也一樣由核心釋放。所以行程死掉不會留下佔住的 slot，不必清鎖檔。
// 持有者把 `{ label, pid, cwd, since }` 寫進自己的鎖檔，排隊者寫 `<dir>/wait-<pid>.json`（拿到 slot 或結束時刪掉；行程已不在的由 status 略過並清掉）。
// 巢狀：在 slot 裡跑的命令帶環境變數 HEAVY_SLOT_HELD；裡面再呼叫 run（例如 bin/check 的測試跑 pre-commit）時直接執行，不再拿第二個 slot（避免 N 個持有者互等）。
//
// 用法：node scripts/heavy-slot.mjs run --label <repo>:<用途> [--timeout <秒>] [--interval <秒>] -- <command> [<arg>...]
//       node scripts/heavy-slot.mjs status
//       node scripts/heavy-slot.mjs stats [--since <ISO 時間>] [--label <glob>]
//   run     拿到 slot 才執行 <command>（不經 shell；要 shell 時寫 `-- sh -c '<指令>'`），結束就釋放，exit code 照傳（被信號殺掉時 128+信號值）。
//           等待中收到 SIGINT／SIGTERM 就放棄排隊並以 128+信號值結束；執行中收到的信號轉給 <command>。
//   --label <repo>:<用途>（必填，[A-Za-z0-9_.:@/-]）：status 與 SLOT_WAIT 顯示的名字，例如 `ron-skills:pre-commit`、`spay2:check-contracts`。
//   --timeout 等待上限秒數（預設 $HEAVY_CHECK_TIMEOUT，再來 1800；0 是不設上限）；--interval SLOT_WAIT 的間隔秒數（預設 $HEAVY_CHECK_WAIT_INTERVAL，再來 30）。
//   status  列出每個 slot 的持有者與排隊者。
//   stats   讀量測 log，依 label 印件數與 wait_ms、run_ms 的中位數、P90（nearest-rank）；--since 只算 started_at 在它之後的，--label 是 glob（`*`、`?`）。
// slot 數（全機一個設定）：$HEAVY_CHECK_SLOTS（測試用）＞ ~/.config/orca-heavy-check/slots（內容是一個正整數）＞ 2。adapter 不宣告 slot 數，只宣告哪些檢查經 slot 跑。
// 鎖檔目錄：$HEAVY_CHECK_DIR，預設 ~/.local/state/orca-heavy-check。不用 /tmp、~/.cache（會被清理：持有中的鎖檔被刪，下一個行程建新的同名檔
//   就 flock 得到，兩支同時在 slot 裡），也不用 $XDG_RUNTIME_DIR（git hook、cron、Orca 分頁不一定都有它，有的有、有的沒有就分成兩組 slot）。
// 其他環境變數：HEAVY_CHECK_TIMEOUT、HEAVY_CHECK_WAIT_INTERVAL。
// 量測 log：每次 run 拿到 slot 並結束、或等到逾時，在鎖檔目錄的 log.jsonl 追加一行
//   `{ label, repo（label 冒號前）, pid, wait_ms, run_ms, exit, load1（拿到 slot 時的 1 分鐘 load；逾時時是放棄時的）, started_at（開始排隊，ISO）, timed_out }`。
//   寫不進去只略過，不影響命令與 exit code。巢狀（SLOT_NESTED）與 SLOT_UNAVAILABLE 不記。
// stderr（run；命令自己的輸出照原樣）：
//   SLOT_WAIT <label> <已等秒數>s holders=<label>@<pid>:<已持有秒數>s[,…]   排隊中，每 interval 秒一行（第一行在等滿 interval 時）；holders 沒人時是 `-`
//   SLOT_ACQUIRED <label> slot-<i>/<N> waited=<秒數>s                       拿到 slot，接著執行命令（量排隊時間用）
//   SLOT_TIMEOUT <label> <已等秒數>s holders=…                               等到上限，不執行命令，exit 75：呼叫端當負載關卡處理（稍後重跑），不是檢查失敗
//   SLOT_NESTED <label> held=<外層>                                          已在 slot 裡（HEAVY_SLOT_HELD），直接執行
//   SLOT_UNAVAILABLE <label> <原因>                                          沒有 perl 或鎖檔目錄建不了，不限流、直接執行
// stdout（status）：`SLOTS <忙>/<N> dir=<目錄>`，每個持有者 `HOLDER slot-<i> <label> pid=<pid> held=<秒數>s cwd=<目錄>`，
//   每個排隊者 `WAITER <label> pid=<pid> waited=<秒數>s cwd=<目錄>`。
// stdout（stats）：每個 label 一行（依 label 排序）`STATS <label> n=<件數> timeouts=<逾時件數> wait_p50=<ms> wait_p90=<ms> run_p50=<ms> run_p90=<ms>`
//   （run 只算拿到 slot 的件數，沒有時印 `-`）；沒有任何符合的紀錄時印 `STATS none`。
// 不提供 acquire／release：wrapper 已涵蓋兩個 repo 的入口；而且 Claude 的每次 Bash 呼叫是新的行程，
//   「acquire 的行程死掉就釋放」與「跨呼叫持有」互斥，只能靠常駐的持有者，又會回到行程死了 slot 卻沒放的風險。
// exit：run 是命令的 exit code，75 等待逾時，2 用法錯誤；status、stats 0，2 用法錯誤。
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { constants, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/heavy-slot.mjs run --label <repo>:<用途> [--timeout <秒>] [--interval <秒>] -- <command> [<arg>...]｜node scripts/heavy-slot.mjs status｜node scripts/heavy-slot.mjs stats [--since <ISO>] [--label <glob>]';

/** 等待逾時的 exit code（EX_TEMPFAIL）：呼叫端以它加 SLOT_TIMEOUT 行判斷，不當成檢查失敗。 */
export const SLOT_TIMEOUT_EXIT = 75;
const LABEL = /^[\w.:@/-]+$/;
/** perl 輪詢鎖檔的間隔秒數。 */
const POLL = process.env.HEAVY_CHECK_POLL || '1';

const SCRIPT = fileURLToPath(import.meta.url);

// 依序試每個鎖檔，拿到就清空鎖檔、印 ACQUIRED <i>（持有者資訊由本程式接著寫入），然後讀 stdin 直到 EOF（呼叫者結束或關閉 stdin）才結束、釋放。
// 排隊時父行程不在了（getppid 變了）就結束，不留孤兒輪詢。
const HOLDER = `use strict; use Fcntl qw(:flock);
$| = 1;
my ($poll, @files) = @ARGV;
my $parent = getppid();
while (1) {
  for my $i (0 .. $#files) {
    open(my $fh, '>>', $files[$i]) or die "open $files[$i]: $!\\n";
    if (flock($fh, LOCK_EX | LOCK_NB)) {
      truncate($fh, 0);
      print "ACQUIRED $i\\n";
      1 while <STDIN>;
      exit 0;
    }
    close($fh);
  }
  exit 3 if getppid() != $parent;
  select(undef, undef, undef, $poll);
}`;

// 每個鎖檔一行 busy 或 free：拿得到共用鎖就是沒人持有（立刻放掉）。
const PROBE = `use strict; use Fcntl qw(:flock);
for my $f (@ARGV) {
  my $fh;
  if (!open($fh, '<', $f)) { print "free\\n"; next; }
  print flock($fh, LOCK_SH | LOCK_NB) ? "free\\n" : "busy\\n";
  close($fh);
}`;

const home = env => env.HOME || homedir();

/** 鎖檔目錄：$HEAVY_CHECK_DIR，預設 ~/.local/state/orca-heavy-check。 */
export const slotDir = (env = process.env) => env.HEAVY_CHECK_DIR || join(home(env), '.local/state/orca-heavy-check');

/** 全機的 slot 數設定檔。 */
export const slotsFile = (env = process.env) => join(home(env), '.config/orca-heavy-check/slots');

/** slot 數：$HEAVY_CHECK_SLOTS ＞ ~/.config/orca-heavy-check/slots ＞ 2；取到的值不是正整數時 undefined。 */
export function slotCount(env = process.env) {
  let value = env.HEAVY_CHECK_SLOTS;
  if (value === undefined) {
    try { value = readFileSync(slotsFile(env), 'utf8').trim(); } catch { value = '2'; }
  }
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

/** 量測 log 追加一行；失敗只略過。 */
function logRun(dir, record) {
  try { appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(record)}\n`); } catch { /* 不影響命令 */ }
}

/** nearest-rank 百分位；空陣列時 undefined。 */
export function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const globRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** log.jsonl 的內容 → 依 label 的統計行；since 是 ISO 時間、label 是 glob，都可省略。壞掉的行略過。 */
export function statsLines(text, { since, label } = {}) {
  const sinceMs = since ? Date.parse(since) : undefined;
  const match = label ? globRegExp(label) : undefined;
  const groups = new Map();
  for (const line of text.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record.label !== 'string') continue;
    if (sinceMs !== undefined && !(Date.parse(record.started_at) >= sinceMs)) continue;
    if (match && !match.test(record.label)) continue;
    if (!groups.has(record.label)) groups.set(record.label, []);
    groups.get(record.label).push(record);
  }
  if (!groups.size) return ['STATS none'];
  const show = value => (value === undefined ? '-' : String(value));
  return [...groups.keys()].sort().map(name => {
    const records = groups.get(name);
    const waits = records.map(r => r.wait_ms).filter(Number.isFinite);
    const runs = records.filter(r => !r.timed_out).map(r => r.run_ms).filter(Number.isFinite);
    return `STATS ${name} n=${records.length} timeouts=${records.filter(r => r.timed_out).length} wait_p50=${show(percentile(waits, 50))} wait_p90=${show(percentile(waits, 90))} run_p50=${show(percentile(runs, 50))} run_p90=${show(percentile(runs, 90))}`;
  });
}

const lockFiles = (dir, slots) => Array.from({ length: slots }, (_, i) => join(dir, `slot-${i + 1}.lock`));
const seconds = ms => Math.floor(ms / 1000);
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

/**
 * 目前的持有者與排隊者：{ holders: [{ slot, label, pid, cwd, since }], waiters: [{ label, pid, cwd, since }] }。
 * 持有者以 flock 判斷（鎖檔內容可能是上一個持有者留下的）；排隊者的 pid 已不在時刪掉它的檔。沒有 perl 時丟出。
 */
export function readSlots({ dir = slotDir(), slots = slotCount() ?? 2 } = {}) {
  const files = lockFiles(dir, slots);
  const probe = spawnSync('perl', ['-e', PROBE, ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (probe.error) throw probe.error;
  const states = probe.stdout.trim().split('\n');
  const holders = files.flatMap((file, i) => states[i] === 'busy' ? [{ slot: i + 1, label: '?', ...readJson(file) }] : []);
  let names = [];
  try { names = readdirSync(dir).filter(name => /^wait-\d+\.json$/.test(name)); } catch { /* 目錄還沒建 */ }
  const waiters = names.flatMap(name => {
    const info = readJson(join(dir, name));
    const pid = Number(name.match(/\d+/)[0]);
    if (!alive(pid)) { rmSync(join(dir, name), { force: true }); return []; }
    return info ? [{ ...info, pid }] : [];
  });
  return { holders, waiters };
}

/** SLOT_WAIT／SLOT_TIMEOUT 的 holders 欄：`<label>@<pid>:<秒數>s`，逗號分隔；沒人時 `-`。 */
export function holdersField(holders, now = Date.now()) {
  if (!holders.length) return '-';
  return holders.map(h => `${h.label}@${h.pid ?? '?'}:${h.since ? seconds(now - Date.parse(h.since)) : '?'}s`).join(',');
}

/**
 * 給呼叫端（pilot-land.mjs、land.mjs）組出經 slot 執行 argv 的 [command, args]：同目錄的本程式 `run --label <label> -- <argv>`。
 * timeoutSec 有給時帶 --timeout。label 裡 --label 不收的字元（目錄名的空白、中文）換成 `_`，否則 run 以用法錯誤 exit 2、被當成檢查沒過。
 */
export function slotCommand(label, argv, { timeoutSec } = {}) {
  return [process.execPath, [SCRIPT, 'run', '--label', label.replace(/[^\w.:@/-]/g, '_'), ...(timeoutSec === undefined ? [] : ['--timeout', String(timeoutSec)]), '--', ...argv]];
}

/** 呼叫端的輸出是不是 slot 等待逾時（exit 75 而且有 SLOT_TIMEOUT 行）；是的話傳回那一行，否則 undefined。 */
export function slotTimeoutLine(code, output) {
  return code === SLOT_TIMEOUT_EXIT ? String(output).match(/^SLOT_TIMEOUT .*$/m)?.[0] : undefined;
}

/** 命令列 → { command: 'run', label, timeoutSec, intervalSec, argv } 或 { command: 'status' }；錯誤時 { error }。 */
export function parseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === 'status') return rest.length ? { error: 'status 不接參數' } : { command };
  if (command === 'stats') {
    const options = { command };
    for (let i = 0; i < rest.length; i += 2) {
      const [flag, value] = [rest[i], rest[i + 1]];
      if (value === undefined) return { error: `${flag} 要有值` };
      if (flag === '--since') {
        if (Number.isNaN(Date.parse(value))) return { error: `--since 要是 ISO 時間：${value}` };
        options.since = value;
      } else if (flag === '--label') options.label = value;
      else return { error: `不認得的選項 ${flag}` };
    }
    return options;
  }
  if (command !== 'run') return { error: `不認得的子命令：${command ?? '（沒有）'}` };
  const split = rest.indexOf('--');
  if (split < 0 || split === rest.length - 1) return { error: 'run 要以 -- 接要執行的命令' };
  const options = { command, timeoutSec: env.HEAVY_CHECK_TIMEOUT ?? '1800', intervalSec: env.HEAVY_CHECK_WAIT_INTERVAL ?? '30', argv: rest.slice(split + 1) };
  const flags = rest.slice(0, split);
  for (let i = 0; i < flags.length; i += 2) {
    const [flag, value] = [flags[i], flags[i + 1]];
    if (value === undefined) return { error: `${flag} 要有值` };
    if (flag === '--label') options.label = value;
    else if (flag === '--timeout') options.timeoutSec = value;
    else if (flag === '--interval') options.intervalSec = value;
    else return { error: `不認得的選項 ${flag}` };
  }
  if (!options.label || !LABEL.test(options.label)) return { error: `--label 要是 <repo>:<用途>（[A-Za-z0-9_.:@/-]）：${options.label ?? '（沒有）'}` };
  for (const key of ['timeoutSec', 'intervalSec']) {
    const n = Number(options[key]);
    if (!/^\d+(\.\d+)?$/.test(String(options[key])) || (key === 'intervalSec' && n <= 0)) return { error: `${key === 'timeoutSec' ? '--timeout' : '--interval'} 要是${key === 'timeoutSec' ? '非負' : '正'}數：${options[key]}` };
    options[key] = n;
  }
  return options;
}

const signalExit = signal => 128 + (constants.signals[signal] ?? 1);

/** 直接執行命令（不經 slot），exit code 照傳。 */
function runDirect(argv, env = process.env) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env });
    const forward = signal => child.kill(signal);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward);
    child.on('error', error => { process.stderr.write(`heavy-slot: ${argv[0]}：${error.message}\n`); resolve(127); });
    child.on('close', (code, signal) => resolve(code ?? signalExit(signal)));
  });
}

async function run({ label, timeoutSec, intervalSec, argv }) {
  if (process.env.HEAVY_SLOT_HELD) {
    process.stderr.write(`SLOT_NESTED ${label} held=${process.env.HEAVY_SLOT_HELD}\n`);
    return runDirect(argv);
  }
  const slots = slotCount();
  if (!slots) {
    process.stderr.write(`slot 數要是正整數（$HEAVY_CHECK_SLOTS 或 ${slotsFile()}）\n${USAGE}\n`);
    return 2;
  }
  const dir = slotDir();
  const started = Date.now();
  const record = { label, repo: label.split(':')[0], pid: process.pid, started_at: new Date(started).toISOString() };
  const info = { label, pid: process.pid, cwd: process.cwd(), since: new Date(started).toISOString() };
  const waitFile = join(dir, `wait-${process.pid}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(waitFile, JSON.stringify(info));
  } catch (error) {
    process.stderr.write(`SLOT_UNAVAILABLE ${label} ${error.code ?? error.message}\n`);
    return runDirect(argv);
  }
  const dropWait = () => rmSync(waitFile, { force: true });
  process.on('exit', dropWait);

  const holder = spawn('perl', ['-e', HOLDER, POLL, ...lockFiles(dir, slots)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const holders = () => {
    try { return holdersField(readSlots({ dir, slots }).holders); } catch { return '?'; }
  };
  const acquired = await new Promise(resolve => {
    let out = '';
    const timers = [];
    const done = value => { timers.forEach(clearInterval); timers.forEach(clearTimeout); for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal); resolve(value); };
    const onSignal = signal => { holder.kill('SIGKILL'); done({ signal }); };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
    holder.on('error', error => done({ error }));
    holder.on('close', code => done({ error: new Error(`perl exit ${code}`) }));
    holder.stdout.setEncoding('utf8').on('data', chunk => {
      out += chunk;
      const slot = out.match(/^ACQUIRED (\d+)$/m)?.[1];
      if (slot !== undefined) done({ slot: Number(slot) + 1 });
    });
    timers.push(setInterval(() => process.stderr.write(`SLOT_WAIT ${label} ${seconds(Date.now() - started)}s holders=${holders()}\n`), intervalSec * 1000));
    if (timeoutSec > 0) timers.push(setTimeout(() => { holder.kill('SIGKILL'); done({ timeout: true }); }, timeoutSec * 1000));
  });
  dropWait();
  if (acquired.signal) return signalExit(acquired.signal);
  if (acquired.timeout) {
    process.stderr.write(`SLOT_TIMEOUT ${label} ${seconds(Date.now() - started)}s holders=${holders()}\n`);
    logRun(dir, { ...record, wait_ms: Date.now() - started, run_ms: 0, exit: SLOT_TIMEOUT_EXIT, load1: loadavg()[0], timed_out: true });
    return SLOT_TIMEOUT_EXIT;
  }
  if (acquired.error) {
    process.stderr.write(`SLOT_UNAVAILABLE ${label} ${acquired.error.code ?? acquired.error.message}\n`);
    return runDirect(argv);
  }
  holder.removeAllListeners('close');
  // 持有期間 perl 不再印東西，只等 stdin 關閉後自己結束。鎖檔只是記錄，從另一個 fd 寫入不影響 flock。
  try { writeFileSync(lockFiles(dir, slots)[acquired.slot - 1], JSON.stringify({ ...info, since: new Date().toISOString() })); } catch { /* 只影響 status 顯示 */ }
  process.stderr.write(`SLOT_ACQUIRED ${label} slot-${acquired.slot}/${slots} waited=${seconds(Date.now() - started)}s\n`);
  const runStarted = Date.now();
  const load1 = loadavg()[0];
  const code = await runDirect(argv, { ...process.env, HEAVY_SLOT_HELD: `${label} slot-${acquired.slot}` });
  holder.stdin.end();
  logRun(dir, { ...record, wait_ms: runStarted - started, run_ms: Date.now() - runStarted, exit: code, load1, timed_out: false });
  return code;
}

function status() {
  const slots = slotCount();
  if (!slots) {
    process.stderr.write(`slot 數要是正整數（$HEAVY_CHECK_SLOTS 或 ${slotsFile()}）\n`);
    return 2;
  }
  const dir = slotDir();
  const { holders, waiters } = readSlots({ dir, slots });
  const now = Date.now();
  const age = since => (since ? `${seconds(now - Date.parse(since))}s` : '?');
  console.log(`SLOTS ${holders.length}/${slots} dir=${dir}`);
  for (const h of holders) console.log(`HOLDER slot-${h.slot} ${h.label} pid=${h.pid ?? '?'} held=${age(h.since)} cwd=${h.cwd ?? '?'}`);
  for (const w of waiters.sort((a, b) => String(a.since).localeCompare(String(b.since)))) console.log(`WAITER ${w.label} pid=${w.pid} waited=${age(w.since)} cwd=${w.cwd ?? '?'}`);
  return 0;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`${options.error}\n${USAGE}\n`);
    return 2;
  }
  if (options.command === 'stats') {
    let text = '';
    try { text = readFileSync(join(slotDir(), 'log.jsonl'), 'utf8'); } catch { /* 還沒有紀錄 */ }
    for (const line of statsLines(text, options)) console.log(line);
    return 0;
  }
  return options.command === 'status' ? status() : run(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
