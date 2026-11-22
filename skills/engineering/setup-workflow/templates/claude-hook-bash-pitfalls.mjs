#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Claude Code Bash PreToolUse hook：擋下三種 agent 反覆踩、錯誤訊息又不指向原因的 Bash 寫法（#444、#428、#479）。
// 1. heredoc 分隔字沒加引號（#444）：`cat > f.md <<EOF` 的內文 bash 與 zsh 都照命令替換處理，內文裡 Markdown 的 `` `git cherry-pick 84554ca` ``
//    會被當命令執行，輸出換進檔案、命令本身也真的跑了（retro-418.md 的內文被吃掉三段）。分隔字有任何引號（`'EOF'`、`"EOF"`、`\EOF`、`E"OF"`）內文就不展開。
//    命中：`<<WORD`／`<<-WORD`（不是 `<<<` here-string，不在引號、註解或 `$(( … ))` 裡）的分隔字沒引號，且內文含沒跳脫的反引號或 `$(`。
//    內文只有 `$VAR` 不擋（刻意展開變數很常見）。同一指令多個 heredoc 各自判斷。
// 2. `gh issue view`／`gh pr view` 帶 `--comments` 卻沒有 `--json`（#428）：非 tty 下只印 metadata 與留言，沒有 title、labels、body，
//    agent 以為看完了 Issue，其實漏了正文。指令中任一個簡單指令符合就擋（引號裡的字不算）。
// 3. `bin/check` 接管線（`bin/check 2>&1 | tail -3`，#479）：exit code 是管線最後一個指令的，`tail` 一律 0；背景跑時輸出又可能是空的，
//    結果行與 exit 都拿不到，只好整條重跑（約 20 分鐘）。命中：簡單指令（去掉 `VAR=…` 與 env／time／nice／timeout <n>／bash／sh 前綴後）
//    是 `bin/check`（或 `…/bin/check`）且後面接 `|`／`|&`，整串指令沒有 `pipefail` 也沒有 `PIPESTATUS`。`||` 不算管線。
// 命中時 exit 2，stderr 用繁體中文說明原因與改法；輸入不合法或不是 Bash 時 exit 0 不輸出。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { doubleQuoteEnd, substitutionEnd } from './lib/shell-quote.mjs';

const BREAK = new Set([' ', '\t', ';', '|', '&', '(', ')', '<', '>', '\n']);
const SEPARATORS = new Set([';', '|', '&', '(', ')', '\n']);

