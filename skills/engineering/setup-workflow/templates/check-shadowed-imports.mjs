#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 區域宣告遮蔽同名 import 的靜態檢查（spay2 retro ff00a288#3）：probe 內新增 `const landingChanges = () => …`，遮蔽同檔頂層的同名 import，
// focused 測試全綠，到完整檢查才抓到。純 JS 腳本 `node --check` 不報遮蔽。
// 用法：node scripts/check-shadowed-imports.mjs [<檔案或目錄>…]（目錄遞迴掃 *.mjs，略過 node_modules 與 . 開頭目錄；不帶參數時掃本檔所在目錄）
// 規則：
//   - import 綁定名：行首 `import` 的靜態 import（預設、`{ a, b as c }` 的區域名、`* as ns`；可跨行）；`import(…)` 與 `export … from` 不產生綁定。
//   - 重新宣告：同檔出現 `const|let|var <name>`（含 `{ … }`／`[ … ]` 解構的區域名）、`function <name>`、`class <name>`。
//     ESM 頂層重複宣告 import 名是 SyntaxError，所以能解析的檔案裡每個命中都在巢狀作用域、確實遮蔽 import，不另設排除。
//   - 註解、字串、template literal 的文字部分與正規表示式字面值先遮掉（保留換行），測試 fixture 字串裡的 `const x` 不算。
//   - 不查函式參數與 catch 參數（候選只要求 const|let|var|function|class）。
//   - 明確排除（spay2 對全部 scripts 試跑 28 筆後訂定；見 excusal()）：
//     builtin：`node:` 模組的綁定（`join`／`resolve`／`test` 等通用名常被迴圈變數或區域 helper 重用）；
//     same-module-reimport：`const { x } = await import('<同一模組>')` 重新取得同一個綁定；
//     test-helper：*.test.mjs 裡 `./test/…` 測試 helper（`run`／`git` 等）被單一測試改寫成在地版本。
//     被測模組本身的 export 在測試裡遮蔽（假件）與正式碼的遮蔽仍會報。
// stdout：每個命中一行 `SHADOWED_IMPORT <檔案>:<行號> <名稱>`（路徑相對 cwd），actionable：把區域名改名（或改用 import）後重跑；全部乾淨時不印。
// exit：有命中 1、乾淨 0、檔案或目錄讀取失敗 2。
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

// `/` 前一個有意義字元是這些時視為正規表示式開頭
const BEFORE_REGEX = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const isIdentStart = code => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
const isIdent = code => isIdentStart(code) || (code >= 48 && code <= 57);
const isSpace = code => code === 32 || code === 9 || code === 10 || code === 13;

/** 原始碼 → 同長度字串：註解、字串、template 文字與正規表示式字面值換成空白（換行保留，行號不變）；template 的 `${…}` 保留為程式碼。 */
export function maskSource(source) {
  const parts = [];
  let copied = 0; // source[copied, i) 尚未輸出
  const mask = (from, to) => {
    // from..to（不含）換成空白；之前的程式碼原樣輸出
    if (from > copied) parts.push(source.slice(copied, from));
    if (to > from) parts.push(source.slice(from, to).replace(/[^\n]/g, ' '));
    copied = to;
  };
  const n = source.length;
  const stack = []; // 每層是一個 template 的 `${` 內大括號深度
  let last = ''; // 上一個有意義的程式碼字元或關鍵字
  let i = 0;
  const template = () => {
    // i 指在 template 文字開頭（反引號或 `}` 之後）
    const start = i;
    while (i < n) {
      const ch = source.charCodeAt(i);
      if (ch === 92) { i += 2; continue; }
      if (ch === 96) { mask(start, i); i += 1; last = ')'; return; }
      if (ch === 36 && source.charCodeAt(i + 1) === 123) { mask(start, i); i += 2; stack.push(0); last = '{'; return; }
      i += 1;
    }
    mask(start, Math.min(i, n));
  };
  while (i < n) {
    const ch = source.charCodeAt(i);
    const next = source.charCodeAt(i + 1);
    if (ch === 47 && next === 47) {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      mask(i, stop); i = stop;
      continue;
    }
    if (ch === 47 && next === 42) {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      mask(i, stop); i = stop;
      continue;
    }
    if (ch === 39 || ch === 34) {
      const start = i + 1;
      i = start;
      while (i < n) {
        const c = source.charCodeAt(i);
        if (c === 92) { i += 2; continue; }
        if (c === ch || c === 10) break;
        i += 1;
      }
      i = Math.min(i, n);
      mask(start, i);
      if (i < n) i += 1;
      last = ')';
      continue;
    }
    if (ch === 96) { i += 1; template(); continue; }
    if (ch === 47 && (last === '' || BEFORE_REGEX.has(last) || KEYWORDS_BEFORE_REGEX.has(last))) {
      // 正規表示式字面值
      const start = i + 1;
      i = start;
      let klass = false;
      while (i < n) {
        const c = source.charCodeAt(i);
        if (c === 92) { i += 2; continue; }
        if (c === 10) break;
        if (c === 91) klass = true;
        else if (c === 93) klass = false;
        else if (c === 47 && !klass) break;
        i += 1;
      }
      i = Math.min(i, n);
      mask(start, i);
      if (i < n && source.charCodeAt(i) === 47) i += 1;
      last = ')';
      continue;
    }
    if (stack.length && ch === 123) stack[stack.length - 1] += 1;
    if (stack.length && ch === 125) {
      if (stack[stack.length - 1] === 0) { stack.pop(); i += 1; template(); continue; }
      stack[stack.length - 1] -= 1;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdent(source.charCodeAt(j))) j += 1;
      const word = source.slice(i, j);
      i = j;
      last = KEYWORDS_BEFORE_REGEX.has(word) ? word : 'a';
      continue;
    }
    i += 1;
    if (!isSpace(ch)) last = isIdent(ch) || ch === 41 || ch === 93 || ch === 46 ? ')' : String.fromCharCode(ch);
  }
  mask(n, n);
  return parts.join('');
}

