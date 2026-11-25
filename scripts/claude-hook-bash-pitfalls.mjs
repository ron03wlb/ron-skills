#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Claude Code Bash PreToolUse hook：擋下五種 agent 反覆踩、錯誤訊息又不指向原因的 Bash 寫法（#444、#428、#479、#571、#636）。
// 1. heredoc 分隔字沒加引號（#444）：`cat > f.md <<EOF` 的內文 bash 與 zsh 都照命令替換處理，內文裡 Markdown 的 `` `git cherry-pick 84554ca` ``
//    會被當命令執行，輸出換進檔案、命令本身也真的跑了（retro-418.md 的內文被吃掉三段）。分隔字有任何引號（`'EOF'`、`"EOF"`、`\EOF`、`E"OF"`）內文就不展開。
//    命中：`<<WORD`／`<<-WORD`（不是 `<<<` here-string，不在引號、註解或 `$(( … ))` 裡）的分隔字沒引號，且內文含沒跳脫的反引號或 `$(`。
//    內文只有 `$VAR` 不擋（刻意展開變數很常見）。同一指令多個 heredoc 各自判斷。
// 2. `gh issue view`／`gh pr view` 帶 `--comments` 卻沒有 `--json`（#428）：非 tty 下只印 metadata 與留言，沒有 title、labels、body，
//    agent 以為看完了 Issue，其實漏了正文。指令中任一個簡單指令符合就擋（引號裡的字不算）。
// 3. `bin/check` 接管線（`bin/check 2>&1 | tail -3`，#479）：exit code 是管線最後一個指令的，`tail` 一律 0；背景跑時輸出又可能是空的，
//    結果行與 exit 都拿不到，只好整條重跑（約 20 分鐘）。命中：簡單指令（去掉 `VAR=…` 與 env／time／nice／timeout <n>／bash／sh 前綴後）
//    是 `bin/check`（或 `…/bin/check`）且後面接 `|`／`|&`，整串指令沒有 `pipefail` 也沒有 `PIPESTATUS`。`||` 不算管線。
// 4. grep 文件後把每行截短（`grep -rn "a\|b" docs/agents GLOSSARY.md | cut -c1-160`，#571）：docs/agents 的條目是單行長條目，
//    命中的詞常在截斷處之後，印出來的那行看不到它，agent 誤判沒有殘留。命中：同一條管線裡 grep（egrep／fgrep／rg）的搜尋目標
//    有文件類路徑（`docs`、`…/docs/…`、`*.md`、`GLOSSARY`，或 `--include=*.md`），後面接 `cut -c`／`cut -b`、`head -c` 或 awk 的 `substr(`。
//    `cut -d… -f…`（欄位切）、`head -n`、grep 程式碼目錄都不擋。
// 5. `git commit` 的訊息主旨以 `#` 開頭（`#395 Push gate：…`，#636）：commit-msg 的 check-commit-message.mjs（與 git 的 strip cleanup）
//    把 `#` 開頭的行當註解刪掉，內文第一行頂上來當主旨，於是報 `COMMIT_MSG_SECOND_LINE`、提示加空行，指錯方向；
//    而且要等 pre-commit 跑完檢查子集才擋。這裡在 commit 之前就擋。命中：簡單指令（去掉 `VAR=…` 與前綴、git 的 `-C`／`-c` 等全域選項後）
//    是 `git commit`，訊息第一個非空行以 `#` 開頭：`-m`／`--message` 的值（含 `"$(cat <<'EOF' … EOF)"`）、`-F -` 時該指令的 heredoc、
//    `-F <檔>` 時讀該檔（相對路徑依 hook 輸入的 cwd 與 `git -C`；讀不到就放行）。只看主旨，內文行以 `#` 開頭不擋。
// 命中時 exit 2，stderr 用繁體中文說明原因與改法；輸入不合法或不是 Bash 時 exit 0 不輸出。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        doc.body = lines.join('\n');
        heredocs.push(doc);
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
      // heredoc 也記在所屬的簡單指令上（`git commit -F -` 要讀它的內文）；內文讀到換行之後才填。
      if (tag) { const doc = { tag, quoted, strip, body: '' }; pending.push(doc); (words.heredocs ??= []).push(doc); }
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

