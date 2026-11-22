#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Claude Code Bash PreToolUse hook：擋下會被 zsh EQUALS 或 NOMATCH 中止整串指令的字（#203、#209）。
// zsh 預設開著 EQUALS：沒加引號、以 `=` 開頭的字會換成指令路徑（`=node` → `/usr/local/bin/node`），找不到就印 `(eval):1: == not found`
// 並中止整串指令。session 2ebf77bf 三次用 `echo ===` 當分隔線，後面的指令都沒跑、exit 1，錯誤訊息又不指向原因，各多花一次重跑。
// 命中的字：不在引號、heredoc 內容、註解、`[[ … ]]` 與 `(( … ))` 裡，以 `=` 開頭、後面還有字的字（`===`、`==`、`=x`）。
// 單獨一個 `=`（`[ a = b ]`）、`VAR=x`、`--opt=x`、`a==b` 都不是以 `=` 開頭的字，放行。
// NOMATCH：沒加引號、含 `*`／`?` 的 `--<opt>=<pattern>` 字（`--include=*.md`）zsh 會當檔名展開，找不到就印
// `no matches found: --include=*.md` 並中止整串指令（session 19341230，#209）。
// 分支 pattern 同理：沒加引號、含 `*`／`?`、以 `issue/`、`pilot/`、`retro/`、`origin/` 開頭的字（`git merge-base issue/193-* …`）
// 不是檔案，zsh 一樣印 `no matches found` 中止（session cbef7b39，#218）。
// for 清單：`for d in ~/a/*/x; do` 的 glob 沒有相符檔案時，NOMATCH 中止整串指令，連清單之後的 `echo done` 都不會跑，agent 看到沒有輸出就回報「找不到」
// （session f236b357 jsonl 第 207 行：`~/Documents/Workspace/mec-wiki` 明明存在，#284）。多半有相符檔案的 `for f in tests/*.test.mjs` 不該擋，所以 hook 實際比對檔案系統，
// 只擋此刻沒有相符檔案的；帶 `(N)` 限定、`setopt nullglob`、含變數或大括號（看不出會展開成什麼）、指令裡有 `cd` 時的相對路徑（不知道當時的目錄）都放行。
// 一般參數（#287）：`grep -l x scripts/*health* 2>/dev/null` 沒有相符檔案時一樣 NOMATCH 中止（session 3cf4e67c jsonl 第 196 行），而且 2>/dev/null 救不了。和 for 清單一樣比對檔案系統，有相符的放行；
// bash 把沒有相符的 glob 原樣傳給指令，無害。`case`、`noglob` 看不出是不是 glob，放行。
// 指令開頭只有一個 `cd <字面絕對路徑>` 時，相對路徑以該路徑解析（#287 的兩條指令都以 `cd /Users/…` 開頭）；其他 cd、pushd 看不出當時的目錄，相對路徑放行。
// PIPESTATUS：Bash 工具跑的是 zsh，bash 的 `${PIPESTATUS[0]}` 在 zsh 展開成空字串，pipe 前那支指令的 exit code 就不見了
// （session 8d8ec702 jsonl 第 183 行 `… | tail -20; echo "exit=${PIPESTATUS[0]}"` 印 `exit=`，#238）。沒加引號或在雙引號裡的才算，單引號與 heredoc 內容放行。
// 修飾字（#408）：zsh 把沒加大括號的 `$name:` 後接修飾字字母當成 history 修飾字，`git show $c:engine/x.py` 的 `$c:e` 取副檔名，
// 印 `fatal: ambiguous argument 'ngine/x.py'`（investing session 3b67e742，24 圈無效重放）。沒加引號或在雙引號裡的才算，`${c}:`、單引號、跳脫、heredoc 內容放行。
// 變數不切分（#413 第 4 項）：bash 把沒加引號的 `$F` 依空白切成多個參數，zsh 不切。`F="a.py b.py"; ruff check $F` 在 zsh 只傳一個參數
// （investing session 97ce22e7 jsonl 第 842 行 `E902 File name too long`），`worktree-overlap.mjs $F` 把整串當一個檔名、什麼都不印，看起來像「沒有重疊」
// （investing retro 03b2c41c 第 118 行），`for f in $F` 也只跑一次。同一條指令裡先以含空白的值賦值（`F="a b"`、`F='a b'`、`export F="a b"`），
// 之後沒加引號的 `$F`、`${F}` 才算；雙引號、`${=F}`、陣列（`F=(a b)`）、`[[ ]]`、`(( ))`、單引號、heredoc 內容、`echo`／`print` 的參數
// （切不切輸出都一樣）、賦值之前的使用放行。看不到前一條指令設的變數，所以跨指令的不擋。
// 命中時 exit 2，stderr 說明原因與改法；$SHELL 不是 zsh（#301）、輸入不合法或不是 Bash 時 exit 0 不輸出。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doubleQuoteEnd } from './lib/shell-quote.mjs';

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

