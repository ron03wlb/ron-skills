#!/usr/bin/env node
// 會 spawn git 的 *.test.mjs 必須 import test/isolate-git-env.mjs（或已 import 它的 repo-fixture.mjs），
// 否則在 git hook 或帶 GIT_DIR 的環境執行時，fixture 會改到真正的 repo（retro 2026-10-16：user.name=fixture 寫進 .git/config）。
// 用法：node scripts/check-test-git-isolation.mjs <目錄>...（掃描範圍由專案傳入：寫死的目錄不存在時會 ENOENT 當掉）。
// exit：0 通過；1 有違規（stderr 列出檔案）；2 沒帶目錄或目錄不存在。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SPAWNS_GIT = /node:child_process/;
const ISOLATED = /import\s+(?:[^;]*?from\s+)?['"]\.{1,2}\/(?:[\w.-]+\/)*(?:isolate-git-env|repo-fixture)\.mjs['"]/;
const SPAWN_CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const SHELL_CALLS = new Set(['exec', 'execSync']);
// 這些字元或關鍵字之後的 `/` 是 regex 字面值起點，不是除號。
const REGEX_AFTER_CHAR = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'yield', 'await', 'void', 'delete', 'new', 'throw']);

/**
 * 把原始碼切成識別字、標點與字串 token；註解與 regex 丟掉，字串內容（含其中看似程式碼的文字）只當一個 str token。
 * template 字面值的各段另收進 scripts：測試寫給子行程執行的假指令稿都用 template（會繼承本行程 env），引號字串則多是測試資料。
 */
function tokens(text) {
  const out = [];
  const scripts = [];
  const templates = []; // 每層 `${` 進入時的大括號深度
  let depth = 0;
  let i = 0;
  const regexAllowed = () => {
    const last = out.at(-1);
    return !last || (last.kind === 'punc' && REGEX_AFTER_CHAR.has(last.value)) || (last.kind === 'id' && REGEX_AFTER_WORD.has(last.value));
  };
  // 讀一段 template 字面值到結尾反引號，或到 `${` 並轉回程式碼。
  const template = () => {
    let value = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { value += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { i++; out.push({ kind: 'str', value }); scripts.push(value); return; }
      if (c === '$' && text[i + 1] === '{') { i += 2; templates.push(depth); scripts.push(value); out.push({ kind: 'punc', value: '(' }); return; }
      value += c; i++;
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (c === '/' && regexAllowed()) {
      let inClass = false;
      for (i++; i < text.length && text[i] !== '\n'; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
      }
      i++;
      while (/\w/.test(text[i] ?? '')) i++;
      out.push({ kind: 'regex' });
      continue;
    }
    if (c === "'" || c === '"') {
      let value = '';
      for (i++; i < text.length && text[i] !== c && text[i] !== '\n'; i++) {
        if (text[i] === '\\') i++;
        value += text[i] ?? '';
      }
      i++;
      out.push({ kind: 'str', value });
      continue;
    }
    if (c === '`') { i++; template(); continue; }
    const word = /^[\w$]+/.exec(text.slice(i, i + 64));
    if (word) { out.push({ kind: 'id', value: word[0] }); i += word[0].length; continue; }
    i++;
    if (c === '{') depth++;
    if (c === '}') {
      if (templates.length && templates.at(-1) === depth) { templates.pop(); out.push({ kind: 'punc', value: ')' }); template(); continue; }
      depth--;
    }
    out.push({ kind: 'punc', value: c });
  }
  return { list: out, scripts };
}

/**
 * 程式碼或 template 指令稿是否以 git 為要執行的指令：child_process 呼叫的第一個引數是 'git'
 * （exec／execSync 為 'git …' 指令字串），或 argv 陣列字面值第一個元素是 'git'（交給包裝 spawn 的 helper，如 run(repo, ['git', …])）。
 * 引號字串與註解內文不算：#653 的 findLeaks 測試資料 "execFileSync('git', …)" 從不執行。
 */
export function spawnsGit(text) {
  const { list, scripts } = tokens(text);
  return scripts.some(spawnsGit) || list.some((token, k) => {
    const next = list[k + 1];
    const arg = list[k + 2];
    if (token.kind === 'punc' && token.value === '[') return next?.kind === 'str' && next.value === 'git';
    if (token.kind !== 'id' || next?.kind !== 'punc' || next.value !== '(' || arg?.kind !== 'str') return false;
    if (SPAWN_CALLS.has(token.value)) return arg.value === 'git';
    return SHELL_CALLS.has(token.value) && /^git(?:\s|$)/.test(arg.value);
  });
}

/** 回傳測試檔是否會 spawn git 卻沒有 import 隔離模組。 */
export function missingIsolation(text) {
  return SPAWNS_GIT.test(text) && spawnsGit(text) && !ISOLATED.test(text);
}

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? testFiles(path) : entry.name.endsWith('.test.mjs') ? [path] : [];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const roots = process.argv.slice(2);
  const missing = roots.filter(root => !existsSync(root));
  if (!roots.length || missing.length) {
    console.error(missing.length ? `目錄不存在：${missing.join(' ')}` : '用法：node scripts/check-test-git-isolation.mjs <目錄>...');
    process.exit(2);
  }
  const problems = roots.flatMap(testFiles).filter(file => missingIsolation(readFileSync(file, 'utf8')));
  if (problems.length) {
    console.error(`以下測試會 spawn git 卻沒有 import test/isolate-git-env.mjs（或 repo-fixture.mjs），請在檔首加上 import：\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('測試 git 環境隔離檢查通過。');
}