const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
/** grep／rg 帶值、值另成一個字的選項（`-e PAT`、`-A 3`、`--include '*.md'`）。 */
const GREP_VALUED = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-g', '-t', '-T', '--regexp', '--file', '--max-count',
  '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--glob', '--type']);
const DOC_PATH = /(?:^|\/)docs(?:\/|$)|\.md$|(?:^|\/)GLOSSARY/;

/** grep 的搜尋目標（或 `--include` glob）有文件類路徑。 */
function grepsDocs(args) {
  let pattern = false;
  for (let i = 1; i < args.length; i++) {
    const w = args[i];
    if (w === '--') return args.slice(i + (pattern ? 1 : 2)).some(a => DOC_PATH.test(a));
    if (/^--(?:include|glob)=/.test(w)) { if (/\.md\b/.test(w)) return true; continue; }
    if (w === '--include' || w === '--glob' || w === '-g') { if (/\.md\b/.test(args[i + 1] ?? '')) return true; i++; continue; }
    if (GREP_VALUED.has(w)) { if (w === '-e' || w === '-f' || w === '--regexp' || w === '--file') pattern = true; i++; continue; }
    if (/^-[ef]./.test(w) || /^--(?:regexp|file)=/.test(w)) { pattern = true; continue; }
    if (w.startsWith('-') && w !== '-') continue;
    if (!pattern) { pattern = true; continue; }
    if (DOC_PATH.test(w)) return true;
  }
  return false;
}

/** 把每行截短的指令：`cut -c`／`cut -b`、`head -c`、awk 程式裡有 `substr(`。 */
function truncates(args) {
  if (args[0] === 'cut') return args.some(w => /^-[cb]/.test(w) || /^--(?:characters|bytes)\b/.test(w));
  if (args[0] === 'head') return args.some(w => /^-c/.test(w) || /^--bytes\b/.test(w));
  if (/^[gm]?awk$/.test(args[0] ?? '')) return args.slice(1).some(w => /\bsubstr\s*\(/.test(w));
  return false;
}

/** 同一條管線裡 grep 文件、後面又把每行截短（回傳 grep 那個簡單指令，字以空白相接）。 */
export function truncatedDocGrep(command) {
  const { simple } = scan(command);
  const hits = [];
  for (let start = 0; start < simple.length;) {
    let end = start;
    while (simple[end].piped && end + 1 < simple.length) end++;
    const pipeline = simple.slice(start, end + 1).map(words => words.slice(commandIndex(words)));
    pipeline.forEach((args, k) => {
      if (GREPS.has(args[0]) && grepsDocs(args) && pipeline.slice(k + 1).some(truncates)) hits.push(args.join(' '));
    });
    start = end + 1;
  }
  return hits;
}

/** git 帶值、值另成一個字的全域選項（`git -C dir commit`）。 */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
/** git commit 帶值的短選項：m、F 是訊息，c、C、t 取別的來源，值都可以黏著寫（`-qm msg`、`-Ffile`）。 */
const COMMIT_SHORT_VALUED = new Set(['m', 'F', 'c', 'C', 't']);
const COMMIT_LONG_VALUED = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date',
  '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file']);

