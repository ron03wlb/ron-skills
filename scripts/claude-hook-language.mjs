#!/usr/bin/env node
// Claude Code 語言 hook：使用者可見文字（assistant text block）以英文為主時回報，要求以繁體中文重新說明。
// 專案規定使用者可見訊息一律繁體中文（寫在 CLAUDE.md 等 agent 指引），連工具呼叫之間的一行進度也算；只靠文字規則會反覆重犯，所以用 hook 擋。
// 依 stdin hook JSON 的 hook_event_name 分兩種用法：
// - PostToolUse／PostToolUseFailure：檢查這次工具呼叫前緊鄰的文字段（上一個工具呼叫或 tool_result 之後到本 tool_use 為止），
//   同一輪就能改正；工具已執行，exit 2 只把 stderr 交回 agent。transcript 還沒寫入這次的 tool_use 時（Skill、Edit 這類幾十毫秒就結束的工具，
//   #238：前面有英文段的 Bash 14/14 都抓到，Skill、Edit 0/9），改看 transcript 尾端最後一個 tool_use、tool_result 或使用者輪之後的文字段。
//   #250：Bash 也會漏，hook 觸發時連 3 秒前的文字段都還沒寫入（整則 assistant 訊息延後寫），尾端文字段是空的。所以找不到 tool_use 時
//   等 RETRY_MS 重讀一次；專案根有 `.scratch/` 時把兩次讀到的行數、有沒有找到、尾端項目的 type 與 timestamp 附加到 `.scratch/language-hook.log`，
//   累積後判斷寫入時機，再決定改等更久、改用 hook 輸入，或只靠 Stop。這行的 `at` 是 hook 結束時間，`start` 是 hook 讀 stdin 前的時間，
//   `waitMs` 是重讀前實際等待的毫秒數（沒重讀為 0），用來對照 transcript 寫入時間而不必回推（retro spay2 ddc8bd0e#4）。
// - Stop（或未帶 hook_event_name）：檢查最後一個使用者輪（或本 hook 最後一次提示，見下）之後的所有文字段；PostToolUse 尚未掛上時仍有覆蓋，
//   PostToolUse 提示過的段落不再提一次。
// 同一條規則也擋簡體字：CJK 比例分不出繁簡，session f236b357 有三段以「这」開頭（jsonl 第 293、610、646 行）都放行（#284）。
// harness 合成的訊息（用量上限「You've hit your weekly limit · resets 3am」、API Error 等）不是模型輸出：transcript 中這類 assistant 項目
// 帶 isApiErrorMessage／apiError 或 model `<synthetic>`，整筆略過；結構欄位缺漏時再以固定句型比對文字。
// Stop 只看最後一次語言檢查提示（Stop hook feedback 或 PostToolUse 的 hook_blocking_error）之後的文字：提示過的段落不再重提，
// 否則 /loop 的 coordinator 長時間沒有新的使用者輪，每次 Stop 都重抓同一句舊英文。
// 子代理（#901）：hook 輸入帶 agent_id／agent_type，transcript_path 卻是父 session 的 transcript（2026-11-16 實測，Claude Code 2.1.325），
// 原本子代理每次跑 Bash 都引用父段落擋下（followups 625）。帶 agent_id 時改讀 `<transcript 去掉 .jsonl>/subagents/agent-<agent_id>.jsonl`，
// 讀不到就 exit 0 放行；任何情況都不拿父 transcript 檢查子代理的工具呼叫。
// 子代理不做英文檢查、只擋簡體字（retro spay2 2282a2a4#6）：子代理的文字交給協調者，不是使用者可見訊息，brief 常要求英文回覆
//   （AGENTS.md：給 AI 讀的寫英文）；原本 #988 fact-brief 子代理的英文報告在 SubagentHandback 的 PreToolUse 被擋，只好改用繁中回覆。
// - PreToolUse（#938）：工具執行前檢查這次工具呼叫前的文字段（同 PostToolUse 的 locateTool），命中就 exit 2，工具不執行、stderr 交回 agent。
//   #901 實測：PreToolUse 觸發當下 transcript 多半還沒寫入本次工具前的文字段：claude -p 主 session 53 次（每次前面都有文字段）只命中 14 次
//   （26.4%；Bash 0/19、Read 3/9、Edit 5/8、Skill 0/8、Write 6/8、Agent 0/1）；等 300 ms 重讀為 45/53（84.9%，Skill 仍 0/8）。
//   所以 tail 沒有文字段時等 RETRY_MS 重讀一次，仍沒有就 exit 0，交給 PostToolUse／Stop 補抓；Skill 重讀也讀不到，直接 exit 0 不等待。
//   2026-11-18 再量（互動 TUI、auto mode）：本次工具前的文字段與 tool_use 常在 PreToolUse hook 全部結束後才寫入，不是固定延遲：
//   hook 輪詢 3 秒，3 次有 2 次始終讀不到；`claude -p`（含 auto mode）則在 hook 開始後 16–136 ms 就寫入。
//   `.scratch/language-hook.log` 中前面有文字段的 Bash 162 次：首讀命中 35、重讀命中 46、漏 81。所以不要拉長等待：被擋住的那一半
//   等多久都讀不到，只拖慢每次呼叫；漏掉的由 PostToolUse／Stop 補抓，長時間工具（如 120 s 逾時的 commit + push）的提示會延到工具結束。
//   stdin 只有 session_id、transcript_path、cwd、prompt_id、permission_mode、effort、hook_event_name、tool_name、tool_input、tool_use_id
//   （子代理另有 agent_id、agent_type），沒有 assistant 文字可用。PreToolUse 擋下只在 transcript 留一筆 is_error 的 tool_result
//   （`PreToolUse:<工具> hook error: [<command>]: <stderr>`，沒有 hook_blocking_error attachment），Stop 與 PostToolUse 認得它，不重提同一段。
// 命中時 exit 2，stderr 交回 agent 繼續；專案根有 `.scratch/` 時另在 `.scratch/language-hook.log` 記一行 {at, hook_event_name, session_id, tool}（不含文字）。
// stop_hook_active 為 true（已因本 hook 續跑一次）、輸入不合法、讀不到 transcript 時 exit 0 不輸出，避免卡住。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 程式碼、路徑、網址、識別字不算語言：先移除再計數
const STRIP = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /https?:\/\/\S+/g,
  /(?:~|\.{0,2})?\/[\w.\-/#@]+/g,
  /\b[\w-]+\.(?:mjs|js|sh|py|md|json|java|sql|ya?ml|gradle)\b/g,
  /\b[0-9a-f]{7,40}\b/g,
];
const CJK = /[㐀-鿿豈-﫿]/g;
const WORD = /\b[A-Za-z]{2,}\b/g;

