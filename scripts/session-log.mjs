#!/usr/bin/env node
// setup-workflow 正本。讀 Claude Code session transcript（jsonl）裡的 tool call，取代 retro／retro-collect 每次手寫的解析器（#403）。
// 手寫版的毛病：`slice(0,200)`、`cut -c1-300` 截掉指令結尾而誤判；同一個 tool_use 在 `api-request-blob` 再出現一次，看起來像重送；
// 要的只有 hook 的 blockingError，卻印出整串 `hook_success` 附件與 `api-request` 行。
// 用法：node scripts/session-log.mjs <session 前綴 | jsonl 路徑> [--lines a-b] [--grep <regex>] [--max <n>]
//   session 前綴在 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/` 找 `<前綴>*.jsonl`，要剛好一個。
//   --lines：只印 tool call（或沒有 tool call 的 blockingError）落在 jsonl 第 a～b 行的；--grep：只印整組有相符的；
//   --max：每個欄位只留前 n 字並標原長度，沒帶就不截斷。
// stdout：第一行 `# <jsonl 路徑>`，之後每個 tool call 一組，依它在 jsonl 的行號排序：
//   `<行號> <tool> <輸入 JSON>`、`<行號> result|result(error) <結果 JSON 字串>`、`<行號> blockingError <hook> <訊息 JSON 字串>`。
//   同一個 tool_use id、tool_result、附件 uuid 只取第一次；`api-request*` 行與 `hook_success` 附件不讀。
// exit：0 有印出；1 沒有相符；2 用法錯誤、找不到 session 或前綴不唯一（stderr `SESSION_NOT_FOUND`／`SESSION_AMBIGUOUS`）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = () => {
  console.error('用法：node scripts/session-log.mjs <session 前綴 | jsonl 路徑> [--lines a-b] [--grep <regex>] [--max <n>]');
  process.exit(2);
};

function parseArgs(argv) {
  const options = { target: undefined, lines: undefined, grep: undefined, max: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lines') {
      const match = /^(\d+)-(\d+)$/.exec(argv[++i] ?? '');
      if (!match) usage();
      options.lines = [Number(match[1]), Number(match[2])];
    } else if (arg === '--grep') {
      if (!argv[++i]) usage();
      try { options.grep = new RegExp(argv[i], 'u'); } catch { usage(); }
    } else if (arg === '--max') {
      options.max = Number(argv[++i]);
      if (!Number.isInteger(options.max) || options.max < 1) usage();
    } else if (arg.startsWith('--') || options.target) {
      usage();
    } else {
      options.target = arg;
    }
  }
  if (!options.target) usage();
  return options;
}

function findTranscript(target) {
  if (target.endsWith('.jsonl') && existsSync(target)) return target;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const found = [];
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const path = join(projects, dir);
    if (!statSync(path).isDirectory()) continue;
    for (const name of readdirSync(path)) {
      if (name.startsWith(target) && name.endsWith('.jsonl')) found.push(join(path, name));
    }
  }
  if (found.length === 1) return found[0];
  console.error(found.length ? `SESSION_AMBIGUOUS ${target} ${found.join(' ')}` : `SESSION_NOT_FOUND ${target} ${projects}`);
  process.exit(2);
}

const resultText = content => (typeof content === 'string' ? content
  : (content ?? []).map(part => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n'));

function readGroups(text) {
  const calls = new Map();
  const results = new Set();
  const seenBlocking = new Set();
  const orphans = []; // 找不到對應 tool_use 的結果與 blockingError（例如 Stop hook），依自己的行號排
  const attach = (id, row) => {
    const call = id && calls.get(id);
    if (call) call.rows.push(row); else orphans.push({ line: row[0], rows: [row] });
  };
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    let record;
    try { record = JSON.parse(raw); } catch { return; }
    const content = record.message?.content;
    if (record.type === 'assistant' && Array.isArray(content)) {
      for (const part of content) {
        if (part.type !== 'tool_use' || calls.has(part.id)) continue;
        calls.set(part.id, { line, rows: [[line, part.name, JSON.stringify(part.input)]] });
      }
    } else if (record.type === 'user' && Array.isArray(content)) {
      for (const part of content) {
        if (part.type !== 'tool_result' || results.has(part.tool_use_id)) continue;
        results.add(part.tool_use_id);
        attach(part.tool_use_id, [line, part.is_error ? 'result(error)' : 'result', JSON.stringify(resultText(part.content))]);
      }
    } else if (record.type === 'attachment' && record.attachment?.type === 'hook_blocking_error') {
      const key = record.uuid ?? `line ${line}`;
      if (seenBlocking.has(key)) return;
      seenBlocking.add(key);
      const { hookName, toolUseID, blockingError } = record.attachment;
      const message = typeof blockingError === 'string' ? blockingError : blockingError?.blockingError;
      attach(toolUseID, [line, `blockingError ${hookName}`, JSON.stringify(message ?? '')]);
    }
  });
  return [...calls.values(), ...orphans].sort((a, b) => a.line - b.line);
}

const options = parseArgs(process.argv.slice(2));
const file = findTranscript(options.target);
const clip = field => (options.max && field.length > options.max
  ? `${field.slice(0, options.max)}…(原長 ${field.length} 字)` : field);
console.log(`# ${file}`);
let printed = false;
for (const group of readGroups(readFileSync(file, 'utf8'))) {
  if (options.lines && (group.line < options.lines[0] || group.line > options.lines[1])) continue;
  if (options.grep && !group.rows.some(row => options.grep.test(row.join(' ')))) continue;
  printed = true;
  for (const [line, label, field] of group.rows) console.log(`${line} ${label} ${clip(field)}`);
}
process.exit(printed ? 0 : 1);
