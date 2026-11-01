#!/usr/bin/env node
// 可攜性檢查：擋只在 Linux／GNU 能跑的寫法（macOS 是 BSD 工具與 bash 3.2），以及只差大小寫的兩個追蹤檔（macOS 預設檔案系統不分大小寫）。
// 用法：在 repo 內執行 node check-portability.mjs [<path>...]。掃追蹤檔與沒被忽略的新檔，違規一行一個 `<file>:<line>: <規則> <改法>` 印到 stderr，exit 1。
// 給了 <path>（相對 repo 根的檔案或目錄，照字面比對、不展開萬用字元）時只掃這些路徑，大小寫衝突也只比這些路徑裡的追蹤檔。
// 例外：在同一行寫 `portability-ok: <理由>`；沒寫理由不算例外。
// 範圍：shell 規則只掃 shell 檔（.sh、.bash 或 sh 系 shebang），JS 字串裡組出的指令、package.json 的 scripts 與 Markdown 不掃；註解不掃。
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const JS = new Set(['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts']);

// shell 指令：前面是行首或 | ; & ( `，可帶路徑（/usr/bin/sed）；OPTS 是指令字之後、目標選項之前的其他選項。
const cmd = name => `(?<=^|[\\s|;&(\`])(?:\\S*/)?(?:${name})`;
const OPTS = '(?:\\s+-\\S+)*?';
const END = '(?=[\\s;&|)"`]|$)';
// short 列出可以和目標選項併寫的旗標（如 readlink -nf）；會帶值的選項不能列進去，-Iseconds 的 d 是值的一部分。
const option = (name, short, long) => new RegExp(`${cmd(name)}${OPTS}\\s+(?:${short}|${long})${END}`);

// 規則清單只在這裡（另有 case：只差大小寫的追蹤檔）。kinds 決定套用的檔案：js、test（js 的測試檔）、shell、bash（zsh、ksh 以外的 shell 檔）。
// quoted：比對路徑字面值的規則在 shell 檔看保留引號內容的那一行（路徑常寫在引號裡），其他規則看清掉引號內容的那一行。
const RULES = [
  { id: 'tmpdir', kinds: ['test'], pattern: /(?<![\w$])tmpdir\(\s*\)/, hint: 'macOS 的 tmpdir() 是 symlink，測試改用 realTmpdir()' },
  // realTmpdir() 回傳共用的系統暫存目錄本身，不是新目錄；整個指派給變數再往裡寫，第二次跑就撞上上一次留下的檔（retro 1101c：EEXIST .scratch）。
  { id: 'realtmpdir-dir', kinds: ['test'], pattern: /=\s*realTmpdir\(\s*\)\s*(?:;|$)/, hint: "realTmpdir() 是共用的系統暫存目錄，改用 mkdtempSync(join(realTmpdir(), '<前綴>-'))" },
  { id: 'proc', kinds: ['js', 'shell'], quoted: true, pattern: /\/proc\//, hint: 'macOS 沒有 /proc，改用 process 或 ps 的資訊' },
  { id: 'declare-A', kinds: ['bash'], pattern: new RegExp(`${cmd('declare|typeset|local')}${OPTS}\\s+-[A-Za-z]*A`), hint: 'macOS 的 bash 3.2 沒有關聯陣列，改寫成 node' },
  // sed 的 script 常帶空白與 -i 字樣，引號內整段當參數的一部分（--expression='…'）。
  { id: 'sed-i', kinds: ['shell'], pattern: new RegExp(`${cmd('sed')}(?:\\s+(?:'[^']*'|"[^"]*"|[^\\s'"|;&)])+)*?\\s+(?:-[A-Za-z]*i|--in-place)(?=[\\s;&|)]|''|""|$)`),
    hint: "GNU 的 sed -i 與 BSD 的 sed -i '' 互不相容，改用 sed -i.bak 再刪 .bak" },
  { id: 'readlink-f', kinds: ['shell'], pattern: option('readlink', '-[enqsvz]*f[enqsvz]*', '--canonicalize'), hint: '改用 cd "$(dirname "$p")" && pwd -P，或 node 的 realpathSync' },
  { id: 'date-d', kinds: ['shell'], pattern: option('date', '-[uR]*d\\S*', '--date\\S*'), hint: 'BSD date 用 -j -f／-v，兩邊不通用，日期運算改寫成 node' },
  { id: 'stat-c', kinds: ['shell'], pattern: option('stat', '-L?c\\S*', '--format\\S*|--printf\\S*'), hint: 'BSD stat 用 -f，改用 wc -c、ls 或 node 的 statSync' },
  { id: 'xargs-r', kinds: ['shell'], pattern: option('xargs', '-[0ptx]*r[0ptx]*', '--no-run-if-empty'), hint: 'BSD xargs 沒有 -r，先確認輸入非空再呼叫' },
  // 只有選項、沒有 `-` 或檔案參數：BSD paste 不讀 stdin，只印 usage（#98），用 < 導入也一樣。-d 的值可以分開寫。
  // 雙引號在比對前已清成 ""，所以結尾不收 "：-d "," 的值不能被當成指令結束。
  { id: 'paste-s', kinds: ['shell'],
    pattern: new RegExp(`${cmd('paste')}(?=${OPTS}\\s+-[A-Za-z]*s)(?:\\s+(?:-[A-Za-z]*d\\s+[^\\s|;&)]+|-[^\\s\\-|;&)<>][^\\s|;&)<>]*))+\\s*(?:$|[|;&)\`<>])`),
    hint: 'paste -s 要帶 - 或檔案參數，BSD paste 才會讀 stdin' },
];

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失敗：${result.stderr.trim()}`);
  return result.stdout;
}

/** 檔案套用哪些規則的 kinds；不是 JS 或 shell 檔時是空陣列。 */
function kindsOf(path, text) {
  if (JS.has(extname(path))) return /\.test\.[cm]?[jt]s$|(?:^|\/)tests?\//.test(path) ? ['js', 'test'] : ['js'];
  if (!['.sh', '.bash'].includes(extname(path)) && !/^#!.*\b(?:ba|z|k|da)?sh\b/.test(text)) return [];
  return /^#!.*\b(?:z|k)sh\b/.test(text) ? ['shell'] : ['shell', 'bash'];
}

/** JS 的一行去掉 // 註解（引號裡的 // 不算）；區塊註解的行整行不掃。 */
function jsCode(line) {
  if (/^\s*(?:\*|\/\*)/.test(line)) return '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; }
    else if ('\'"`'.includes(c)) quote = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** shell 的一行只留指令：單引號內容清成 ''，雙引號只留 $(…) 裡的指令，引號外的 # 起是註解；keepQuoted 時只去註解、引號內容照留。 */
function shellCode(line, keepQuoted = false) {
  let out = '';
  const stack = [{ dq: false, depth: 0 }];
  for (let i = 0; i < line.length; i++) {
    const c = line[i]; const top = stack.at(-1);
    if (c === '\\') { if (keepQuoted || !top.dq) out += c + (line[i + 1] ?? ''); i++; continue; }
    if (top.dq) {
      if (c === '"') { stack.pop(); out += c; }
      else if (c === '$' && line[i + 1] === '(') { stack.push({ dq: false, depth: 0 }); out += '$('; i++; }
      else if (keepQuoted) out += c;
      continue;
    }
    if (c === "'") { const close = line.indexOf("'", i + 1); out += keepQuoted ? line.slice(i, close < 0 ? undefined : close + 1) : "''"; i = close < 0 ? line.length : close; continue; }
    if (c === '"') { stack.push({ dq: true }); out += c; continue; }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(line[i - 1]))) break;
    if (c === '(') top.depth++;
    if (c === ')' && stack.length > 1 && top.depth === 0) { stack.pop(); out += c; continue; }
    if (c === ')') top.depth--;
    out += c;
  }
  return out;
}

