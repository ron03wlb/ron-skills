#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（#355，取自 investing 的 scripts/pilot-watch.mjs）：coordinator 的背景 worker watcher，取代各自手寫的 watch.sh。
// 每 interval 秒讀每個 handle 的 `terminal read --screen`（經 orca-session-send.mjs 的 orca()：不經 shell、不依賴 jq，tail 帶反斜線時先修 JSON），
// 結果行的判斷與 Probe 的 WORKER 共用 pilot-probe.mjs 的 resultMatch（容忍縮排、TUI 框線與 bullet、略過提示列），不另寫一份
// （#325：自寫的 `^(DONE|STOP) [0-9]+` 漏抓兩格縮排的結果行，漏掉 STOP 約 1 小時）。
// 直接給的 handle：啟動時先記下畫面上已有的結果行當基準，不報（#323：resume 後畫面還留著舊 STOP）；之後最後一個結果行不在基準裡才算新結果。
// batch 成員照 Probe 的 WORKER 判斷：最後一個結果行就是結果，只略過成員 `resumed:` 行記下的 resume 前舊結果（pilot-batch resume，#356；
// 兩邊都經 pilot-probe.mjs 的 resultText 去掉 `│` 之後的 Orca 側欄再比對，#643 第 1 項：累積輸出裡的舊 STOP 尾巴黏著側欄，watcher 一啟動就結束），
// 啟動時已在畫面上的新結果行第一輪就報（#406：resume 後、watcher 啟動前印的 DONE 被畫面基準吞掉，watcher 一直不通知）。
// 有一個 handle 出現新結果或 terminal 已結束（`status: exited`）就印出這一輪的事件並結束：coordinator 以背景執行它，結束即被叫醒，處理後再起一次。
// 兩輪之間不只睡 interval（CoS item 67）：上一次讀到工作中畫面（`esc to interrupt` 或 spinner，pilot-probe.mjs 的 workingScreen）的 handle
// 各起一個 `terminal wait --for tui-idle`，和 interval 一起等、先到先醒。worker 印完結果行、結束那一輪就是 tui-idle，watcher 隨即讀畫面印 RESULT，
// 不必等到下一個 interval。畫面已閒置的 handle 不起等待（tui-idle 會立刻成立而空轉）；醒來沒有結果時照常下一輪，那個 handle 讀到閒置就不再起。
// batch 成員印 RESULT 時同時把結果行記進 checkpoint 同目錄的 `results/<handle>`（`<ISO 時間> <結果行>`，pilot-probe.mjs 的 recordResult）：
// 結果行之後可能被捲走、terminal 可能結束，Probe 畫面上讀不到時改讀這份，--apply 照常寫回（#413 第 1 項）。記不進去時照樣印 RESULT、stderr 印 `RECORD_FAILED <handle> <原因>`。
// batch 成員的結果是 DONE（含 from-state）時，畫面上它之前的 `POSTLAND <n> <command>`（pilot-probe.mjs 的 postlandCommands）在 checkpoint 鎖內補成
// 表格下方的 `postland: #<n> <command>` 行（已記過的不重記，lib/pilot-store.mjs 的 addPostland），pilot-land.mjs 落地後印 POSTLAND_PENDING（#502）。
// stdout 不變；寫不進去時 stderr 印 `POSTLAND_RECORD_FAILED <handle> <原因>`。
//
// 用法：node scripts/pilot-watch.mjs [<handle>|<checkpoint>.md]... [--batch <key>]... [--checkout <主 checkout>] [--interval <秒>] [--worker-state <路徑>]
//       node scripts/pilot-watch.mjs --tail <handle> [--lines <n>]
//       node scripts/pilot-watch.mjs --pid <pid> [--out <輸出檔>] [--lines <n>] [--interval <秒>]
//   --batch    監看 <主 checkout>/.scratch/pilot/batch-<key>.md 裡 state 為 running 的成員；可重複，每一批都監看（investing 舊版只看最後一批，發生三次）。
//              --checkout 預設是目前目錄所屬 repo 的主 checkout（`git worktree list` 的第一個）。
//   <checkpoint>.md  直接給 batch checkpoint 的路徑，同 --batch；batch 名取檔名 `batch-<key>.md` 的 key（不是這個形狀時取去掉 .md 的檔名）。
//   batch 成員只認自己號碼的結果行；直接給的 handle 任何號碼都算。`# batch req-<n>` 的 checkpoint（pilot-dispatch --unit 的 fix unit，#590）裡
//   Issue 欄是 `-` 的列也是成員，號碼是 `req-<n>`（pilot-probe.mjs 的 parseBatch），認 `DONE req-<n> <sha>`、`STOP req-<n> <cause>`；直接給的 handle 也認。
//   unit 的 POSTLAND 不記成 `postland:` 行（讀取端只認 Issue 號碼）。
//   --interval 輪詢間隔秒數（預設 60，可帶小數）。
//   --worker-state <路徑>（#466，只對 batch 成員）：worker checkpoint 的路徑，`<worktree>`、`<n>` 換成成員列的值，預設 `<worktree>/.scratch/issue-run-<n>/state.md`
//              （同 pilot-probe.mjs 的 --worker-state）。
//   --tail <handle> [--lines <n>]：唯讀，印該 worker 畫面的最後 n 行（預設 40），與 `pilot-probe.mjs --tail` 同一份實作；不能和其他參數併用。
//   --pid <pid> [--out <輸出檔>]（#693）：等前任留下的行程（Probe 的 `PUSHING <key> pid=<pid> out=<輸出檔>`）結束，coordinator 以背景執行，結束即被叫醒：
//              每 --interval 秒（這個模式預設 15）以 kill 0 檢查，pid 不在之後印 `PID_EXITED <pid>`，有 --out 時再印輸出檔最後 --lines 行（預設 40），
//              檔不在時印 `NO_OUTPUT <輸出檔>`；exit 0。不讀 Orca，不需要 ORCA_CLI_COMMAND（#679：手寫的 `pgrep -f` 迴圈比對到自己的命令列，永遠不結束）。
//              不能和 handle、checkpoint、--batch、--tail 併用。
// stdout（<batch> 是批次名，直接給的 handle 是 `-`）：
//   RESULT <batch> <handle> <結果行>（新的 `DONE <n> <sha>`、`STOP <n> <cause>`，去掉縮排與框線）｜
//   RESULT <batch> <handle> DONE <n> <sha> from-state（#466：batch 成員的 terminal 已結束、沒有結果行，worker checkpoint 最後一行 `State:` 是
//     `done, candidate <sha>` 而 sha 等於成員 worktree 的 HEAD；<sha> 是完整的 HEAD，判斷同 Probe 的 `WORKER <n> DONE <sha> from-state`）｜EXITED <batch> <handle>（terminal 已結束且沒有新結果行；batch 成員第一輪就已 exited、沒有結果行也沒有 from-state 時（例如 WSL 重開前的舊 terminal）不算，還有別的 terminal 活著就不印、交給 Probe 的 STUCK exited，全部都已結束才印，#573）
//   READ_FAILED <batch> <handle> <原因>（讀不到，下一輪重試）｜NO_RUNNING <key>（那一批沒有 running 成員）｜BATCH_FAILED <key> <原因>（checkpoint 讀不到）
// exit：0 印出 RESULT／EXITED（同一輪的全部印完），或沒有任何可監看的 handle；1 BATCH_FAILED 或 --tail 讀不到；
//       2 用法錯誤或沒有 $ORCA_CLI_COMMAND。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { orca } from './orca-session-send.mjs';
import { addPostland, pidAlive, updateCheckpoint } from './lib/pilot-store.mjs';
import { WORKER_STATE, parseBatch, postlandCommands, recordResult, resultMatch, screenLines, scrollbackMatch, stateResult, workerTail, workingScreen } from './pilot-probe.mjs';

