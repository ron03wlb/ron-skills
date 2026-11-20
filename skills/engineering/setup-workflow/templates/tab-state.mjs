#!/usr/bin/env node
// 分頁狀態（GLOSSARY.md「分頁狀態」）：Orca 分頁標題最前面的 `<狀態>｜` 前綴，狀態是處理中、待 Retro、待關閉。
// 換目前分頁（ORCA_TERMINAL_HANDLE）標題的狀態前綴，沒有前綴就補上；agent、skill、pilot script 與 claude-hook-tab-state.mjs 都用它。
// 目前標題以 Orca 的分頁資料為準：`terminal list --include-visual-layouts` 的 tab title；`terminals[].title` 是程式自己的標題（Claude 的自動標題），不是分頁標題。
// 每個 handle 最後設定的標題另記在本機 TAB_STATE_DIR（預設 ~/.local/state/orca-tab-titles）的 `<handle>` 檔：本腳本改名前寫入（改名失敗時還原），hook 從 Bash 的
// `orca terminal rename` 指令擷取寫入；Orca 查不到分頁時才用它，其他會改標題的 hook 也靠它判斷標題歸本腳本管理。
//
// 用法：node scripts/tab-state.mjs <處理中|待 Retro|待關閉> [--topic <主題>]
//       node scripts/tab-state.mjs --title <handle> → 印該分頁目前標題（Orca 的版面資料沒涵蓋的分頁退回記錄）；`/retro-collect` 用它判斷能不能關。
// --topic 把標題整個設成 `<狀態>｜<主題>`，不讀目前標題：session 開頭用它，記錄裡可能還是同一個 handle 上一個 session 的主題（#141）；
// 之後換階段、動作、Issue、⏸ 也帶 --topic（標題格式見 issue-run ADAPTER.md 的 Tab state 段）。
// 不帶 --topic：換成處理中時只換前綴，其他文字不動；換成其他狀態時只留 `<狀態>｜<主題>`，拿掉主題後的 `｜` 段（階段、動作）與 ` ⏸`（#334：`待 Retro` 留下
//   `｜規劃｜grilling`）。hook 與 tab-state-finish 直接呼叫 setState，仍只換前綴。
// 改名後讀回實際分頁標題再回報（2026-11-02：Orca 回 ok、分頁實際沒變，只看回傳就回報了沒發生的事）；只有這個 CLI 入口讀回，hook 與 tab-state-finish 直接呼叫 setState，不多花 Orca 呼叫。
// stdout：改名成功時印 `TAB_STATE <新標題>`；讀不到分頁（舊版 Orca、連不上、太慢）無從比對，照樣算成功。
// stderr：Orca 呼叫失敗時印 `TAB_STATE_FAILED <狀態> <原因>`。逾時時腳本自己讀回實際標題：已生效就算成功（#295：沒印 TAB_STATE 卻改成功、和完全沒改，看起來一樣），
//   確定沒生效就再送一次（retro spay2 b1549391#4：agent 只能自己 --title 再重跑）；仍逾時才印，這時改名可能已送達，分頁實際標題要另外看。
//   讀回的標題不符時再送一次、再讀回：別的寫入者可能剛蓋掉（retro 2de453a3#6：orca-tab-title hook 的背景工作在讀到記錄之前就決定要清標題，幾秒後才送出，清掉本腳本剛設的標題）。
//   讀回在 TAB_STATE_VERIFY_MS（預設 5000）內每隔 TAB_STATE_VERIFY_RETRY_MS（預設 400）讀一次，相符就停；重送後同樣輪詢一輪。
//   仍不符才印 `TAB_STATE_MISMATCH <應有標題> actual=<實際標題>`，不印 TAB_STATE，下一行 `TAB_STATE_RENAME <最後一次 rename 的回傳 JSON>`、
//   再下一行 `TAB_STATE_TAB <最後一次讀回時 visualLayouts 裡該分頁那一列的 JSON>`，分得出 rename 沒生效、讀回延遲或別的寫入者蓋回。
//   原因：2026-11-05 低負載實測 rename 後第一次 list 就是新標題，但 2026-11 investing 高負載（load 約 18）多次 MISMATCH、actual 是上一次要求的標題，
//   約 10 分鐘後 --title 才讀到新標題（#332 第 4 項）；舊版只讀 3 次、間隔 400 ms。另有 actual 一直停在同一個舊標題、重跑也不變的情形（#336 第 1 項，未重現），診斷行就是為它留的。
//   --title 讀不到 Orca（`terminal list` 實測 3–8.5 秒，上限 ORCA_LIST_MS）而退回記錄時，stderr 印 `TAB_TITLE_FROM_RECORD <handle>`：這是最後設定的標題，不代表分頁實際如此（同一 retro 就把它讀成改名已生效）。
// exit：0 已改名，或沒有 ORCA_TERMINAL_HANDLE（不輸出）、Orca 呼叫失敗（不擋 hook 與 script）；1 讀回的標題不符；2 狀態不合法、--topic 沒有值。
// ORCA_CLI_COMMAND 沒設時用 PATH 上的 `orca`。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const WORKING = '處理中';
export const STATES = [WORKING, '待 Retro', '待關閉'];
const SEP = '｜';
const PREFIX = new RegExp(`^(?:${STATES.join('|')})${SEP}`);
/** 一次 tab-state 或 hook 呼叫裡全部 Orca 呼叫共用的上限。 */
const ORCA_BUDGET_MS = Number(process.env.TAB_STATE_BUDGET_MS || 10000);
/** 讀目前標題的 `terminal list --include-visual-layouts` 另外的上限：它在這台機器花過 12.8 秒（#295），不留時間給改名的話，整次都被中止。逾時就改用記錄的標題。 */
const ORCA_LIST_MS = Number(process.env.TAB_STATE_LIST_BUDGET_MS || 6000);
/** 改名後讀回：輪詢的時間上限與間隔，新標題可能要過一下才反映在 visualLayouts（高負載時更久，#332）。 */
const VERIFY_MS = Number(process.env.TAB_STATE_VERIFY_MS || 5000);
const VERIFY_RETRY_MS = Number(process.env.TAB_STATE_VERIFY_RETRY_MS || 400);

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

