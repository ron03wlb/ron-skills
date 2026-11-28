#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 在 Orca 開一個新的 Claude session 並送出第一個 prompt：有 ORCA_TERMINAL_HANDLE 時 split 在呼叫者的 pane 旁邊（使用者的每個分頁各有用途，不另開新分頁），
// 沒有時，或帶 `--tab`（新 session 要比呼叫者活得久，例如 coordinator 交接後使用者會關掉舊視窗）時，在主 checkout 新開分頁；
// 帶 `--worktree <path>`（要在自己 worktree 跑的 session）時，在該 worktree 新開分頁；
// 新分頁時標題前面加上分頁狀態「處理中｜」（tab-state.mjs；已有狀態前綴就換掉），命名並記下標題（Orca 讀不回，見 tab-state.mjs）。
// split 模式不改名也不記標題：分頁標題歸呼叫者，split 出來的 session 跑 tab-state 時也不改（印 TAB_STATE_SKIP split，#378）。
// 之後等 TUI 就緒（兩輪）→ 送出 prompt 並讀畫面確認送達（orca-session-send.mjs 的 waitTuiReady／sendPrompt）。
// 送出不帶 `--wait-submit`：Orca 從 WSL 常因無法確認 prompt-delivery 回 runtime_unavailable 且完全不送出。
// 任何「開新 session 接手」的交接都走這裡，不手動組 create／split／rename／wait／send。
// 啟動指令預設裸 `claude`（吃全域設定的模型）；openSession 帶 `model` 時改成 `claude --model <model>`。只有 pilot-handoff.mjs 開後繼 coordinator 時
// 帶它（adapter 的 `Coordinator model:` 宣告）；本支的命令列不讀 adapter、不帶 `--model`，其他用途開的 session 都是裸 `claude`。
//
// `--capacity <repo> --kind fix|retro`（#622：tooling fix unit 與 /retro-collect 收集者跑完整檢查，卻不是 batch 成員）：開分頁前以同目錄 pilot-capacity.mjs 的
//   帳本鎖裡預留一個名額（合計＋1，兩個呼叫者不會同時拿到最後一個），超過上限就印 `STOP capacity <合計>/<上限> [<repo>=<n>...] +1`、不開；
//   分頁開好後（送出失敗而 STOP 時也是）預留列換成分頁的 handle，分頁沒開成時刪掉；換 handle 失敗（含預留列已不在帳本，原因 `pending-row-missing`）時 stderr 印 `WARN capacity-record <原因> → <補記指令（先 close 預留列再 open）>`；帳本讀寫失敗時印 `STOP capacity ledger <原因>`、不開。這筆 session 列
//   之後由 pilot-probe.mjs `--capacity <repo>` 每輪刷新或在 terminal 結束時清掉。兩個旗標要一起給；`<repo>` 同 Probe 的 `--capacity <repo>`（主 checkout 的目錄名）。
//   $PILOT_MACHINE_WORKER_CAP 空白時先印 CAPACITY_ENV_MISSING 那一行（pilot-capacity.mjs）。
//
// 用法（cwd 為 repo 內任一 checkout）：node scripts/orca-session-split.mjs --title <分頁標題（split 模式不用）> --prompt <第一個 prompt> [--tab | --worktree <path>] [--capacity <repo> --kind fix|retro]
// stdout：OPENED <terminal handle>，或 STOP <原因>（capacity <合計>/<上限> …、create <錯誤>、tui-timeout <handle>、send <handle>、orca <錯誤碼>）。
//   tui-timeout 時 stderr 先印分頁畫面尾巴（orca-session-send.mjs 的 `SCREEN_TAIL`，#536）。
// exit：0 已送出；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { orca, sendPrompt, waitTuiReady } from './orca-session-send.mjs';
import { SESSION_KINDS, closeSession, envMissingLines, ledgerPath, machineCap, renameSession, reserveSession, stopLine, validRepo } from './pilot-capacity.mjs';
import { recordTitle, withState } from './tab-state.mjs';

const USAGE = '用法：node scripts/orca-session-split.mjs --title <分頁標題> --prompt <第一個 prompt> [--tab | --worktree <path>] [--capacity <repo> --kind fix|retro]（需要 ORCA_CLI_COMMAND）';

/** `--model` 值只允許英數字與 `._-`：值原樣拼進 Orca 的 `--command`，其他字元可能被 shell 解讀。 */
export const MODEL_ID = /^[A-Za-z0-9._-]+$/;

/** 開 session 的指令：`model` 合法時 `claude --model <model>`，沒給或不合法時裸 `claude`（呼叫者先驗過並 WARN，這裡再擋一次）。 */
export const claudeCommand = model => (model && MODEL_ID.test(model) ? `claude --model ${model}` : 'claude');

/** 主 checkout 路徑（git worktree list 的第一筆）。 */
export function mainCheckout() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git worktree list 失敗：${result.stderr.trim()}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/**
 * 開 Claude session 並送出 prompt；`newTab` 為真時即使在 pane 內也新開分頁。`ctx` 是 `{ cli, signal? }`（同 orca-session-send.mjs）。
 * `model` 是啟動時的 `--model` 值（見 claudeCommand），沒給時裸 `claude`。
 * `createSignal`（預設 `ctx.signal`）只管開分頁那一步：呼叫者可以讓它不受總預算中止（殺掉 create，Orca 可能已開好分頁卻沒回 handle）。
 * @returns {Promise<{handle: string} | {stop: string, handle?: string, aborted?: boolean}>} 成功回 handle；失敗回 STOP 原因（不含 `STOP ` 前綴），
 *   分頁已開好時附 handle 讓呼叫者關掉；開分頁那一步被中止時 `aborted` 為真。
 */
