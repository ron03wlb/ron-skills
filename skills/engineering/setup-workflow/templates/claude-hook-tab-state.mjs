#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Claude Code 分頁狀態 hook：能用程式偵測的分頁狀態轉換（GLOSSARY.md「分頁狀態」）自動以 tab-state.mjs 換掉目前分頁標題的狀態前綴，
// Stop 時標題沒有合法前綴就自行補上處理中。只在 Orca 裡跑的 session 才動作：terminal 分頁（ORCA_TERMINAL_HANDLE），或 Orca 聊天（tab-state.mjs 的 sessionTarget，#335）。
// 依 stdin hook JSON 的 hook_event_name：
// - PostToolUse（matcher Bash）：輸出命中 PostToolUse 觸發條件就換狀態；指令裡有改本分頁標題的 `orca terminal rename … --title <標題>`
//   時記下這個標題（Orca 查不到分頁時的備援，見 tab-state.mjs）。
// - Stop：最後一段 assistant 文字命中 Stop 觸發條件就換狀態；接著檢查標題，沒有 `<狀態>｜` 前綴就自行設為處理中、exit 0（retro e87d365c#5：exit 2 只為要 agent 跑一次 tab-state，多花一輪）。
//   只檢查格式，不判斷狀態對不對；stop_hook_active 為 true（已因 Stop hook 續跑一次）時不檢查。
//   補前綴蓋不掉既有狀態：標題以狀態名開頭但分隔符不對（`待 Retro|…`），或記錄的標題是處理中以外的狀態（別的 hook 蓋掉實際標題，或 Stop 觸發條件剛換狀態但分頁沒跟上）時不改名。
//   這兩種情況、改名失敗、讀回仍沒有前綴時 exit 2，stderr 交回 agent 改名；session 只回答問題（input.cwd 的工作區乾淨、transcript 沒有 commit）時
//   訊息多一句指向待關閉（#399：問答 session 選了待 Retro，等於要使用者為一則問答跑 /retro）。
// 預設觸發條件見 DEFAULT_TRIGGERS；`/retro` 的待關閉由 retro 最後一步自己呼叫 tab-state，記錄的標題已是待關閉時觸發條件不再降回待 Retro（#327）。專案可以在 `docs/agents/tab-state.json`
// 新增、覆寫或停用觸發條件：`{ "triggers": { "<名稱>": { "event": "PostToolUse"|"Stop", "match": "<regex，逐行比對>", "skipCommand": "<regex>", "state": "<狀態>" } | null } }`，
// 同名覆寫、null 停用；PostToolUse 的 match 比對 Bash 的 stdout，Stop 的比對最後一段 assistant 文字；
// 選填的 skipCommand 命中 Bash 指令時不觸發（Stop 沒有指令，不看它）；選填的 `"worker": true`（Stop）要 match 第一個捕獲群組的 Issue 號碼是這個 session 以 `/issue-run <n> --worker` 開工的（#650）；比對前把引號內含空白的文字換成空字串（標題、訊息裡提到的不算），不含空白的去掉引號照常比對（`'--keep-branch'` 仍是選項）。檔案不存在或不是合法 JSON 就用預設值。
// 不在 Orca 裡、輸入不合法、Orca 呼叫失敗時一律 exit 0 不輸出。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATES, currentTitle, hasState, orcaContext, recordTitle, recordedTitle, sessionTarget, setState, titleMismatch } from './tab-state.mjs';

export const DEFAULT_TRIGGERS = {
  // land.mjs 合入後的最後一行；pilot 的 coordinator 以 `--keep-branch` 或 Push gate 入口 `pilot-land.mjs push`（#395，只認指令開頭或 ; & | ( 之後的 node 呼叫）落地整合分支，它還在運作，不算；
  // `issue-pool.mjs claim` 對已落地的單印的 `LANDED <n> <sha>` 是「別重派」，不是落地（#650：coordinator Dispatch 時認領，分頁被換成待 Retro）
  landed: { event: 'PostToolUse', match: '^LANDED \\S+ [0-9a-f]{7,40}$', skipCommand: '--keep-branch\\b|(^|[;&|(]\\s*)node\\s+\\S*(pilot-land\\.mjs\\s+push|issue-pool\\.mjs)\\b', state: '待 Retro' },
  // pilot-handoff.mjs 交接完成，舊 coordinator 退役（行尾可能帶接手 session 的 `name <name>`，#372）
  'pilot-handoff': { event: 'PostToolUse', match: '^HANDED_OFF \\S+( name .+)?$', state: '待 Retro' },
  // L3 worker 寫出自己的 DONE 結果行；worker 見 matchedTrigger（#650：coordinator 轉述 worker 的 DONE 行不算）
  'worker-done': { event: 'Stop', match: '^DONE (\\d+) [0-9a-f]{7,40}$', worker: true, state: '待 Retro' },
};

