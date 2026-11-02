#!/usr/bin/env node
// 分頁狀態（GLOSSARY.md「分頁狀態」）：Orca 分頁標題最前面的 `<狀態>｜` 前綴，狀態是處理中、待 Retro、待關閉。
// 只換目前分頁（ORCA_TERMINAL_HANDLE）標題的狀態前綴，沒有前綴就補上，其他文字不動；agent、skill、pilot script 與 claude-hook-tab-state.mjs 都用它。
// 目前標題以 Orca 的分頁資料為準：`terminal list --include-visual-layouts` 的 tab title；`terminals[].title` 是程式自己的標題（Claude 的自動標題），不是分頁標題。
// 每個 handle 最後設定的標題另記在本機 TAB_STATE_DIR（預設 ~/.local/state/orca-tab-titles）的 `<handle>` 檔：本腳本改名後寫入，hook 從 Bash 的
// `orca terminal rename` 指令擷取寫入；Orca 查不到分頁時才用它，其他會改標題的 hook 也靠它判斷標題歸本腳本管理。
//
// 用法：node scripts/tab-state.mjs <處理中|待 Retro|待關閉> [--topic <主題>]
// --topic 把標題整個設成 `<狀態>｜<主題>`，不讀目前標題：session 開頭用它，記錄裡可能還是同一個 handle 上一個 session 的主題（#141）；
// 之後換階段、動作、Issue、⏸，或離開處理中要拿掉階段與動作時也帶 --topic；只換狀態前綴時不帶（標題格式見 issue-run ADAPTER.md 的 Tab state 段）。
// stdout：改名成功時印 `TAB_STATE <新標題>`。
// stderr：Orca 呼叫失敗時印 `TAB_STATE_FAILED <狀態> <原因>`；原因是逾時時改名可能已送達，分頁實際標題要另外看（#295：沒印 TAB_STATE 卻改成功、和完全沒改，看起來一樣）。
// exit：0 已改名，或沒有 ORCA_TERMINAL_HANDLE（不輸出）、Orca 呼叫失敗（不擋 hook 與 script）；2 狀態不合法、--topic 沒有值。
// ORCA_CLI_COMMAND 沒設時用 PATH 上的 `orca`。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATES = ['處理中', '待 Retro', '待關閉'];
const SEP = '｜';
const PREFIX = new RegExp(`^(?:${STATES.join('|')})${SEP}`);
/** 一次 tab-state 或 hook 呼叫裡全部 Orca 呼叫共用的上限。 */
const ORCA_BUDGET_MS = Number(process.env.TAB_STATE_BUDGET_MS || 10000);
/** 讀目前標題的 `terminal list --include-visual-layouts` 另外的上限：它在這台機器花過 12.8 秒（#295），不留時間給改名的話，整次都被中止。逾時就改用記錄的標題。 */
const ORCA_LIST_MS = Number(process.env.TAB_STATE_LIST_BUDGET_MS || 6000);

/**
 * Orca CLI 呼叫；回傳 JSON 的 result，失敗丟出含錯誤碼的 Error，`signal` 中止時殺掉 CLI。
 * 本腳本不 import orca-session-send.mjs：專案可能有自己的（例如同步版）送出腳本，tab-state 與 hook 要能原樣複製進去。
 */
async function orca({ cli, signal }, ...args) {
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

/** 去掉標題最前面的狀態前綴。 */
export const stripState = title => String(title ?? '').replace(PREFIX, '');

/** 標題是否以合法的狀態前綴開頭。 */
export const hasState = title => PREFIX.test(String(title ?? ''));

/** 本腳本與 hook 的 Orca 呼叫環境：ORCA_CLI_COMMAND 沒設時用 PATH 上的 `orca`，全部呼叫共用 ORCA_BUDGET_MS。 */
export const orcaContext = () => ({ cli: process.env.ORCA_CLI_COMMAND || 'orca', signal: AbortSignal.timeout(ORCA_BUDGET_MS) });

/** 換成 `state` 的前綴，其他文字不動。 */
export const withState = (title, state) => `${state}${SEP}${stripState(title)}`;

/** 去掉狀態前綴與 `[類別] ` 之後比對：`處理中｜[維運] issue-pilot coordinator` 與 `issue-pilot coordinator` 同一個主題。 */
const topic = title => stripState(title).replace(/^\[[^\]]*\]\s*/, '').trim();
export const sameTopic = (a, b) => Boolean(topic(a)) && topic(a) === topic(b);

const dir = () => process.env.TAB_STATE_DIR || join(homedir(), '.local/state/orca-tab-titles');
const file = handle => join(dir(), handle.replace(/[^\w.-]/g, '_'));

/** 這個 handle 最後設定的標題；沒有記錄時為 null。 */
export function recordedTitle(handle) {
  return handle && existsSync(file(handle)) ? readFileSync(file(handle), 'utf8') : null;
}

/** 記下這個 handle 最後設定的標題；記錄只是輔助，寫不進去時傳回 false，不丟錯（開分頁、改名照常算成功）。 */
export function recordTitle(handle, title) {
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(file(handle), title);
    return true;
  } catch {
    return false;
  }
}

/** 找出含 `handle` 這個 pane 的分頁標題；visualLayouts 是分割、群組與分頁組成的巢狀結構。 */
function tabTitleOf(node, handle) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const title = tabTitleOf(item, handle);
      if (title != null) return title;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  if (node.panes && JSON.stringify(node.panes).includes(JSON.stringify(handle))) return node.title ?? null;
  return tabTitleOf(Object.values(node), handle);
}

/** 目前標題：Orca 的實際分頁標題；Orca 查不到時用記錄，再沒有就是 Orca 的自動標題。`ctx` 是 `{ cli, signal? }`。 */
export async function currentTitle(ctx, handle) {
  let live = null;
  try {
    const limit = AbortSignal.timeout(ORCA_LIST_MS);
    const { visualLayouts } = await orca({ ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, limit]) : limit }, 'terminal', 'list', '--include-visual-layouts');
    live = tabTitleOf(visualLayouts, handle);
  } catch { /* 舊版 Orca 沒有這個旗標、Orca 暫時連不上，或太慢 */ }
  if (live !== null) return live;
  const recorded = recordedTitle(handle);
  if (recorded !== null) return recorded;
  const { terminals } = await orca(ctx, 'terminal', 'list');
  return terminals.find(terminal => terminal.handle === handle)?.title ?? '';
}

/** 把分頁標題換成 `state` 的前綴並記下；有 `topic` 時標題是 `<state>｜<topic>`，不讀目前標題。傳回新標題。 */
export async function setState(ctx, handle, state, topic) {
  const title = withState(topic ?? await currentTitle(ctx, handle), state);
  await orca(ctx, 'terminal', 'rename', '--terminal', handle, '--title', title);
  recordTitle(handle, title);
  return title;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--topic');
  const state = (at < 0 ? args : args.slice(0, at)).join(' ');
  const topic = at < 0 ? undefined : args.slice(at + 1).join(' ').trim();
  if (!STATES.includes(state) || topic === '') {
    console.error(`用法：node scripts/tab-state.mjs <${STATES.join('|')}> [--topic <主題>]`);
    process.exit(2);
  }
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) process.exit(0);
  try {
    const title = await setState(orcaContext(), handle, state, topic);
    console.log(`TAB_STATE ${title}`);
  } catch (error) {
    console.error(`TAB_STATE_FAILED ${state} ${error.name === 'AbortError' ? `逾時（${ORCA_BUDGET_MS} ms），改名可能已送達` : error.message}`);
    process.exit(0);
  }
}
