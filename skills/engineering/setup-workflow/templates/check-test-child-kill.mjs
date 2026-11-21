#!/usr/bin/env node
// node:test 內以 spawn／fork／execFile 產生並存進變數的子行程，下一個語句必須是 t.after(() => <child>.kill())（spay2 #653）。
// assertion 失敗會跳過之後的程式，測試中段的 kill() 不會執行，子行程讓測試檔的 event loop 不結束（spay2 #279／#284：sleep 300 卡到外層逾時）。
// 無法在更上層消除：共用 spawn helper 只涵蓋改用它的測試，強制改用仍要一支 lint；`node --test --import` 預載只涵蓋經包裝的呼叫。
// 等待 close／exit 的一次性子行程（測試 await 它結束）不檢查。
// 用法：node scripts/check-test-child-kill.mjs [<目錄>…]（遞迴掃 *.test.mjs，略過 node_modules；不帶參數時掃本檔所在目錄）
// stderr：每處違規一行 `<檔案>:<行> <變數> = <呼叫>(…) …；修正：…`；stdout：通過時一行摘要。
// exit：0 通過；1 有違規；2 目錄讀不到。
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ASSIGN = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?(spawn|fork|execFile)\s*\(/g;
const OPENERS = { '(': ')', '[': ']', '{': '}' };
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;

/**
 * 把字串、樣板字串、註解與 regex literal 的內容換成空白（保留換行與長度），只留下程式碼供比對。
 * @param {string} text 原始碼
 * @returns {string}
 */
function maskNonCode(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let previous = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end;
      blank(i, stop); i = stop - 1; continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2;
      blank(i, stop); i = stop - 1; continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '/' && (previous === '' || REGEX_BEFORE.test(previous) || /\b(?:return|typeof)$/.test(text.slice(Math.max(0, i - 16), i).trimEnd())))) {
      let j = i + 1; let inClass = false;
      for (; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue; }
        if (c === '/' && text[j] === '[') inClass = true;
        else if (c === '/' && text[j] === ']') inClass = false;
        else if (text[j] === c && !inClass) break;
        else if (c !== '`' && text[j] === '\n') break;
      }
      blank(i + 1, j); i = j; previous = c; continue;
    }
    if (!/\s/.test(c)) previous = c;
  }
  return out.join('');
}

/** 從開括號 open 找到對應的關括號位置；找不到回傳 -1。 */
function closing(code, open) {
  const stack = [];
  for (let i = open; i < code.length; i++) {
    if (OPENERS[code[i]]) stack.push(OPENERS[code[i]]);
    else if (code[i] === stack.at(-1)) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}

/** 從 from 往後找到所在區塊結束（關括號比開括號多一個）的位置。 */
function blockEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (OPENERS[code[i]]) depth++;
    else if (')]}'.includes(code[i]) && --depth < 0) return i;
  }
  return code.length;
}

const escape = name => name.replaceAll('$', '\\$');
// EventEmitter 方法回傳子行程本身，鏈在 spawn(…) 後面時變數仍拿到子行程；其他鏈式呼叫（如 unref()）不回傳子行程。
const RETURNS_CHILD = /^\.\s*(?:on|once|addListener|prependListener|prependOnceListener|off|removeListener|setMaxListeners)\s*\(/;

/** [from, to) 內是否以 prefix 開頭監聽 close／exit：比對遮罩後的程式碼，再到原文確認事件名，註解與字串不算。 */
function listensForEnd(text, code, prefix, from, to) {
  const listener = new RegExp(`${prefix}\\s*\\.\\s*(?:on|once)\\s*\\(\\s*(['"])`, 'g');
  listener.lastIndex = from;
  for (let match; (match = listener.exec(code)) && match.index < to;) {
    const quote = match[1];
    if (new RegExp(`^(?:close|exit)${quote}`).test(text.slice(match.index + match[0].length))) return true;
  }
  return false;
}

/**
 * 列出存進變數的子行程沒有在下一個語句註冊 t.after kill 的位置。
 * @param {string} text 測試檔內容
 * @returns {{ line: number, name: string, call: string }[]}
 */
export function findLeaks(text) {
  const code = maskNonCode(text);
  const leaks = [];
  for (const match of code.matchAll(ASSIGN)) {
    const [, name, call] = match;
    const close = closing(code, match.index + match[0].length - 1);
    if (close < 0) continue;
    let pos = close + 1;
    let chainEnd = close + 1;
    for (;;) {
      while (/\s/.test(code[pos] ?? '')) pos++;
      const chained = RETURNS_CHILD.exec(code.slice(pos));
      if (!chained) break;
      const end = closing(code, pos + chained[0].length - 1);
      if (end < 0) break;
      pos = chainEnd = end + 1;
    }
    if (code[pos] === '.') continue; // spawn(…).unref() 之類：變數拿到的不是子行程
    const id = escape(name);
    if (listensForEnd(text, code, '(?<=\\))', close + 1, chainEnd)) continue;
    pos = chainEnd;
    while (/[ \t]/.test(code[pos] ?? '')) pos++;
    if (code[pos] === ';') pos++;
    while (/\s/.test(code[pos] ?? '')) pos++;
    const after = /^[A-Za-z_$][\w$]*\s*\.\s*after\s*\(/.exec(code.slice(pos));
    if (after) {
      const end = closing(code, pos + after[0].length - 1);
      const body = code.slice(pos, end < 0 ? code.length : end + 1);
      if (new RegExp(`(?<![\\w$.])${id}\\s*\\.\\s*kill\\s*\\(|\\bprocess\\s*\\.\\s*kill\\s*\\(\\s*${id}\\s*\\.\\s*pid\\b`).test(body)) continue;
    }
    if (listensForEnd(text, code, `(?<![\\w$.])${id}`, chainEnd, blockEnd(code, chainEnd))) continue;
    leaks.push({ line: text.slice(0, match.index + match[0].indexOf(name)).split('\n').length, name, call });
  }
  return leaks;
}

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path);
    return entry.name.endsWith('.test.mjs') ? [path] : [];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const roots = process.argv.length > 2 ? process.argv.slice(2) : [dirname(fileURLToPath(import.meta.url))];
  let files;
  try { files = roots.flatMap(testFiles); } catch (error) { console.error(`check-test-child-kill: 讀不到 ${error.path ?? roots.join(' ')}：${error.message}`); process.exit(2); }
  const problems = files.flatMap(file => findLeaks(readFileSync(file, 'utf8')).map(leak =>
    `${file}:${leak.line} ${leak.name} = ${leak.call}(…) 之後的下一個語句沒有註冊 kill；修正：緊接著加一行 t.after(() => ${leak.name}.kill());（只等它 close／exit 的一次性子行程，改成在同一區塊以 ${leak.name}.on('close', …) 等它結束）`));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`測試子行程 t.after kill 檢查通過（${files.length} 個測試檔）。`);
}