/** `for … in` 清單裡沒加引號、含 `*`／`?`、沒帶 `(N)` 限定的字（依出現順序）。 */
export function forGlobWords(command) {
  return scan(command).forGlobs;
}

/** 一般參數（不在 for 清單、`--opt=` 或 ref 字裡）沒加引號、含 `*`／`?`、沒帶 `(N)` 限定的字（依出現順序）。 */
export function argGlobWords(command) {
  return scan(command).argGlobs;
}

/** 一個 glob 此刻有沒有相符的路徑；`**`、大括號這類看不出會展開成什麼的算有，不擋。 */
export function globMatches(pattern, { cwd = process.cwd(), home = homedir() } = {}) {
  if (/[$`{\\'"]|\*\*/.test(pattern) || /^~[^/]/.test(pattern)) return true;
  const path = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : pattern;
  let found = [path.startsWith('/') ? '/' : cwd];
  for (const part of path.split('/').filter(Boolean)) {
    if (!/[*?[]/.test(part)) {
      found = found.map(dir => join(dir, part)).filter(existsSync);
      continue;
    }
    let name;
    try {
      name = new RegExp(`^${part.replace(/[.+^()|]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'u');
    } catch { return true; }
    found = found.flatMap(dir => {
      try {
        return readdirSync(dir).filter(entry => name.test(entry) && (part[0] === '.' || entry[0] !== '.')).map(entry => join(dir, entry));
      } catch { return []; }
    });
  }
  return found.length > 0;
}

// 指令自己關掉 NOMATCH 時清單不會中止。
const NOMATCH_OFF = /\b(?:setopt\s+[^;\n]*\b(?:null_?glob|no_?nomatch)\b|unsetopt\s+[^;\n]*\bnomatch\b)/i;
// `case` 的 pattern 與 `noglob` 之後的字不展開。
const NOT_GLOB_CONTEXT = /(?:^|[\s;&|(])(?:case|noglob)\s/;

/** 相對路徑在指令裡是以哪個目錄解析：沒有 cd 時是 cwd，開頭唯一的 `cd <字面絕對路徑>` 且目錄存在時是它，其他情況看不出來（null）。 */
function globCwd(command, { cwd, home = homedir() } = {}) {
  const moves = command.match(/(?:^|[\s;&|(])(?:cd|pushd)\s/g)?.length ?? 0;
  if (!moves) return { cwd };
  const target = moves === 1 && command.match(/^\s*cd\s+(~\/[^\s;&|$`'"*?\\]*|\/[^\s;&|$`'"*?\\]*)\s*(?:&&|;|\n)/)?.[1];
  const dir = target && (target.startsWith('~/') ? join(home, target.slice(2)) : target);
  return dir && existsSync(dir) ? { cwd: dir } : null;
}

/** 這些字裡此刻沒有相符檔案的；相對路徑看不出當時的目錄時放行。 */
function unmatched(words, command, { cwd, home } = {}) {
  if (NOMATCH_OFF.test(command)) return [];
  const at = globCwd(command, { cwd, home });
  return words.filter(word => (at || /^[~/]/.test(word)) && !globMatches(word, { cwd: at?.cwd, home }));
}

/** 指令裡 for 清單中此刻沒有相符檔案的 glob。 */
export function unmatchedForGlobs(command, options) {
  return unmatched(forGlobWords(command), command, options);
}

/** 指令裡一般參數中此刻沒有相符檔案的 glob。 */
export function unmatchedArgGlobs(command, options) {
  return NOT_GLOB_CONTEXT.test(command) ? [] : unmatched(argGlobWords(command), command, options);
}

/** 沒加大括號、後接 zsh 修飾字字母的 `$name:x`（依出現順序，不重複），例如 `git show $c:engine/x.py` 的 `$c:e`。 */
export function modifierWords(command) {
  return scan(command).modifiers.map(m => m.word);
}

// zsh 參數展開接受的修飾字字母（`:gs/…` 這類 g、& 開頭的少見，不擋）。
const MODIFIER = /^\$([A-Za-z_]\w*|\d):([aAcehlPqQrstux])([^\s;&|()<>"'`]*)/;

/** 含空白的 `NAME="…"` 之後沒加引號的 `$NAME`／`${NAME}`（依出現順序，不重複），zsh 不切分、bash 會切（#413）。 */
export function splitWords(command) {
  return scan(command).splits;
}

// `$NAME` 或 `${NAME}`；`${=NAME}`、`${NAME[@]}`、`${NAME:-x}` 這類不是單純的變數展開，不算。
const PLAIN_VAR = /^\$(?:([A-Za-z_]\w*)(?![\w{])|\{([A-Za-z_]\w*)\})/;
// 參數不必切開的指令：echo／print 切不切印出來都一樣；`[`、`test` 的運算元與 `case` 的對象本來就該是一個值，zsh 不切才正確。
const SPLIT_HARMLESS = new Set(['echo', 'print', '[', 'test', 'case']);
// 後面接的賦值在這條指令之後仍有效的宣告指令；其他指令前的賦值（`F="a b" cmd $F`）只給那支指令，`$F` 展開的是舊值。
const DECLARE = new Set(['export', 'local', 'typeset', 'declare', 'readonly']);

/** 指令有沒有在 zsh 會展開的地方用到 bash 的 `$PIPESTATUS`。 */
export function usesPipestatus(command) {
  return scan(command).pipestatus;
}

// 雙引號裡跳脫過的 `\$PIPESTATUS` 不展開（retro 1101b：留言內文提到它就被擋下）。
const PIPESTATUS = /(?:^|[^\\])\$\{?PIPESTATUS\b/;

function scan(command) {
  const found = [];
  const nomatch = [];
  const forGlobs = [];
  const argGlobs = [];
  let pipestatus = false;
  const modifiers = [];
  const assigned = new Set(); // 目前為止以含空白的值賦值、之後沒再改成不含空白的變數
  const splits = [];
  let vars = []; // 目前的字裡沒加引號的 `$NAME`
  let cmdStart = true; // 目前的字還在指令名稱之前（指令開頭或前面只有賦值）
  let cmd = null; // 目前這條指令的名稱
  let pending = []; // 這條指令裡的賦值 [名稱, 值含空白]：指令結束、確定不是前綴賦值後才生效
  // 一條指令結束：只有賦值或宣告指令（export F="a b"）的賦值生效，再重設指令狀態。
  const newCommand = () => {
    if (cmd === null || DECLARE.has(cmd)) {
      for (const [name, spaced] of pending) {
        if (spaced) assigned.add(name);
        else assigned.delete(name);
      }
    }
    pending = [];
    cmdStart = true;
    cmd = null;
  };
  const modifier = text => {
    const m = text.match(MODIFIER);
    if (m) modifiers.push({ word: `$${m[1]}:${m[2]}`, fix: `\${${m[1]}}:${m[2]}${m[3]}` });
  };
  let forList = 0; // 1：剛看到 for；2：看過變數名；3：在 in 之後的清單裡
  let atCommand = true; // 目前的字在指令開頭（for 只有在這裡才是關鍵字）
  let wild = false; // 目前的字有沒有沒加引號的 * 或 ?
  let glob = false; // 目前的字在 `--opt=` 之後、或像 ref 的字裡，有沒有沒加引號的 * 或 ?
  const heredocs = [];
  let i = 0;
  let word = '';
  let wordStart = true; // 目前的字是否還沒有任何字元
  let startsWithEquals = false;
  let depth = 0; // [[ … ]] 或 (( … )) 的層數：裡面的 == 是比較運算子
  const end = () => {
    if (word && depth === 0) {
      const assign = word.match(/^([A-Za-z_]\w*)=(.*)$/s);
      if (cmdStart && !assign) { cmd = word; cmdStart = false; }
      // 賦值的右邊（`G=$F`）兩種 shell 都不切分。
      if (assign) pending.push([assign[1], /\s/.test(assign[2])]);
      else for (const name of vars) if (assigned.has(name) && !SPLIT_HARMLESS.has(cmd)) splits.push(`$${name}`);
    }
    vars = [];
    if (startsWithEquals && word.length > 1 && depth === 0) found.push(word);
    if (glob && depth === 0) nomatch.push(word);
    if (word && depth === 0) {
      const qualified = /^\([^)]*N[^)]*\)/.test(command.slice(i, i + 16));
      if (wild && !glob && forList !== 3 && !qualified && !/^\w+=/.test(word)) argGlobs.push(word);
      if (forList === 3) {
        if (word === 'do') forList = 0;
        else if (wild && !qualified) forGlobs.push(word);
      } else if (forList === 2) forList = word === 'in' ? 3 : 0;
      else if (forList === 1) forList = 2;
      else if (word === 'for' && atCommand) forList = 1;
      atCommand = word === 'then' || word === 'do' || word === 'else';
      if (atCommand) newCommand();
    }
    glob = false;
    wild = false;
    word = '';
    wordStart = true;
    startsWithEquals = false;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === '\n') {
      end();
      forList = 0;
      atCommand = true;
      newCommand();
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
      // 引號裡的字不展開；雙引號裡的 `$( … )`、反引號是新的命令替換，引號狀態重設，內容另外遞迴掃描（#360）。
      let j;
      if (c === "'") {
        j = command.indexOf("'", i + 1);
        if (j < 0) j = command.length;
      } else {
        const quoted = doubleQuoteEnd(command, i);
        j = quoted.end;
        if (PIPESTATUS.test(command.slice(i, j))) pipestatus = true;
        for (let k = i + 1; k < j; k++) {
          if (command[k] === '\\') k++;
          else if (command[k] === '$') modifier(command.slice(k, j));
        }
        for (const inner of quoted.commands) {
          const sub = scan(inner);
          found.push(...sub.equals);
          nomatch.push(...sub.nomatch);
          forGlobs.push(...sub.forGlobs);
          argGlobs.push(...sub.argGlobs);
          if (sub.pipestatus) pipestatus = true;
          modifiers.push(...sub.modifiers);
        }
      }
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
    if (BREAK.has(c)) {
      end();
      if (c === ';' || c === '&' || c === '|') { forList = 0; atCommand = true; }
      if (c === '(') atCommand = true;
      if (c === ';' || c === '&' || c === '|' || c === '(') newCommand();
      i++;
      continue;
    }
    if (c === '$' && PIPESTATUS.test(command.slice(i, i + 12))) pipestatus = true;
    if (c === '$') modifier(command.slice(i));
    if (c === '$' && depth === 0) {
      const m = command.slice(i).match(PLAIN_VAR);
      if (m) vars.push(m[1] ?? m[2]);
    }
    if (wordStart && c === '=') startsWithEquals = true;
    if ((c === '*' || c === '?') && GLOB_WORD.test(word)) glob = true;
    if (c === '*' || c === '?') wild = true;
    word += c;
    wordStart = false;
    i++;
  }
  end();
  const seen = new Set();
  const unique = modifiers.filter(m => !seen.has(m.word) && seen.add(m.word));
  return { equals: found, nomatch, pipestatus, forGlobs, argGlobs, modifiers: unique, splits: [...new Set(splits)] };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // 全部只在 zsh 才擋：bash 沒有 EQUALS、NOMATCH，`$PIPESTATUS` 又是對的，在 bash 照建議改成 `${pipestatus[1]}` 只拿到空字串（#301）。
  if (!/(?:^|\/)zsh$/.test(process.env.SHELL ?? '')) process.exit(0);
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const command = input?.tool_input?.command;
  if (input?.tool_name && input.tool_name !== 'Bash') process.exit(0);
  if (typeof command !== 'string') process.exit(0);
  const { equals, nomatch, pipestatus, modifiers, splits } = scan(command);
  const unmatchedFor = unmatchedForGlobs(command, { cwd: input?.cwd });
  const args = unmatchedArgGlobs(command, { cwd: input?.cwd });
  if (!equals.length && !nomatch.length && !pipestatus && !unmatchedFor.length && !args.length && !modifiers.length && !splits.length) process.exit(0);
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
  if (args.length) lines.push(
    `沒加引號的 glob 此刻沒有相符的檔案：${args.map(w => `\`${w}\``).join('、')}。`,
    'zsh 的 NOMATCH 會中止整串指令，`2>/dev/null` 也救不了，後面的指令都不跑（#287）。',
    `不是要展開就加引號；可能沒有相符時改成 \`${args[0]}(N)\` 或改用 \`find\`。`,
  );
  if (unmatchedFor.length) lines.push(
    `for 清單裡的 glob 此刻沒有相符的檔案：${unmatchedFor.map(w => `\`${w}\``).join('、')}。`,
    'zsh 的 NOMATCH 會中止整串指令，清單之後的指令都不跑、也沒有輸出；這不代表要找的東西不存在（#284）。',
    `改成 \`${unmatchedFor[0]}(N)\`（沒有相符時展開成空），或改用 \`find\`。`,
  );
  if (modifiers.length) lines.push(
    `zsh 會把沒加大括號的 \`$name:\` 後接的字母當成修飾字：${modifiers.map(m => `\`${m.word}\``).join('、')}（\`:e\` 取副檔名、\`:h\` 取目錄、\`:t\` 取檔名…）。`,
    '冒號之後的字會被吃掉或改寫，例如 `git show $c:engine/x.py` 印 `fatal: ambiguous argument \'ngine/x.py\'`（#408）。',
    `變數名稱加大括號：${modifiers.map(m => `\`${m.fix}\``).join('、')}。`,
  );
  if (splits.length) {
    const name = splits[0].slice(1);
    lines.push(
      `zsh 不會把沒加引號的變數依空白切成多個參數（bash 會）：${splits.map(w => `\`${w}\``).join('、')} 的值含空白，整串只傳成一個參數（#413）。`,
      '指令會把整串當一個檔名或參數：可能報 `File name too long`，也可能什麼都不印，看起來像「沒有命中」；`for … in` 只跑一次。',
      `改用陣列：\`${name}=(a b c)\` 再寫 \`"\${${name}[@]}"\`（bash、zsh 都切成各元素）；要整串當一個參數時加雙引號 \`"$${name}"\`。`,
    );
  }
  if (pipestatus) lines.push(
    'Bash 工具跑的是 zsh，bash 的 `$PIPESTATUS` 在 zsh 展開成空字串，pipe 前那支指令的 exit code 會不見（#238）。',
    '改用 zsh 的 `${pipestatus[1]}`（從 1 起算），或不要 pipe，直接看結果行。',
  );
  console.error(lines.join('\n'));
  process.exit(2);
}