const USAGE = '用法：node scripts/pilot-watch.mjs [<handle>|<checkpoint>.md]... [--batch <key>]... [--checkout <主 checkout>] [--interval <秒>] [--worker-state <路徑>]｜node scripts/pilot-watch.mjs --tail <handle> [--lines <n>]（需要 ORCA_CLI_COMMAND）｜node scripts/pilot-watch.mjs --pid <pid> [--out <輸出檔>] [--lines <n>] [--interval <秒>]';

const oneLine = text => String(text).replace(/\s+/g, ' ').trim() || 'unknown';

/** 命令列 → { handles, checkpoints, batches, checkout, intervalMs } 或 { tail, lines }；用法錯誤時 { error }。 */
export function parseArgs(argv) {
  const options = { handles: [], checkpoints: [], batches: [], intervalMs: 60_000 };
  let tail;
  let pid;
  let out;
  let lines;
  let interval = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--tail', '--lines', '--interval', '--batch', '--checkout', '--worker-state', '--pid', '--out'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} 要有值` };
      if (arg === '--tail') tail = value;
      else if (arg === '--pid') {
        pid = Number(value);
        if (!/^\d+$/.test(value) || pid < 1) return { error: `--pid 要是正整數：${value}` };
      } else if (arg === '--out') out = value;
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
      } else if (arg === '--worker-state') {
        if (options.workerState !== undefined) return { error: '--worker-state 只能給一次' };
        options.workerState = value;
      } else options.checkout = value;
    } else if (arg.startsWith('--')) return { error: `不認得的選項 ${arg}` };
    else if (arg.endsWith('.md')) options.checkpoints.push(arg);
    else options.handles.push(arg);
  }
  if (pid !== undefined) {
    if (tail !== undefined || options.handles.length || options.checkpoints.length || options.batches.length || options.checkout !== undefined || options.workerState !== undefined) {
      return { error: '--pid 不能和 handle、checkpoint、--batch、--tail 併用' };
    }
    return { pid, out, lines: lines ?? 40, intervalMs: interval ? options.intervalMs : 15_000 };
  }
  if (out !== undefined) return { error: '--out 只能和 --pid 一起用' };
  if (tail !== undefined) {
    if (options.handles.length || options.checkpoints.length || options.batches.length || options.checkout !== undefined || options.workerState !== undefined || interval) {
      return { error: '--tail 不能和其他參數併用' };
    }
    return { tail, lines: lines ?? 40 };
  }
  if (lines !== undefined) return { error: '--lines 只能和 --tail 或 --pid 一起用' };
  if (options.checkout !== undefined && !options.batches.length) return { error: '--checkout 只能和 --batch 一起用' };
  if (options.workerState !== undefined && !options.batches.length && !options.checkpoints.length) return { error: '--worker-state 只能和 batch 一起用' };
  if (!options.handles.length && !options.checkpoints.length && !options.batches.length) return { error: '沒有 handle、checkpoint 或 --batch' };
  return options;
}

