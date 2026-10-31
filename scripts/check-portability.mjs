#!/usr/bin/env node
// 可攜性檢查：擋只在 Linux／GNU 能跑的寫法（macOS 是 BSD 工具與 bash 3.2），以及只差大小寫的兩個追蹤檔（macOS 預設檔案系統不分大小寫）。
// 用法：在 repo 內執行 node check-portability.mjs。掃追蹤檔與沒被忽略的新檔，違規一行一個 `<file>:<line>: <規則> <改法>` 印到 stderr，exit 1。
// 例外：在同一行寫 `portability-ok: <理由>`；沒寫理由不算例外。
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

// 規則清單只在這裡（另有 case：只差大小寫的追蹤檔）。kinds 決定套用的檔案：js、test（js 的測試檔）、shell。
const RULES = [
  { id: 'tmpdir', kinds: ['test'], pattern: /(?<![\w$])tmpdir\(\)/, hint: 'macOS 的 tmpdir() 是 symlink，測試改用 realTmpdir()' },
  { id: 'proc', kinds: ['js', 'shell'], pattern: /\/proc\//, hint: 'macOS 沒有 /proc，改用 process 或 ps 的資訊' },
  { id: 'declare-A', kinds: ['shell'], pattern: new RegExp(`${cmd('declare|typeset|local')}${OPTS}\\s+-[A-Za-z]*A`), hint: 'macOS 的 bash 3.2 沒有關聯陣列，改寫成 node' },
  // sed 的 script 常帶空白與 -i 字樣，引號內整段當一個參數。
  { id: 'sed-i', kinds: ['shell'], pattern: new RegExp(`${cmd('sed')}(?:\\s+(?:'[^']*'|"[^"]*"|[^\\s'"|;&)]+))*?\\s+(?:-[A-Za-z]*i|--in-place)(?=[\\s;&|)]|''|""|$)`),
    hint: "GNU 的 sed -i 與 BSD 的 sed -i '' 互不相容，改用 sed -i.bak 再刪 .bak" },
  { id: 'readlink-f', kinds: ['shell'], pattern: option('readlink', '-[enqsvz]*f[enqsvz]*', '--canonicalize'), hint: '改用 cd "$(dirname "$p")" && pwd -P，或 node 的 realpathSync' },
  { id: 'date-d', kinds: ['shell'], pattern: option('date', '-[uR]*d\\S*', '--date\\S*'), hint: 'BSD date 用 -j -f／-v，兩邊不通用，日期運算改寫成 node' },
  { id: 'stat-c', kinds: ['shell'], pattern: option('stat', '-L?c\\S*', '--format\\S*|--printf\\S*'), hint: 'BSD stat 用 -f，改用 wc -c、ls 或 node 的 statSync' },
  { id: 'xargs-r', kinds: ['shell'], pattern: option('xargs', '-[0ptx]*r[0ptx]*', '--no-run-if-empty'), hint: 'BSD xargs 沒有 -r，先確認輸入非空再呼叫' },
  // 只有選項、沒有 `-` 或檔案參數：BSD paste 不讀 stdin，只印 usage（#98）。-d 的值可以分開寫。
  { id: 'paste-s', kinds: ['shell'],
    pattern: new RegExp(`${cmd('paste')}(?=${OPTS}\\s+-[A-Za-z]*s)(?:\\s+(?:-[A-Za-z]*d\\s+[^\\s|;&)]+|-[^\\s\\-|;&)][^\\s|;&)]*))+\\s*(?:$|[|;&)\`"])`),
    hint: 'paste -s 要帶 - 或檔案參數，BSD paste 才會讀 stdin' },
];

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失敗：${result.stderr.trim()}`);
  return result.stdout;
}

function kindOf(path, text) {
  if (JS.has(extname(path))) return 'js';
  if (['.sh', '.bash'].includes(extname(path)) || /^#!.*\b(?:ba|z|k|da)?sh\b/.test(text)) return 'shell';
  return null;
}

/** 去掉註解，只留程式碼。 */
function code(kind, line) {
  if (kind === 'js') return /^\s*(?:\*|\/\*)/.test(line) ? '' : line.replace(/(^|\s)\/\/.*$/, '$1');
  return line.replace(/(^|\s)#.*$/, '$1');
}

const root = git(['rev-parse', '--show-toplevel']).trim();
const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
const problems = [];
let checked = 0;
for (const path of files) {
  let stat;
  try { stat = lstatSync(join(root, path)); } catch { continue; }
  if (!stat.isFile()) continue;
  const text = readFileSync(join(root, path), 'utf8');
  const kind = kindOf(path, text);
  if (!kind) continue;
  checked++;
  const kinds = kind === 'js' && /\.test\.[cm]?[jt]s$|(?:^|\/)tests?\//.test(path) ? [kind, 'test'] : [kind];
  text.split('\n').forEach((line, index) => {
    if (/portability-ok:\s*\S/.test(line)) return;
    const body = code(kind, line);
    for (const rule of RULES) {
      if (rule.kinds.some(k => kinds.includes(k)) && rule.pattern.test(body)) problems.push(`${path}:${index + 1}: ${rule.id} ${rule.hint}`);
    }
  });
}
const byLower = new Map();
for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
  const key = path.toLowerCase();
  byLower.set(key, [...(byLower.get(key) ?? []), path]);
}
for (const [first, ...rest] of [...byLower.values()].filter(paths => paths.length > 1).map(paths => paths.sort())) {
  problems.push(`${first}: case 與 ${rest.join('、')} 只差大小寫，macOS 預設的檔案系統放不下兩個`);
}
for (const problem of problems) console.error(problem);
if (problems.length) process.exitCode = 1;
else console.log(`可攜性檢查通過（${checked} 個檔案）。`);