/**
 * 一段文字是否以英文為主：移除程式碼與路徑後，英文單字至少 6 個且中文字不到單字數的 1/4；
 * 或英文單字 3–5 個且完全沒有中文字（「Still running; nothing new.」）。
 * 以中文句型串起技術名詞的進度行（「Fast check exit 0。跑 Docker focused」）不會命中；
 * 門檻依 2026-10-20 對 ~/.claude/projects 全部 11386 段 assistant 文字的抽樣調整；
 * 短句規則依 2026-10-21 對一個專案最近 173 個 transcript 7334 段文字抽樣：多命中 93 段，全是英文進度句。
 * @param {string} text assistant text block
 * @returns {boolean}
 */
export function isMostlyEnglish(text) {
  const plain = STRIP.reduce((s, re) => s.replace(re, ' '), text);
  const words = (plain.match(WORD) || []).length;
  const cjk = (plain.match(CJK) || []).length;
  return words >= 6 ? cjk * 4 < words : words >= 3 && cjk === 0;
}

// 只有簡體才有的常用字；繁簡同形的（后、里、面、发音的髮等）不列。門檻依 2026-11-01 對 ~/.claude/projects 每個專案最近 40 個 transcript、6281 段文字抽樣：
// 命中 3 段，正好是 #284 那三段；引號「…」裡的字通常是在引用別人的話（討論這個 hook 本身時），不算。
const SIMPLIFIED = /[这们个为说时会对发过还来国关开进实现应该样让给从问题经检认单动态产务处档码项写读运执两吗]/gu;
const QUOTED = /「[^」\n]*」/g;