export async function openSession(ctx, { title, prompt, main, self = process.env.ORCA_TERMINAL_HANDLE, newTab = false, createSignal = ctx.signal, model }) {
  const tabTitle = withState(title, '處理中');
  const command = claudeCommand(model);
  let handle;
  try {
    if (self && !newTab) {
      // split 出來的 pane 和呼叫者同一個分頁，分頁標題歸呼叫者：不改名、不記標題（#378）。
      handle = (await orca({ ...ctx, signal: createSignal }, 'terminal', 'split', '--terminal', self, '--direction', 'vertical', '--command', command)).split.handle;
    } else {
      handle = (await orca({ ...ctx, signal: createSignal }, 'terminal', 'create', '--worktree', `path:${main}`, '--title', tabTitle, '--command', command)).terminal.handle;
      recordTitle(handle, tabTitle);
    }
  } catch (error) {
    return handle ? { stop: `create ${error.message}`, handle } : { stop: `create ${error.message}`, aborted: error.name === 'AbortError' };
  }
  try {
    if (!await waitTuiReady(ctx, handle)) return { stop: `tui-timeout ${handle}`, handle };
    if (!await sendPrompt(ctx, handle, prompt)) return { stop: `send ${handle}`, handle };
  } catch (error) {
    return { stop: `orca ${error.message}`, handle };
  }
  return { handle };
}

/** 換 handle 失敗時給人的補記指令：先刪預留列再記真的 handle，同一個分頁不算兩次。 */
export const recordFix = ({ repo, kind, handle, pending }) =>
  `node scripts/pilot-capacity.mjs close ${pending} && node scripts/pilot-capacity.mjs open ${repo} ${kind} ${handle}`;

/**
 * 算進全機帳本的 openSession（#622）：先在帳本鎖裡預留一個名額（pilot-capacity.mjs 的 reserveSession，合計＋1 超過上限就回
 * `{ stop: 'capacity …' }`、不開；兩個呼叫者不會同時拿到最後一個名額），開成功後把預留列換成分頁的 handle，開不成時刪掉預留列。
 * 帳本讀寫失敗時不開分頁，回 `{ stop: 'capacity ledger <原因>' }`。
 * `capacity` 是 `{ repo, kind, file?, cap? }`（file 預設 $PILOT_WORKERS_LEDGER，cap 預設 $PILOT_MACHINE_WORKER_CAP）；其餘同 openSession。
 * 開分頁那一步就失敗（沒有 handle）時刪掉預留；STOP 帶 handle 時分頁還開著，預留列照樣換成它的 handle。
 * 換 handle 失敗（帳本讀寫失敗，或預留列已不在帳本時 recordError 是 `pending-row-missing`）時回 `{ handle, recordError, pending }`（stop 照舊；pending 是預留列的 handle）：預留列仍佔著名額但 Probe 讀不到它、2 小時後不計，呼叫者在 stderr 印
 * `WARN capacity-record <原因>`（同 pilot-dispatch.mjs 的 `WARN capacity-report`），人照那一行補記（recordFix：先 close 預留列再 open）。
 */
export async function openCountedSession(ctx, options, { repo, kind, file = ledgerPath(), cap = machineCap() }) {
  if (cap === undefined) return { stop: 'capacity cap-invalid（$PILOT_MACHINE_WORKER_CAP 不是正整數）' };
  let room;
  try {
    room = reserveSession(file, { repo, kind }, { cap });
  } catch (error) {
    return { stop: `capacity ledger ${error.message}` };
  }
  if (!room.ok) return { stop: stopLine(room).replace(/^STOP /, '') };
  const opened = await openSession(ctx, options);
  try {
    // STOP 帶 handle（送出或確認失敗）時分頁還開著：照樣換成它的 handle，由 Probe 在 terminal 結束時清掉；沒有分頁時才釋出預留。
    if (!opened.handle) closeSession(file, room.handle);
    // 預留列已被清掉（別的寫入者刪了它）時 rename 換不到：照換 handle 失敗處理，讓人補記，不默默少算這個分頁。
    else if (!renameSession(file, room.handle, opened.handle)) return { ...opened, recordError: 'pending-row-missing', pending: room.handle };
    return opened;
  } catch (error) {
    return { ...opened, recordError: error.message, pending: room.handle };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const title = value('--title');
  const prompt = value('--prompt');
  // 值是下一個旗標（`--capacity --kind fix`）時當作沒給值。
  const flagValue = flag => { const v = value(flag); return v === undefined || v.startsWith('--') ? undefined : v; };
  const repo = flagValue('--capacity');
  const kind = flagValue('--kind');
  const cli = process.env.ORCA_CLI_COMMAND;
  // 旗標在、值卻缺（例如最後一個參數是 `--capacity`）也算帶了，交給下一行判成用法錯誤，不默默略過檢查。
  const counted = args.includes('--capacity') || args.includes('--kind');
  const badCapacity = counted && (!validRepo(repo) || !SESSION_KINDS.includes(kind) || machineCap() === undefined);
  if (!title || !prompt || !cli || badCapacity) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const worktree = value('--worktree');
    const options = { title, prompt, main: worktree ?? mainCheckout(), newTab: Boolean(worktree) || args.includes('--tab') };
    if (counted) for (const line of envMissingLines()) console.log(line);
    const opened = counted ? await openCountedSession({ cli }, options, { repo, kind }) : await openSession({ cli }, options);
    if (opened.recordError) console.error(`WARN capacity-record ${opened.recordError} → ${recordFix({ repo, kind, ...opened })}`);
    console.log(opened.stop ? `STOP ${opened.stop}` : `OPENED ${opened.handle}`);
    process.exit(opened.stop ? 4 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
