#!/usr/bin/env node
// 把 prompt 送進既有的 Orca Claude terminal（pilot 派工送 `/issue-run`、handoff 送 `/loop /issue-pilot`），並確認已開始處理。移植自 spay2。
// 不用裸 `terminal send`：它會回 accepted，文字卻停在輸入框沒提交，重送又會黏成兩份。
// 步驟：等 TUI 閒置（兩輪）→ 送出並讀畫面確認 prompt 開頭或 `esc to interrupt` 出現，沒出現就延後重送。
// 送出前先讀 composer：先前裸 `terminal send` 留下未提交的同一段 prompt 時只補 Enter，不再黏成兩份（spay2 #691）。
// session 仍在忙時 tui-idle 不成立，兩輪逾時即 STOP tui-timeout，不把 prompt 排進忙碌中的 turn。
//
// 用法：node scripts/orca-session-send.mjs --terminal <handle> --prompt <text>
// stdout 最後一行：SENT <handle>，或 STOP <原因>（tui-timeout <handle>、send <handle>、orca <錯誤碼>）。
// stderr：第一次送出因 composer 已有該 prompt 而只補 Enter 時印 `DRAFT_SUBMIT <handle>`（不含 prompt 文字）。
// exit：0 已送達；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/orca-session-send.mjs --terminal <handle> --prompt <text>（需要 ORCA_CLI_COMMAND）';

/** 每輪等 TUI 就緒的上限；共等兩輪（spay2 實測第一次常逾時、第二次在 30 秒內就緒）。 */
const TUI_WAIT_MS = Number(process.env.SESSION_TUI_WAIT_MS || 120000);

/**
 * 送出後讀畫面確認的間隔與次數，以及每次送出前的等待：第一次立即、第二次 5 秒後、第三次 30 秒後。
 * 第三次是因為 tui-idle 判定就緒早於輸入框可收字，幾分鐘後再送才成功。
 */
const CONFIRM_MS = Number(process.env.SESSION_SEND_CONFIRM_MS || 2000);
const CONFIRM_POLLS = 5;
const SEND_DELAYS = [0, Number(process.env.SESSION_SEND_RESEND_MS || 5000), Number(process.env.SESSION_SEND_LATE_RESEND_MS || 30000)];

/**
 * Orca CLI 呼叫；回傳 JSON 的 result，失敗丟出含錯誤碼的 Error。
 * `signal` 中止時殺掉 CLI 並丟出 AbortError（pilot-handoff 用它限制總時間、處理 SIGTERM）。
 */
export async function orca({ cli, signal }, ...args) {
  const child = spawn(cli, [...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], signal });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  let body;
  try { body = JSON.parse(stdout); } catch { throw new Error((stderr || stdout || '').trim().split('\n').pop() || `exit ${status}`); }
  if (!body.ok) throw new Error(body.error?.code ?? body.error?.message ?? 'orca 失敗');
  return body.result;
}

/** 等 terminal 的 Claude TUI 就緒，最多兩輪。 */
export async function waitTuiReady(ctx, handle) {
  for (let round = 0; round < 2; round++) {
    if ((await orca(ctx, 'terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(TUI_WAIT_MS))).wait?.satisfied) return true;
  }
  return false;
}

/**
 * 送出 prompt 並確認進了 Claude：TUI 剛就緒時 Orca 會回 accepted 卻吞掉輸入。
 * 畫面出現 prompt 開頭或 `esc to interrupt` 才算送達；否則依 SEND_DELAYS 重送。送不出或三次都沒送達傳回 false。
 * 第一次送出前先讀一次 composer 的 `draft`（缺省視為空），已有同一段文字時只補 Enter，並在 stderr 印 `DRAFT_SUBMIT <handle>`。
 */
export async function sendPrompt(ctx, handle, text) {
  const landed = tail => tail.some(line => line.includes(text.slice(0, 24)) || line.includes('esc to interrupt'));
  let draft = (await orca(ctx, 'terminal', 'read', '--terminal', handle)).terminal?.draft ?? '';
  if (resendInput(draft, text)[1] === '') console.error(`DRAFT_SUBMIT ${handle}`);
  for (const delay of SEND_DELAYS) {
    if (delay) await sleep(delay, undefined, { signal: ctx.signal });
    if (!(await orca(ctx, 'terminal', 'send', '--terminal', handle, ...resendInput(draft, text))).send?.accepted) return false;
    for (let poll = 0; poll < CONFIRM_POLLS; poll++) {
      await sleep(CONFIRM_MS, undefined, { signal: ctx.signal });
      const screen = (await orca(ctx, 'terminal', 'read', '--terminal', handle)).terminal ?? {};
      draft = screen.draft ?? '';
      // 文字還在輸入框（draft 含 prompt 開頭）時，畫面上那一行只是輸入框，不算送達。
      if (landed(screen.tail ?? []) && resendInput(draft, text)[1] !== '') return true;
    }
  }
  return false;
}

/** 重送的輸入：文字已留在輸入框（`draft` 含 prompt 開頭）時只補 Enter，否則送文字加 Enter；避免黏成兩份。 */
export function resendInput(draft, text) {
  return draft.includes(text.slice(0, 24)) ? ['--text', '', '--enter'] : ['--text', text, '--enter'];
}

/**
 * 等既有 terminal 閒置後送出 prompt 並確認送達。`ctx` 是 `{ cli, signal? }`；中止也回 `orca` STOP，由呼叫者看 `signal.reason` 改判。
 * @returns {{handle: string} | {stop: string}} 成功回 handle；失敗回 STOP 原因（不含 `STOP ` 前綴）。
 */
export async function sendToSession(ctx, handle, prompt) {
  try {
    if (!await waitTuiReady(ctx, handle)) return { stop: `tui-timeout ${handle}` };
    if (!await sendPrompt(ctx, handle, prompt)) return { stop: `send ${handle}` };
  } catch (error) {
    return { stop: `orca ${error.message}` };
  }
  return { handle };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const handle = value('--terminal');
  const prompt = value('--prompt');
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!handle || !prompt || !cli || args.length !== 4) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const sent = await sendToSession({ cli }, handle, prompt);
    console.log(sent.stop ? `STOP ${sent.stop}` : `SENT ${sent.handle}`);
    process.exit(sent.stop ? 4 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