/** 預設值加上專案 `docs/agents/tab-state.json` 的新增、覆寫（同名）與停用（null）；每個觸發條件帶 `name`（它的鍵）。 */
export function triggers(project) {
  const merged = { ...DEFAULT_TRIGGERS };
  const file = project && join(project, 'docs/agents/tab-state.json');
  let config = {};
  try { config = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { /* 不合法就用預設值 */ }
  for (const [name, trigger] of Object.entries(config?.triggers ?? {})) {
    if (trigger === null) delete merged[name];
    else merged[name] = trigger;
  }
  return Object.entries(merged).map(([name, trigger]) => ({ ...trigger, name }))
    .filter(trigger => STATES.includes(trigger.state) && typeof trigger.match === 'string');
}

/**
 * skipCommand 比對用的指令：引號內含空白的（標題、訊息）換成空字串 `''`，不含空白的去掉引號照常比對（`'--keep-branch'` 是實際傳入的選項）。
 */
const unquoted = command => String(command ?? '').replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (quoted, double, single) => {
  const text = single ?? double.replace(/\\(.)/g, '$1');
  return /\s/.test(text) ? "''" : text;
});

/**
 * 第一個命中 `text`、而且 skipCommand 沒命中 `command` 的觸發條件：`{ state, name, text }`，text 是命中的那段文字；沒有就是 null。
 * 帶 `worker: true` 的觸發條件另要 match 的第一個捕獲群組（Issue 號碼）在 `workers`（這個 session 以 `/issue-run <n> --worker` 開工的號碼，見 workerIssues）裡：
 * coordinator 回報裡轉述的 worker 結果行不算（#650）。`workers` 省略時不檢查（呼叫端行為照舊）。
 * regex 寫壞的觸發條件略過。要記觸發條件名稱的 hook（例如 log 寫 `trigger=<名稱>`）用這個，不要自己再寫一份比對迴圈（investing#529）。
 */
export function matchedTrigger(list, event, text, command = '', workers) {
  for (const trigger of list.filter(trigger => trigger.event === event)) {
    try {
      if (trigger.skipCommand && new RegExp(trigger.skipCommand).test(unquoted(command))) continue;
      for (const match of String(text ?? '').matchAll(new RegExp(trigger.match, 'gm'))) {
        if (trigger.worker && workers && !workers.includes(match[1])) continue;
        return { state: trigger.state, name: trigger.name, text: match[0] };
      }
    } catch { /* 略過寫壞的 regex */ }
  }
  return null;
}

/** matchedTrigger 的狀態；沒有命中時 null。 */
export const matchedState = (list, event, text, command = '', workers) => matchedTrigger(list, event, text, command, workers)?.state ?? null;

// 使用者指令 `/issue-run <n> … --worker`：純文字或 slash command 展開的 `<command-name>/issue-run</command-name>\n<command-args><n> --worker …`。
const WORKER_COMMAND = /\/issue-run(?:<\/command-name>)?\s*(?:<command-args>)?\s*#?(\d+)\b[^\n<]*\s--worker\b/g;

/** transcript 裡使用者（不含 tool_result 與 isMeta 的 skill 展開）以 `/issue-run <n> --worker` 開工的 Issue 號碼。 */
export function workerIssues(path) {
  const issues = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user' || entry.isMeta) continue;
    const content = entry.message?.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => String(block.text)) : [];
    for (const text of texts) for (const [, n] of text.matchAll(WORKER_COMMAND)) issues.push(n);
  }
  return issues;
}