/** `--pid`：等 pid 結束，印 PID_EXITED 與輸出檔尾巴（#693）。 */
async function waitPid({ pid, out, lines, intervalMs }) {
  while (pidAlive(pid)) await sleep(intervalMs);
  process.stdout.write(`PID_EXITED ${pid}\n`);
  if (out === undefined) return 0;
  let text;
  try { text = readFileSync(out, 'utf8'); } catch {
    process.stdout.write(`NO_OUTPUT ${out}\n`);
    return 0;
  }
  const tail = text.trimEnd().split('\n').slice(-lines).join('\n');
  if (tail) process.stdout.write(`${tail}\n`);
  return 0;
}

/** checkpoint 路徑 → batch 名：`batch-<key>.md` 取 key，其他取去掉 .md 的檔名。 */
export const batchKey = file => basename(file, '.md').replace(/^batch-/, '');

/**
 * 監看主迴圈。targets 是 [{ batch, handle, n, resumed, worktree }]（n 缺省時任何號碼都算；有 n 的是 batch 成員，resumed 是它 `resumed:` 行記下的舊結果行）；read(handle) 傳回 { tail, status }，失敗時丟出；
 * wait(ms) 等下一輪；print(line) 印一行；record(target, line) 在 batch 成員印畫面上的 RESULT 時收到它的結果行（#413；from-state 的不記，Probe 自己重讀 worker checkpoint）；
 * postland(target, commands) 在 batch 成員的結果是 DONE（含 from-state）而畫面上有它的 POSTLAND 行時收到那些指令（#502）。
 * 第一輪記基準（已結束的 terminal 直接回報），之後每輪讀一次，有事件就印完這一輪後傳回 0。
 */
