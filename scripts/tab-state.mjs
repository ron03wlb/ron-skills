#!/usr/bin/env node
// 分頁狀態（GLOSSARY.md「分頁狀態」）：Orca 分頁標題最前面的 `<狀態>｜` 前綴，狀態是處理中、待 Retro、待關閉。
// 只換目前分頁（ORCA_TERMINAL_HANDLE）標題的狀態前綴，沒有前綴就補上，其他文字不動；agent、skill、pilot script 與 claude-hook-tab-state.mjs 都用它。
// Orca（1.4.245）讀不回 `terminal rename` 設的分頁標題：`terminal list` 的 title 是 Claude 的自動標題。所以每個 handle 最後設定的標題
// 記在本機 TAB_STATE_DIR（預設 ~/.local/state/orca-tab-titles）的 `<handle>` 檔：本腳本改名後寫入，hook 從 Bash 的
// `orca terminal rename` 指令擷取寫入；沒有記錄時以 Orca 的自動標題為目前標題（從沒改過名的分頁顯示的就是它）。
//
// 用法：node scripts/tab-state.mjs <處理中|待 Retro|待關閉> [--topic <主題>]
// --topic 把標題整個設成 `<狀態>｜<主題>`，不讀目前標題：session 開頭用它，記錄裡可能還是同一個 handle 上一個 session 的主題（#141）；
// 之後的狀態切換不帶 --topic。
// stdout：改名成功時印 `TAB_STATE <新標題>`。
// exit：0 已改名，或沒有 ORCA_TERMINAL_HANDLE、Orca 呼叫失敗（都不輸出）；2 狀態不合法、--topic 沒有值。
// ORCA_CLI_COMMAND 沒設時用 PATH 上的 `orca`。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { orca } from './orca-session-send.mjs';

export const STATES = ['處理中', '待 Retro', '待關閉'];
const SEP = '｜';
const PREFIX = new RegExp(`^(?:${STATES.join('|')})${SEP}`);
/** 一次 tab-state 或 hook 呼叫裡全部 Orca 呼叫共用的上限。 */
const ORCA_BUDGET_MS = 10000;

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

/** 目前標題：記錄，沒有時是 Orca 的自動標題。`ctx` 是 `{ cli, signal? }`（同 orca-session-send.mjs）。 */
export async function currentTitle(ctx, handle) {
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
  } catch {
    process.exit(0);
  }
}