/**
 * 一段文字裡只有簡體才有的字（不重複、依出現順序）；程式碼、路徑與「…」引用不算。
 * @param {string} text assistant text block
 * @returns {string[]}
 */
export function simplifiedChars(text) {
  const plain = [...STRIP, QUOTED].reduce((s, re) => s.replace(re, ' '), text);
  return [...new Set(plain.match(SIMPLIFIED) ?? [])];
}

// harness 固定句型（只比對短訊息開頭，避免略過模型自己提到這些字的段落）
const HARNESS = [
  /^You(?:['’]ve| have) (?:hit|reached) your\b[^\n]*\blimit\b/i,
  /^(?:Claude )?(?:AI )?usage limit (?:reached|exceeded)\b/i,
  /^Your [^\n]*\blimit (?:has |will )?reset/i,
  /^API Error\b/,
];
const HARNESS_MAX = 300;
const NOTICE = '語言檢查：';

/** harness 合成的 assistant 項目：isApiErrorMessage、apiError 或 model `<synthetic>`（2026-10-23 某 transcript 的 weekly limit 即此形狀）。 */
export function isSyntheticEntry(entry) {
  return entry.type === 'assistant' && (entry.isApiErrorMessage === true || Boolean(entry.apiError) || entry.message?.model === '<synthetic>');
}

/** 文字是否為 harness 的用量上限／重置／API 錯誤提示（結構欄位缺漏時的後備）。 */
export function isHarnessText(text) {
  const trimmed = text.trim();
  return trimmed.length <= HARNESS_MAX && HARNESS.some(re => re.test(trimmed));
}

// assistant 項目中要檢查的文字段：合成項目與 harness 句型除外。
function textBlocks(entry) {
  if (isSyntheticEntry(entry)) return [];
  return entry.message.content.filter(block => block.type === 'text' && block.text.trim() && !isHarnessText(block.text)).map(block => block.text);
}

const PRE_TOOL_ERROR = /^PreToolUse:\S+ hook error:/;

/** PreToolUse 擋下留下的 tool_result：is_error、內容以 `PreToolUse:<工具> hook error:` 開頭且是本 hook 的提示。 */
function isPreToolNotice(block) {
  if (block?.type !== 'tool_result' || block.is_error !== true) return false;
  const text = typeof block.content === 'string' ? block.content
    : Array.isArray(block.content) ? block.content.map(part => part?.text ?? '').join('') : '';
  return PRE_TOOL_ERROR.test(text) && text.includes(NOTICE);
}

/** 本 hook 先前的提示：Stop hook feedback（meta 使用者訊息）、PostToolUse 的 hook_blocking_error attachment，或 PreToolUse 擋下的 tool_result。 */
function isLanguageNotice(entry) {
  if (entry.type === 'user' && entry.isMeta) {
    const content = entry.message?.content;
    return typeof content === 'string' && content.startsWith('Stop hook feedback:') && content.includes(NOTICE);
  }
  if (entry.type === 'user' && Array.isArray(entry.message?.content)) return entry.message.content.some(isPreToolNotice);
  return entry.type === 'attachment' && entry.attachment?.type === 'hook_blocking_error'
    && JSON.stringify(entry.attachment.blockingError ?? '').includes(NOTICE);
}

/** 使用者輪的開始：使用者或系統送來的訊息（不含 tool_result 與 meta）。 */
function isTurnStart(entry) {
  if (entry.type !== 'user' || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && !content.some(block => block.type === 'tool_result');
}

/**
 * 依序走過 transcript 的 assistant 文字段；遇到使用者輪開始、tool_use 或 tool_result 就切段。
 * @param {string} jsonl transcript 內容
 * @param {(texts: string[], block: object) => boolean} onToolUse 遇到 tool_use 時以切段前的文字呼叫，回傳 true 即停止
 * @returns {string[]} 停止時的那一段文字，或走完時最後一段
 */
function scanSegments(jsonl, onToolUse) {
  let texts = [];
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;
    if (entry.type === 'user') {
      if (isTurnStart(entry) || (Array.isArray(content) && content.some(block => block.type === 'tool_result'))) texts = [];
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      const skip = isSyntheticEntry(entry);
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) { if (!skip && !isHarnessText(block.text)) texts.push(block.text); }
        else if (block.type === 'tool_use') {
          if (onToolUse(texts, block)) return texts;
          texts = [];
        }
      }
    }
  }
  return texts;
}