/** 離開處理中時留下的主題：去掉狀態前綴、第一個 `｜` 之後的段（階段、動作）與結尾的 ` ⏸`；去完是空的就不去。 */
export const mainTopic = title => stripState(title).split(SEP)[0].replace(/\s*⏸\s*$/, '').trim() || stripState(title);

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

/** 刪掉這個 handle 的標題記錄（分頁關了之後用）；沒有記錄或沒給 handle 時什麼都不做，刪不掉時丟錯。 */
export function forgetTitleRecord(handle) {
  if (handle) rmSync(file(handle), { force: true });
}

/** 找出含 `handle` 這個 pane 的分頁（有標題的那一層）；visualLayouts 是分割、群組與分頁組成的巢狀結構。 */
function tabOf(node, handle) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const tab = tabOf(item, handle);
      if (tab?.title != null) return tab;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  if (node.panes && JSON.stringify(node.panes).includes(JSON.stringify(handle))) return node;
  return tabOf(Object.values(node), handle);
}

/** 含 `handle` 這個 pane 的分頁標題；找不到時為 null。 */
export const tabTitleOf = (node, handle) => tabOf(node, handle)?.title ?? null;

/** Orca 裡含 `handle` 的分頁那一列；讀不到時為 null（舊版 Orca 沒有這個旗標、Orca 暫時連不上，或太慢）。 */
async function liveTab(ctx, handle) {
  try {
    const limit = AbortSignal.timeout(ORCA_LIST_MS);
    const { visualLayouts } = await orca({ ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, limit]) : limit }, 'terminal', 'list', '--include-visual-layouts');
    const tab = tabOf(visualLayouts, handle);
    return tab?.title != null ? tab : null;
  } catch {
    return null;
  }
}

/** Orca 的實際分頁標題；讀不到時為 null。 */
const liveTitle = async (ctx, handle) => (await liveTab(ctx, handle))?.title ?? null;

/** 目前標題：Orca 的實際分頁標題；Orca 查不到時用記錄，再沒有就是 Orca 的自動標題。`ctx` 是 `{ cli, signal? }`。 */
export async function currentTitle(ctx, handle) {
  const live = await liveTitle(ctx, handle);
  if (live !== null) return live;
  const recorded = recordedTitle(handle);
  if (recorded !== null) return recorded;
  const { terminals } = await orca(ctx, 'terminal', 'list');
  return terminals.find(terminal => terminal.handle === handle)?.title ?? '';
}

/** 把分頁標題換成 `state` 的前綴並記下；有 `topic` 時標題是 `<state>｜<topic>`，不讀目前標題。`ctx.onRename` 收到 rename 的回傳。傳回新標題。 */
export async function setState(ctx, handle, state, topic) {
  const title = withState(topic ?? await currentTitle(ctx, handle), state);
  // 先記再改名：CLI 一次呼叫要 3 秒，改名送出到生效之間，orca-tab-title hook 靠記錄才知道標題歸本腳本管（retro 2de453a3#6）。改名失敗時還原。
  const previous = recordedTitle(handle);
  recordTitle(handle, title);
  try {
    const reply = await orca(ctx, 'terminal', 'rename', '--terminal', handle, '--title', title);
    ctx.onRename?.(reply);
  } catch (error) {
    if (previous === null) forgetTitleRecord(handle);
    else recordTitle(handle, previous);
    throw error;
  }
  return title;
}

