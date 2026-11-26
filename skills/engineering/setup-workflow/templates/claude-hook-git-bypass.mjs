#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Claude Code PreToolUse hook（Bash）：拒絕繞過 git hook 的指令，例如 `git -c core.hooksPath=/dev/null commit`、`--no-verify`、`-n` commit。
// 整合分支的 reference-transaction guard 與 pre-push gate 都靠 git hook；繞過即失去保護。
// 另攔以 shell `&` 背景化的長等待指令（`--long-wait` 指定）：前景 Bash 裡的 `&` 工作結束時不會觸發 task notification，
// 必須改用 Bash tool 的 run_in_background。與 git 無關，但 settings.json 只有使用者能改，沿用這支既有的 Bash PreToolUse hook。
// 另攔要整份讀的指令（`--whole-output` 指定）以管線接 grep／head／tail／cut：過濾會丟掉縮排明細行，cut 會截掉長行尾端的指令
// （文字規則寫了仍再犯，依「prose rules become scripts」改由 hook 擋，與背景化長等待指令同為拒絕）。
// 拒絕訊息要說明改成單獨一個 Bash 呼叫執行：只拿掉管線仍會與其他指令串在同一呼叫而再被拒或逾時（retro spay2 5014f17f#1、91b73b4b#1）。
// 另攔長跑 gate（`--exit-gate` 指定）以管線接 grep／head／tail／cut：Bash 回報的 exit code 是管線最後一支的，gate 失敗也通知 exit 0
// （retro spay2 b949589b#1：`check-contracts.sh | tail -15` 與 `fix-land.mjs … | tail -12` 都假綠，靠讀輸出才發現）。同一指令有 pipefail 時 exit code 正確，不攔；同一支 script 只印資料的形式（EXIT_GATE_READ_ONLY）不攔。
// 另攔 pilot-handoff.mjs 與其他指令串接（`;`、`&&`、`||`、換行）：內建規則，不需要旗標，見 chainedHandoff。
//   第一個參數是 `--review`／`--review-done`（唯讀列清單、記回顧點，不交接）的段落不算交接，可與其他指令串接（retro spay2 687eb996#4、a1d68426#4）。
// 另攔要背景執行的指令（`--background-only` 指定）在前景執行：`tool_input.run_in_background` 不是 true 就拒絕（retro spay2 1677d177#1：前景 batch-land.mjs 擋住 session 10 分鐘）。
// `--long-wait` 的 spec 所在 pipeline（以 `;`、`&&`、`||`、換行切段，不以 `|` 切）以單一 `&` 結尾也攔（retro spay2 b0225c1b#1：`… 2>&1 | head -0 &`）。
// `--long-wait` 的 spec 前面串了其他指令（`&&`、`;`、`||`、換行；前面只有 `cd` 或變數指派不算）也拒絕，訊息「長等待指令（watcher）單獨一個背景呼叫」；
//   actionable：先跑前面的指令，再以 run_in_background 單獨執行 watcher（retro spay2 e320267d#5：task notification 的摘要是整串的描述，看不出哪個 worker 交件）。
// 任一拒絕時，指令含 here-doc（`<<`）或寫檔重導（`>`、`>>`、`2>`、`&>`；`2>&1`、`>&2`、`>/dev/null` 不算）就在訊息後加一行
//   「本指令中的寫檔也未執行；寫檔另開一個呼叫。」：不另外 actionable，照拒絕訊息改法重送時把寫檔拆成另一個呼叫（retro spay2 e9234021#4）。
// 任一拒絕時，被拒的是串接指令（`;`、`&&`、`||`、換行切出兩段以上，`cd`／變數指派不算）就再加一行
//   「被拒的整個 Bash 呼叫都沒有執行（含串在一起的其他指令與寫檔），改寫後全部重送。」：不另外 actionable，重送時別只重送被點名的那段
//   （retro spay2 b20cba58#3：`followups.mjs add … | tail` 與另一個 `tail` 串在一起被拒，之後沒有重送，followups 記錄與另一段都沒執行）。
//   串接中有一段帶 `--reason-file <路徑>` 時再加「先用 Write 寫 reason 檔，再單獨執行 `<script> --reason-file <路徑>`。」
//   （retro spay2 3eccd274#4：heredoc 寫 reason 檔再串 pilot-handoff.mjs 被拒，試錯一次才改成 Write ＋單獨呼叫）。
// 前景執行偵測（runs）也認 `node --test a.test.mjs b.test.mjs` 這類 node 選項與前面的其他測試檔：`--background-only verify-unit.test.mjs`
//   才攔得到 `node --test scripts/verify-unit.test.mjs | head`（retro spay2 31d564a6#2：實測 228 秒，超過前景 120 秒被移到背景，管線緩衝讓輸出檔一直是空的）。
// `--long-wait` 的 spec 所在段落帶 `--once` 時不算長等待（不等待、印一次就結束），`&` 背景化與串接都不攔；同一呼叫裡其他沒帶 `--once` 的
//   長等待段落照攔（retro spay2 a5403bfb#1：`pilot-status.mjs --drain; batch-watch.mjs --once <handle>` 被誤擋，tick 本來就要求 `--once` 唯讀探查）。
// `--long-wait` 只認執行該 script 的段落（node［不含 `--check`／`-c`／`--help`／`--version`］、bash／sh 或直接執行，可帶路徑）：`node --check <spec>`、
//   grep 參數與直譯器 here-doc 字串裡的字樣不算（retro spay2 1112b followups 617，retro 1116a：`node --check scripts/x.mjs && node --check scripts/batch-watch.mjs`
//   被當成 watcher 前面串了其他指令而誤擋）。
// 「執行該 script」的判定（runs）各規則共用：`--background-only`、`--exit-gate` 與 pilot-handoff.mjs 串接也不認 `node --check`／`-c`／`--help`／`--version`，
//   路徑前綴不含 `=`（`F=scripts/x.mjs` 是變數指派，不是執行），變數指派的值不以 `(` 開頭（`ARGS=(--long-wait x.mjs …)` 是陣列）
//   （retro spay2 db0c0090#2：子代理回報「指令字面含檔名就被擋」，重現兩筆原指令後真正原因是 `node --check scripts/batch-land.mjs`、
//   `node --check pilot-handoff.mjs && echo ok` 與 `F="scripts/batch-la""nd.mjs"`；1119b 的 `--long-wait` 實例是 `node -e` 字串內以動態 import 載入 batch-watch 的指令，
//   直譯器 -e 內 `import(`／`require(` 的括號被當成段落開頭；heredoc 內文與 `sed -i … <path>` 原本就不算）。
// `--long-wait` 只看 shell `&` 與串接，攔不到前景呼叫；兩者互不取代，`--exit-gate` 也獨立判定，同一支 script 可以同時帶。
// 另攔 `grep -o` 的 pattern 有兩個以上 `.\{0,<n>\}`／`.{0,<n>}`／`[^.]\{0,<n>\}` 且第二大的 n ≥ 40（前後文各取 n 字）：內建規則，不需要旗標，見 wideGrepReason。
//   Claude Code 的 grep 是 ugrep，兩段寬範圍重複常報 `exceeds complexity limits`、exit 2（隨資料而變；單邊 1000 可，`-P` 不受影響）。訊息「grep -o 的 pattern 前後都有 `.{0,n}`」；actionable：專案有 `scripts/doc-excerpt.mjs`（以 $CLAUDE_PROJECT_DIR 判斷）時
//   改用 `node scripts/doc-excerpt.mjs '<詞>' <檔案>…`，否則改用 Python（retro spay2 bdabcbed#1：#295 後同一錯又踩兩次，doc-excerpt.mjs 沒人導過去）。
// 另攔 `while`／`until` 迴圈裡的 `pgrep -f`（內建規則，見 selfMatchLoopReason）：訊息「while／until 迴圈裡的 `pgrep -f` 會比對到執行這個迴圈的 shell 本身」；
//   actionable：改用 run_in_background 的完成通知，或取 pid 後 `while kill -0 <pid>`（retro spay2 1a01bf03#1：#961 worker 卡 2 小時）。
// 另攔讓 HEAD 離開分支的 `git checkout <rev>`（不帶路徑，含 `git checkout <rev> --` 後面沒有路徑）與 `git switch --detach`／`-d`、`git checkout --detach`（內建規則，見 detachReason）：
//   訊息「會讓 HEAD 離開分支（detached HEAD）」；actionable：讀舊版用 `git show <rev>:<path>`（retro spay2 db00b6a5#1：worktree 內 `git checkout -q 7da0a2eae -- 2>/dev/null`
//   想讀舊檔，HEAD 離開任務分支）；暫存 clone 用 `git switch -c <tmp> <rev>`（spay2 retro c31287e9#1：scratchpad 內 clone 的 `git checkout --detach` 被擋，只加訊息、不放寬規則）。不看所在目錄：主 checkout 的 claude-hook-main-checkout.mjs 放行 `checkout … --` 與非本機分支的 rev，兩邊都會踩到。
//   本 hook 不呼叫 git，`<rev>` 以字面判斷：7–40 位十六進位、含 `~`／`^`／`@{`（`@{-N}` 同 `-`，不算）、`HEAD` 開頭帶後綴，或 `origin/`、`refs/remotes/`、`refs/tags/` 開頭；
//   分支名稱、`-`、建分支（`-b`／`-B`／`--orphan`）與帶路徑的 `git checkout <rev> -- <path>`、`git checkout <rev> <path>` 放行。
// `--background-only` 另有內建項目 BUILTIN_BACKGROUND_ONLY（`orca-session-send.mjs --when-idle`，retro spay2 1a01bf03#8），訊息同 `--background-only`。
// 用法：node scripts/claude-hook-git-bypass.mjs [--long-wait <spec>]… [--whole-output <spec>]… [--exit-gate <script 名稱>]… [--background-only <spec>]…
//   spec 是「script 名稱[ 旗標]」，例如 `watch.mjs` 或 `queue.mjs --wait`：帶旗標時同段指令要有該旗標才算。不帶時只攔 git 繞過。
// stdin 是 hook JSON（tool_input.command、tool_input.run_in_background）；命中時 exit 2，stderr 交回 agent；其他情況 exit 0 不輸出。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * 直譯器程式碼接成一行再比對：BYPASS 的 -n／--no-verify 只看 shell 的同一行（#339），直譯器裡的換行不分隔指令，
 * argv 串列與字串裡的多行訊息都會跨行（`subprocess.run([⏎'git', 'commit',⏎'-n'])`、`os.system('''git commit -m 'a⏎b' -n''')`，#339 PR review）。
 * 接成一行後，只有字串開頭（引號後）或 shell 分隔符（`;`、`&`、`|`、`$(` 後）的 git 才是指令，其餘改成 `git_` 不比對：
 * 函式名 `git(root, "show", …)`、字串裡敘述 hook 訊息的「以 git commit -n 繞過」不是指令，接成一行後卻會和別處的 commit、-n 湊成繞過（#564）。
 */
