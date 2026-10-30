#!/usr/bin/env node
// 在 Orca 開一個新的 Claude session 並送出第一個 prompt：有 ORCA_TERMINAL_HANDLE 時 split 在呼叫者的 pane 旁邊（使用者的每個分頁各有用途，不另開新分頁），
// 沒有時，或帶 `--tab`（新 session 要比呼叫者活得久，例如 coordinator 交接後使用者會關掉舊視窗）時，在主 checkout 新開分頁；
// 帶 `--worktree <path>`（要在自己 worktree 跑的 session）時，在該 worktree 新開分頁；
// 命名 → 等 TUI 就緒（兩輪）→ 送出 prompt 並讀畫面確認送達（orca-session-send.mjs 的 waitTuiReady／sendPrompt）。
// 送出不帶 `--wait-submit`：Orca 從 WSL 常因無法確認 prompt-delivery 回 runtime_unavailable 且完全不送出。
// 任何「開新 session 接手」的交接都走這裡，不手動組 create／split／rename／wait／send。
//
// 用法（cwd 為 repo 內任一 checkout）：node scripts/orca-session-split.mjs --title <分頁標題> --prompt <第一個 prompt> [--tab | --worktree <path>]
// stdout：OPENED <terminal handle>，或 STOP <原因>（create <錯誤>、tui-timeout <handle>、send <handle>、orca <錯誤碼>）。
// exit：0 已送出；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { orca, sendPrompt, waitTuiReady } from './orca-session-send.mjs';

const USAGE = '用法：node scripts/orca-session-split.mjs --title <分頁標題> --prompt <第一個 prompt> [--tab | --worktree <path>]（需要 ORCA_CLI_COMMAND）';

/** 主 checkout 路徑（git worktree list 的第一筆）。 */
export function mainCheckout() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git worktree list 失敗：${result.stderr.trim()}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/**
 * 開 Claude session 並送出 prompt；`newTab` 為真時即使在 pane 內也新開分頁。`ctx` 是 `{ cli, signal? }`（同 orca-session-send.mjs）。
 * `createSignal`（預設 `ctx.signal`）只管開分頁那一步：呼叫者可以讓它不受總預算中止（殺掉 create，Orca 可能已開好分頁卻沒回 handle）。
 * @returns {Promise<{handle: string} | {stop: string, handle?: string, aborted?: boolean}>} 成功回 handle；失敗回 STOP 原因（不含 `STOP ` 前綴），
 *   分頁已開好時附 handle 讓呼叫者關掉；開分頁那一步被中止時 `aborted` 為真。
 */
export async function openSession(ctx, { title, prompt, main, self = process.env.ORCA_TERMINAL_HANDLE, newTab = false, createSignal = ctx.signal }) {
  let handle;
  try {
    if (self && !newTab) {
      handle = (await orca({ ...ctx, signal: createSignal }, 'terminal', 'split', '--terminal', self, '--direction', 'vertical', '--command', 'claude')).split.handle;
      await orca({ ...ctx, signal: createSignal }, 'terminal', 'rename', '--terminal', handle, '--title', title);
    } else {
      handle = (await orca({ ...ctx, signal: createSignal }, 'terminal', 'create', '--worktree', `path:${main}`, '--title', title, '--command', 'claude')).terminal.handle;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const title = value('--title');
  const prompt = value('--prompt');
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!title || !prompt || !cli) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const worktree = value('--worktree');
    const opened = await openSession({ cli }, { title, prompt, main: worktree ?? mainCheckout(), newTab: Boolean(worktree) || args.includes('--tab') });
    console.log(opened.stop ? `STOP ${opened.stop}` : `OPENED ${opened.handle}`);
    process.exit(opened.stop ? 4 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