const root = git(['rev-parse', '--show-toplevel']).trim();
// 路徑參數在 repo 根比對；沒給時是整個 repo。
const scope = process.argv.length > 2 ? ['--', ...process.argv.slice(2)] : [];
const listed = args => git(['-C', root, '--literal-pathspecs', 'ls-files', '-z', ...args, ...scope]).split('\0').filter(Boolean);
const files = [...new Set(listed(['--cached', '--others', '--exclude-standard']))].sort();
const problems = [];
let checked = 0;
for (const path of files) {
  let stat;
  try { stat = lstatSync(join(root, path)); } catch { continue; }
  if (!stat.isFile()) continue;
  const text = readFileSync(join(root, path), 'utf8');
  const kinds = kindsOf(path, text);
  if (!kinds.length) continue;
  checked++;
  text.split('\n').forEach((line, index) => {
    if (/portability-ok:\s*\S/.test(line)) return;
    const js = kinds.includes('js');
    const body = js ? jsCode(line) : shellCode(line);
    const quoted = js ? body : shellCode(line, true);
    for (const rule of RULES) {
      if (rule.kinds.some(k => kinds.includes(k)) && rule.pattern.test(rule.quoted ? quoted : body)) problems.push(`${path}:${index + 1}: ${rule.id} ${rule.hint}`);
    }
  });
}
const byLower = new Map();
for (const path of listed([])) {
  const key = path.toLowerCase();
  byLower.set(key, [...(byLower.get(key) ?? []), path]);
}
for (const [first, ...rest] of [...byLower.values()].filter(paths => paths.length > 1).map(paths => paths.sort())) {
  problems.push(`${first}: case 與 ${rest.join('、')} 只差大小寫，macOS 預設的檔案系統放不下兩個`);
}
for (const problem of problems) console.error(problem);
if (problems.length) process.exitCode = 1;
else console.log(`可攜性檢查通過（${checked} 個檔案）。`);
