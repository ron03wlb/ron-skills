#!/usr/bin/env node
// 包住 `node --test`，偵測並補跑靜默遺失的測試（曾發生：多檔合併執行時一個長跑測試檔的最後 14 個測試
// 沒有出現在輸出、總數少 13，卻 exit 0；單獨重跑 91 個全過）。Node v24.21 重現：`--test-force-exit` 加上多檔並行時，
// 父行程會在長跑檔的子行程跑完前結束，該檔尾段結果不見、整體仍 exit 0；不加 force-exit 或只跑單檔幾乎不發生，
// 父行程多掛 reporter（含寫檔）時幾乎每次發生，所以本 wrapper 不多掛 reporter，只轉印 spec 輸出。
// 呼叫端沒給 `--test-reporter` 時明確指定單一的 spec：Node 22 在 stdout 不是 TTY（這裡是 pipe）時預設 tap，Node 23 起才一律 spec。
// force-exit 是測試 guardrail 的規範，不拿掉，改成比對後單獨重跑遺失的檔：
//   子行程端由 lib/node-test-count-preload.mjs 記每檔實際跑完的測試名稱；父行程的 `ℹ tests <n>` 等於總數即通過，
//   不等時以 spec 輸出的測試名稱逐檔比對，找出有測試沒出現在輸出的檔。
//   沒有 node.test tracing channel 的 Node（22）記不到名稱：所有記錄都沒收到事件時放行，只回傳 node --test 的 exit code。
// 用法：node scripts/node-test-guarded.mjs <node --test 的選項（--name=value 形式）…> <測試檔…>
//   node --test 失敗時原樣回傳其 exit code。
//   有遺失時每檔印 `NODE_TEST_LOST <path> ran=<子行程跑完數> missing=<輸出中缺的數>` 到 stderr，以同樣選項單獨重跑該檔，
//   印 `NODE_TEST_RERUN <path> PASS|FAIL`；全部 PASS 時 exit 0，否則 exit 1。
//   遺失的是回報而不是執行時（Linux CI 上單獨重跑也會遺失，#256）：子行程紀錄完整（每個開始的測試都有結束紀錄）、
//   沒有失敗、子行程 exit 0，就印 `NODE_TEST_RECORDED <path> PASS：<說明>` 判定通過、不重跑；其餘照舊單獨重跑，重跑也以同樣規則判定。
//   總數不等卻找不到是哪個檔時印 `NODE_TEST_COUNT_MISMATCH`，exit 1。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRELOAD = fileURLToPath(new URL('./lib/node-test-count-preload.mjs', import.meta.url));
/** 父行程先結束時，長跑檔的子行程還在跑、記錄尚未寫出：最多等這麼久。 */
const ORPHAN_WAIT_MS = Number(process.env.NODE_TEST_GUARD_WAIT_MS ?? 120_000);
const RESULT = /^\s*(?:✔|✖|﹣|⚠) (.*?)(?: \(\d+(?:\.\d+)?m?s\))?(?: # (?:SKIP|TODO)\b.*)?$/;

/** preload 的 JSON lines → Map<file, names[]>（同一檔多行時合併）。 */
export function parseRan(text) {
  const ran = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const { file, names } = JSON.parse(line);
    ran.set(file, [...(ran.get(file) ?? []), ...names]);
  }
  return ran;
}

/** preload 的 JSON lines 有記錄、但沒有一筆收到 node.test 事件（Node 22 沒有這個 channel）。 */
export function untraced(text) {
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return records.length > 0 && !records.some(record => record.traced);
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

/** 跑一次 node --test → { code, lost, mismatch, passed }；passed(file) 是該檔子行程紀錄是否全過。 */
async function runOnce(options, files) {
  const dir = mkdtempSync(join(tmpdir(), 'node-test-guarded-'));
  const ranFile = join(dir, 'ran.jsonl');
  try {
    const env = { ...process.env, NODE_TEST_COUNT_FILE: ranFile, NODE_TEST_COUNT_ROOT: String(process.pid),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(PRELOAD).href}`.trim() };
    const child = spawn(process.execPath, ['--test', ...options, ...files], { stdio: ['inherit', 'pipe', 'inherit'], env });
    let output = '';
    child.stdout.on('data', chunk => { process.stdout.write(chunk); output += chunk; });
    const code = await new Promise(done => child.on('close', (status, signal) => done(status ?? (signal ? 1 : 0))));
    if (code !== 0) return { code, lost: [], passed: () => false };
    const wanted = files.map(file => resolve(file));
    const readText = () => existsSync(ranFile) ? readFileSync(ranFile, 'utf8') : '';
    let text = readText();
    let ran = parseRan(text);
    const total = () => [...ran.values()].reduce((sum, names) => sum + names.length, 0);
    if (ran.size >= wanted.length && total() === reportedTotal(output)) return { code, lost: [], passed: () => false };
    // 父行程先結束：還在跑的子行程結束時才寫記錄，等它們寫完再比對
    for (const until = Date.now() + ORPHAN_WAIT_MS; wanted.some(file => !ran.has(file)) && !untraced(text) && Date.now() < until;) {
      await sleep(500);
      text = readText();
      ran = parseRan(text);
    }
    if (untraced(text)) return { code, lost: [], passed: () => false };
    const lost = lostFiles(ran, output);
    for (const file of wanted.filter(file => !ran.has(file))) lost.push({ file, ran: '?', missing: '?' });
    return { code, lost, passed: file => recordedPass(text, file), mismatch: !lost.length && total() !== reportedTotal(output) ? `ran=${total()} reported=${reportedTotal(output)}` : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function main(args) {
  const options = args.filter(arg => arg.startsWith('-'));
  if (!options.some(arg => arg.startsWith('--test-reporter='))) options.unshift('--test-reporter=spec');
  const files = args.filter(arg => !arg.startsWith('-'));
  const first = await runOnce(options, files);
  if (first.code !== 0) return first.code;
  if (first.mismatch) {
    console.error(`NODE_TEST_COUNT_MISMATCH ${first.mismatch}：總數不等但找不到是哪個檔，整組重跑確認。`);
    return 1;
  }
  let failed = false;
  for (const { file, ran, missing } of first.lost) {
    const path = relative(process.cwd(), file);
    console.error(`NODE_TEST_LOST ${path} ran=${ran} missing=${missing}`);
    if (first.passed(file)) {
      console.error(`NODE_TEST_RECORDED ${path} PASS：回報遺失，子行程紀錄每個測試都跑完且沒有失敗`);
      continue;
    }
    const solo = await runOnce(options, [path]);
    const pass = solo.code === 0 && !solo.mismatch && solo.lost.every(lost => solo.passed(lost.file));
    console.error(`NODE_TEST_RERUN ${path} ${pass ? 'PASS' : 'FAIL'}`);
    failed ||= !pass;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