/**
 * Stop 用：取出 transcript 最後一個使用者輪（或本 hook 最後一次提示）之後的所有 assistant 文字（tool_result 不切輪），
 * harness 合成訊息除外。
 * @param {string} jsonl transcript 內容
 * @returns {string[]}
 */
export function lastTurnTexts(jsonl) {
  let texts = [];
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (isTurnStart(entry) || isLanguageNotice(entry)) texts = [];
    else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) texts.push(...textBlocks(entry));
  }
  return texts;
}

/**
 * PostToolUse 用：緊接在指定 tool_use 之前的 assistant 文字；平行呼叫的第二個以後沒有自己的文字段，回傳空陣列。
 * transcript 還沒寫入該 tool_use 時，回傳尾端最後一個 tool_use、tool_result 或使用者輪之後的文字段（就是這次呼叫前的文字）。
 * @param {string} jsonl transcript 內容
 * @param {string} toolUseId hook 輸入的 tool_use_id
 * @returns {string[]}
 */
export function textsBeforeTool(jsonl, toolUseId) {
  return locateTool(jsonl, toolUseId).texts;
}

/**
 * textsBeforeTool 加上 transcript 裡有沒有這個 tool_use，與尾端項目的 type、timestamp（寫入時機的量測用）。
 * @param {string} jsonl transcript 內容
 * @param {string} toolUseId hook 輸入的 tool_use_id
 * @returns {{texts: string[], found: boolean, lines: number, lastType: string|null, lastTs: string|null}}
 */
export function locateTool(jsonl, toolUseId) {
  let found = false;
  const texts = scanSegments(jsonl, (_, block) => (found = block.id === toolUseId));
  const lines = jsonl.split('\n').filter(Boolean);
  let last = null;
  for (let i = lines.length - 1; i >= 0 && !last; i--) { try { last = JSON.parse(lines[i]); } catch { /* 略過半行 */ } }
  return { texts, found, lines: lines.length, lastType: last?.type ?? null, lastTs: last?.timestamp ?? null };
}

/**
 * 這個 tool_use 是否已被本 hook 的 PreToolUse 擋下（transcript 有它的 PreToolUse 提示 tool_result）。
 * @param {string} jsonl transcript 內容
 * @param {string} toolUseId hook 輸入的 tool_use_id
 * @returns {boolean}
 */
