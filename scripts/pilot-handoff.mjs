#!/usr/bin/env node
// /issue-pilot coordinator 交接給乾淨的 session：達到 adapter Pilot Defaults 的交接條件時，舊 session 在安全點呼叫它，自己就此退役。參考 spay2 同名腳本。
// pilot 的狀態都在 `.scratch/pilot/` 與批次 checkpoint，新 session 從磁碟接手，不需要舊 context。
// 步驟：確認 `.scratch/pilot/coordinator` 的 pid 是呼叫者 → 改寫為 handoff 行（不含 `pid ` 欄，新 session 視為無人占用）
//   → 在主 checkout 新開分頁 `issue-pilot coordinator` 跑 claude → orca-session-send 送出 `/loop /issue-pilot`
//   → 等新 session 把 `pid ` 行寫進 coordinator 檔，才算交接完成。
// 任一步失敗就還原 coordinator 檔、關掉已開的分頁並 STOP，舊 session 照常繼續當 coordinator（分頁留著，`/loop` 之後仍可能接手，變成兩個 coordinator）。
// 沒有 coordinator 檔也是 STOP not-coordinator。
//
// 用法：node scripts/pilot-handoff.mjs --session <舊 session id> --pid <舊 CLAUDE_PID> --reason <原因>
// stdout 最後一行：HANDED_OFF <terminal handle>，或 STOP <原因>（not-coordinator、create、tui-timeout、send、orca、pid-timeout）。
// exit：0 交接完成；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { orca, sendToSession } from './orca-session-send.mjs';

const USAGE = '用法：node scripts/pilot-handoff.mjs --session <id> --pid <pid> --reason <原因>（需要 ORCA_CLI_COMMAND）';
export const LOOP_COMMAND = '/loop /issue-pilot';
export const TITLE = 'issue-pilot coordinator';

/** 新 session 啟動、TUI 就緒後跑完 /issue-pilot 的 Entry 才寫 pid 行；預設最多等 10 分鐘。 */
const WAIT_MS = Number(process.env.PILOT_HANDOFF_WAIT_MS || 600000);
const POLL_MS = Number(process.env.PILOT_HANDOFF_POLL_MS || 5000);

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git worktree list 失敗：${result.stderr.trim()}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** 等 coordinator 檔出現別人的 `pid ` 行；逾時傳回 false。 */
function waitNewCoordinator(file, pid) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const owner = readFileSync(file, 'utf8').match(/^pid (\d+)\b/m)?.[1];
    if (owner && owner !== pid) return true;
    if (Date.now() >= deadline) return false;
    sleep(POLL_MS);
  }
}

function handoff(cli, main, { session, pid, reason }) {
  const file = join(main, '.scratch/pilot/coordinator');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!new RegExp(`^pid ${pid}\\b`, 'm').test(original)) return `STOP not-coordinator ${original.trim()}`;
  const line = `handoff   from-session ${session}   from-pid ${pid}   at ${new Date().toISOString()}   reason ${reason}\n`;
  writeFileSync(file, line);
  // 新 session 可能已寫入自己的 pid 行；只在檔案仍是本次 handoff 行時還原，不蓋掉別人。
  let handle;
  const stop = cause => {
    if (handle) {
      try { orca(cli, 'terminal', 'close', '--terminal', handle); } catch (error) { cause += `（關閉 ${handle} 失敗：${error.message}，請手動關掉）`; }
    }
    if (readFileSync(file, 'utf8') === line) writeFileSync(file, original);
    return `STOP ${cause}`;
  };
  try {
    handle = orca(cli, 'terminal', 'create', '--worktree', `path:${main}`, '--title', TITLE, '--command', 'claude').terminal.handle;
  } catch (error) {
    return stop(`create ${error.message}`);
  }
  const sent = sendToSession(cli, handle, LOOP_COMMAND);
  if (sent.stop) return stop(sent.stop);
  if (!waitNewCoordinator(file, pid)) return stop(`pid-timeout ${handle}`);
  return `HANDED_OFF ${handle}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const options = { session: value('--session'), pid: value('--pid'), reason: value('--reason') };
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!options.session || !/^\d+$/.test(options.pid ?? '') || !options.reason || !cli) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const line = handoff(cli, mainCheckout(), options);
    console.log(line);
    process.exit(line.startsWith('STOP') ? 4 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