/**
 * 觸發條件的狀態要不要套到 `handle` 的分頁：記錄的標題已是待關閉（`/retro` 最後一步切的）時不降回待 Retro（#327：worker 在 DONE 之後的同一輪跑 retro，
 * Stop 時最後一段文字仍以 DONE 結果行收尾）。
 */
export function applies(state, recorded) {
  return !(state === '待 Retro' && String(recorded ?? '').startsWith('待關閉｜'));
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

/** transcript 每段 assistant 訊息的內容區塊。 */
function* assistantBlocks(path) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) yield* entry.message.content;
  }
}

/** transcript 最後一段 assistant 文字。 */
function lastAssistantText(path) {
  let text = '';
  for (const block of assistantBlocks(path)) if (block.type === 'text' && block.text.trim()) text = block.text;
  return text;
}

// 會留下 commit 的 Bash 指令：`git [-C <dir>|-c <k=v>]… commit`，或交付用的 land.mjs。
const COMMITS = /\bgit(?:\s+-[Cc]\s+\S+)*\s+commit\b|\bland\.mjs\b/;

/** session 只回答問題：`cwd` 的工作區乾淨，transcript 也沒有會 commit 的 Bash 指令。判斷不了（不是 git repo、讀不到 transcript）時傳回 false。 */
export function answerOnly(cwd, transcriptPath) {
  if (!cwd || !transcriptPath) return false;
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 10000 });
  if (status.status !== 0 || status.stdout.trim()) return false;
  try {
    for (const block of assistantBlocks(transcriptPath)) {
      if (block.type === 'tool_use' && block.name === 'Bash' && COMMITS.test(String(block.input?.command ?? ''))) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** 標題 `title` 沒有前綴時補上處理中；補上且讀回有前綴才傳回 true。傳回 false 時未改名或改名沒生效，由 agent 決定（見檔頭）。 */
async function addWorkingPrefix(ctx, handle, title) {
  const recorded = recordedTitle(handle);
  if (STATES.some(state => title.startsWith(state)) || (hasState(recorded) && !recorded.startsWith('處理中'))) return false;
  try {
    // 帶入已讀到的標題，不再讀一次：讀回之前不留下另一個狀態被蓋掉的空檔。
    const set = await setState(ctx, handle, '處理中', title);
    const actual = await titleMismatch(ctx, handle, set);
    return actual === null || hasState(actual);
  } catch {
    return false;
  }
}

const output = response => typeof response === 'string' ? response : String(response?.stdout ?? '');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = sessionTarget();
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
      if (state && applies(state, recordedTitle(handle))) await setState(ctx, handle, state);
    } else if (input.hook_event_name === 'Stop') {
      let text = '';
      let workers = [];
      try {
        text = input.transcript_path ? lastAssistantText(input.transcript_path) : '';
        workers = input.transcript_path ? workerIssues(input.transcript_path) : [];
      } catch { /* 讀不到 transcript 就不觸發 */ }
      const state = matchedState(list, 'Stop', text, '', workers);
      if (state && applies(state, recordedTitle(handle))) await setState(ctx, handle, state);
      if (!input.stop_hook_active) {
        const title = await currentTitle(ctx, handle);
        if (!hasState(title) && !await addWorkingPrefix(ctx, handle, title)) {
          process.stderr.write(`分頁狀態：目前分頁標題「${title}」開頭沒有狀態前綴（${STATES.map(s => `${s}｜`).join('、')}）。`
            + '請用 `node scripts/tab-state.mjs <狀態>` 補上前綴，或以 `node scripts/tab-state.mjs <狀態> --topic "<主題>"` 照 adapter Tab state 段的標題格式重設；'
            + '還在處理（含等使用者回答或核准）用處理中，工作已交付、等使用者跑 /retro 用待 Retro，/retro 已結束用待關閉。'
            + (answerOnly(input.cwd, input.transcript_path)
              ? '這個 session 的工作區乾淨、沒有 commit：只回答問題、沒有交付東西時用 `node scripts/tab-state.mjs 待關閉`，不必為問答跑 /retro。' : '')
            + '\n');
          process.exit(2);
        }
      }
    }
  } catch {
    process.exit(0);
  }
}
