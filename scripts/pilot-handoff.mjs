#!/usr/bin/env node
// /issue-pilot coordinator 交接給乾淨的 session：達到 adapter Pilot Defaults 的交接條件時，舊 session 在安全點呼叫它，自己就此退役。參考 spay2 同名腳本。
// pilot 的狀態都在 `.scratch/pilot/` 與批次 checkpoint，新 session 從磁碟接手，不需要舊 context。
// 步驟：確認 `.scratch/pilot/coordinator` 的 pid 是呼叫者 → 改寫為 handoff 行（不含 `pid ` 欄，新 session 視為無人占用）
//   → 記下主 checkout 現有的分頁 → 在主 checkout 新開分頁 `issue-pilot coordinator` 跑 claude（失敗時依快照與標題找回已開的分頁關掉） → orca-session-send 送出 `/loop /issue-pilot`
//   → 等新 session 把 `pid ` 行寫進 coordinator 檔，才算交接完成。
// 任一步失敗就還原 coordinator 檔、關掉已開的分頁並 STOP，舊 session 照常繼續當 coordinator（分頁留著，`/loop` 之後仍可能接手，變成兩個 coordinator）。
// 沒有 coordinator 檔也是 STOP not-coordinator。
// 總時間有上限：Bash 工具最多等 600 秒，被殺就來不及還原，所以預算到了（STOP timeout）或收到 SIGTERM、SIGINT（STOP signal <名稱>）都中止進行中的步驟（terminal create 例外，見 BUDGET_MS）、走同一條還原路徑，
// 最壞在 540 秒內結束。因此全程用 async：同步等待會擋住訊號處理。
//
// 用法：node scripts/pilot-handoff.mjs --session <舊 session id> --pid <舊 CLAUDE_PID> --reason <原因>
// stdout 最後一行：HANDED_OFF <terminal handle>，或 STOP <原因>（not-coordinator、create、tui-timeout、send、orca、pid-timeout、timeout、signal）。
// exit：0 交接完成；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { orca, sendToSession } from './orca-session-send.mjs';

const USAGE = '用法：node scripts/pilot-handoff.mjs --session <id> --pid <pid> --reason <原因>（需要 ORCA_CLI_COMMAND）';
export const LOOP_COMMAND = '/loop /issue-pilot';
export const TITLE = 'issue-pilot coordinator';

/** 新 session 啟動、TUI 就緒後跑完 /issue-pilot 的 Entry 才寫 pid 行；送達後最多等 5 分鐘（仍受總預算限制）。 */
const WAIT_MS = Number(process.env.PILOT_HANDOFF_WAIT_MS || 300000);
const POLL_MS = Number(process.env.PILOT_HANDOFF_POLL_MS || 5000);

/**
 * 總預算 510 秒，到了就中止。create 不被預算中止（殺掉它，Orca 可能已開好分頁卻沒回 handle，就關不掉），
 * 只受自己的上限：預設 90 秒（WSL 上常超過 10 秒）。其他每步 Orca 呼叫預設最多 10 秒。
 * create 前只有一次快照 list，不會撞上預算；預設值下最壞是預算 510 秒加還原時關分頁 10 秒，低於 540 秒。
 */
const BUDGET_MS = Number(process.env.PILOT_HANDOFF_BUDGET_MS || 510000);
const CREATE_MS = Number(process.env.PILOT_HANDOFF_CREATE_MS || 90000);
const ORCA_STEP_MS = Number(process.env.PILOT_HANDOFF_STEP_MS || 10000);

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git worktree list 失敗：${result.stderr.trim()}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** 等 coordinator 檔出現別人的 `pid ` 行；逾時傳回 false，中止時丟出 AbortError。 */
async function waitNewCoordinator(file, pid, signal) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const owner = (existsSync(file) ? readFileSync(file, 'utf8') : '').match(/^pid (\d+)\b/m)?.[1];
    if (owner && owner !== pid) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS, undefined, { signal });
  }
}

/** 主 checkout 目前的 Orca 分頁。 */
async function listTerminals(cli, main) {
  return (await orca({ cli, signal: AbortSignal.timeout(ORCA_STEP_MS) }, 'terminal', 'list', '--worktree', `path:${main}`)).terminals;
}

