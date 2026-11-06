#!/usr/bin/env node
// Claude Code PreToolUse hook（Bash）：拒絕繞過 git hook 的指令，例如 `git -c core.hooksPath=/dev/null commit`、`--no-verify`、`-n` commit。
// 整合分支的 reference-transaction guard 與 pre-push gate 都靠 git hook；繞過即失去保護。
// 另攔以 shell `&` 背景化的長等待指令（`--long-wait` 指定）：前景 Bash 裡的 `&` 工作結束時不會觸發 task notification，
// 必須改用 Bash tool 的 run_in_background。與 git 無關，但 settings.json 只有使用者能改，沿用這支既有的 Bash PreToolUse hook。
// 另攔要整份讀的指令（`--whole-output` 指定）以管線接 grep／head／tail／cut：過濾會丟掉縮排明細行，cut 會截掉長行尾端的指令
// （文字規則寫了仍再犯，依「prose rules become scripts」改由 hook 擋，與背景化長等待指令同為拒絕）。
// 另攔長跑 gate（`--exit-gate` 指定）以管線接 grep／head／tail／cut：Bash 回報的 exit code 是管線最後一支的，gate 失敗也通知 exit 0
// （retro spay2 b949589b#1：`check-contracts.sh | tail -15` 與 `fix-land.mjs … | tail -12` 都假綠，靠讀輸出才發現）。同一指令有 pipefail 時 exit code 正確，不攔；同一支 script 只印資料的形式（EXIT_GATE_READ_ONLY）不攔。
// 另攔 pilot-handoff.mjs 與其他指令串接（`;`、`&&`、`||`、換行）：內建規則，不需要旗標，見 chainedHandoff。
// 另攔要背景執行的指令（`--background-only` 指定）在前景執行：`tool_input.run_in_background` 不是 true 就拒絕（retro spay2 1677d177#1：前景 batch-land.mjs 擋住 session 10 分鐘）。
// `--long-wait` 的 spec 所在 pipeline（以 `;`、`&&`、`||`、換行切段，不以 `|` 切）以單一 `&` 結尾也攔（retro spay2 b0225c1b#1：`… 2>&1 | head -0 &`）。
// `--long-wait` 的 spec 前面串了其他指令（`&&`、`;`、`||`、換行；前面只有 `cd` 或變數指派不算）也拒絕，訊息「長等待指令（watcher）單獨一個背景呼叫」；
//   actionable：先跑前面的指令，再以 run_in_background 單獨執行 watcher（retro spay2 e320267d#5：task notification 的摘要是整串的描述，看不出哪個 worker 交件）。
// 任一拒絕時，指令含 here-doc（`<<`）或寫檔重導（`>`、`>>`、`2>`、`&>`；`2>&1`、`>&2`、`>/dev/null` 不算）就在訊息後加一行
//   「本指令中的寫檔也未執行；寫檔另開一個呼叫。」：不另外 actionable，照拒絕訊息改法重送時把寫檔拆成另一個呼叫（retro spay2 e9234021#4）。
// `--long-wait` 只看 shell `&` 與串接，攔不到前景呼叫；兩者互不取代，`--exit-gate` 也獨立判定，同一支 script 可以同時帶。
// 用法：node scripts/claude-hook-git-bypass.mjs [--long-wait <spec>]… [--whole-output <spec>]… [--exit-gate <script 名稱>]… [--background-only <spec>]…
//   spec 是「script 名稱[ 旗標]」，例如 `watch.mjs` 或 `queue.mjs --wait`：帶旗標時同段指令要有該旗標才算。不帶時只攔 git 繞過。
// stdin 是 hook JSON（tool_input.command、tool_input.run_in_background）；命中時 exit 2，stderr 交回 agent；其他情況 exit 0 不輸出。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 引號內會被執行的情形：shell 的 -c、eval、ssh、watch；另一支直譯器的 -c／-e；管線或 here-string 餵給 shell。
const SHELL_NAME = String.raw`(?:ba|z|da|k|fi)?sh`;
const RUNS_SHELL = new RegExp(String.raw`(?:^|[\s/])(?:(?:${SHELL_NAME}|su|flock|script)\b[^\n]*\s-[a-zA-Z]*c\s*$|${SHELL_NAME}\b[^\n]*<<<\s*$|eval\s+$|(?:ssh|watch|parallel)\s)`);
const RUNS_CODE = /(?:^|[\s/])(?:python[\d.]*|node|perl|ruby)\b[^\n]*\s(?:-[a-zA-Z]*[ce]|--eval)[\s=]*$/;
const FEEDS_SHELL = new RegExp(String.raw`^[^;\n]*?\|&?\s*(?:sudo\s+)?(?:\S*\/)?${SHELL_NAME}\b`);
const HEREDOC_SHELL = new RegExp(String.raw`(?:^|[\s/])(?:${SHELL_NAME}(?:\s+-\S*)*\s*<<|ssh\s[^\n]*<<)`);
const HEREDOC_CODE = /(?:^|[\s/])(?:python[\d.]*|node|perl|ruby)(?:\s+-\S*)*\s*<</;
const HEREDOC = /^<<-?\s*(['"]?)([\w.-]+)\1/;

/** text[start] 是單引號開頭 → 結束位置與內容；不成對為 null。 */
function singleQuoted(text, start) {
  const end = text.indexOf("'", start + 1);
  return end < 0 ? null : { literal: text.slice(start + 1, end), subs: [], end: end + 1 };
}

/** text[start] 是雙引號開頭 → 結束位置、內容（去掉跳脫）與其中會執行的 `$(…)`、反引號；不成對為 null。 */
function doubleQuoted(text, start) {
  let literal = '';
  const subs = [];
  for (let i = start + 1; i < text.length;) {
    if (text[i] === '"') return { literal, subs, end: i + 1 };
    if (text[i] === '\\') {
      literal += /["\\$`]/.test(text[i + 1] ?? '') ? text[i + 1] : text.slice(i, i + 2);
      i += 2;
    } else if (text.startsWith('$(', i)) {
      const end = closingParen(text, i + 2);
      if (end < 0) return null;
      subs.push(text.slice(i + 2, end));
      literal += text.slice(i, end + 1);
      i = end + 1;
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) return null;
      subs.push(text.slice(i + 1, end));
      literal += text.slice(i, end + 1);
      i = end + 1;
    } else literal += text[i++];
  }
  return null;
}

/** 換行之後的 here-doc 內容：回傳結束標記那行之後的位置；找不到標記為 -1。 */
function heredocEnd(text, lineStart, delimiters) {
  let at = lineStart;
  for (const delimiter of delimiters) {
    for (;;) {
      if (at >= text.length) return -1;
      const newline = text.indexOf('\n', at);
      const line = text.slice(at, newline < 0 ? text.length : newline);
      at = newline < 0 ? text.length : newline + 1;
      if (line.replace(/^\t+/, '') === delimiter) break;
    }
  }
  return at;
}

/** text[start] 在 `$(` 之後 → 對應 `)` 的位置（略過引號、註解與 here-doc）；找不到為 -1。 */
function closingParen(text, start) {
  let depth = 1;
  let delimiters = [];
  for (let i = start; i < text.length;) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === "'" || c === '"') {
      const quoted = (c === "'" ? singleQuoted : doubleQuoted)(text, i);
      if (!quoted) return -1;
      i = quoted.end;
    } else if (c === '#' && /[\s;&|(]/.test(text[i - 1] ?? ' ')) {
      const newline = text.indexOf('\n', i);
      if (newline < 0) return -1;
      i = newline;
    } else if (text.startsWith('<<', i) && !text.startsWith('<<<', i)) {
      const match = HEREDOC.exec(text.slice(i));
      if (match) delimiters.push(match[2]);
      i += match ? match[0].length : 2;
    } else if (c === '\n' && delimiters.length) {
      i = heredocEnd(text, i + 1, delimiters);
      if (i < 0) return -1;
      delimiters = [];
    } else {
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/** 一段引號內容在比對用文字裡的樣子：會被執行的展開比對；git 的參數（單一個字、core.hooksPath 設定）去引號；其他文字換成 `""`。 */
function quotedView({ literal, subs }, segment, rest, codeIsData) {
  if (/^\s*core\.hooks/i.test(literal)) return literal;
  if (RUNS_SHELL.test(segment) || FEEDS_SHELL.test(rest)) return ` ; ${commandView(literal, codeIsData)} ; `;
  if (RUNS_CODE.test(segment)) return ` ; ${literal.replace(/['"`]/g, ' ')} ; `;
  const ran = subs.map(sub => ` ; ${commandView(sub, codeIsData)} ; `).join('');
  return (/^[\w./=:@%+,-]+$/.test(literal) ? literal : '""') + ran;
}

/**
 * 比對用的指令文字：成對引號內的文字換掉（`--prompt '… git commit --no-verify …'` 只是字串），註解拿掉，
 * 不是餵給 shell 或直譯器的 here-doc 內容拿掉（commit message、寫檔的內容）；會被執行的引號內容（`bash -c '…'`、雙引號內的 `$(…)`）照常比對。
 * 引號不成對時其餘原樣比對：寧可多攔。
 * codeIsData：直譯器的 here-doc 內容也拿掉。git 繞過要看它（`os.system('cd x && git …')`）；gate 的判定不看：
 * 那是另一種語言，字串不是指令（retro spay2 86eda4c4#3：`s="['node x.mjs … | tail']"` 整行原樣比對，`s="['node ` 還被當成環境變數指派）。
 * 直譯器的 -c／-e 內容照常比對（`python3 -c "os.system('x.mjs | tail')"` 是一行寫完的真實呼叫，PR #314 的 review）。
 */
function commandView(command, codeIsData = false) {
  let out = '';
  let segment = 0;
  let line = 0;
  let delimiters = [];
  for (let i = 0; i < command.length;) {
    const c = command[i];
    if (c === '\\') {
      out += command.slice(i, i + 2);
      i += 2;
    } else if (c === "'" || c === '"') {
      const quoted = (c === "'" ? singleQuoted : doubleQuoted)(command, i);
      if (!quoted) return out + command.slice(i);
      out += quotedView(quoted, out.slice(segment), command.slice(quoted.end), codeIsData);
      i = quoted.end;
    } else if (c === '#' && /[\s;&|(]/.test(command[i - 1] ?? ' ')) {
      const newline = command.indexOf('\n', i);
      i = newline < 0 ? command.length : newline;
    } else if (command.startsWith('<<<', i)) {
      out += '<<<';
      i += 3;
    } else if (command.startsWith('<<', i)) {
      const match = HEREDOC.exec(command.slice(i));
      if (match) delimiters.push(match[2]);
      out += match ? match[0] : '<<';
      i += match ? match[0].length : 2;
    } else if (c === '\n' && delimiters.length) {
      const end = heredocEnd(command, i + 1, delimiters);
      if (end < 0) return out + command.slice(i);
      const lineEnd = command.indexOf('\n', i);
      const head = command.slice(line, lineEnd);
      const executed = HEREDOC_SHELL.test(head) || FEEDS_SHELL.test(head) || (!codeIsData && HEREDOC_CODE.test(head));
      out += executed ? command.slice(i, end) : '\n';
      delimiters = [];
      i = end;
      line = end;
      segment = out.length;
    } else if (c === '`') {
      out += ' ; ';
      i++;
      segment = out.length;
    } else {
      out += c;
      i++;
      if (c === '\n') line = i;
      if (/[;|\n(]/.test(c) || (c === '&' && !/[<>]/.test(command[i - 2] ?? '') && command[i] !== '>')) segment = out.length;
    }
  }
  return out;
}

// 只比對 git 指令本身（前面是行首、空白或 shell 分隔符）；比對的是 commandView 的結果，字串、grep 與唯讀查詢不攔。
const BYPASS = [
  [/(^|[\s;&|(])git\b[^;&|]*\s-c\s*["']?core\.hooks[Pp]ath=/, '改寫 core.hooksPath'],
  [/(^|[\s;&|(])git\b[^;&|]*\sconfig\b(?![^;&|]*\s--(get|get-all|list|unset)\b)[^;&|]*\score\.hooks[Pp]ath\s+[^\s;&|]/, '改寫 core.hooksPath'],
  [/(^|[\s;&|(])git\b[^;&|]*\s--no-verify\b/, '--no-verify'],
  [/(^|[\s;&|(])git\b[^;&|]*\bcommit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/, 'git commit -n'],
];

// shell 重導（`>`、`>>`、`2>`、`&>`、`>&2`、`<` 及其目標）：`git config core.hooksPath >/dev/null` 是唯讀查詢，
// 不去掉的話 `>/dev/null` 會被當成設定值（retro spay2 0cd3fdeb#3）。要在指令開頭或空白、分隔符之後才算，
// `core.hooksPath=/x>y` 這種黏在值上的不動；`<<`、`<<<` 不算。
const REDIRECT = /(?<![^\s;&|(])(?:\d+|&)?(?:>>?|<(?!<))[&|]?\s*[^\s;&|()<>]*/g;

/**
 * @param {string} command Bash tool 的完整指令
 * @returns {string|null} 命中的繞過方式；未命中為 null
 */
export function bypassReason(command) {
  const view = commandView(command).replace(REDIRECT, ' ');
  for (const [pattern, reason] of BYPASS) if (pattern.test(view)) return reason;
  return null;
}

/** gate 類判定（exit-gate、串接交接、background-only）用的比對文字：見 commandView 的 codeIsData。 */
const gateView = command => commandView(command, true);

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** spec「script 名稱[ 旗標]」→ regex 片段：名稱本身，帶旗標時接同段指令內（不跨 `;`、`&`、`|`、換行）的 `\s<旗標>`。 */
function specPattern(spec) {
  const [script, flag] = spec.trim().split(/\s+/);
  return escape(script) + (flag ? String.raw`[^;&|\n]*\s${escape(flag)}(?![\w-])` : '');
}

// 長等待指令之後、同一段指令內（不跨 `;`、`||`、換行）出現單獨的 `&`：排除 `&&`、`2>&1`／`>&`、`&>`、`|&`。
// 若 `&&` 串起的整串最後以 `&` 結尾，整串都在背景，一樣攔。單一 `|` 不切段：`<spec> 2>&1 | head -0 &` 是整條 pipeline 在背景
// （retro spay2 b0225c1b#1：原本 `|` 也切段，watcher 經 `| head -0 &` 在背景跑、不觸發 task notification，hook 放行）。
const backgrounded = specs => new RegExp(`(${specs.map(specPattern).join('|')})(?:[^;|\\n]|(?<!\\|)\\|(?!\\|))*?(?<![&>|<])&(?![&>])`);

/**
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} specs 長等待指令的 spec
 * @returns {string|null} 以 `&` 背景化的長等待指令 spec；未命中為 null
 */
export function backgroundJobReason(command, specs = []) {
  if (!specs.length) return null;
  const match = backgrounded(specs).exec(gateView(command));
  return match ? specs.find(spec => new RegExp(`^${specPattern(spec)}`).test(match[1])) : null;
}

// 指令之後、同一段指令內（不跨 `;`、`&&`／`&`、換行；`2>&1` 等重導向不算）以 `|`（或 `|&`）接 grep／egrep／rg／head／tail／cut（可帶路徑，
// 中間可經 tee 等其他管線）。指令前同段出現引號（例如 `grep "status.mjs --probe | grep" docs`）視為字串，不攔。
const FILTER = String.raw`\|&?\s*(?:\S*\/)?(?:e?grep|rg|head|tail|cut)\b`;
const FILTER_NAME = /(e?grep|rg|head|tail|cut)\b/;
const filtered = spec => new RegExp(String.raw`(?:^|[;&|\n(])[^;&|\n"']*?${specPattern(spec)}`
  + String.raw`(?:[^;&|\n]|(?<=[<>])&|\|(?!${FILTER}))*?(?<filter>${FILTER})`);

/**
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} specs 要整份讀的指令 spec
 * @returns {string|null} 過濾輸出的指令名稱（grep／head／tail／cut…）；未命中為 null
 */
export function probeFilterReason(command, specs = []) {
  return filteredOutput(command, specs)?.filter ?? null;
}

/** 被過濾的 spec 與過濾指令名稱；未命中為 null。 */
function filteredOutput(command, specs) {
  for (const spec of specs) {
    const filter = filtered(spec).exec(command)?.groups.filter;
    if (filter) return { spec, filter: FILTER_NAME.exec(filter)[1] };
  }
  return null;
}

/**
 * 「這一段指令在執行 script」的 regex 片段：段落開頭，可接 shell 關鍵字（`do`、`then`、`{` 等，retro spay2 6d21b9cc#3：for 迴圈內的管線原本看不到）、
 * 環境變數與 node／bash／sh，可帶路徑。`(?<!\\)`：沒加引號的 `grep a\|x.mjs f` 裡，`\|` 也不是分隔。
 */
const runs = script => String.raw`(?:^|(?<!\\)[;&|\n(])\s*(?:(?:do|then|else|elif|if|while|until|\{|!)\s+)*(?:\w+=\S*\s+)*(?:(?:node|bash|sh)\s+)?(?:[^\s;&|"']*\/)?${escape(script)}(?![\w.-])`;

// 只印資料、不是 gate 的形式：script 之後的參數符合就不算 exit gate（retro spay2 4a22bbe7#3：`followups.mjs list | cut`、`issue-create.mjs --template | head`
// 被拒，理由是「gate 失敗也顯示成功」，但它們不是 gate，整段多指令 Bash 卻要重送）。寫死在這裡而不是新增旗標：hook 的參數在 settings.json，只有使用者能改。
// 寫入形式要繼續攔，所以比對開頭：issue-create.mjs 只把第一個參數的 `--template` 當成印骨架。
// `--help`／`-h` 也只印用法（retro spay2 2dc186b1#4：`issue-create.mjs --help 2>&1 | head -5` 被拒，`--template … | head -60` 放行）；
// 只列確認過會先處理 `--help` 的 script，不一律放行：不認得 `--help` 的 gate 可能照常整個跑完。
const EXIT_GATE_READ_ONLY = {
  'followups.mjs': /^\s+(?:list|--help|-h)(?![\w-])/,
  'issue-create.mjs': /^\s+(?:--template|--help|-h)(?![\w-])/,
};

const COMPOUND_CLOSERS = new Map([['for', 'done'], ['select', 'done'], ['while', 'done'], ['until', 'done'], ['if', 'fi'], ['case', 'esac'], ['{', '}']]);
// 後面還是指令開頭的關鍵字。
const KEEPS_COMMAND = new Set(['do', 'then', 'else', 'elif', '!']);
// 管線之前的文字，同 exitGateReason：不跨 `;`、`&`、換行與 `||`，`2>&1` 等重導向不算，可經過 tee 等其他管線。
const UNTIL_FILTER = String.raw`(?:[^;&|\n]|(?<=[<>])&|(?!${FILTER})\|(?!\|))*`;
const PIPED_TO_FILTER = new RegExp(`^${UNTIL_FILTER}?(?<filter>${FILTER})`);

/**
 * 管線接在整個迴圈或群組之後（`for …; done | tail`、`{ gate; } | tail`、`( gate ) | tail`，followups 394）：回傳各複合指令的內文與過濾指令。
 * 關鍵字要在指令開頭才算（`followups.mjs done | tail` 的 done 是參數）；`$(…)` 不算，它的 exit code 本來就不會回報。
 */
function pipedCompounds(view) {
  const found = [];
  const open = [];
  let atCommand = true;
  const close = (start, end) => {
    const { bodyStart, substitution } = open.pop();
    const filter = PIPED_TO_FILTER.exec(view.slice(end))?.groups.filter;
    if (filter && !substitution) found.push({ body: view.slice(bodyStart, start), filter });
  };
  for (const { 0: token, index } of view.matchAll(/\n|[;&|()]|[^\s;&|()]+/g)) {
    const end = index + token.length;
    if (token === '(') {
      open.push({ closer: ')', bodyStart: end, substitution: /[$<>]/.test(view[index - 1] ?? '') });
      atCommand = true;
    } else if (token === ')') {
      if (open.at(-1)?.closer === ')') close(index, end);
      atCommand = false;
    } else if (/^[\n;&|]$/.test(token)) atCommand = true;
    else if (atCommand) {
      if (COMPOUND_CLOSERS.has(token)) open.push({ closer: COMPOUND_CLOSERS.get(token), bodyStart: end });
      else if (open.at(-1)?.closer === token) { close(index, end); atCommand = false; }
      else if (!KEEPS_COMMAND.has(token)) atCommand = false;
    }
  }
  return found;
}

/** 這段指令裡有不是唯讀形式的 script 執行。 */
function runsGate(body, script) {
  const pattern = new RegExp(runs(script) + `(?<args>${UNTIL_FILTER})`, 'g');
  for (const { groups: { args } } of body.matchAll(pattern)) {
    if (args.includes('|') || !EXIT_GATE_READ_ONLY[script]?.test(args)) return true;
  }
  return false;
}

/**
 * script 要被實際執行才算（見 runs）；`cat x.mjs | head`、`git log -- x.mjs | head`、引號內的字樣不算。
 * 比對 gateView 的結果：`grep -E 'a|x.mjs|b' | grep -v grep`、`grep "a\\|x.mjs" f | cut` 的 `|` 在引號內，不是分隔（retro spay2 4799d53c#6、1d552915#3）；`bash -c '…'` 內的照常比對。
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} scripts 長跑 gate 的 script 名稱
 * @returns {{ script: string, filter: string }|null} 被接管線的 gate 與過濾指令名稱；未命中為 null
 */
export function exitGateReason(command, scripts = []) {
  const view = gateView(command);
  if (/\bpipefail\b/.test(view)) return null;
  for (const script of scripts) {
    const pattern = new RegExp(runs(script) + String.raw`(?<args>(?:[^;&|\n]|(?<=[<>])&|\|(?!${FILTER}))*?)(?<filter>${FILTER})`, 'g');
    // 逐一看：前面的唯讀形式不掩蓋同一條指令後面真正的 gate。
    for (const { groups: { args, filter } } of view.matchAll(pattern)) {
      // args 來自 commandView（引號內已遮蔽），裡面的 `|` 是真的管線，後面可能接真的 gate（`list | xargs … done | tail`），不算唯讀。
      if (args.includes('|') || !EXIT_GATE_READ_ONLY[script]?.test(args)) return { script, filter: FILTER_NAME.exec(filter)[1] };
    }
  }
  for (const { body, filter } of pipedCompounds(view)) {
    const script = scripts.find(name => runsGate(body, name));
    if (script) return { script, filter: FILTER_NAME.exec(filter)[1] };
  }
  return null;
}

/**
 * 要背景執行的指令在前景執行。script 要被實際執行才算（見 runs），註解、字串與直譯器 here-doc 的內容不算。
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} specs 要背景執行的 spec（「script 名稱[ 旗標]」）
 * @param {unknown} runInBackground hook 收到的 tool_input.run_in_background：Bash tool 沒帶背景時可能沒有這個欄位，只有 true 算背景
 * @returns {string|null} 命中的 spec；未命中為 null
 */
export function foregroundReason(command, specs = [], runInBackground = false) {
  if (runInBackground === true || !specs.length) return null;
  const view = gateView(command);
  return specs.find(spec => {
    const [script, flag] = spec.trim().split(/\s+/);
    return new RegExp(runs(script) + (flag ? String.raw`[^;&|\n]*\s${escape(flag)}(?![\w-])` : '')).test(view);
  }) ?? null;
}

/**
 * 串接的指令裡有 pilot-handoff.mjs（retro spay2 f5d852cf#7：drain、diff 與交接串成一個 Bash 呼叫，結果印出時已交接，交接內容漏了它）。
 * 交接前要讀完其他指令的結果，所以另一段指令就算串接；`cd` 與單純的變數指派沒有結果要讀，不算。管線不是串接。
 * pilot-handoff.mjs 是 setup-workflow 自己的正本，規則內建，不必多帶旗標。
 * @param {string} command Bash tool 的完整指令
 * @returns {boolean} 要拒絕時為 true
 */
export function chainedHandoff(command) {
  const parts = statements(command);
  const handoff = new RegExp(runs('pilot-handoff.mjs'));
  return parts.some(text => handoff.test(text)) && parts.filter(text => !SETUP_ONLY.test(text)).length > 1;
}

/** 切成各段指令（`;`、`&&`、`||`、單一 `&`、換行；管線不切），去掉空段。 */
const statements = command => gateView(command).split(/(?<!\\)(?:[;\n]|&&|\|\||(?<![<>&])&(?![>&]))/).map(text => text.trim()).filter(Boolean);
// 沒有結果要讀的段落：`cd` 與單純的變數指派。
const SETUP_ONLY = /^(?:cd(?:\s|$)|\w+=\S*$)/;

/**
 * 長等待指令（`--long-wait`）前面串了其他指令（retro spay2 e320267d#5：`pilot-decision.mjs … && batch-watch.mjs --pilot --exit-on-finish`
 * 當成一個背景呼叫，task notification 的摘要是整串的描述，讀起來不像 worker 交件，每次都要另外 tail 輸出才知道是誰）。
 * 前面只有 `cd` 或變數指派不算；後面接的指令、管線不算。spec 要被實際執行才算（見 runs）。
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} specs 長等待指令的 spec
 * @returns {string|null} 被串接的 spec；未命中為 null
 */
export function chainedLongWaitReason(command, specs = []) {
  if (!specs.length) return null;
  const parts = statements(command);
  for (const [i, text] of parts.entries()) {
    const spec = specs.find(item => {
      const [script, flag] = item.trim().split(/\s+/);
      return new RegExp(runs(script) + (flag ? String.raw`[^;&|\n]*\s${escape(flag)}(?![\w-])` : '')).test(text);
    });
    if (spec && parts.slice(0, i).some(before => !SETUP_ONLY.test(before))) return spec;
  }
  return null;
}

// 寫檔：here-doc（`<<`，不含 `<<<`）或寫到檔案的重導（`>`、`>>`、`2>`、`&>`）；`2>&1`、`>&2` 與寫到 /dev/null 不算。比對 commandView（引號內遮蔽）。
const WRITES_FILE = /(?:^|[^<])<<(?!<)|(?<![<>=\w])(?:\d+|&)?>>?(?!&)\s*(?!\/dev\/null(?![\w./-]))[^\s;&|<>()]/;

/**
 * 被拒的指令整個都沒執行，裡面的寫檔也是（retro spay2 e9234021#4：heredoc 寫檔＋`issue-create.mjs … | tail` 被拒，之後 `ls` 才發現檔案不存在）。
 * @param {string} command Bash tool 的完整指令
 * @returns {boolean} 指令含寫檔時為 true
 */
export function writesFile(command) {
  return WRITES_FILE.test(commandView(command, true));
}

/** argv 中所有 `<flag> <value>` 的 value；緊接的是另一個旗標時不算值。 */
const values = (args, flag) => args.flatMap((arg, i) => (arg === flag && args[i + 1] && !args[i + 1].startsWith('--') ? [args[i + 1]] : []));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let command = '';
  let runInBackground;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))?.tool_input;
    command = input?.command ?? '';
    runInBackground = input?.run_in_background;
  } catch { process.exit(0); }
  // 所有拒絕共用：指令含寫檔時補一句，寫檔也沒有執行（retro spay2 e9234021#4）。
  const deny = message => {
    process.stderr.write(message + (writesFile(command) ? '本指令中的寫檔也未執行；寫檔另開一個呼叫。\n' : ''));
    process.exit(2);
  };
  const reason = bypassReason(command);
  if (reason) {
    deny(`拒絕：指令以 ${reason} 繞過 git hook。整合分支 guard 與 push gate 都在 hook 內；照常執行 git，讓 hook 跑完。hook 失敗時修正原因或回報使用者。\n`);
  }
  const args = process.argv.slice(2);
  const job = backgroundJobReason(command, values(args, '--long-wait'));
  if (job) {
    deny(`拒絕：以 shell \`&\` 在前景 Bash 背景化 ${job}，結束時不會觸發 task notification。去掉 \`&\`，改用 Bash tool 的 run_in_background: true 執行同一指令。\n`);
  }
  const chainedWait = chainedLongWaitReason(command, values(args, '--long-wait'));
  if (chainedWait) {
    deny(`拒絕：${chainedWait} 前面串了其他指令（\`&&\`／\`;\`）。長等待指令（watcher）單獨一個背景呼叫：task notification 的摘要是整個呼叫的描述，串在一起就看不出是哪個 worker 交件。先跑前面的指令，再以 Bash tool 的 run_in_background: true 單獨執行 ${chainedWait}（前面可以有 \`cd\` 或變數指派）。\n`);
  }
  const found = filteredOutput(command, values(args, '--whole-output'));
  if (found) {
    const { spec, filter } = found;
    deny(`拒絕：${spec} 的輸出以 ${filter} 過濾。這個輸出要整份讀：底下的縮排明細行會被濾掉，下一輪誤判為沒變。拿掉管線，直接執行。\n`);
  }
  const gate = exitGateReason(command, values(args, '--exit-gate'));
  if (gate) {
    deny(`拒絕：${gate.script} 接 ${gate.filter}，回報的 exit code 是 ${gate.filter} 的，gate 失敗也顯示成功。改成 \`<指令> > <log> 2>&1; rc=$?; tail -n 20 <log>; exit $rc\`。\n`);
  }
  const foreground = foregroundReason(command, values(args, '--background-only'), runInBackground);
  if (foreground) {
    deny(`拒絕：${foreground} 在前景執行，會把這個 session 擋到它結束（最多 600 秒），期間 worker 的結果都不會被處理。改用 Bash tool 的 run_in_background: true 執行同一指令，結束時會收到通知。\n`);
  }
  if (chainedHandoff(command)) {
    deny('拒絕：pilot-handoff.mjs 與其他指令串在同一個 Bash 呼叫，前面的結果印出時已經交接，交接內容會漏掉它。先跑其他指令、讀完結果，再單獨執行 pilot-handoff.mjs（前面可以有 `cd` 或變數指派）。\n');
  }
}
