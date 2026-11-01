#!/usr/bin/env node
// Claude Code 分頁狀態 hook：能用程式偵測的分頁狀態轉換（GLOSSARY.md「分頁狀態」）自動以 tab-state.mjs 換掉目前分頁標題的狀態前綴，
// Stop 時標題沒有合法前綴就要求改名。只在 Orca 裡跑的 session（有 ORCA_TERMINAL_HANDLE）才動作。
// 依 stdin hook JSON 的 hook_event_name：
// - PostToolUse（matcher Bash）：輸出命中 PostToolUse 觸發條件就換狀態；指令裡有改本分頁標題的 `orca terminal rename … --title <標題>`
//   時記下這個標題（Orca 讀不回 rename 設的標題，見 tab-state.mjs），之後 tab-state 才換得到前綴、Stop 才檢查得到。
// - Stop：最後一段 assistant 文字命中 Stop 觸發條件就換狀態；接著檢查標題，沒有 `<狀態>｜` 前綴就 exit 2，stderr 交回 agent 改名。
//   只檢查格式，不判斷狀態對不對；stop_hook_active 為 true（已因 Stop hook 續跑一次）時不檢查。
// 預設觸發條件見 DEFAULT_TRIGGERS；`/retro` 的待關閉由 retro 最後一步自己呼叫 tab-state。專案可以在 `docs/agents/tab-state.json`
// 新增、覆寫或停用觸發條件：`{ "triggers": { "<名稱>": { "event": "PostToolUse"|"Stop", "match": "<regex，逐行比對>", "skipCommand": "<regex>", "state": "<狀態>" } | null } }`，
// 同名覆寫、null 停用；PostToolUse 的 match 比對 Bash 的 stdout，Stop 的比對最後一段 assistant 文字；
// 選填的 skipCommand 命中 Bash 指令時不觸發（Stop 沒有指令，不看它）。檔案不存在或不是合法 JSON 就用預設值。
// 沒有 ORCA_TERMINAL_HANDLE、輸入不合法、Orca 呼叫失敗時一律 exit 0 不輸出。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATES, currentTitle, hasState, orcaContext, recordTitle, setState } from './tab-state.mjs';

export const DEFAULT_TRIGGERS = {
  // land.mjs 合入後的最後一行；pilot 的 coordinator 以 `--keep-branch` 落地整合分支，它還在運作，不算
  landed: { event: 'PostToolUse', match: '^LANDED \\S+ [0-9a-f]{7,40}$', skipCommand: '--keep-branch\\b', state: '待 Retro' },
  // pilot-handoff.mjs 交接完成，舊 coordinator 退役
  'pilot-handoff': { event: 'PostToolUse', match: '^HANDED_OFF \\S+$', state: '待 Retro' },
  // L3 worker 寫出 DONE 結果行
  'worker-done': { event: 'Stop', match: '^DONE \\d+ [0-9a-f]{7,40}$', state: '待 Retro' },
};

/** 預設值加上專案 `docs/agents/tab-state.json` 的新增、覆寫（同名）與停用（null）。 */
export function triggers(project) {
  const merged = { ...DEFAULT_TRIGGERS };
  const file = project && join(project, 'docs/agents/tab-state.json');
  let config = {};
  try { config = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { /* 不合法就用預設值 */ }
  for (const [name, trigger] of Object.entries(config?.triggers ?? {})) {
    if (trigger === null) delete merged[name];
    else merged[name] = trigger;
  }
  return Object.values(merged).filter(trigger => STATES.includes(trigger?.state) && typeof trigger.match === 'string');
}

/** 第一個命中 `text`、而且 skipCommand 沒命中 `command` 的觸發條件的狀態；regex 寫壞的觸發條件略過。 */
export function matchedState(list, event, text, command = '') {
  for (const trigger of list.filter(trigger => trigger.event === event)) {
    try {
      if (trigger.skipCommand && new RegExp(trigger.skipCommand).test(command)) continue;
      if (new RegExp(trigger.match, 'm').test(text)) return trigger.state;
    } catch { /* 略過寫壞的 regex */ }
  }
  return null;
}

const unquote = word => word.startsWith("'") ? word.slice(1, -1) : word.startsWith('"') ? word.slice(1, -1).replace(/\\(.)/g, '$1') : word;
const WORD = `("(?:[^"\\\\]|\\\\.)*"|'[^']*'|\\S+)`;
// 頂層指令：以換行或引號外的 `; & |` 切開；開頭是 `[orca] terminal rename` 的才是改名（commit 訊息、echo 裡提到的不算）。
const COMMANDS = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\n;&|"'])+/g;
const RENAME = /^\s*(?:\S+\s+)?terminal\s+rename\b/;

/**
 * 指令裡改本分頁標題的 `terminal rename` 設的最後一個標題；`--terminal` 是 handle 本身或 `$ORCA_TERMINAL_HANDLE`（省略時是目前分頁）。
 * 標題含 `$`（要 shell 展開）時不算，傳回 null。
 */
export function renamedTitle(command, handle) {
  let title = null;
  for (const [segment] of String(command ?? '').matchAll(COMMANDS)) {
    if (!RENAME.test(segment)) continue;
    const terminal = segment.match(new RegExp(`--terminal(?:\\s+|=)${WORD}`))?.[1];
    const value = segment.match(new RegExp(`--title(?:\\s+|=)${WORD}`))?.[1];
    if (value === undefined) continue;
    const target = terminal === undefined ? handle : unquote(terminal);
    if (![handle, '$ORCA_TERMINAL_HANDLE', '${ORCA_TERMINAL_HANDLE}'].includes(target)) continue;
    const text = unquote(value);
    if (!text.includes('$')) title = text;
  }
  return title;
}

/** transcript 最後一段 assistant 文字。 */
function lastAssistantText(path) {
  let text = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) if (block.type === 'text' && block.text.trim()) text = block.text;
  }
  return text;
}

const output = response => typeof response === 'string' ? response : String(response?.stdout ?? '');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  if (!handle || !input) process.exit(0);
  const ctx = orcaContext();
  const list = triggers(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  try {
    if (String(input.hook_event_name).startsWith('PostToolUse')) {
      if (input.tool_name !== 'Bash') process.exit(0);
      const title = renamedTitle(input.tool_input?.command, handle);
      if (title !== null) recordTitle(handle, title);
      const state = matchedState(list, 'PostToolUse', output(input.tool_response), String(input.tool_input?.command ?? ''));
      if (state) await setState(ctx, handle, state);
    } else if (input.hook_event_name === 'Stop') {
      let text = '';
      try { text = input.transcript_path ? lastAssistantText(input.transcript_path) : ''; } catch { /* 讀不到 transcript 就不觸發 */ }
      const state = matchedState(list, 'Stop', text);
      if (state) await setState(ctx, handle, state);
      if (!input.stop_hook_active) {
        const title = await currentTitle(ctx, handle);
        if (!hasState(title)) {
          process.stderr.write(`分頁狀態：目前分頁標題「${title}」開頭沒有狀態前綴（${STATES.map(s => `${s}｜`).join('、')}）。`
            + '請用 `node scripts/tab-state.mjs <狀態>` 補上前綴，或以 `node scripts/tab-state.mjs <狀態> --topic "<主題>"` 照 adapter Tab state 段的標題格式重設；'
            + '還在處理（含等使用者回答或核准）用處理中，工作已交付、等使用者跑 /retro 用待 Retro，/retro 已結束用待關閉。\n');
          process.exit(2);
        }
      }
    }
  } catch {
    process.exit(0);
  }
}
