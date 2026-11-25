#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 包住 `node --test`，偵測並補跑靜默遺失的測試（曾發生：多檔合併執行時一個長跑測試檔的最後 14 個測試
// 沒有出現在輸出、總數少 13，卻 exit 0；單獨重跑 91 個全過）。Node v24.21 重現：`--test-force-exit` 加上多檔並行時，
// 父行程會在長跑檔的子行程跑完前結束，該檔尾段結果不見、整體仍 exit 0；不加 force-exit 或只跑單檔幾乎不發生，
// 父行程多掛 reporter（含寫檔）時幾乎每次發生，所以本 wrapper 不多掛 reporter，只轉印 spec 輸出。
// 呼叫端沒給 `--test-reporter` 時明確指定單一的 spec：Node 22 在 stdout 不是 TTY（這裡是 pipe）時預設 tap，Node 23 起才一律 spec。
// force-exit 是測試 guardrail 的規範，不拿掉，改成比對後單獨重跑遺失的檔：
//   子行程端由 lib/node-test-count-preload.mjs 記每檔實際跑完的測試名稱，以及開始數、error 事件數與 exit code；父行程的 `ℹ tests <n>` 等於總數、
//   且 spec 輸出逐檔名稱都對得上即通過（中途結束的檔在輸出只算 1 個，總數可能恰好相等，#517），否則以 spec 輸出的測試名稱逐檔比對，找出有測試沒出現在輸出的檔。
//   名稱比對只看有紀錄的測試，從沒開始的測試兩邊一起少就看不到（spay2 #1099：同一 commit 三輪 `ℹ tests` 4444／4472／4496 都綠），所以先逐檔核對
//   「應執行的檔」都收齊（missingFiles）：有紀錄、收到事件、<root> 跑完（preload 的 finished）、開始數等於結束數、至少一個測試，且父行程 exit 0 時子行程也 exit 0。
//   缺的檔每檔印 `MISSING_RESULTS <path> <原因>` 到 stderr，單獨重跑，重跑也要收齊才算 PASS（印 `NODE_TEST_RERUN <path> PASS|FAIL`），否則 exit 1。
//   唯一的例外是 Node 沒有 node.test tracing channel（22）：所有紀錄都沒有事件，且探測確認 channel 不存在時，記不到名稱與是否跑完，
//   只能逐檔核對有紀錄、exit 0，印 `NODE_TEST_UNTRACED`。channel 存在時沒有事件的檔一律算缺（測試檔在第一個測試前就結束、或根本沒有測試）。
// 用法：node scripts/node-test-guarded.mjs <node --test 的選項（--name=value 形式）…> <測試檔…>
//   node --test 失敗時，依子行程紀錄（failed、code）找出失敗的檔（沒有紀錄的檔也算），各單獨重跑一次（高負載下才失敗的測試，retro spay2 92fa93fe#3）：
//   全過時每檔印 `NODE_TEST_FLAKE_SUSPECT <path>` 到 stderr、不算失敗；cwd 有 scripts/followups.mjs 時另寫一行 followups [tooling]，每個呼叫端都記到（followups 264：
//   原本只有 push gate 會寫，batch-merge verify 與 fix-land 的 check-contracts 只留在 log）。內容相同的未處理行已存在時它不重複寫；寫不成不影響結果。重跑仍失敗印 `NODE_TEST_RERUN <path> FAIL`，回傳第一次的 exit code。
//   flake 行為 `NODE_TEST_FLAKE_SUSPECT <path> output=<log>`：首輪 stdout 尾段（FLAKE_OUTPUT_LIMIT）另存到 <git common dir>/node-test-flake-output/<path 轉檔名>.log（followups 430：
//   push gate log 每輪覆寫，首輪失敗輸出隨之消失；followups 419 查不到原始失敗）。同一檔只留最新一次（路徑固定，followups 的去重不受影響），超過 FLAKE_OUTPUT_TTL_MS（14 天）的檔在下次另存時刪除；
//   不在 git repo 時放 tmpdir()，NODE_TEST_FLAKE_OUTPUT_DIR 可改位置；寫不成時不帶 output=，不影響結果。
//   找不出失敗的檔（Node 22 沒有紀錄、載入就失敗的單檔）時直接回傳第一次的 exit code；失敗的檔超過 FLAKE_MAX_FILES 時印 `NODE_TEST_FLAKE_SKIPPED <n> …`、不重跑，視為真實失敗。
//   有遺失時每檔印 `NODE_TEST_LOST <path> ran=<子行程跑完數> missing=<輸出中缺的數>` 到 stderr，單獨重跑該檔，
//   印 `NODE_TEST_RERUN <path> PASS|FAIL`；全部 PASS 時 exit 0，否則 exit 1。
//   單獨重跑都拿掉 `--test-force-exit`：高負載下單檔一樣會遺失回報（retro spay2 1102a：pilot-status 輸出少一截、0 fail 仍判 FAIL）。沒有 force-exit 收尾，留下掛著 handle 的測試檔
//   不會自己結束，所以重跑有上限 RERUN_TIMEOUT_MS，逾時印 `NODE_TEST_RERUN_TIMEOUT <path> <ms>` 並判 FAIL。
//   遺失的是回報而不是執行時（Linux CI 上單獨重跑也會遺失，#256）：子行程紀錄完整（每個開始的測試都有結束紀錄）、
//   沒有失敗、子行程 exit 0，就印 `NODE_TEST_RECORDED <path> PASS：<說明>` 判定通過、不重跑；其餘照舊單獨重跑，重跑也以同樣規則判定。
//   總數不等卻找不到是哪個檔時印 `NODE_TEST_COUNT_MISMATCH`，exit 1。
// 併發上限（CoS item 67／138）：node --test 沒帶 --test-concurrency 時預設開 availableParallelism()-1 個測試行程，heavy-slot 只限同時幾支、不限每支用多少 CPU，
//   16 核機器上 2 個 slot 持有者就占滿整台（load 67–86）。所以呼叫端沒帶 `--test-concurrency` 時，帶入環境變數 NODE_TEST_CONCURRENCY（正整數，預設 6）；
//   值不合法（空字串除外）時 stderr 印 `WARN NODE_TEST_CONCURRENCY <值> 不是正整數，改用 6`。呼叫端自己帶了（`--test-concurrency=<n>`）就以呼叫端為準。建議值見 setup-workflow SKILL 的 Concurrency。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRELOAD = fileURLToPath(new URL('./lib/node-test-count-preload.mjs', import.meta.url));
/** 父行程先結束時，長跑檔的子行程還在跑、記錄尚未寫出：最多等這麼久。 */
const ORPHAN_WAIT_MS = Number(process.env.NODE_TEST_GUARD_WAIT_MS ?? 120_000);
/** 單獨重跑一檔的上限，環境變數 NODE_TEST_RERUN_TIMEOUT_MS 可改。 */
const RERUN_TIMEOUT_MS = Number(process.env.NODE_TEST_RERUN_TIMEOUT_MS ?? 900_000);
/** 失敗的檔多於這個數就不逐檔重跑：大範圍失敗是真的壞了，逐檔重跑只是多花時間。 */
const FLAKE_MAX_FILES = Number(process.env.NODE_TEST_FLAKE_MAX_FILES ?? 5);
/** flake 首輪輸出另存的上限：spec reporter 的失敗段落在輸出最後，留尾段（followups 430）。 */
const FLAKE_OUTPUT_LIMIT = 2 * 1024 * 1024;
const FLAKE_OUTPUT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** spec 的結果行 → 測試名稱。skip／todo 帶原因字串時 duration 後面接 `# <原因>`（不是 SKIP／TODO），也要剝掉。 */
const RESULT = /^\s*(?:✔|✖|﹣|⚠) (.*?)(?: \(\d+(?:\.\d+)?m?s\)(?: # .*)?| # (?:SKIP|TODO)\b.*)?$/;

/** preload 的 JSON lines → Map<file, names[]>（同一檔多行時合併）。 */
export function parseRan(text) {
  const ran = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const { file, names } = JSON.parse(line);
    ran.set(file, [...(ran.get(file) ?? []), ...names]);
  }
  return ran;
}

/** preload 的 JSON lines 有記錄、但沒有一筆收到 node.test 事件（Node 22 沒有這個 channel，或每個檔都在第一個測試前結束）。 */
export function untraced(text) {
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return records.length > 0 && !records.some(record => record.traced);
}

let channelProbe;
/** 這個 Node 有沒有 node.test tracing channel：實際起一個測試行程看會不會收到事件（只在所有紀錄都沒有事件時才需要，結果快取）。 */
export function hasTestChannel() {
  channelProbe ??= spawnSync(process.execPath, ['--input-type=module', '-e', "import { tracingChannel } from 'node:diagnostics_channel';\nlet seen = false;\n"
    + "tracingChannel('node.test').subscribe({ start() {}, asyncStart() {}, asyncEnd() {}, error() {}, end() { seen = true; } });\n"
    + "process.on('exit', () => process.stderr.write(String(seen)));\nconst { test } = await import('node:test');\ntest('probe', () => {});\n"],
  { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }).stderr.trim().endsWith('true');
  return channelProbe;
}

/**
 * 應執行的檔逐檔核對子行程紀錄是否收齊 → [{ file, reason }]。parentCode 是 node --test 的 exit code：父行程 exit 0 而子行程非 0，代表結果沒送完就結束。
 * traced 為 false（Node 沒有 channel）時只看有沒有紀錄與 exit code。
 */
export function missingFiles(text, files, { parentCode = 0, traced = true } = {}) {
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return files.flatMap(file => {
    const own = records.filter(record => record.file === file);
    const reason = !own.length ? 'no-record'
      : parentCode === 0 && own.some(({ code }) => code !== 0) ? `exit=${own.find(({ code }) => code !== 0).code}`
      : !traced ? null
      : own.some(record => !record.traced) ? 'no-events'
      : own.some(record => record.finished !== true || record.started !== record.names.length)
        ? `not-finished started=${own.reduce((sum, record) => sum + record.started, 0)} ended=${own.reduce((sum, record) => sum + record.names.length, 0)}`
      : own.every(record => !record.names.length) ? 'no-tests'
      : null;
    return reason ? [{ file, reason }] : [];
  });
}

/**
 * 子行程紀錄證明該檔全過：至少一筆紀錄，每筆都收到事件、開始的測試數等於結束數、沒有失敗、子行程 exit 0。
 * 缺欄位（舊格式）一律不算。
 */
export function recordedPass(text, file) {
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(record => record.file === file);
  return records.length > 0 && records.every(({ names, traced, started, failed, code }) =>
    traced === true && Array.isArray(names) && started === names.length && failed === 0 && code === 0);
}

/** node --test 失敗時要單獨重跑的檔：紀錄有失敗或子行程 exit 非 0，或沒有紀錄（子行程被殺）。Node 22 全部沒有事件：找不出，回空陣列。 */
export function failedFiles(text, files) {
  if (untraced(text)) return [];
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return files.filter(file => {
    const own = records.filter(record => record.file === file);
    return !own.length || own.some(({ failed, code }) => failed > 0 || code !== 0);
  });
}

/** spec 輸出最後的 `ℹ tests <n>`；沒有時 null。 */
export function reportedTotal(output) {
  const last = [...output.matchAll(/^ℹ tests (\d+)$/gm)].at(-1);
  return last ? Number(last[1]) : null;
}

/**
 * 子行程跑完的名稱 vs spec 輸出出現的名稱（多重集合）→ 有名稱沒出現的檔 [{ file, ran, missing }]。
 * 同名測試分屬多檔時，缺的名稱算到每個含它的檔（寧可多重跑）。
 * @param {Map<string, string[]>} ran
 * @param {string} output
 */
export function lostFiles(ran, output) {
  const shown = new Map();
  for (const line of output.split('\n')) {
    const name = RESULT.exec(line)?.[1];
    if (name !== undefined) shown.set(name, (shown.get(name) ?? 0) + 1);
  }
  const expected = new Map();
  for (const names of ran.values()) for (const name of names) expected.set(name, (expected.get(name) ?? 0) + 1);
  const short = new Set([...expected].filter(([name, count]) => (shown.get(name) ?? 0) < count).map(([name]) => name));
  return [...ran].filter(([, names]) => names.some(name => short.has(name)))
    .map(([file, names]) => ({ file, ran: names.length, missing: names.filter(name => short.has(name)).length }));
}

/**
 * 跑一次 node --test → { code, lost, missing, mismatch, passed, failed, timedOut }；passed(file) 是該檔子行程紀錄是否全過，failed 是失敗要重跑的檔，
 * missing 是沒收齊的檔（missingFiles）。
 * 有 timeoutMs 時逾時收掉整個行程群組（沒有 force-exit 時掛著的測試子行程不會自己結束），判定為失敗。
 */
async function runOnce(options, files, { timeoutMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'node-test-guarded-'));
  const ranFile = join(dir, 'ran.jsonl');
  try {
    const env = { ...process.env, NODE_TEST_COUNT_FILE: ranFile, NODE_TEST_COUNT_ROOT: String(process.pid),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(PRELOAD).href}`.trim() };
    const child = spawn(process.execPath, ['--test', ...options, ...files], { stdio: ['inherit', 'pipe', 'inherit'], env, detached: Boolean(timeoutMs) });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { process.stdout.write(chunk); output += chunk; });
    const timer = timeoutMs && setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已結束 */ }
    }, timeoutMs);
    const status = await new Promise(done => child.on('close', (exit, signal) => done(exit ?? (signal ? 1 : 0))));
    clearTimeout(timer);
    const code = timedOut && status === 0 ? 1 : status;
    if (timedOut) return { code, lost: [], missing: [], passed: () => false, failed: [], timedOut };
    const wanted = files.map(file => resolve(file));
    const readText = () => existsSync(ranFile) ? readFileSync(ranFile, 'utf8') : '';
    let text = readText();
    let ran = parseRan(text);
    const total = () => [...ran.values()].reduce((sum, names) => sum + names.length, 0);
    // 總數相等還不夠：中途 process.exit(0) 的檔被父行程算成 1 個測試，跑完數恰好相等時會放過（#517），所以逐檔名稱也要對得上；
    // 名稱都對得上也不夠：在測試之間結束的檔，紀錄與輸出一起少（#1099），所以每個檔都要收齊。
    if (code === 0 && !missingFiles(text, wanted).length && total() === reportedTotal(output) && !lostFiles(ran, output).length) {
      return { code, lost: [], missing: [], passed: () => false, failed: [] };
    }
    // 父行程先結束：還在跑的子行程結束時才寫記錄，等它們寫完再比對。沒有 force-exit 時父行程會等子行程，沒有記錄就是不會有了。
    const orphans = options.includes('--test-force-exit');
    for (const until = Date.now() + ORPHAN_WAIT_MS; orphans && wanted.some(file => !ran.has(file)) && Date.now() < until;) {
      await sleep(500);
      text = readText();
      ran = parseRan(text);
    }
    // 例外只有一種：Node 沒有 node.test channel，記不到名稱與是否跑完，只能逐檔核對有紀錄與 exit code。沒有事件但 channel 存在就是沒收齊，照常判定。
    const traced = !untraced(text) || hasTestChannel();
    if (!traced) console.error(`NODE_TEST_UNTRACED ${process.version} 沒有 node.test tracing channel：只逐檔核對子行程紀錄與 exit code，無法比對測試名稱與是否跑完`);
    const failed = code === 0 ? [] : failedFiles(text, wanted);
    const missing = missingFiles(text, wanted, { parentCode: code, traced }).filter(({ file }) => !failed.includes(file));
    const skip = file => failed.includes(file) || missing.some(entry => entry.file === file);
    const lost = lostFiles(ran, output).filter(({ file }) => !skip(file));
    return { code, lost, missing, failed, output, passed: file => recordedPass(text, file),
      mismatch: traced && code === 0 && !lost.length && !missing.length && total() !== reportedTotal(output) ? `ran=${total()} reported=${reportedTotal(output)}` : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const DEFAULT_TEST_CONCURRENCY = 6;

/**
 * 加上併發上限的選項：呼叫端已帶 `--test-concurrency`（`=<n>` 形式）就原樣回傳，否則附加 `--test-concurrency=<NODE_TEST_CONCURRENCY 或 6>`。
 * `warn` 收到值不合法時的警告行（沒設或空字串不算不合法）。
 */
export function withConcurrency(options, env = process.env, warn = line => console.error(line)) {
  if (options.some(option => option === '--test-concurrency' || option.startsWith('--test-concurrency='))) return options;
  const raw = env.NODE_TEST_CONCURRENCY?.trim() ?? '';
  let value = DEFAULT_TEST_CONCURRENCY;
  if (/^[1-9]\d*$/.test(raw)) value = Number(raw);
  else if (raw !== '') warn(`WARN NODE_TEST_CONCURRENCY ${raw} 不是正整數，改用 ${DEFAULT_TEST_CONCURRENCY}`);
  return [...options, `--test-concurrency=${value}`];
}

/** 單獨重跑的選項：拿掉 force-exit，父行程才會等子行程把結果送完。 */
export const soloOptions = options => options.filter(option => option !== '--test-force-exit');

/**
 * flake 寫進 followups 的 [tooling] 行，交 /retro-collect（retro 92fa93fe#3、followups 264）。followups.mjs 依 git common dir 寫回主 checkout，暫時 worktree 裡跑也一樣。
 * 只認 cwd 自己的 scripts/followups.mjs 與 cwd 內的檔：測試 fixture 的 cwd 沒有它，不會寫到真正的 followups。不丟錯、不輸出：不能讓記錄影響測試結果。
 */
function recordFlake(path, saved) {
  if (path.startsWith('..') || !existsSync('scripts/followups.mjs')) return;
  spawnSync(process.execPath, ['scripts/followups.mjs', 'add', 'node-test-guarded', '--tooling', `NODE_TEST_FLAKE_SUSPECT ${path}：首輪失敗、單獨重跑全過${saved ? `；首輪輸出 ${saved}` : ''}`], { stdio: 'ignore', timeout: 30_000 });
}

/** flake 首輪輸出的存放目錄：要活過驗收的暫時 worktree 與專屬 TMPDIR，所以放 git common dir（followups 430）。 */
function flakeOutputDir() {
  if (process.env.NODE_TEST_FLAKE_OUTPUT_DIR) return process.env.NODE_TEST_FLAKE_OUTPUT_DIR;
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  return join(common.status === 0 ? common.stdout.trim() : tmpdir(), 'node-test-flake-output');
}

/** 另存 flake 首輪輸出並清掉過期的檔；傳回 log 路徑，寫不成傳回 null（不影響測試結果）。 */
export function saveFlakeOutput(path, output, dir = flakeOutputDir(), now = Date.now()) {
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      const old = join(dir, name);
      if (now - statSync(old).mtimeMs > FLAKE_OUTPUT_TTL_MS) rmSync(old, { force: true });
    }
    const file = join(dir, `${path.replace(/[^\w.-]/g, '_')}.log`);
    writeFileSync(file, output.slice(-FLAKE_OUTPUT_LIMIT));
    return file;
  } catch {
    return null;
  }
}

/** 單獨重跑一檔；全過回 true。 */
async function rerun(options, path) {
  const solo = await runOnce(soloOptions(options), [path], { timeoutMs: RERUN_TIMEOUT_MS });
  if (solo.timedOut) console.error(`NODE_TEST_RERUN_TIMEOUT ${path} ${RERUN_TIMEOUT_MS}`);
  return solo.code === 0 && !solo.mismatch && !solo.missing.length && solo.lost.every(({ file }) => solo.passed(file));
}

export async function main(args) {
  const options = withConcurrency(args.filter(arg => arg.startsWith('-')));
  if (!options.some(arg => arg.startsWith('--test-reporter='))) options.unshift('--test-reporter=spec');
  const files = args.filter(arg => !arg.startsWith('-'));
  const first = await runOnce(options, files);
  if (first.code !== 0 && !first.failed.length) return first.code;
  if (first.failed.length > FLAKE_MAX_FILES) {
    console.error(`NODE_TEST_FLAKE_SKIPPED ${first.failed.length} 個檔失敗，超過單獨重跑上限 ${FLAKE_MAX_FILES}，視為真實失敗`);
    return first.code;
  }
  if (first.mismatch) {
    console.error(`NODE_TEST_COUNT_MISMATCH ${first.mismatch}：總數不等但找不到是哪個檔，整組重跑確認。`);
    return 1;
  }
  let status = 0;
  for (const file of first.failed) {
    const path = relative(process.cwd(), file);
    if (await rerun(options, path)) {
      const saved = saveFlakeOutput(path, first.output);
      console.error(`NODE_TEST_FLAKE_SUSPECT ${path}${saved ? ` output=${saved}` : ''}`);
      recordFlake(path, saved);
    } else {
      console.error(`NODE_TEST_RERUN ${path} FAIL`);
      status = first.code;
    }
  }
  for (const { file, reason } of first.missing) {
    const path = relative(process.cwd(), file);
    console.error(`MISSING_RESULTS ${path} ${reason}`);
    const pass = await rerun(options, path);
    console.error(`NODE_TEST_RERUN ${path} ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) status ||= 1;
  }
  for (const { file, ran, missing } of first.lost) {
    const path = relative(process.cwd(), file);
    console.error(`NODE_TEST_LOST ${path} ran=${ran} missing=${missing}`);
    if (first.passed(file)) {
      console.error(`NODE_TEST_RECORDED ${path} PASS：回報遺失，子行程紀錄每個測試都跑完且沒有失敗`);
      continue;
    }
    const pass = await rerun(options, path);
    console.error(`NODE_TEST_RERUN ${path} ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) status ||= 1;
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
