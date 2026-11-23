#!/usr/bin/env node
// Orca bot 聊天的分頁狀態 hook（事項 #89）：bot 的 Home 聊天與排程開的對話也帶 `<狀態>｜` 前綴（GLOSSARY.md「分頁狀態」）。
// bot 資料夾（~/.orca/bots/<bot>）不載入 repo 的 `.claude/settings.json`，未信任的資料夾連專案層 settings 都不讀，所以掛在使用者層
// `~/.claude/settings.json` 的 UserPromptSubmit 與 Stop；指令先用 shell 判斷 ORCA_BOT_TOOLS_TOKEN，一般 session 不啟動 node。
// 本腳本只在 bot 聊天生效：有 ORCA_BOT_TOOLS_TOKEN、ORCA_STRUCTURED_SESSION、ORCA_AGENT_SESSION_ID，沒有 ORCA_TERMINAL_HANDLE，
// 而且 hook 輸入的 cwd 在 ~/.orca/bots/ 底下（BOT_CHAT_ROOT 可改，測試用）；其他一律 exit 0 不動。
//
// 狀態對應：
// - UserPromptSubmit（Ron 或排程送進一則訊息、開始一輪）→ 處理中。
// - Stop（一輪結束）：Home 聊天（`bot chats` 那列 home 為 true）維持處理中：它不會被關，一輪結束就是在等下一則訊息，
//   照 GLOSSARY「處理中」包含停下來等使用者；其他聊天（排程開的 `… run N`、orchestration 開的）→ 待關閉：bot 聊天不跑 /retro，
//   跟只回答問題的 session 一樣不經待 Retro。之後再有訊息進來，UserPromptSubmit 會換回處理中。
// 標題只換前綴，原標題的主體（Orca 自動取的 `Home`、`每晚 20:30 … run 1` 等）原樣保留；已經是要的標題就不呼叫 rename。
//
// 速度與安靜：hook 本身只讀 stdin、記下這次事件的序號，就把改名交給 detached 子行程、立即 exit 0，不等 Orca（`bot chats`、`chat rename`
// 各要一兩秒）；stdout、stderr 一律不輸出（UserPromptSubmit 的 stdout 會進 context）。子行程改名前確認序號仍是這個聊天最新的事件，
// 短的一輪裡 Stop 的子行程先跑完時，UserPromptSubmit 的子行程就不再把待關閉蓋回處理中。
// 用法（settings 裡）：node <本檔>；子行程：node <本檔> --run <事件> <序號>。
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORKING, orcaContext, setState, stripState, withState } from './tab-state.mjs';

export const CLOSABLE = '待關閉';

/** 這個 session 是 bot 聊天時傳回 `chat:<session id>`，否則 null。`cwd` 是 hook 輸入的 cwd。 */
export function botChatTarget(env, cwd) {
  if (!env.ORCA_BOT_TOOLS_TOKEN || !env.ORCA_STRUCTURED_SESSION || !env.ORCA_AGENT_SESSION_ID || env.ORCA_TERMINAL_HANDLE) return null;
  const root = env.BOT_CHAT_ROOT || join(homedir(), '.orca/bots');
  const rel = cwd ? relative(root, cwd) : '..';
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return `chat:${env.ORCA_AGENT_SESSION_ID}`;
}

/** 事件與聊天是不是 Home 決定的狀態；不處理的事件為 null。 */
export function stateFor(event, home) {
  if (event === 'UserPromptSubmit') return WORKING;
  if (event === 'Stop') return home ? WORKING : CLOSABLE;
  return null;
}

const seqDir = () => process.env.TAB_STATE_DIR || join(homedir(), '.local/state/orca-tab-titles');
const seqFile = handle => join(seqDir(), `${handle.replace(/[^\w.-]/g, '_')}.bot-seq`);
const readSeq = handle => { try { return readFileSync(seqFile(handle), 'utf8'); } catch { return null; } };

/** 讀 `orca bot chats --json`（本 bot 自己的聊天）裡 `id` 那列；讀不到時 null。 */
function botChat(cli, id, signal) {
  return new Promise(resolve => {
    const child = spawn(cli, ['bot', 'chats', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], signal });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const body = JSON.parse(stdout);
        resolve(body.ok ? body.result.chats.find(chat => chat.id === id) ?? null : null);
      } catch { resolve(null); }
    });
  });
}

/** 子行程：讀聊天那列、決定狀態，需要時改名。序號已不是最新（之後有別的事件）就不動。 */
export async function run(handle, event, seq) {
  const ctx = orcaContext();
  const row = await botChat(ctx.cli, handle.slice('chat:'.length), ctx.signal);
  const state = row && typeof row.title === 'string' ? stateFor(event, row.home === true) : null;
  if (!state || withState(row.title, state) === row.title || readSeq(handle) !== seq) return null;
  return setState(ctx, handle, state, stripState(row.title));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [flag, event, seq] = process.argv.slice(2);
    if (flag === '--run') {
      const handle = `chat:${process.env.ORCA_AGENT_SESSION_ID}`;
      await run(handle, event, seq).catch(() => null);
    } else {
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const handle = botChatTarget(process.env, input.cwd);
      if (handle && stateFor(input.hook_event_name, false)) {
        const token = `${Date.now()}-${process.pid}-${input.hook_event_name}`;
        mkdirSync(seqDir(), { recursive: true });
        writeFileSync(seqFile(handle), token);
        spawn(process.execPath, [fileURLToPath(import.meta.url), '--run', input.hook_event_name, token], { detached: true, stdio: 'ignore' }).unref();
      }
    }
  } catch { /* 安靜失敗：不擋回覆 */ }
  process.exit(0);
}