export function preToolNoticed(jsonl, toolUseId) {
  for (const line of jsonl.split('\n')) {
    if (!line.includes(toolUseId)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.type === 'user' ? entry.message?.content : null;
    if (Array.isArray(content) && content.some(block => block.tool_use_id === toolUseId && isPreToolNotice(block))) return true;
  }
  return false;
}

const RETRY_MS = 300;
const AGENT_ID = /^[\w-]+$/;
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 子代理自己的 transcript：父 transcript 同名目錄下的 subagents/agent-<agent_id>.jsonl（#901 實測的檔案配置）。
 * @param {string} transcriptPath hook 輸入的 transcript_path（子代理時是父 session 的）
 * @param {string} agentId hook 輸入的 agent_id
 * @returns {string|null} agent_id 不是單純識別字時 null
 */
export function subagentTranscript(transcriptPath, agentId) {
  if (!AGENT_ID.test(agentId)) return null;
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const start = new Date().toISOString();
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  if (input?.stop_hook_active || !input?.transcript_path) process.exit(0);
  const event = String(input.hook_event_name ?? '');
  const preTool = event === 'PreToolUse';
  const postTool = event.startsWith('PostToolUse');
  // Skill 的 tool_use 在 PreToolUse 觸發時重讀也讀不到（#901：0/8），等待只增加延遲，交給 PostToolUse／Stop
  if (preTool && input.tool_name === 'Skill') process.exit(0);
  if ((preTool || postTool) && !input.tool_use_id) process.exit(0);
  const transcript = input.agent_id ? subagentTranscript(input.transcript_path, String(input.agent_id)) : input.transcript_path;
  if (!transcript) process.exit(0);
  let jsonl;
  try { jsonl = readFileSync(transcript, 'utf8'); } catch { process.exit(0); }
  const scratch = join(process.env.CLAUDE_PROJECT_DIR || input.cwd || '.', '.scratch');
  const log = record => {
    if (!existsSync(scratch)) return;
    try { appendFileSync(join(scratch, 'language-hook.log'), `${JSON.stringify(record)}\n`); } catch { /* 記錄失敗不影響檢查 */ }
  };
  let texts;
  if (preTool || postTool) {
    if (postTool && preToolNoticed(jsonl, input.tool_use_id)) process.exit(0);
    const first = locateTool(jsonl, input.tool_use_id);
    let retry = null;
    let waitMs = 0;
    // PostToolUse：還沒寫入這個 tool_use 就重讀；PreToolUse：尾端沒有文字段才重讀（找到 tool_use 而沒有文字段的是平行呼叫的第二個以後）
    if (preTool ? !first.found && !first.texts.length : !first.found) {
      const waited = Date.now();
      wait(RETRY_MS);
      waitMs = Date.now() - waited;
      let again = null;
      try { again = readFileSync(transcript, 'utf8'); } catch { /* 用第一次的結果 */ }
      // 擋下紀錄可能在等待期間才寫入：重讀的內容也要再認一次
      if (again !== null && postTool && preToolNoticed(again, input.tool_use_id)) process.exit(0);
      if (again !== null) retry = locateTool(again, input.tool_use_id);
    }
    texts = (retry ?? first).texts;
    const strip = ({ texts: t, ...rest }) => ({ ...rest, texts: t.length });
    log({ at: new Date().toISOString(), start, waitMs, hook_event_name: event, tool: input.tool_name ?? null,
      id: input.tool_use_id, agent: input.agent_id ? true : undefined, first: strip(first), retry: retry && strip(retry) });
  } else texts = lastTurnTexts(jsonl);
  // 子代理（agent_id）只擋簡體字：英文是給協調者讀的（retro spay2 2282a2a4#6）
  const english = input.agent_id ? [] : texts.filter(isMostlyEnglish);
  const simplified = texts.filter(text => simplifiedChars(text).length);
  const where = preTool || postTool ? '這次工具呼叫前' : '本輪';
  const blocked = preTool ? '工具未執行，改用繁體中文說明後再呼叫。' : '';
  const deny = message => {
    log({ at: new Date().toISOString(), hook_event_name: event || 'Stop', session_id: input.session_id ?? null, tool: input.tool_name ?? null });
    process.stderr.write(`${message}${blocked}\n`);
    process.exit(2);
  };
  if (simplified.length && !english.length) {
    const chars = [...new Set(simplified.flatMap(simplifiedChars))].join('、');
    deny(`語言檢查：${where}有 ${simplified.length} 段使用者可見文字用了簡體字（${chars}）。使用者可見訊息一律以繁體中文撰寫；請改用繁體中文重新說明這些內容。`);
  }
  if (english.length) {
    const sample = english[0].replace(/\s+/g, ' ').slice(0, 120);
    deny(`語言檢查：${where}有 ${english.length} 段使用者可見文字以英文為主（例：「${sample}」）。`
      + '使用者可見訊息一律以繁體中文撰寫，工具呼叫之間的一行進度也算；請用繁體中文重新說明這些內容，之後的進度行也改用繁體中文，程式碼、路徑與技術名詞維持英文。');
  }
}