/** 遮罩後與原始原始碼 → Map<綁定名, 模組字串>（模組字串從原始碼同位置讀回，遮罩保留長度）。 */
export function importBindings(masked, source = masked) {
  const names = new Map();
  for (const match of masked.matchAll(/^import\s+([^;'"`]*?)\s*from\s*(['"])/gm)) {
    const quote = match.index + match[0].length;
    const specifier = source.slice(quote, source.indexOf(match[2], quote));
    let clause = match[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const local = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (local && /^[A-Za-z_$][\w$]*$/.test(local)) names.set(local, specifier);
      }
      clause = clause.replace(braces[0], '');
    }
    const namespace = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) { names.set(namespace[1], specifier); clause = clause.replace(namespace[0], ''); }
    const fallback = clause.replace(/,/g, ' ').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(fallback)) names.set(fallback, specifier);
  }
  return names;
}

/** 解構樣式（`{ a, b: c, ...d }`／`[a, , b = 1]`）的區域名。 */
function patternNames(pattern) {
  const names = [];
  // 去掉預設值（到下一個 , 或結尾，不處理含逗號的預設值運算式）
  const body = pattern.replace(/=[^,}\]]*/g, '');
  for (const part of body.split(/[,{}[\]]/)) {
    const local = part.trim().replace(/^\.\.\./, '').split(':').pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
  }
  return names;
}

/**
 * 遮罩後與原始原始碼 → [{ line, name, from }]：const|let|var（含解構）、function、class 宣告的名稱；
 * from 為宣告右側直接是 `[await ]import('<模組>')` 時的模組字串，否則 null。
 */
export function declarations(masked, source = masked) {
  const found = [];
  const starts = [0];
  for (let i = masked.indexOf('\n'); i >= 0; i = masked.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = index => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= index) low = mid; else high = mid - 1; }
    return low + 1;
  };
  for (const match of masked.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\}|\[[^\]]*\])/g)) {
    const target = match[1];
    const names = /^[{[]/.test(target) ? patternNames(target) : [target];
    const end = match.index + match[0].length;
    const dynamic = masked.slice(end, end + 200).match(/^\s*=\s*(?:await\s+)?import\(\s*(['"])/);
    let from = null;
    if (dynamic) { const quote = end + dynamic[0].length; from = source.slice(quote, source.indexOf(dynamic[1], quote)); }
    for (const name of names) found.push({ line: lineOf(match.index), name, from });
  }
  for (const match of masked.matchAll(/(?<![\w$.])(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    found.push({ line: lineOf(match.index), name: match[1], from: null });
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * 明確排除的合理遮蔽（先對全部 scripts 試跑後訂的規則，見 header）→ 排除理由，不排除時 null。
 * file 只用來判斷是否 *.test.mjs。
 */
export function excusal({ specifier, from }, file = '') {
  if (specifier.startsWith('node:')) return 'builtin';
  if (from === specifier) return 'same-module-reimport';
  if (/\.test\.mjs$/.test(file) && /^\.\/test\//.test(specifier)) return 'test-helper';
  return null;
}

/** 原始碼 → [{ line, name }]：遮蔽 import 且不屬明確排除的區域宣告。 */
export function shadowedImports(source, file = '') {
  const masked = maskSource(source);
  const imports = importBindings(masked, source);
  return declarations(masked, source)
    .filter(({ name, from }) => imports.has(name) && !excusal({ specifier: imports.get(name), from }, file))
    .map(({ line, name }) => ({ line, name }));
}

/** dir 下（遞迴）所有 *.mjs，略過 node_modules 與 . 開頭目錄。 */
export function scriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : scriptFiles(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  }).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const targets = process.argv.length > 2 ? process.argv.slice(2) : [dirname(fileURLToPath(import.meta.url))];
  let hits = 0;
  let failed = false;
  const unreadable = (path, error) => { console.error(`check-shadowed-imports: 讀不到 ${path}：${error.message}`); failed = true; };
  for (const target of targets) {
    let files;
    try { files = statSync(target).isDirectory() ? scriptFiles(target) : [target]; } catch (error) { unreadable(target, error); continue; }
    for (const file of files) {
      let source;
      try { source = readFileSync(file, 'utf8'); } catch (error) { unreadable(file, error); continue; }
      const shown = relative(process.cwd(), file) || file;
      for (const { line, name } of shadowedImports(source, file)) { console.log(`SHADOWED_IMPORT ${shown}:${line} ${name}`); hits += 1; }
    }
  }
  process.exit(failed ? 2 : hits ? 1 : 0);
}