const codeView = code => code.replace(/\n/g, ' ')
  .replace(/\bgit\b/g, (word, at, text) => (/(?:['"`]|[;&|]\s*|\$\()$/.test(text.slice(Math.max(0, at - 8), at)) ? word : 'git_'));

/** 一段引號內容在比對用文字裡的樣子：會被執行的展開比對；git 的參數（單一個字、core.hooksPath 設定）去引號；其他文字換成 `""`。 */
function quotedView({ literal, subs }, segment, rest, codeIsData, inlineSubs) {
  if (/^\s*core\.hooks/i.test(literal)) return literal;
  if (RUNS_SHELL.test(segment) || FEEDS_SHELL.test(rest)) return ` ; ${commandView(literal, codeIsData, inlineSubs)} ; `;
  // `import(…)`／`require(…)` 載入模組、不執行它的 CLI：去掉括號，免得 `(` 被當成段落開頭（retro spay2 db0c0090#2：
  // `node -e` 字串內以動態 import 載入 batch-watch 被當成執行 watcher）；`os.system('x.mjs | tail')` 照常比對。
  if (RUNS_CODE.test(segment)) return ` ; ${codeView(literal).replace(/\b(?:import|require)\s*\(/g, 'import ').replace(/['"`]/g, ' ')} ; `;
  const ran = inlineSubs ? subs.map(sub => ` ; ${commandView(sub, codeIsData)} ; `).join('') : '';
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
function commandView(command, codeIsData = false, inlineSubs = true) {
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
      out += quotedView(quoted, out.slice(segment), command.slice(quoted.end), codeIsData, inlineSubs);
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
      // 餵給 shell 的內文再跑一次 commandView：其中引號內的換行也要收掉（#339 PR review：`bash <<'E'` 內多行訊息的 commit -n）。
      const body = command.slice(i + 1, end).replace(/[^\n]*\n?$/, '');
      if (HEREDOC_SHELL.test(head) || FEEDS_SHELL.test(head)) out += `\n${commandView(body, codeIsData, inlineSubs)}\n`;
      else if (!codeIsData && HEREDOC_CODE.test(head)) out += `\n${codeView(body)}\n`;
      else out += '\n';
      delimiters = [];
      i = end;
      line = end;
      segment = out.length;
    } else if (c === '`') {
      out += inlineSubs ? ' ; ' : ' ';
      i++;
      if (inlineSubs) segment = out.length;
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
  // 這兩條只看同一行：換行後是另一個指令（#339：`git commit-tree …` 換行接 `zsh -n g` 被當成 `git commit -n`）；
  // -n 那條的 subcommand 要剛好是 commit，commit-tree、commit-graph 不算；--no-verify 照舊不限 subcommand（`git push --no-verify` 繞過 pre-push gate）。行尾反斜線接續在 bypassReason 先接成一行（CONTINUATION）。
  // core.hooksPath 兩條不在 #339 範圍，仍可跨行（寧可多攔）。
  [/(^|[\s;&|(])git\b[^;&|\n]*\s--no-verify\b/, '--no-verify'],
  [/(^|[\s;&|(])git\b[^;&|\n]*\bcommit(?![-\w])[^;&|\n]*\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/, 'git commit -n'],
];

// 行尾反斜線接續：shell 當成同一個指令，比對前接成一行，`git commit -m x \<換行> -n` 才不會因為 BYPASS 只看同一行而漏攔。
const CONTINUATION = /\\\n/g;

// shell 重導（`>`、`>>`、`2>`、`&>`、`>&2`、`<` 及其目標）：`git config core.hooksPath >/dev/null` 是唯讀查詢，
// 不去掉的話 `>/dev/null` 會被當成設定值（retro spay2 0cd3fdeb#3）。要在指令開頭或空白、分隔符之後才算，
// `core.hooksPath=/x>y` 這種黏在值上的不動；`<<`、`<<<` 不算。
const REDIRECT = /(?<![^\s;&|(])(?:\d+|&)?(?:>>?|<(?!<))[&|]?\s*[^\s;&|()<>]*/g;

/**
 * @param {string} command Bash tool 的完整指令
 * @returns {string|null} 命中的繞過方式；未命中為 null
 */
export function bypassReason(command) {
  // 兩份視圖：替換內容插回原位（抓 `$(…)` 裡的 git），以及不插（雙引號內的 `$(…)`、反引號不切斷外層指令，
  // `git commit -m "$(cat <<'EOF' … EOF⏎)" --no-verify` 的旗標才和 git 同段；#339 之前與之後都放行，#412 的繞過語料找到）。
  for (const inlineSubs of [true, false]) {
    const view = commandView(command, false, inlineSubs).replace(CONTINUATION, ' ').replace(REDIRECT, ' ');
    for (const [pattern, reason] of BYPASS) if (pattern.test(view)) return reason;
  }
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
// 帶 `--once` 的段落只印一次就結束，不是長等待（retro spay2 a5403bfb#1）。
const ONCE = /\s--once(?![\w-])/;
// 從 spec 開頭到第一個 `;`、`&`、`|`、換行為止（`>&`、`&>` 的 `&` 屬於重導，不切）：執行該 watcher 的那一段。
const SEGMENT = /^(?:[^;&|\n]|(?<=[<>])&|&(?=>))*/;
const backgrounded = specs => new RegExp(`(${specs.map(specPattern).join('|')})(?:[^;|\\n]|(?<!\\|)\\|(?!\\|))*?(?<![&>|<])&(?![&>])`);

/**
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} specs 長等待指令的 spec
 * @returns {string|null} 以 `&` 背景化的長等待指令 spec；未命中為 null
 */
export function backgroundJobReason(command, specs = []) {
  if (!specs.length) return null;
  // 只看執行該 watcher 的那一段（切在 `;`、`&`、`|`、換行，`2>&1` 等重導不切）帶不帶 `--once`：
  // `watch --pilot && watch --once x &` 的 `--pilot` 段照攔（retro spay2 a5403bfb#1，codex review P2）。
  // 每個 spec 出現處各自從該處比對，前一段因 `--once` 略過時，後面同一串的其他 watcher 仍會被檢查。
  const view = gateView(command);
  const sticky = new RegExp(backgrounded(specs).source, 'y');
  // 只從「執行該 script」的位置比對（見 runsWait）：`node --check`、grep 參數裡的字樣不算（retro spay2 1112b followups 617，retro 1116a）。
  const names = specs.map(spec => spec.trim().split(/\s+/)[0]);
  for (const start of view.matchAll(new RegExp(names.map(runsWait).join('|'), 'g'))) {
    // 比對結果以 script 名稱結尾；從名稱處開始比對背景化（同 specPattern 的起點）。
    sticky.lastIndex = start.index + start[0].length - [...names].sort((a, b) => b.length - a.length).find(name => start[0].endsWith(name)).length;
    const match = sticky.exec(view);
    if (match && !ONCE.test(SEGMENT.exec(match[0])[0])) return specs.find(spec => new RegExp(`^${specPattern(spec)}`).test(match[1]));
  }
  return null;
}

// 指令之後、同一段指令內（不跨 `;`、`&&`／`&`、換行；`2>&1` 等重導向不算）以 `|`（或 `|&`）接 grep／egrep／rg／head／tail／cut（可帶路徑，
// 中間可經 tee 等其他管線）。指令前同段出現引號（例如 `grep "status.mjs --probe | grep" docs`）視為字串，不攔。
const FILTER = String.raw`\|&?\s*(?:\S*\/)?(?:e?grep|rg|head|tail|cut)\b`;
const FILTER_NAME = /(e?grep|rg|head|tail|cut)\b/;
// script 要被實際執行才算（見 runs，比對 gateView；retro spay2 db0c0090#2：原本段落內任何位置出現 spec 字樣都算，`P=scripts/x.mjs --probe | head` 也攔）。
const filtered = spec => {
  const [script, flag] = spec.trim().split(/\s+/);
  return new RegExp(runs(script) + (flag ? String.raw`[^;&|\n]*\s${escape(flag)}(?![\w-])` : '')
    + String.raw`(?:[^;&|\n]|(?<=[<>])&|\|(?!${FILTER}))*?(?<filter>${FILTER})`);
};

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
  const view = specs.length ? gateView(command) : '';
  for (const spec of specs) {
    const filter = filtered(spec).exec(view)?.groups.filter;
    if (filter) return { spec, filter: FILTER_NAME.exec(filter)[1] };
  }
  return null;
}

// `node --check`／`-c`（只檢查語法）、`--help`、`--version` 不執行 script（retro spay2 1112b followups 617，retro 1116a：
// `node --check scripts/x.mjs && node --check scripts/batch-watch.mjs` 被當成 watcher 前面串了其他指令而誤擋；
// retro spay2 db0c0090#2：`node --check scripts/batch-land.mjs` 被當成前景執行 batch-land.mjs）。
const NODE_OPTION = String.raw`(?!(?:-c|--check|-h|--help|-v|--version)(?![^\s;&|]))-[^\s;&|]+`;
/** 長等待（`--long-wait`）的 script 被 node 執行（或直接、經 bash／sh 執行）的段落：同 runs。 */
const runsWait = script => runs(script);

/**
 * 「這一段指令在執行 script」的 regex 片段：段落開頭，可接 shell 關鍵字（`do`、`then`、`{` 等，retro spay2 6d21b9cc#3：for 迴圈內的管線原本看不到）、
 * 環境變數與 node／bash／sh，可帶路徑。`(?<!\\)`：沒加引號的 `grep a\|x.mjs f` 裡，`\|` 也不是分隔。
 * 不執行 script 的 node 旗標（NODE_OPTION）、變數指派的值（路徑前綴不含 `=`）與陣列指派（`X=(…`）不算（retro spay2 db0c0090#2）。
 */
const runs = script => String.raw`(?:^|(?<!\\)[;&|\n(])\s*(?:(?:do|then|else|elif|if|while|until|\{|!)\s+)*(?:\w+=(?!\()\S*\s+)*(?:node(?:\s+${NODE_OPTION})*(?:\s+[^\s;&|"'<>-][^\s;&|"'<>]*\.test\.m?js)*\s+|(?:bash|sh)\s+)?(?:[^\s;&|"'=]*\/)?${escape(script)}(?![\w.-])`;

// 只印資料、不是 gate 的形式：script 之後的參數符合就不算 exit gate（retro spay2 4a22bbe7#3：`followups.mjs list | cut`、`issue-create.mjs --template | head`
// 被拒，理由是「gate 失敗也顯示成功」，但它們不是 gate，整段多指令 Bash 卻要重送）。寫死在這裡而不是新增旗標：hook 的參數在 settings.json，只有使用者能改。
// 寫入形式要繼續攔，所以比對開頭：issue-create.mjs 只把第一個參數的 `--template` 當成印骨架。
// `--help`／`-h` 也只印用法（retro spay2 2dc186b1#4：`issue-create.mjs --help 2>&1 | head -5` 被拒，`--template … | head -60` 放行）；
// 只列確認過會先處理 `--help` 的 script，不一律放行：不認得 `--help` 的 gate 可能照常整個跑完。
// retro spay2 05f4385f#3：`update-issue-body.mjs --help 2>&1 | head -15` 被拒；它把 `--help` 當 iid、印 USAGE 後 exit 2，不寫入。
// 同樣確認過：fix-land.mjs（任一參數 `--help`／`-h` 先印 USAGE、exit 0）、check-contracts.sh（不是 `--static` 的參數都印用法、exit 2）。
const HELP_ONLY = /^\s+(?:--help|-h)(?![\w-])/;
// followups.mjs 不帶參數只印用法（exit 2、不寫入）也放行（retro spay2 2df91b24#3：`node scripts/followups.mjs 2>&1 | head -20` 查用法被拒，整個呼叫重送）。
const EXIT_GATE_READ_ONLY = {
  'followups.mjs': /^(?:\s+(?:list|--help|-h)(?![\w-])|(?:\s+\d?>&\d)*\s*$)/,
  'issue-create.mjs': /^\s+(?:--template|--help|-h)(?![\w-])/,
  'update-issue-body.mjs': HELP_ONLY,
  'fix-land.mjs': HELP_ONLY,
  'check-contracts.sh': HELP_ONLY,
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

// 內建的 `--background-only`（不需要旗標；hook 的參數在 settings.json，只有使用者能改）：
// `orca-session-send.mjs --when-idle` 等到 worker 閒置才送，前景呼叫會把 session 擋到上限（retro spay2 1a01bf03#8：前景跑滿 300 秒才被移到背景）。
export const BUILTIN_BACKGROUND_ONLY = ['orca-session-send.mjs --when-idle'];

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
 * 第一個參數是 `--review`／`--review-done` 時只列或記回顧點、不交接，不算（retro spay2 687eb996#4、a1d68426#4：`pilot-handoff.mjs --review; echo ===; …` 被拒、多重送一次）。
 * @param {string} command Bash tool 的完整指令
 * @returns {boolean} 要拒絕時為 true
 */
export function chainedHandoff(command) {
  const parts = statements(command);
  const handoff = new RegExp(runs('pilot-handoff.mjs') + String.raw`(?!\s+--review(?:-done)?(?![\w-]))`);
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
      return new RegExp(runsWait(script) + (flag ? String.raw`[^;&|\n]*\s${escape(flag)}(?![\w-])` : '')).test(text);
    });
    if (spec && !ONCE.test(text) && parts.slice(0, i).some(before => !SETUP_ONLY.test(before))) return spec;
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

/**
 * 被拒的指令是串接（兩段以上不是 `cd`／變數指派的指令）時補的說明：整個呼叫都沒執行；有一段帶 `--reason-file` 時指明先 Write 再單獨執行。
 * @param {string} command Bash tool 的完整指令
 * @returns {string} 要附在拒絕訊息後的文字；不是串接時為空字串
 */
export function chainedNote(command) {
  const parts = statements(command).filter(text => !SETUP_ONLY.test(text));
  if (parts.length < 2) return '';
  let note = '被拒的整個 Bash 呼叫都沒有執行（含串在一起的其他指令與寫檔），改寫後全部重送。\n';
  for (const text of parts) {
    const match = /(?:^|\s)(?:[^\s;&|"']*\/)?([\w.-]+\.m?js)\b[^;&|\n]*?\s--reason-file[=\s]\s*([^\s;&|<>()]+)/.exec(text);
    if (match) {
      note += `先用 Write 寫 reason 檔，再單獨執行 \`${match[1]} --reason-file ${match[2]}\`（前面可以有 \`cd\`）。\n`;
      break;
    }
  }
  return note;
}

// grep 前後文的範圍重複：`.` 或字元類（`[^.]`）接 `\{0,120\}`（BRE）或 `{0,120}`（ERE），取上限。固定次數 `.\{120\}x.\{200\}` 不算：
// 對 ~/.claude/projects 全部 Bash 呼叫試跑，固定次數的 grep -o 幾十次都沒報錯。
const REPEAT = /(?:\.|\[\^?\]?[^\]]*\])\\?\{\d*,(\d+)\\?\}/g;
// 第二大的上限到這個值才攔：ugrep 的判定隨資料而變（同一 docs/agents/issue-pilot.md：20／900 可，40／40 比對 `STOP` 時 exit 2），
// 20 以下實測都跑得動；誤攔的代價只是改用 doc-excerpt.mjs。
const WIDE_MIN = 40;
const upperBounds = text => [...text.matchAll(REPEAT)].map(([, high]) => Number(high));
// 指令開頭可略過的關鍵字。
const LEADING_WORD = /^(?:do|then|else|elif|if|while|until|\{|!|time)$/;
// 短選項中接參數的字母：之後的字是參數（`-A3`、`-efoo`），不再當選項看。
const SHORT_WITH_ARG = /[efmABCdD]/;

/** 原始指令切成各段簡單指令的字（處理引號、跳脫、註解與 here-doc 內容；`$(…)` 不展開，當成字的一部分）。 */
function simpleCommands(command) {
  const commands = [];
  let words = [];
  let word = null;
  let delimiters = [];
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < command.length;) {
    const c = command[i];
    if (c === '\\') {
      if (command[i + 1] !== '\n') word = (word ?? '') + (command[i + 1] ?? '');
      i += 2;
    } else if (c === "'" || c === '"') {
      const quoted = (c === "'" ? singleQuoted : doubleQuoted)(command, i);
      if (!quoted) { word = (word ?? '') + command.slice(i + 1); break; }
      word = (word ?? '') + quoted.literal;
      i = quoted.end;
    } else if (c === '#' && word === null) {
      const newline = command.indexOf('\n', i);
      i = newline < 0 ? command.length : newline;
    } else if (command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
      endWord();
      const match = HEREDOC.exec(command.slice(i));
      if (match) delimiters.push(match[2]);
      i += match ? match[0].length : 2;
    } else if (c === '\n') {
      endCommand();
      i = delimiters.length ? heredocEnd(command, i + 1, delimiters) : i + 1;
      delimiters = [];
      if (i < 0) break;
    } else if (/[;&|()]/.test(c)) {
      // `2>&1`、`>&2`、`&>` 的 `&` 屬於重導，不切段
      if (c === '&' && (/[<>]/.test(command[i - 1] ?? '') || command[i + 1] === '>')) word = (word ?? '') + c;
      else endCommand();
      i++;
    } else if (/\s/.test(c)) {
      endWord();
      i++;
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  endCommand();
  return commands;
}

/**
 * `grep -o` 的 pattern 有兩個以上寬範圍重複（retro spay2 bdabcbed#1：
 * `grep -n -o '.\{0,120\}\(STOP_INTEGRATED\|MERGED_OPEN\).\{0,120\}' docs/agents/*.md` → ugrep `exceeds complexity limits`、exit 2）。
 * 只看以 grep／egrep／ugrep 開頭的段落（`command grep`、帶路徑的 grep 是 GNU grep，不攔）；`-P` 走 PCRE 不受影響，不攔；
 * 沒有 `-o` 或只有一個重複（單邊前後文）時 ugrep 跑得動，不攔。
 * @param {string} command Bash tool 的完整指令
 * @returns {boolean} 要拒絕時為 true
 */
export function wideGrepReason(command) {
  for (const words of simpleCommands(command)) {
    let at = 0;
    while (at < words.length && (LEADING_WORD.test(words[at]) || /^\w+=/.test(words[at]))) at++;
    if (!/^(?:e|u)?grep$/.test(words[at] ?? '')) continue;
    let only = false;
    let perl = false;
    let wide = false;
    let options = true;
    for (const arg of words.slice(at + 1)) {
      if (options && arg === '--') { options = false; continue; }
      if (options && arg.startsWith('--')) {
        if (arg === '--only-matching') only = true;
        if (arg === '--perl-regexp') perl = true;
        if (!arg.startsWith('--regexp=')) continue;
      } else if (options && /^-[^-]/.test(arg)) {
        const letters = arg.slice(1).split(SHORT_WITH_ARG)[0];
        if (letters.includes('o')) only = true;
        if (letters.includes('P')) perl = true;
      }
      if ((upperBounds(arg).sort((a, b) => b - a)[1] ?? 0) >= WIDE_MIN) wide = true;
    }
    if (only && wide && !perl) return true;
  }
  return false;
}

// pgrep 帶 -f（可與其他短選項合寫，例 `-af`）或 --full。
const PGREP_FULL = /(?:^|[\s(`!])pgrep(?:\s+-[^\s]*)*?\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--full)(?![\w-])/;
const LOOP_OPENERS = new Set(['while', 'until', 'for', 'select']);

/**
 * `while`／`until` 迴圈（條件或內文）裡的 `pgrep -f`：pattern 也出現在執行這個迴圈的 shell 自己的命令列，pgrep 永遠找得到它，迴圈不會結束
 * （retro spay2 1a01bf03#1：`until ! pgrep -f "impacted-tests.mjs c1e9348e3" >/dev/null; do sleep 30; done` 讓 #961 的 worker 卡 2 小時，
 * 真正的程序早已結束，只剩 Claude 的 `bash -c` 自己相符）。迴圈外單獨的 `pgrep -af foo` 只查一次，不攔；`for` 迴圈不攔。
 * @param {string} command Bash tool 的完整指令
 * @returns {boolean} 要拒絕時為 true
 */
export function selfMatchLoopReason(command) {
  const loops = [];
  for (const words of simpleCommands(command)) {
    let at = 0;
    for (; at < words.length; at++) {
      const word = words[at];
      if (LOOP_OPENERS.has(word)) loops.push(word);
      else if (word === 'done') loops.pop();
      else if (!LEADING_WORD.test(word)) break;
    }
    const inWait = loops.some(word => word === 'while' || word === 'until');
    if (inWait && PGREP_FULL.test(words.join(' '))) return true;
  }
  return false;
}

// git 的全域選項中接下一個字當參數的。
const GIT_GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
// 字面上就是 commit 而不是本機分支的 rev。
const DETACHING_REV = /^(?:[0-9a-f]{7,40}|HEAD[~^@].*|origin\/.+|refs\/(?:remotes|tags)\/.+|.*(?:[~^]|@\{(?!-)).*)$/;
// shell 重導的字（`2>/dev/null`、`>`、`&>`）：不是 git 的參數；只有運算子時下一個字是目標。
const REDIRECT_WORD = /^(?:\d+|&)?(?:>>?|<)(?:&?\S*)$/;

/**
 * 讓 HEAD 離開分支的 git 指令（retro spay2 db00b6a5#1：worktree 內 `git checkout -q 7da0a2eae -- 2>/dev/null` 想讀舊檔，HEAD 離開任務分支）。
 * `git switch --detach`／`-d`、`git checkout --detach` 一律算；`git checkout` 不帶路徑（沒有 `--` 而只有一個位置參數，或 `--` 後面沒有東西）
 * 且 rev 字面上是 commit（DETACHING_REV）時算。分支名稱、`-`、建分支、帶路徑的形式放行。引號內文字不算（simpleCommands）。
 * @param {string} command Bash tool 的完整指令
 * @returns {string|null} 命中的指令摘要；未命中為 null
 */
export function detachReason(command) {
  for (const raw of simpleCommands(command)) {
    const words = [];
    for (let i = 0; i < raw.length; i++) {
      if (!REDIRECT_WORD.test(raw[i])) words.push(raw[i]);
      else if (/[<>]$/.test(raw[i])) i++;
    }
    let at = 0;
    while (at < words.length && (LEADING_WORD.test(words[at]) || /^\w+=/.test(words[at]))) at++;
    if (!/^(?:\S*\/)?git$/.test(words[at] ?? '')) continue;
    at++;
    while (at < words.length && words[at].startsWith('-')) at += GIT_GLOBAL_WITH_ARG.has(words[at]) ? 2 : 1;
    const [sub, ...rest] = words.slice(at);
    if (sub === 'switch' && rest.some(arg => arg === '--detach' || arg === '-d')) return `git switch ${rest.includes('-d') ? '-d' : '--detach'}`;
    if (sub !== 'checkout') continue;
    if (rest.includes('--detach')) return 'git checkout --detach';
    if (rest.some(arg => ['-b', '-B', '--orphan'].includes(arg) || arg.startsWith('--pathspec-from-file'))) continue;
    const dash = rest.indexOf('--');
    const before = (dash < 0 ? rest : rest.slice(0, dash)).filter(arg => !arg.startsWith('-'));
    const after = dash < 0 ? [] : rest.slice(dash + 1);
    if (before.length !== 1 || after.length) continue;
    if (DETACHING_REV.test(before[0])) return `git checkout ${before[0]}${dash < 0 ? '' : ' --'}`;
  }
  return null;
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
    process.stderr.write(message + (writesFile(command) ? '本指令中的寫檔也未執行；寫檔另開一個呼叫。\n' : '') + chainedNote(command));
    process.exit(2);
  };
  const reason = bypassReason(command);
  if (reason) {
    deny(`拒絕：指令以 ${reason} 繞過 git hook。整合分支 guard 與 push gate 都在 hook 內；照常執行 git，讓 hook 跑完。hook 失敗時修正原因或回報使用者。\n`);
  }
  if (wideGrepReason(command)) {
    const excerpt = existsSync(join(process.env.CLAUDE_PROJECT_DIR || '.', 'scripts', 'doc-excerpt.mjs'));
    deny('拒絕：grep -o 的 pattern 前後都有 `.{0,n}`，Claude Code 的 grep（ugrep）會報 `exceeds complexity limits`、exit 2。'
      + (excerpt ? "改用 `node scripts/doc-excerpt.mjs '<詞>' <檔案>…`（前後各取 60 字，`--width <n>` 調整）。\n"
        : '改用 Python 讀檔，以 `re.finditer` 取比對處前後的字。\n'));
  }
  const detach = detachReason(command);
  if (detach) {
    deny(`拒絕：\`${detach}\` 會讓 HEAD 離開分支（detached HEAD），之後的 commit 不在任務分支上。只要讀舊版內容用 \`git show <rev>:<path>\``
      + '（整棵樹用 `git archive <rev> | tar -x -C <暫存目錄>`）；要把檔案還原成舊版用 `git checkout <rev> -- <path>`（帶路徑，HEAD 不動）。'
      + '暫存 clone 用 `git switch -c <tmp> <rev>`。\n');
  }
  if (selfMatchLoopReason(command)) {
    deny('拒絕：while／until 迴圈裡的 `pgrep -f` 會比對到執行這個迴圈的 shell 本身（它的命令列含同一段 pattern），迴圈永遠不會結束。'
      + '等自己啟動的長指令：改用 Bash tool 的 run_in_background: true，等完成通知；等既有程序：先取 pid，改用 `while kill -0 <pid> 2>/dev/null; do sleep 30; done`。\n');
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
    deny(`拒絕：${spec} 的輸出以 ${filter} 過濾。這個輸出要整份讀：底下的縮排明細行會被濾掉，下一輪誤判為沒變。拿掉管線，把這個指令單獨放在一個 Bash 呼叫執行（不與其他讀檔或指令以 \`;\`／\`&&\` 串接，前面可有 \`cd\`；可能較久時設較長 timeout）。\n`);
  }
  const gate = exitGateReason(command, values(args, '--exit-gate'));
  if (gate) {
    deny(`拒絕：${gate.script} 接 ${gate.filter}，回報的 exit code 是 ${gate.filter} 的，gate 失敗也顯示成功。改成 \`<指令> > <log> 2>&1; rc=$?; tail -n 20 <log>; exit $rc\`。\n`);
  }
  const foreground = foregroundReason(command, [...values(args, '--background-only'), ...BUILTIN_BACKGROUND_ONLY], runInBackground);
  if (foreground) {
    deny(`拒絕：${foreground} 在前景執行，會把這個 session 擋到它結束（最多 600 秒），期間 worker 的結果都不會被處理。改用 Bash tool 的 run_in_background: true 執行同一指令，結束時會收到通知；要過濾輸出時先寫進 log（\`> <log> 2>&1\`），通知後再 grep／tail（背景的管線輸出有緩衝，提早讀是空的）。\n`);
  }
  if (chainedHandoff(command)) {
    deny('拒絕：pilot-handoff.mjs 與其他指令串在同一個 Bash 呼叫，前面的結果印出時已經交接，交接內容會漏掉它。先跑其他指令、讀完結果，再單獨執行 pilot-handoff.mjs（前面可以有 `cd` 或變數指派）。\n');
  }
}
