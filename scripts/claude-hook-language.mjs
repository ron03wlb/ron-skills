#!/usr/bin/env node
// Claude Code 語言 hook：使用者可見文字（assistant text block）以英文為主時回報，要求以繁體中文重新說明。
// 專案規定使用者可見訊息一律繁體中文（寫在 CLAUDE.md 等 agent 指引），連工具呼叫之間的一行進度也算；只靠文字規則會反覆重犯，所以用 hook 擋。
// 依 stdin hook JSON 的 hook_event_name 分兩種用法：
// - PostToolUse／PostToolUseFailure：檢查這次工具呼叫前緊鄰的文字段（上一個工具呼叫或 tool_result 之後到本 tool_use 為止），
//   同一輪就能改正；工具已執行，exit 2 只把 stderr 交回 agent。transcript 還沒寫入這次的 tool_use 時（Skill、Edit 這類幾十毫秒就結束的工具，
//   #238：前面有英文段的 Bash 14/14 都抓到，Skill、Edit 0/9），改看 transcript 尾端最後一個 tool_use、tool_result 或使用者輪之後的文字段。
//   #250：Bash 也會漏，hook 觸發時連 3 秒前的文字段都還沒寫入（整則 assistant 訊息延後寫），尾端文字段是空的。所以找不到 tool_use 時
//   等 RETRY_MS 重讀一次；專案根有 `.scratch/` 時把兩次讀到的行數、有沒有找到、尾端項目的 type 與 timestamp 附加到 `.scratch/language-hook.log`，
//   累積後判斷寫入時機，再決定改等更久、改用 hook 輸入，或只靠 Stop。
// - Stop（或未帶 hook_event_name）：檢查最後一個使用者輪的所有文字段；PostToolUse 尚未掛上時仍有覆蓋，
//   PostToolUse 提示過卻未改正的段落會再提一次（可接受）。
// harness 合成的訊息（用量上限「You've hit your weekly limit · resets 3am」、API Error 等）不是模型輸出：transcript 中這類 assistant 項目
// 帶 isApiErrorMessage／apiError 或 model `<synthetic>`，整筆略過；結構欄位缺漏時再以固定句型比對文字。
// Stop 只看最後一次語言檢查提示（Stop hook feedback 或 PostToolUse 的 hook_blocking_error）之後的文字：提示過的段落不再重提，
// 否則 /loop 的 coordinator 長時間沒有新的使用者輪，每次 Stop 都重抓同一句舊英文。
// 命中時 exit 2，stderr 交回 agent 繼續；stop_hook_active 為 true（已因本 hook 續跑一次）、輸入不合法、
// 讀不到 transcript 時 exit 0 不輸出，避免卡住。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** 本 hook 先前的提示：Stop hook feedback（meta 使用者訊息）或 PostToolUse 的 hook_blocking_error attachment。 */
function isLanguageNotice(entry) {
  if (entry.type === 'user' && entry.isMeta) {
    const content = entry.message?.content;
    return typeof content === 'string' && content.startsWith('Stop hook feedback:') && content.includes(NOTICE);
  }
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

const RETRY_MS = 300;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  if (input?.stop_hook_active || !input?.transcript_path) process.exit(0);
  const postTool = String(input.hook_event_name ?? '').startsWith('PostToolUse');
  if (postTool && !input.tool_use_id) process.exit(0);
  let jsonl;
  try { jsonl = readFileSync(input.transcript_path, 'utf8'); } catch { process.exit(0); }
  let texts;
  if (postTool) {
    const first = locateTool(jsonl, input.tool_use_id);
    let retry = null;
    if (!first.found) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS);
      try { retry = locateTool(readFileSync(input.transcript_path, 'utf8'), input.tool_use_id); } catch { /* 用第一次的結果 */ }
    }
    texts = (retry ?? first).texts;
    const scratch = join(process.env.CLAUDE_PROJECT_DIR || input.cwd || '.', '.scratch');
    if (existsSync(scratch)) {
      const strip = ({ texts: t, ...rest }) => ({ ...rest, texts: t.length });
      try {
        appendFileSync(join(scratch, 'language-hook.log'), `${JSON.stringify({ at: new Date().toISOString(), tool: input.tool_name ?? null,
          id: input.tool_use_id, first: strip(first), retry: retry && strip(retry) })}\n`);
      } catch { /* 量測失敗不影響檢查 */ }
    }
  } else texts = lastTurnTexts(jsonl);
  const english = texts.filter(isMostlyEnglish);
  if (english.length) {
    const sample = english[0].replace(/\s+/g, ' ').slice(0, 120);
    const where = postTool ? '這次工具呼叫前' : '本輪';
    process.stderr.write(`語言檢查：${where}有 ${english.length} 段使用者可見文字以英文為主（例：「${sample}」）。`
      + '使用者可見訊息一律以繁體中文撰寫，工具呼叫之間的一行進度也算；請用繁體中文重新說明這些內容，之後的進度行也改用繁體中文，程式碼、路徑與技術名詞維持英文。\n');
    process.exit(2);
  }
}