/**
 * 改名逾時之後：讀回實際標題，已生效傳回它；確定沒生效就再送一次，傳回新標題；讀不到分頁無從判斷，丟回原本的錯。
 * 沒帶 topic 時不知道原本要的完整標題，帶著 `state` 前綴就算生效。
 */
export async function settleTimeout(handle, state, topic, timeout, onRename) {
  const live = await liveTitle(orcaContext(), handle);
  if (live === null) throw timeout;
  if (topic === undefined ? live.startsWith(`${state}${SEP}`) : live.trim() === withState(topic, state).trim()) {
    recordTitle(handle, live);
    return live;
  }
  return setState({ ...orcaContext(), onRename }, handle, state, topic);
}

/**
 * 改名後在 VERIFY_MS 內輪詢讀回：讀到與 `title` 相符時為 null；第一次就讀不到分頁時無從比對，也是 null；
 * 到上限仍不符時傳回最後讀到的實際標題（中途某次讀不到不抹掉先前的不符：高負載時 list 本身就慢，#332）。
 * 每次讀各有 ORCA_LIST_MS 上限；`ctx.signal` 若比輪詢窗口短，到期後的讀取都讀不到，所以 CLI 傳不帶 signal 的 ctx。
 * `seen.tab` 留下最後一次讀到的分頁那一列（MISMATCH 診斷用），再傳進下一輪時當作已讀到的標題。
 */
export async function titleMismatch(ctx, handle, title, seen = {}) {
  const deadline = Date.now() + VERIFY_MS;
  // 重送後的第二輪接著第一輪讀到的不符：開頭讀不到分頁時不算相符。
  let actual = seen.tab?.title ?? null;
  for (;;) {
    const tab = await liveTab(ctx, handle);
    if (tab !== null) {
      seen.tab = tab;
      actual = tab.title;
      if (actual.trim() === title.trim()) return null;
    } else if (actual === null) return null;
    if (Date.now() + VERIFY_RETRY_MS >= deadline) return actual;
    await sleep(VERIFY_RETRY_MS);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--title') {
    if (!args[1]) {
      console.error('用法：node scripts/tab-state.mjs --title <handle>');
      process.exit(2);
    }
    const ctx = orcaContext();
    const live = await liveTitle(ctx, args[1]);
    if (live !== null) { console.log(live); process.exit(0); }
    if (recordedTitle(args[1]) !== null) console.error(`TAB_TITLE_FROM_RECORD ${args[1]}`);
    console.log(await currentTitle(ctx, args[1]).catch(() => recordedTitle(args[1]) ?? ''));
    process.exit(0);
  }
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
    const seen = {};
    const onRename = reply => { seen.rename = reply; };
    const ctx = () => ({ ...orcaContext(), onRename });
    // 離開處理中又沒帶 --topic：先讀目前標題取出主題，之後都當成帶了這個 --topic（拿掉階段、動作與 ⏸，#334）。
    let wanted = topic;
    // 改名是冪等的，失敗或逾時就用新的時間上限再送一次：改名可能已送達卻沒寫記錄，`/retro-collect` 讀到舊狀態就不關分頁（1102b 的 #297）。
    // 讀目前標題與改名共用同一個 context，一次嘗試只用一份 ORCA_BUDGET_MS。
    const attempt = async () => {
      const c = ctx();
      if (wanted === undefined && state !== WORKING) wanted = mainTopic(await currentTitle(c, handle));
      return setState(c, handle, state, wanted);
    };
    const title = await attempt().catch(attempt).catch(error => {
      if (error.name !== 'AbortError') throw error;
      return settleTimeout(handle, state, wanted, error, onRename);
    });
    // 讀回不掛共用的時間上限：輪詢由 VERIFY_MS 收尾、每次讀由 ORCA_LIST_MS 收尾，掛上 10 秒上限的話高負載時後段的讀取全被中止。
    const verify = { cli: orcaContext().cli };
    let actual = await titleMismatch(verify, handle, title, seen);
    if (actual !== null) {
      // 重送失敗就照實回報不符，不改成 TAB_STATE_FAILED：剛才讀到的標題確實不對。
      const resent = await setState(ctx(), handle, state, stripState(title)).then(() => true, () => false);
      if (resent) actual = await titleMismatch(verify, handle, title, seen);
    }
    if (actual !== null) {
      console.error(`TAB_STATE_MISMATCH ${title} actual=${actual}`);
      console.error(`TAB_STATE_RENAME ${JSON.stringify(seen.rename ?? null)}`);
      console.error(`TAB_STATE_TAB ${JSON.stringify(seen.tab ?? null)}`);
      process.exit(1);
    }
    console.log(`TAB_STATE ${title}`);
  } catch (error) {
    console.error(`TAB_STATE_FAILED ${state} ${error.name === 'AbortError' ? `逾時（${ORCA_BUDGET_MS} ms），改名可能已送達` : error.message}`);
    process.exit(0);
  }
}
