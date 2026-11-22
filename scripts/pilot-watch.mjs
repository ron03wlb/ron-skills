#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（#355，取自 investing 的 scripts/pilot-watch.mjs）：coordinator 的背景 worker watcher，取代各自手寫的 watch.sh。
// 每 interval 秒讀每個 handle 的 `terminal read --screen`（經 orca-session-send.mjs 的 orca()：不經 shell、不依賴 jq，tail 帶反斜線時先修 JSON），
// 結果行的判斷與 Probe 的 WORKER 共用 pilot-probe.mjs 的 resultMatch（容忍縮排、TUI 框線與 bullet、略過提示列），不另寫一份
// （#325：自寫的 `^(DONE|STOP) [0-9]+` 漏抓兩格縮排的結果行，漏掉 STOP 約 1 小時）。
// 直接給的 handle：啟動時先記下畫面上已有的結果行當基準，不報（#323：resume 後畫面還留著舊 STOP）；之後最後一個結果行不在基準裡才算新結果。
// batch 成員照 Probe 的 WORKER 判斷：最後一個結果行就是結果，只略過成員 `resumed:` 行記下的 resume 前舊結果（pilot-batch resume，#356），
// 啟動時已在畫面上的新結果行第一輪就報（#406：resume 後、watcher 啟動前印的 DONE 被畫面基準吞掉，watcher 一直不通知）。
// 有一個 handle 出現新結果或 terminal 已結束（`status: exited`）就印出這一輪的事件並結束：coordinator 以背景執行它，結束即被叫醒，處理後再起一次。
// batch 成員印 RESULT 時同時把結果行記進 checkpoint 同目錄的 `results/<handle>`（`<ISO 時間> <結果行>`，pilot-probe.mjs 的 recordResult）：
// 結果行之後可能被捲走、terminal 可能結束，Probe 畫面上讀不到時改讀這份，--apply 照常寫回（#413 第 1 項）。記不進去時照樣印 RESULT、stderr 印原因。
//
// 用法：node scripts/pilot-watch.mjs [<handle>|<checkpoint>.md]... [--batch <key>]... [--checkout <主 checkout>] [--interval <秒>]
//       node scripts/pilot-watch.mjs --tail <handle> [--lines <n>]
//   --batch    監看 <主 checkout>/.scratch/pilot/batch-<key>.md 裡 state 為 running 的成員；可重複，每一批都監看（investing 舊版只看最後一批，發生三次）。
//              --checkout 預設是目前目錄所屬 repo 的主 checkout（`git worktree list` 的第一個）。
//   <checkpoint>.md  直接給 batch checkpoint 的路徑，同 --batch；batch 名取檔名 `batch-<key>.md` 的 key（不是這個形狀時取去掉 .md 的檔名）。
//   batch 成員只認自己號碼的結果行；直接給的 handle 任何號碼都算。
//   --interval 輪詢間隔秒數（預設 60，可帶小數）。
//   --tail <handle> [--lines <n>]：唯讀，印該 worker 畫面的最後 n 行（預設 40），與 `pilot-probe.mjs --tail` 同一份實作；不能和其他參數併用。
// stdout（<batch> 是批次名，直接給的 handle 是 `-`）：
//   RESULT <batch> <handle> <結果行>（新的 `DONE <n> <sha>`、`STOP <n> <cause>`，去掉縮排與框線）｜EXITED <batch> <handle>（terminal 已結束且沒有新結果行）
//   READ_FAILED <batch> <handle> <原因>（讀不到，下一輪重試）｜NO_RUNNING <key>（那一批沒有 running 成員）｜BATCH_FAILED <key> <原因>（checkpoint 讀不到）
// exit：0 印出 RESULT／EXITED（同一輪的全部印完），或沒有任何可監看的 handle；1 BATCH_FAILED 或 --tail 讀不到；
//       2 用法錯誤或沒有 $ORCA_CLI_COMMAND。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { orca } from './orca-session-send.mjs';
import { parseBatch, recordResult, resultMatch, screenLines, workerTail } from './pilot-probe.mjs';

const USAGE = '用法：node scripts/pilot-watch.mjs [<handle>|<checkpoint>.md]... [--batch <key>]... [--checkout <主 checkout>] [--interval <秒>]｜node scripts/pilot-watch.mjs --tail <handle> [--lines <n>]（需要 ORCA_CLI_COMMAND）';

const oneLine = text => String(text).replace(/\s+/g, ' ').trim() || 'unknown';

/** 命令列 → { handles, checkpoints, batches, checkout, intervalMs } 或 { tail, lines }；用法錯誤時 { error }。 */
export function parseArgs(argv) {
  const options = { handles: [], checkpoints: [], batches: [], intervalMs: 60_000 };
  let tail;
  let lines;
  let interval = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--tail', '--lines', '--interval', '--batch', '--checkout'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} 要有值` };
      if (arg === '--tail') tail = value;
      else if (arg === '--lines') {
        lines = Number(value);
        if (!Number.isInteger(lines) || lines < 1) return { error: `--lines 要是正整數：${value}` };
      } else if (arg === '--interval') {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) return { error: `--interval 要是正數：${value}` };
        options.intervalMs = seconds * 1000;
        interval = true;
      } else if (arg === '--batch') {
        if (!/^[\w-]+$/.test(value)) return { error: `batch key 不合法：${value}` };
        options.batches.push(value);
      } else options.checkout = value;
    } else if (arg.startsWith('--')) return { error: `不認得的選項 ${arg}` };
    else if (arg.endsWith('.md')) options.checkpoints.push(arg);
    else options.handles.push(arg);
  }
  if (tail !== undefined) {
    if (options.handles.length || options.checkpoints.length || options.batches.length || options.checkout !== undefined || interval) {
      return { error: '--tail 不能和其他參數併用' };
    }
    return { tail, lines: lines ?? 40 };
  }
  if (lines !== undefined) return { error: '--lines 只能和 --tail 一起用' };
  if (options.checkout !== undefined && !options.batches.length) return { error: '--checkout 只能和 --batch 一起用' };
  if (!options.handles.length && !options.checkpoints.length && !options.batches.length) return { error: '沒有 handle、checkpoint 或 --batch' };
  return options;
}