export async function watch({ targets, intervalMs = 60_000, read, scrollback = async () => null, wait = sleep, print = line => process.stdout.write(`${line}\n`), record = () => {}, postland = () => {}, workerState = WORKER_STATE }) {
  const seen = new Map();
  // 同一個 handle 既直接給又是 batch 成員時以 batch 成員為準（只認自己的號碼、標出批次）。
  const unique = [];
  for (const target of targets) {
    const i = unique.findIndex(other => other.handle === target.handle);
    if (i < 0) unique.push(target);
    else if (unique[i].n === undefined && target.n !== undefined) unique[i] = target;
  }
  if (!unique.length) return 0;
  const stale = new Set();
  for (let round = 0; ; round++) {
    if (round) await wait(intervalMs);
    let events = 0;
    let alive = false;
    const exitedFirst = [];
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
      if (terminal.status !== 'exited') alive = true;
      if (n !== undefined) {
        // batch 成員：與 Probe 的 workerState 同一判斷，沒有畫面基準。
        let match = resultMatch(tail, n);
        // #537：結果行已捲出畫面、畫面也不是工作中時，往回讀累積輸出（與 Probe 的 workerState 同一判斷）；那時 POSTLAND 從同一份累積輸出讀（match.tail）。
        if (!match && !workingScreen(tail)) {
          try { match = await scrollback(handle, n); } catch { match = null; }
        }
        if (match && match.line !== target.resumed) {
          record(target, match.line);
          // 請求 unit（`req-<n>`，#590）不記：`postland:` 行的讀取端（pilot-land 的 POSTLAND_PENDING）只認 Issue 號碼。
          const commands = match.kind === 'DONE' && /^\d+$/.test(n) ? postlandCommands(match.tail ?? tail, n) : [];
          if (commands.length) postland(target, commands);
          print(`RESULT ${batch} ${handle} ${match.line}`);
          events++;
        }
        else if (terminal.status === 'exited') {
          // #573：第一輪就已結束的成員（WSL 重開前的舊 terminal，成員列仍是 running）若沒有結果也沒有 from-state，不當事件；
          // 還有別的 terminal 活著時留給 Probe 的 STUCK exited，全部都已結束時才在這一輪結尾補印 EXITED（沒東西可等）。
          if (stale.has(handle)) continue;
          if (round === 0 && !stateResult(target, workerState)) { stale.add(handle); exitedFirst.push(target); continue; }
          // #466：分頁已結束卻沒有結果行時讀 worker checkpoint（與 Probe 的 workerState 同一判斷）。
          const sha = stateResult(target, workerState);
          const commands = sha && /^\d+$/.test(n) ? postlandCommands(tail, n) : [];
          if (commands.length) postland(target, commands);
          print(sha ? `RESULT ${batch} ${handle} DONE ${n} ${sha} from-state` : `EXITED ${batch} ${handle}`);
          events++;
        }
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
    if (!alive) for (const { batch, handle } of exitedFirst) { print(`EXITED ${batch} ${handle}`); events++; }
    if (events) return 0;
  }
}

/**
 * 兩輪之間的等待：ms 毫秒，或 handles 裡任一個 waitIdle(handle, signal) 先以 true resolve（worker 剛閒置）就提早醒。
 * waitIdle 回 false 或失敗（逾時、handle 已失效、terminal 已結束）不提早醒，留給下一輪的讀取判斷。醒來時中止其餘的等待。
 */
export async function wakeOnIdle(ms, handles, waitIdle, wait = sleep) {
  const controller = new AbortController();
  const never = new Promise(() => {});
  try {
    await Promise.race([
      wait(ms, undefined, { signal: controller.signal }).catch(() => {}),
      ...handles.map(handle => waitIdle(handle, controller.signal).then(idle => (idle ? undefined : never), () => never)),
    ]);
  } finally {
    controller.abort();
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
  if (options.pid !== undefined) return waitPid(options);
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
    targets.push(...running.map(member => ({ batch: key, handle: member.handle, n: member.n, resumed: member.resumed, worktree: member.worktree, pilot: dirname(file), file })));
  }
  // 記下每個 handle 上一次讀到的畫面是不是工作中，兩輪之間只對工作中的起 tui-idle 等待。
  const working = new Set();
  const read = async handle => {
    const terminal = (await orca(ctx, 'terminal', 'read', '--terminal', handle, '--screen')).terminal ?? {};
    if (terminal.status !== 'exited' && workingScreen(terminal.tail)) working.add(handle);
    else working.delete(handle);
    return terminal;
  };
  const waitIdle = (handle, signal) => orca({ ...ctx, signal }, 'terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(Math.ceil(options.intervalMs))).then(result => result.wait?.satisfied === true);
  const wait = ms => wakeOnIdle(ms, [...working], waitIdle);
  const record = (target, line) => {
    try {
      recordResult(target.pilot, target.handle, line);
    } catch (error) {
      process.stderr.write(`RECORD_FAILED ${target.handle} ${oneLine(error.message)}\n`);
    }
  };
  const postland = (target, commands) => {
    try {
      updateCheckpoint(target.file, text => addPostland(text, target.n, commands));
    } catch (error) {
      process.stderr.write(`POSTLAND_RECORD_FAILED ${target.handle} ${oneLine(error.message)}\n`);
    }
  };
  const scrollback = (handle, n) => scrollbackMatch(ctx, handle, n);
  return watch({ targets, intervalMs: options.intervalMs, read, scrollback, wait, record, postland, workerState: options.workerState });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