/** `"$(cat <<'EOF' … EOF)"` 形狀的 -m 值 → heredoc 內文；其他含命令替換的值無從得知，回傳 undefined。 */
function messageValue(value) {
  if (!/`|\$\(/.test(value)) return value;
  const match = /^\$\(\s*cat\s+<<-?\s*(['"]?)([\w-]+)\1\s*\n([\s\S]*?)\n\s*\2\s*\n?\s*\)\s*$/.exec(value);
  return match ? match[3] : undefined;
}

/** 訊息的第一個非空行（git 會去掉開頭空行）。 */
const subjectOf = message => String(message).split('\n').find(line => line.trim() !== '') ?? '';

/**
 * 主旨以 `#` 開頭的 `git commit`（回傳 { command, subject }，command 為該簡單指令、字以空白相接）。
 * @param {string} command
 * @param {{cwd?: string, readFile?: (path: string) => string}} [options] `-F <檔>` 的相對路徑依 cwd 解析；讀不到就放行
 */
export function hashSubjectCommits(command, { cwd = process.cwd(), readFile = path => readFileSync(path, 'utf8') } = {}) {
  const hits = [];
  for (const words of scan(command).simple) {
    let i = commandIndex(words);
    if (words[i] !== 'git') continue;
    let dir = cwd;
    for (i++; i < words.length && words[i].startsWith('-'); i++) {
      if (words[i] === '-C') dir = resolve(dir, words[i + 1] ?? '');
      if (GIT_VALUED.has(words[i])) i++;
    }
    if (words[i] !== 'commit') continue;
    /** 第一個訊息來源：{ kind: 'm', value } 或 { kind: 'F', value } */
    let source;
    for (i++; i < words.length && !source; i++) {
      const w = words[i];
      if (w === '--') break;
      const long = /^(--[\w-]+)(?:=([\s\S]*))?$/.exec(w);
      if (long) {
        const value = long[2] ?? (COMMIT_LONG_VALUED.has(long[1]) ? words[++i] : undefined);
        if (long[1] === '--message') source = { kind: 'm', value };
        else if (long[1] === '--file') source = { kind: 'F', value };
        continue;
      }
      if (!/^-[^-]/.test(w)) continue;
      for (let k = 1; k < w.length; k++) {
        if (!COMMIT_SHORT_VALUED.has(w[k])) continue;
        const value = k + 1 < w.length ? w.slice(k + 1) : words[++i];
        if (w[k] === 'm' || w[k] === 'F') source = { kind: w[k], value };
        break;
      }
    }
    if (source?.value === undefined) continue;
    let message;
    if (source.kind === 'm') message = messageValue(source.value);
    else if (source.value === '-') message = words.heredocs?.at(-1)?.body;
    else { try { message = readFile(resolve(dir, source.value)); } catch { message = undefined; } }
    if (message === undefined) continue;
    const subject = subjectOf(message);
    if (subject.startsWith('#')) hits.push({ command: words.join(' '), subject });
  }
  return hits;
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
  const truncated = truncatedDocGrep(command);
  const hashed = hashSubjectCommits(command, typeof input.cwd === 'string' ? { cwd: input.cwd } : {});
  if (!heredocs.length && !views.length && !piped.length && !truncated.length && !hashed.length) process.exit(0);
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
  if (truncated.length) lines.push(
    `\`${truncated[0]}\` 的結果接了截斷（cut -c／head -c／substr）：文件的條目是單行長條目，命中的詞可能剛好在截斷處之後被切掉，看起來像沒有殘留（#571）。`,
    "改用 `node scripts/doc-excerpt.mjs '<regex>' <檔案或目錄>...`，它以命中處為中心截取前後文。",
  );
  if (hashed.length) lines.push(
    `\`git commit\` 的訊息主旨以 # 開頭（\`${[...hashed[0].subject].slice(0, 40).join('')}\`）：commit-msg 檢查（與 git 的 strip cleanup）把 # 開頭的行當註解刪掉，`,
    '內文第一行頂上來當主旨，要等 pre-commit 跑完檢查子集才報 COMMIT_MSG_SECOND_LINE，提示的「加空行」也指錯方向（#636）。',
    '把 Issue 編號放在括號裡，例如 `Push gate（#395）：…`，主旨不要以 # 開頭。',
  );
  console.error(lines.join('\n'));
  process.exit(2);
}
