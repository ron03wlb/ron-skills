#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 把 prompt 送進既有的 Orca Claude terminal（例如派工送 `/issue-run`、交接送 `/loop /issue-pilot`），並確認已開始處理。
// 不用裸 `terminal send`：它會回 accepted，文字卻停在輸入框沒提交，重送又會黏成兩份。
// 步驟：等 TUI 閒置（兩輪）→ 送出並讀畫面確認 prompt 開頭、`esc to interrupt` 或工作中的 spinner 出現，沒出現就延後重送；
// 重送前再讀一次畫面，worker 已在工作就算送達、不重送（#354：spinner 沒有 `esc to interrupt`、prompt 行被長回應擠出畫面，
// 確認逾時後再送兩次，排成兩行 `❯ /issue-run …`）。
// 送出前先讀 composer：先前裸 `terminal send` 留下未提交的同一段 prompt 時只補 Enter，不再黏成兩份。
// session 仍在忙時 tui-idle 不成立，兩輪逾時即 STOP tui-timeout，不把 prompt 排進忙碌中的 turn。
// `--queue` 給忙碌中的 session 補送（例如 Dispatch 之後補範圍，#133）：不等 tui-idle，直接送出排到下一輪；
// 忙碌畫面本來就有 `esc to interrupt`，也可能留著開頭相同的上一則提醒（還會捲出畫面），所以不看畫面，只看 composer：
// 先只打字、等 `draft` 出現 prompt，再只補 Enter、等 `draft` 清空；整段文字最多送一次，只有 Enter 會重送。
// 送出前 composer 不是空的（例如上一次 STOP 留下的舊提醒）就 STOP draft-not-empty，不把舊草稿當成這一則送出；
// 任何一次讀不到 `draft` 欄位（`orca terminal read --help`：may be absent）都無從確認，STOP draft-unavailable，不重送。
// 忙碌中 session 的真實 `terminal read` 樣本：test/fixtures/orca/read-working.json（WSL、Orca 1.4.271 錄，#507；spinner 行與未送出的 `draft` 都在）；
// macOS 那份尚未錄，macos/ 下是同形狀的副本。
//
// 用法：node scripts/orca-session-send.mjs --terminal <handle> --prompt <text> [--queue]
// stdout 最後一行：SENT <handle>、QUEUED <handle>（--queue），或 STOP <原因>（tui-timeout <handle>、send <handle>、draft-not-empty <handle>、draft-unavailable <handle>（後兩者只在 --queue）、orca <錯誤碼>）。
//   步驟逾時的 orca 原因帶出步驟與已花時間：`orca timeout <terminal 子指令> <毫秒>ms`（#535）。
// stderr：不帶 --queue 時，第一次送出因 composer 已有該 prompt 而只補 Enter 時印 `DRAFT_SUBMIT <handle>`（不含 prompt 文字）。
//   `tui-timeout` 時先讀該分頁的畫面再回 STOP（呼叫者之後可能關掉分頁，畫面就跟著消失，#536）：印 `SCREEN_TAIL <handle>` 加最後 15 行（每行前面兩個空白），
//   讀不到時印 `SCREEN_TAIL_UNAVAILABLE <handle> <原因>`；兩者都不改 stdout 的 STOP 行與 exit 碼。
// exit：0 已送達；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/orca-session-send.mjs --terminal <handle> --prompt <text> [--queue]（需要 ORCA_CLI_COMMAND）';

/** tui-timeout 時附在 stderr 的畫面行數。 */
const SCREEN_TAIL_LINES = 15;

/** 每輪等 TUI 就緒的上限；共等兩輪（實測第一次常逾時、第二次在 30 秒內就緒）。 */
const TUI_WAIT_MS = Number(process.env.SESSION_TUI_WAIT_MS || 120000);

/**
 * 送出後讀畫面確認的間隔與次數，以及每次送出前的等待：第一次立即、第二次 5 秒後、第三次 30 秒後。
 * 第三次是因為 tui-idle 判定就緒早於輸入框可收字，幾分鐘後再送才成功。
 */
const CONFIRM_MS = Number(process.env.SESSION_SEND_CONFIRM_MS || 2000);
const CONFIRM_POLLS = 5;
const SEND_DELAYS = [0, Number(process.env.SESSION_SEND_RESEND_MS || 5000), Number(process.env.SESSION_SEND_LATE_RESEND_MS || 30000)];

/**
 * Claude TUI 工作中的 spinner 行，如 `✳ Fiddle-faddling… (1m 32s · ↓ 1.2k tokens)`：符號、動詞加 `…`、括號裡以經過時間或 `esc` 開頭。
 * 不一定帶 `esc to interrupt`（#354 的真實畫面，#323 第 3 項 11-15 留言）。已結束那一輪的 `✻ Cogitated for 46s` 沒有 `…`，
 * 一般輸出的清單行（`* 項目… (見下)`）括號裡不是時間，都不算。
 */