/** 內文會被 bash 當命令替換執行：含沒跳脫的反引號或 `$(`。 */
const substitutes = body => /`|\$\(/.test(body.replace(/\\[\s\S]/g, ''));

/** 掃描指令：每個 heredoc（分隔字、有沒有引號、內文）與每個簡單指令的字（引號已去掉）。 */
function scan(command) {
  const heredocs = [];
  const simple = [];
  let words = [];
  let word = '';
  let inWord = false;
  const pending = [];
  let target = false;
  /** 重導向的目標（`> f`、`2>&1` 的 `1`）不算指令的字。 */
  const endWord = () => { if (inWord) { if (target) target = false; else words.push(word); } word = ''; inWord = false; };
  const endCommand = (piped = false) => { endWord(); target = false; if (words.length) { if (piped) words.piped = true; simple.push(words); } words = []; };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === '\n') {
      endCommand();
      i++;
      while (pending.length) {
        const doc = pending.shift();
        const lines = [];
        while (i < command.length) {
          const next = command.indexOf('\n', i);
          const line = command.slice(i, next < 0 ? command.length : next);
          i = next < 0 ? command.length : next + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.tag) break;
          lines.push(line);
        }
        heredocs.push({ tag: doc.tag, quoted: doc.quoted, body: lines.join('\n') });
      }
      continue;
    }
    if (c === '\\') { word += command[i + 1] ?? ''; inWord = true; i += 2; continue; }
    if (c === "'") {
      let j = command.indexOf("'", i + 1);
      if (j < 0) j = command.length;
      word += command.slice(i + 1, j);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const quoted = doubleQuoteEnd(command, i);
      word += command.slice(i + 1, quoted.end);
      inWord = true;
      for (const inner of quoted.commands) {
        const sub = scan(inner);
        heredocs.push(...sub.heredocs);
        simple.push(...sub.simple);
      }
      i = quoted.end + 1;
      continue;
    }
    if (c === '#' && !inWord) {
      const next = command.indexOf('\n', i);
      i = next < 0 ? command.length : next;
      continue;
    }
    if (c === '$' && command.startsWith('$((', i)) {
      const end = substitutionEnd(command, i);
      word += command.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      const strip = command[j] === '-';
      if (strip) j++;
      while (command[j] === ' ' || command[j] === '\t') j++;
      let tag = '';
      let quoted = false;
      while (j < command.length && !BREAK.has(command[j])) {
        const d = command[j];
        if (d === '\\') { quoted = true; tag += command[j + 1] ?? ''; j += 2; }
        else if (d === "'" || d === '"') {
          quoted = true;
          let k = command.indexOf(d, j + 1);
          if (k < 0) k = command.length;
          tag += command.slice(j + 1, k);
          j = k + 1;
        } else { tag += d; j++; }
      }
      if (tag) pending.push({ tag, quoted, strip });
      i = Math.max(j, i + 2);
      continue;
    }
    // `2>&1`、`<&3`、`&>` 是重導向，`&` 不是分隔字。
    // fd 數字（`2>`）與重導向目標都不算指令的字。
    if (c === '<' || c === '>') {
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; } else endWord();
      i += command[i + 1] === '&' || command[i + 1] === '>' ? 2 : 1;
      target = true;
      continue;
    }
    if (c === '&' && command[i + 1] === '>') { endWord(); i += 2; target = true; continue; }
    if (c === '|' && command[i + 1] === '|') { endCommand(); i += 2; continue; }
    if (c === '|') { endCommand(true); i += command[i + 1] === '&' ? 2 : 1; continue; }
    if (SEPARATORS.has(c)) { endCommand(); i++; continue; }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();
  return { heredocs, simple };
}

/** 指令裡分隔字沒加引號、內文含反引號或 `$(` 的 heredoc（依出現順序）。 */
export function unquotedHeredocs(command) {
  return scan(command).heredocs.filter(doc => !doc.quoted && substitutes(doc.body));
}

/** 指令裡帶 `--comments` 卻沒有 `--json` 的 `gh issue view`／`gh pr view`（回傳該簡單指令，字以空白相接）。 */
export function ghViewCommentsWithoutJson(command) {
  return scan(command).simple.filter(words => {
    const args = words.slice(words.findIndex(w => !/^\w+=/.test(w)));
    if (args[0] !== 'gh' || !['issue', 'pr'].includes(args[1]) || args[2] !== 'view') return false;
    return args.some(w => w === '--comments' || w === '-c') && !args.some(w => w === '--json' || w.startsWith('--json='));
  }).map(words => words.join(' '));
}

const WRAPPERS = new Set(['env', 'time', 'nice', 'timeout', 'bash', 'sh', 'command', 'exec']);
/** 前綴指令帶值的選項（`timeout -k 5`、`nice -n 5`、`timeout -s TERM`、`env -u X`）：值另成一個字時一起跳過。 */
const VALUED = new Set(['-k', '-s', '-n', '-u', '--kill-after', '--signal', '--adjustment', '--unset']);

/** 去掉 `VAR=…` 與前綴指令（含選項、timeout 的時限）後，真正執行的指令字的位置。 */
function commandIndex(words) {
  let i = 0;
  while (/^\w+=/.test(words[i] ?? '')) i++;
  while (WRAPPERS.has(words[i])) {
    const wrapper = words[i++];
    while (words[i]?.startsWith('-')) i += VALUED.has(words[i]) ? 2 : 1;
    if (wrapper === 'timeout' && /^\d/.test(words[i] ?? '')) i++;
    while (/^\w+=/.test(words[i] ?? '')) i++;
  }
  return i;
}

/** 接管線、又沒有 pipefail／PIPESTATUS 的 `bin/check`（回傳該簡單指令，字以空白相接）。 */
export function checkPiped(command) {
  if (/\bpipefail\b|\bPIPESTATUS\b/.test(command)) return [];
  return scan(command).simple.filter(words => {
    if (!words.piped) return false;
    return /(?:^|\/)bin\/check$/.test(words[commandIndex(words)] ?? '');
  }).map(words => words.join(' '));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const command = input?.tool_input?.command;
  if (input?.tool_name && input.tool_name !== 'Bash') process.exit(0);
  if (typeof command !== 'string') process.exit(0);
  const heredocs = unquotedHeredocs(command);
  const views = ghViewCommentsWithoutJson(command);
  const piped = checkPiped(command);
  if (!heredocs.length && !views.length && !piped.length) process.exit(0);
  const lines = [];
  if (heredocs.length) lines.push(
    `heredoc 的分隔字沒加引號（${heredocs.map(d => `<<${d.tag}`).join('、')}），內文又含反引號或 $(：bash 會把內文裡 Markdown 的行內碼當命令替換執行，`,
    '命令真的會跑、輸出換進內文，原本的文字不見（#444）。',
    "改用 <<'EOF'（分隔字加單引號，內文原樣不展開），或用 Write 工具寫檔，再用 --body-file 之類的參數讀它。",
  );
  if (views.length) lines.push(
    `\`${views[0]}\` 帶了 --comments 卻沒有 --json：非 tty 下只印 metadata 與留言，沒有 title、labels、body，會漏看正文（#428）。`,
    '改用 `gh issue view <n> --json number,title,body,labels,comments`（pr 同理，欄位換成 pr 有的）。',
  );
  if (piped.length) lines.push(
    `\`${piped[0]}\` 接了管線：exit code 是管線最後一個指令的（tail 一律 0），背景跑時輸出還可能是空的，結果行與 exit 都拿不到（#479）。`,
    '改成 `bin/check > <log> 2>&1; echo exit=$?; tail -1 <log>`，只讀 log 的最後一行；真要接管線先 `set -o pipefail`。',
  );
  console.error(lines.join('\n'));
  process.exit(2);
}
