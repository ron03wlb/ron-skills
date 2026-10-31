#!/usr/bin/env node
// Claude Code Bash PreToolUse hook：擋下會被 zsh EQUALS 或 NOMATCH 中止整串指令的字（#203、#209）。
// zsh 預設開著 EQUALS：沒加引號、以 `=` 開頭的字會換成指令路徑（`=node` → `/usr/local/bin/node`），找不到就印 `(eval):1: == not found`
// 並中止整串指令。session 2ebf77bf 三次用 `echo ===` 當分隔線，後面的指令都沒跑、exit 1，錯誤訊息又不指向原因，各多花一次重跑。
// 命中的字：不在引號、heredoc 內容、註解、`[[ … ]]` 與 `(( … ))` 裡，以 `=` 開頭、後面還有字的字（`===`、`==`、`=x`）。
// 單獨一個 `=`（`[ a = b ]`）、`VAR=x`、`--opt=x`、`a==b` 都不是以 `=` 開頭的字，放行。
// NOMATCH：沒加引號、含 `*`／`?` 的 `--<opt>=<pattern>` 字（`--include=*.md`）zsh 會當檔名展開，找不到就印
// `no matches found: --include=*.md` 並中止整串指令（session 19341230，#209）。一般的 `*.md` 參數多半是刻意展開，放行。
// 分支 pattern 同理：沒加引號、含 `*`／`?`、以 `issue/`、`pilot/`、`retro/`、`origin/` 開頭的字（`git merge-base issue/193-* …`）
// 不是檔案，zsh 一樣印 `no matches found` 中止（session cbef7b39，#218）。
// PIPESTATUS：Bash 工具跑的是 zsh，bash 的 `${PIPESTATUS[0]}` 在 zsh 展開成空字串，pipe 前那支指令的 exit code 就不見了
// （session 8d8ec702 jsonl 第 183 行 `… | tail -20; echo "exit=${PIPESTATUS[0]}"` 印 `exit=`，#238）。沒加引號或在雙引號裡的才算，單引號與 heredoc 內容放行。
// 命中時 exit 2，stderr 說明原因與改法；輸入不合法或不是 Bash 時 exit 0 不輸出。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 萬用字元出現在這些字裡會被 zsh 當檔名展開而 NOMATCH：`--opt=` 的值，或像分支名稱的字。 */
const GLOB_WORD = /^(--[\w-]+=|(issue|pilot|retro|origin)\/)/;
const BREAK = new Set([' ', '\t', ';', '|', '&', '(', ')', '<', '>', '\n']);

/** 指令裡會被 zsh EQUALS 展開的字（依出現順序）。 */
export function equalsWords(command) {
  return scan(command).equals;
}

/** 指令裡沒加引號、含萬用字元、會被 zsh NOMATCH 中止的 `--opt=pattern` 字（依出現順序）。 */
export function nomatchWords(command) {
  return scan(command).nomatch;
}

/** 指令有沒有在 zsh 會展開的地方用到 bash 的 `$PIPESTATUS`。 */
export function usesPipestatus(command) {
  return scan(command).pipestatus;
}

const PIPESTATUS = /\$\{?PIPESTATUS\b/;

function scan(command) {
  const found = [];
  const nomatch = [];
  let pipestatus = false;
  let glob = false; // 目前的字在 `--opt=` 之後、或像 ref 的字裡，有沒有沒加引號的 * 或 ?
  const heredocs = [];
  let i = 0;
  let word = '';
  let wordStart = true; // 目前的字是否還沒有任何字元
  let startsWithEquals = false;
  let depth = 0; // [[ … ]] 或 (( … )) 的層數：裡面的 == 是比較運算子
  const end = () => {
    if (startsWithEquals && word.length > 1 && depth === 0) found.push(word);
    if (glob && depth === 0) nomatch.push(word);
    glob = false;
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
      if (c === '"' && PIPESTATUS.test(command.slice(i, j))) pipestatus = true;
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
    if (c === '$' && PIPESTATUS.test(command.slice(i, i + 12))) pipestatus = true;
    if (wordStart && c === '=') startsWithEquals = true;
    if ((c === '*' || c === '?') && GLOB_WORD.test(word)) glob = true;
    word += c;
    wordStart = false;
    i++;
  }
  end();
  return { equals: found, nomatch, pipestatus };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const command = input?.tool_input?.command;
  if (input?.tool_name && input.tool_name !== 'Bash') process.exit(0);
  if (typeof command !== 'string') process.exit(0);
  const { equals, nomatch, pipestatus } = scan(command);
  if (!equals.length && !nomatch.length && !pipestatus) process.exit(0);
  const lines = [];
  if (equals.length) lines.push(
    `zsh 會把沒加引號、以 = 開頭的字當 EQUALS 展開成指令路徑：${equals.map(w => `\`${w}\``).join('、')}。`,
    '找不到指令時印 `(eval):1: == not found` 並中止整串指令，後面的指令都不會跑（#203）。',
    "分隔線改成 `echo '==='` 或 `echo ---`；要傳以 = 開頭的參數時加引號。",
  );
  if (nomatch.length) {
    const quoted = nomatch.map(w => { const k = w.startsWith('--') ? w.indexOf('=') : -1; return `${w.slice(0, k + 1)}'${w.slice(k + 1)}'`; });
    lines.push(
      `zsh 會把沒加引號、含 * 或 ? 的字當檔名展開：${nomatch.map(w => `\`${w}\``).join('、')}。`,
      '找不到相符檔案時 NOMATCH 印 `no matches found` 並中止整串指令，前後的輸出都作廢（#209）。',
      `把 pattern 加引號：${quoted.map(w => `\`${w}\``).join('、')}；要找分支用 \`git branch --list '<pattern>'\`（#218）。`,
    );
  }
  if (pipestatus) lines.push(
    'Bash 工具跑的是 zsh，bash 的 `$PIPESTATUS` 在 zsh 展開成空字串，pipe 前那支指令的 exit code 會不見（#238）。',
    '改用 zsh 的 `${pipestatus[1]}`（從 1 起算），或不要 pipe，直接看結果行。',
  );
  console.error(lines.join('\n'));
  process.exit(2);
}
