#!/usr/bin/env node
// Claude Code Bash PreToolUse hook：擋下會被 zsh EQUALS 展開的字（#203）。
// zsh 預設開著 EQUALS：沒加引號、以 `=` 開頭的字會換成指令路徑（`=node` → `/usr/local/bin/node`），找不到就印 `(eval):1: == not found`
// 並中止整串指令。session 2ebf77bf 三次用 `echo ===` 當分隔線，後面的指令都沒跑、exit 1，錯誤訊息又不指向原因，各多花一次重跑。
// 命中的字：不在引號、heredoc 內容、註解、`[[ … ]]` 與 `(( … ))` 裡，以 `=` 開頭、後面還有字的字（`===`、`==`、`=x`）。
// 單獨一個 `=`（`[ a = b ]`）、`VAR=x`、`--opt=x`、`a==b` 都不是以 `=` 開頭的字，放行。
// 命中時 exit 2，stderr 說明原因與改法；輸入不合法或不是 Bash 時 exit 0 不輸出。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BREAK = new Set([' ', '\t', ';', '|', '&', '(', ')', '<', '>', '\n']);

/** 指令裡會被 zsh EQUALS 展開的字（依出現順序）。 */
export function equalsWords(command) {
  const found = [];
  const heredocs = [];
  let i = 0;
  let word = '';
  let wordStart = true; // 目前的字是否還沒有任何字元
  let startsWithEquals = false;
  let depth = 0; // [[ … ]] 或 (( … )) 的層數：裡面的 == 是比較運算子
  const end = () => {
    if (startsWithEquals && word.length > 1 && depth === 0) found.push(word);
    word = '';
    wordStart = true;
    startsWithEquals = false;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === '\n') {
      end();
      i++;
      // heredoc 的內容從下一行開始，到單獨一行的結束字為止。
      while (heredocs.length) {
        const { tag, strip } = heredocs.shift();
        while (i < command.length) {
          const next = command.indexOf('\n', i);
          const line = command.slice(i, next < 0 ? command.length : next);
          i = next < 0 ? command.length : next + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === tag) break;
        }
      }
      continue;
    }
    if (c === '\\') { word += command.slice(i, i + 2); wordStart = false; i += 2; continue; }
    if (c === "'" || c === '"') {
      // 引號裡的字不展開；`"$(…)"` 這類巢狀的內容少見，整段當字串略過。
      let j = i + 1;
      while (j < command.length && command[j] !== c) j += c === '"' && command[j] === '\\' ? 2 : 1;
      word += command.slice(i, j + 1);
      wordStart = false;
      i = j + 1;
      continue;
    }
    if (c === '#' && wordStart) {
      const next = command.indexOf('\n', i);
      i = next < 0 ? command.length : next;
      continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      end();
      const m = command.slice(i).match(/^<<(-?)\s*(['"]?)([\w.-]+)\2/);
      if (m) { heredocs.push({ tag: m[3], strip: m[1] === '-' }); i += m[0].length; continue; }
      i += 2;
      continue;
    }
    if (wordStart && (command.startsWith('[[', i) || command.startsWith('((', i) || command.startsWith('$((', i))) {
      end();
      depth++;
      i += command[i] === '$' ? 3 : 2;
      continue;
    }
    if (depth > 0 && (command.startsWith(']]', i) || command.startsWith('))', i))) {
      end();
      depth--;
      i += 2;
      continue;
    }
    if (BREAK.has(c)) { end(); i++; continue; }
    if (wordStart && c === '=') startsWithEquals = true;
    word += c;
    wordStart = false;
    i++;
  }
  end();
  return found;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const command = input?.tool_input?.command;
  if (input?.tool_name && input.tool_name !== 'Bash') process.exit(0);
  if (typeof command !== 'string') process.exit(0);
  const words = equalsWords(command);
  if (!words.length) process.exit(0);
  console.error([
    `zsh 會把沒加引號、以 = 開頭的字當 EQUALS 展開成指令路徑：${words.map(w => `\`${w}\``).join('、')}。`,
    '找不到指令時印 `(eval):1: == not found` 並中止整串指令，後面的指令都不會跑（#203）。',
    "分隔線改成 `echo '==='` 或 `echo ---`；要傳以 = 開頭的參數時加引號。",
  ].join('\n'));
  process.exit(2);
}