/** checkpoint 路徑 → batch 名：`batch-<key>.md` 取 key，其他取去掉 .md 的檔名。 */
export const batchKey = file => basename(file, '.md').replace(/^batch-/, '');

/**
 * 監看主迴圈。targets 是 [{ batch, handle, n, resumed }]（n 缺省時任何號碼都算；有 n 的是 batch 成員，resumed 是它 `resumed:` 行記下的舊結果行）；read(handle) 傳回 { tail, status }，失敗時丟出；
 * wait(ms) 等下一輪；print(line) 印一行；record(target, line) 在 batch 成員印 RESULT 時收到它的結果行（#413）。第一輪記基準（已結束的 terminal 直接回報），之後每輪讀一次，有事件就印完這一輪後傳回 0。
 */
export async function watch({ targets, intervalMs = 60_000, read, wait = sleep, print = line => process.stdout.write(`${line}\n`), record = () => {} }) {
  const seen = new Map();
  // 同一個 handle 既直接給又是 batch 成員時以 batch 成員為準（只認自己的號碼、標出批次）。
  const unique = [];
  for (const target of targets) {
    const i = unique.findIndex(other => other.handle === target.handle);
    if (i < 0) unique.push(target);
    else if (unique[i].n === undefined && target.n !== undefined) unique[i] = target;
  }
  if (!unique.length) return 0;
  for (let round = 0; ; round++) {
    if (round) await wait(intervalMs);
    let events = 0;
    for (const target of unique) {
      const { batch, handle, n } = target;
      let terminal;
      try {
        terminal = await read(handle);
      } catch (error) {
        print(`READ_FAILED ${batch} ${handle} ${oneLine(error.message)}`);
        continue;
      }
      const tail = screenLines(terminal.tail);
      if (n !== undefined) {
        // batch 成員：與 Probe 的 workerState 同一判斷，沒有畫面基準。
        const match = resultMatch(tail, n);
        if (match && match.line !== target.resumed) {
          record(target, match.line);
          print(`RESULT ${batch} ${handle} ${match.line}`);
          events++;
        }
        else if (terminal.status === 'exited') { print(`EXITED ${batch} ${handle}`); events++; }
        continue;
      }
      if (!seen.has(handle)) {
        // 基準：畫面上這個成員已有的每一個結果行。讀不到的 handle 等第一次讀到時才記。
        seen.set(handle, new Set(tail.map(raw => resultMatch([raw], n)?.line).filter(Boolean)));
        if (terminal.status === 'exited') { print(`EXITED ${batch} ${handle}`); events++; }
        continue;
      }
      const match = resultMatch(tail, n);
      if (match && !seen.get(handle).has(match.line)) { print(`RESULT ${batch} ${handle} ${match.line}`); events++; }
      else if (terminal.status === 'exited') { print(`EXITED ${batch} ${handle}`); events++; }
    }
    if (events) return 0;
  }
}

/** 目前目錄所屬 repo 的主 checkout（`git worktree list --porcelain` 的第一個 worktree）。 */
function mainCheckout() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0 ? result.stdout.match(/^worktree (.+)$/m)?.[1] : undefined;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`${options.error}\n${USAGE}\n`);
    return 2;
  }
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!cli) {
    process.stderr.write(`沒有 $ORCA_CLI_COMMAND，讀不到 terminal\n${USAGE}\n`);
    return 2;
  }
  const ctx = { cli };
  if (options.tail !== undefined) {
    try {
      for (const line of await workerTail(ctx, options.tail, options.lines)) process.stdout.write(`${line}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
  }
  const targets = options.handles.map(handle => ({ batch: '-', handle }));
  const checkout = options.batches.length ? options.checkout ?? mainCheckout() : undefined;
  const files = [
    ...options.batches.map(key => ({ key, file: checkout && join(checkout, '.scratch/pilot', `batch-${key}.md`) })),
    ...options.checkpoints.map(file => ({ key: batchKey(file), file })),
  ];
  for (const { key, file } of files) {
    let text;
    try {
      if (!file) throw new Error('找不到主 checkout（不在 git repo 裡？用 --checkout）');
      text = readFileSync(file, 'utf8');
    } catch (error) {
      process.stdout.write(`BATCH_FAILED ${key} ${oneLine(error.message)}\n`);
      return 1;
    }
    const running = parseBatch(text).members.filter(member => member.state === 'running' && member.handle);
    if (!running.length) process.stdout.write(`NO_RUNNING ${key}\n`);
    targets.push(...running.map(member => ({ batch: key, handle: member.handle, n: member.n, resumed: member.resumed, pilot: dirname(file) })));
  }
  const read = async handle => (await orca(ctx, 'terminal', 'read', '--terminal', handle, '--screen')).terminal ?? {};
  const record = (target, line) => {
    try {
      recordResult(target.pilot, target.handle, line);
    } catch (error) {
      process.stderr.write(`RECORD_FAILED ${target.handle} ${oneLine(error.message)}\n`);
    }
  };
  return watch({ targets, intervalMs: options.intervalMs, read, record });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