export const SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S[^…]*…\s*\((?:\d|esc\b)/u;

/**
 * 把 JSON 字串值裡未跳脫的控制字元改成 \u00XX、不成立的反斜線跳脫改成 `\\`；字串外的內容不動。
 * `terminal read --screen` 的 tail 帶反斜線（Windows 路徑、ANSI 殘留）時 Orca 印出的 JSON 會有這兩種錯（investing#204，#355）；
 * 正常輸出時 JSON.parse 直接成功，用不到這一步。
 */
export function repairJson(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (next !== undefined && '"\\/bfnrt'.includes(next)) { out += c + next; i++; continue; }
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += text.slice(i, i + 6); i += 5; continue; }
      out += '\\\\';
      continue;
    }
    if (c === '"') { inString = false; out += c; continue; }
    const code = c.charCodeAt(0);
    out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : c;
  }
  return out;
}

/**
 * Orca CLI 呼叫；回傳 JSON 的 result，失敗丟出含錯誤碼（`code`）的 Error。輸出不是合法 JSON 時先以 repairJson 修過再解析一次。
 * `signal` 中止時殺掉 CLI 並丟出 AbortError（呼叫者用它限制總時間、處理 SIGTERM）。
 * 逾時有兩種：CLI 自己回 `{ ok: false, error: { code: 'timeout' } }`（`terminal wait` 等不到條件），或呼叫者的 `AbortSignal.timeout` 殺掉它；
 * 兩者的訊息都帶出步驟與已花時間，例如 `timeout terminal list 10003ms`，STOP 行才看得出是哪一步（#535，investing 連續三次交接失敗）。
 * 其他失敗的訊息不變：Orca 的錯誤碼；總預算與 SIGTERM 的中止（reason 是字串）也維持原樣。
 */