/** 關掉分頁；失敗時傳回附在 STOP 原因的說明，成功傳回空字串。 */
async function closeTerminal(cli, handle) {
  try {
    await orca({ cli, signal: AbortSignal.timeout(ORCA_STEP_MS) }, 'terminal', 'close', '--terminal', handle);
    return '';
  } catch (error) {
    return `（關閉 ${handle} 失敗：${error.message}，請手動關掉）`;
  }
}

/**
 * create 失敗（含逾時被殺）時，Orca 可能已開好分頁卻沒回 handle：關掉快照之後才出現、標題是 TITLE 的分頁。
 * 標題相同的既有分頁（例如前次 handoff 開出的現任 coordinator）不碰；新出現但標題不同的（Claude 啟動後會改標題，也可能是人剛開的）
 * 不關，傳回附在 STOP 原因的說明。用標題找有兩個漏洞：分頁已被 Claude 改名，或 create 被殺時 Orca 還沒建好、list 看不到；
 * 所以 create 是被中止而這裡沒關掉任何分頁時，一律提醒人去確認。
 */
async function closeOrphans(cli, main, before, aborted) {
  const remind = `（請確認有沒有留下標題 ${TITLE} 或剛由 create 開出的分頁）`;
  let note = '', closed = 0;
  try {
    for (const terminal of (await listTerminals(cli, main)).filter(terminal => !before.has(terminal.handle))) {
      if (terminal.title !== TITLE) { note += `（新分頁 ${terminal.handle} 標題不符，未關閉，請確認後手動關掉）`; continue; }
      const failed = await closeTerminal(cli, terminal.handle);
      note += failed;
      if (!failed) closed++;
    }
  } catch (error) {
    return `（terminal list 失敗：${error.message}）${remind}`;
  }
  return aborted && !closed ? note + remind : note;
}

/** `signal` 中止時（reason 為 `timeout` 或 `signal <名稱>`）進行中的步驟丟錯，STOP 原因改用 reason。 */
async function handoff(cli, main, { session, pid, reason }, signal) {
  const file = join(main, '.scratch/pilot/coordinator');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!new RegExp(`^pid ${pid}\\b`, 'm').test(original)) return `STOP not-coordinator ${original.trim().split('\n').join(' / ')}`;
  const line = `handoff   from-session ${session}   from-pid ${pid}   at ${new Date().toISOString()}   reason ${reason}\n`;
  writeFileSync(file, line);
  // 新 session 可能已寫入自己的 pid 行；只在檔案仍是本次 handoff 行時還原，不蓋掉別人。
  let handle;
  const ctx = { cli, signal };
  const stop = async cause => {
    if (signal.aborted) cause = signal.reason;
    if (handle) {
      cause += await closeTerminal(cli, handle);
    }
    if (!existsSync(file) || readFileSync(file, 'utf8') === line) writeFileSync(file, original);
    return `STOP ${cause}`;
  };
  let before;
  try {
    before = new Set((await listTerminals(cli, main)).map(terminal => terminal.handle));
  } catch (error) {
    return stop(`orca ${error.message}`);
  }
  try {
    handle = (await orca({ cli, signal: AbortSignal.timeout(CREATE_MS) }, 'terminal', 'create', '--worktree', `path:${main}`, '--title', TITLE, '--command', 'claude')).terminal.handle;
  } catch (error) {
    return stop(`create ${error.message}${await closeOrphans(cli, main, before, error.name === 'AbortError')}`);
  }
  const sent = await sendToSession(ctx, handle, LOOP_COMMAND);
  if (sent.stop) return stop(sent.stop);
  try {
    if (!await waitNewCoordinator(file, pid, signal)) return stop(`pid-timeout ${handle}`);
  } catch (error) {
    return stop(error.message);
  }
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
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort('timeout'), BUDGET_MS);
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => controller.abort(`signal ${name}`));
  try {
    const line = await handoff(cli, mainCheckout(), options, controller.signal);
    clearTimeout(budget);
    console.log(line);
    process.exit(line.startsWith('STOP') ? 4 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