export async function orca({ cli, signal }, ...args) {
  const started = Date.now();
  const timedOut = () => `timeout ${args.slice(0, 2).join(' ')} ${Date.now() - started}ms`;
  try {
    const child = spawn(cli, [...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    let body;
    try { body = JSON.parse(stdout); } catch {
      try { body = JSON.parse(repairJson(stdout)); } catch { throw new Error((stderr || stdout || '').trim().split('\n').pop() || `exit ${status}`); }
    }
    if (!body.ok) {
      const code = body.error?.code ?? body.error?.message ?? 'orca 失敗';
      throw Object.assign(new Error(code === 'timeout' ? timedOut() : code), { code });
    }
    return body.result;
  } catch (error) {
    // 步驟上限（AbortSignal.timeout）到了：AbortError 的 cause 是 TimeoutError。
    if (error.name === 'AbortError' && error.cause?.name === 'TimeoutError') {
      throw Object.assign(new Error(timedOut()), { code: 'timeout', name: 'AbortError', cause: error.cause });
    }
    throw error;
  }
}

/**
 * 等 terminal 的 Claude TUI 就緒，最多兩輪。Orca CLI 等不到條件時回 `timeout` 錯誤碼（不是 `satisfied: false`），
 * 這輪算未就緒、照常再等一輪；其他錯誤與呼叫者的中止照舊丟出（#535）。
 * 兩輪都沒就緒時，回 false 前先以 reportScreenTail 把畫面尾巴印到 stderr（呼叫者接著可能關掉分頁，#536）。
 */
export async function waitTuiReady(ctx, handle) {
  for (let round = 0; round < 2; round++) {
    try {
      if ((await orca(ctx, 'terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(TUI_WAIT_MS))).wait?.satisfied) return true;
    } catch (error) {
      if (error.code !== 'timeout' || ctx.signal?.aborted) throw error;
    }
  }
  await reportScreenTail(ctx, handle);
  return false;
}

/**
 * tui-timeout 時把分頁畫面最後幾行印到 stderr：分頁常卡在啟動對話框（例如 Settings Warning），呼叫者關掉分頁後就看不到（#536）。
 * 讀取失敗只印原因，不丟錯、不改變 STOP。
 */
export async function reportScreenTail(ctx, handle) {
  try {
    const { tail = [] } = (await orca(ctx, 'terminal', 'read', '--terminal', handle, '--screen')).terminal ?? {};
    const lines = tail.map(line => line.trimEnd());
    while (lines.length && !lines.at(-1)) lines.pop();
    console.error([`SCREEN_TAIL ${handle}`, ...lines.slice(-SCREEN_TAIL_LINES).map(line => `  ${line}`)].join('\n'));
  } catch (error) {
    console.error(`SCREEN_TAIL_UNAVAILABLE ${handle} ${error.message}`);
  }
}

/**
 * 送出 prompt 並確認進了 Claude：TUI 剛就緒時 Orca 會回 accepted 卻吞掉輸入。
 * 畫面出現 prompt 開頭、`esc to interrupt` 或工作中的 spinner（SPINNER）才算送達；否則依 SEND_DELAYS 重送，重送前再讀一次畫面，已送達就不重送。
 * 送不出或三次都沒送達傳回 false。
 * 第一次送出前先讀一次 composer 的 `draft`（缺省視為空），已有同一段文字時只補 Enter，並在 stderr 印 `DRAFT_SUBMIT <handle>`。
 */
export async function sendPrompt(ctx, handle, text) {
  // 讀一次畫面：draft（缺省視為空）與是否已送達。文字還在輸入框（draft 含 prompt 開頭）時，畫面上那一行只是輸入框，不算送達。
  const readScreen = async () => {
    const { tail = [], draft = '' } = (await orca(ctx, 'terminal', 'read', '--terminal', handle)).terminal ?? {};
    const landed = tail.some(line => line.includes(promptHead(text)) || line.includes('esc to interrupt') || SPINNER.test(line));
    return { draft: draft ?? '', landed: landed && resendInput(draft ?? '', text)[1] !== '' };
  };
  let { draft } = await readScreen();
  if (resendInput(draft, text)[1] === '') console.error(`DRAFT_SUBMIT ${handle}`);
  for (const delay of SEND_DELAYS) {
    if (delay) {
      await sleep(delay, undefined, { signal: ctx.signal });
      // 重送前再讀一次：worker 可能在等待期間才開始工作，這時重送只會排進佇列。
      const screen = await readScreen();
      if (screen.landed) return true;
      draft = screen.draft;
    }
    if (!(await orca(ctx, 'terminal', 'send', '--terminal', handle, ...resendInput(draft, text))).send?.accepted) return false;
    for (let poll = 0; poll < CONFIRM_POLLS; poll++) {
      await sleep(CONFIRM_MS, undefined, { signal: ctx.signal });
      const screen = await readScreen();
      if (screen.landed) return true;
      draft = screen.draft;
    }
  }
  return false;
}

/**
 * 把 prompt 排進忙碌中 session 的下一輪：`draft` 是空的才只打字，讀到 `draft` 含 prompt 開頭才補 Enter，`draft` 清空才算排進佇列；
 * Enter 依 SEND_DELAYS 重送，整段文字只送一次。
 * @returns {Promise<string | null>} 排進佇列回 null，否則回 STOP 原因：`draft-not-empty`、`draft-unavailable` 或 `send`。
 */
export async function queuePrompt(ctx, handle, text) {
  // 欄位缺省或不是字串（如 null）都算讀不到。
  const readDraft = async () => {
    const draft = (await orca(ctx, 'terminal', 'read', '--terminal', handle)).terminal?.draft;
    return typeof draft === 'string' ? draft : undefined;
  };
  const poll = async done => {
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      await sleep(CONFIRM_MS, undefined, { signal: ctx.signal });
      const draft = await readDraft();
      if (draft === undefined) return 'draft-unavailable';
      if (done(draft)) return null;
    }
    return 'send';
  };
  const draft = await readDraft();
  if (draft === undefined) return 'draft-unavailable';
  if (draft.trim()) return 'draft-not-empty';
  if (!(await orca(ctx, 'terminal', 'send', '--terminal', handle, '--text', text)).send?.accepted) return 'send';
  const typed = await poll(draft => draft.includes(promptHead(text)));
  if (typed) return typed;
  for (const delay of SEND_DELAYS) {
    if (delay) await sleep(delay, undefined, { signal: ctx.signal });
    if (!(await orca(ctx, 'terminal', 'send', '--terminal', handle, '--text', '', '--enter')).send?.accepted) return 'send';
    const queued = await poll(draft => !draft.trim());
    if (queued !== 'send') return queued;
  }
  return 'send';
}

/** 判斷文字是否已在畫面或輸入框時比對的 prompt 開頭。 */
export function promptHead(text) {
  return text.slice(0, 24);
}

/** 重送的輸入：文字已留在輸入框（`draft` 含 prompt 開頭）時只補 Enter，否則送文字加 Enter；避免黏成兩份。 */
export function resendInput(draft, text) {
  return draft.includes(promptHead(text)) ? ['--text', '', '--enter'] : ['--text', text, '--enter'];
}

/**
 * 等既有 terminal 閒置後送出 prompt 並確認送達；`queue` 時不等閒置，送出排到下一輪。`ctx` 是 `{ cli, signal? }`；中止也回 `orca` STOP，由呼叫者看 `signal.reason` 改判。
 * @returns {{handle: string} | {stop: string}} 成功回 handle；失敗回 STOP 原因（不含 `STOP ` 前綴）。
 */
export async function sendToSession(ctx, handle, prompt, { queue = false } = {}) {
  try {
    if (queue) {
      const stop = await queuePrompt(ctx, handle, prompt);
      return stop ? { stop: `${stop} ${handle}` } : { handle };
    }
    if (!await waitTuiReady(ctx, handle)) return { stop: `tui-timeout ${handle}` };
    if (!await sendPrompt(ctx, handle, prompt)) return { stop: `send ${handle}` };
  } catch (error) {
    return { stop: `orca ${error.message}` };
  }
  return { handle };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const handle = value('--terminal');
  const prompt = value('--prompt');
  const queue = args.includes('--queue');
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!handle || !prompt || !cli || args.length !== (queue ? 5 : 4)) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const sent = await sendToSession({ cli }, handle, prompt, { queue });
    console.log(sent.stop ? `STOP ${sent.stop}` : `${queue ? 'QUEUED' : 'SENT'} ${sent.handle}`);
    process.exit(sent.stop ? 4 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
