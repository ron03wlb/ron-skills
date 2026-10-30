#!/usr/bin/env node
// Claude Code PreToolUse hook（Edit|Write|Bash）：退回會讓主 checkout 的 git status 不乾淨的修改，要求改在 worktree 進行。
// 主 checkout 的未提交改動會擋住每一次 integration 合併；事後才偵測曾兩度卡住合併，所以改在修改當下擋。
// 新檔也擋：曾有互動 session 在 pilot 執行時把未追蹤的 GLOSSARY.md 寫進主 checkout，Probe 看到改動就停止合併。
// 主 checkout 判定：目標所在 repo 的 git-dir 等於 git-common-dir（worktree 兩者不同）；gitignored 檔（如 .scratch/）與 repo 外檔案放行。
// Bash 也擋（曾有 session 在主 checkout 以 sed -i 改三支追蹤檔，Edit|Write hook 擋不到）：啟發式辨識 sed -i／perl -i、`>`／`>>` 重導向與 tee 的寫入目標，
// 依指令中的 cd 與 hook 輸入的 cwd 解析相對路徑並展開 `{a,b}`，每個目標用和 Edit|Write 同一個判斷；heredoc 內文與引號內文字不算。eval、子 shell 字串等寫法不在辨識範圍。
// 輸入不合法、git 失敗等任何無法判定的情況 exit 0 不輸出（fail-open），避免卡住正常工作。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** 目標路徑最近的既有目錄（Write 新檔時目錄可能尚未建立）。 */
function existingDir(path) {
  let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/**
 * 寫入目標檔是否會讓主 checkout 的 git status 不乾淨：主 checkout 內的追蹤檔，或未被 gitignore 的新檔。
 * @param {string} filePath 絕對路徑
 * @returns {boolean} 無法判定時為 false
 */
export function dirtiesMainCheckout(filePath) {
  const dir = existingDir(resolve(filePath));
  const dirs = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  if (dirs.status !== 0) return false;
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  if (!gitDir || gitDir !== commonDir) return false;
  if (git(dir, 'ls-files', '--error-unmatch', '--', resolve(filePath)).status === 0) return true;
  // check-ignore：0 為 gitignored、1 為未忽略，其他（git 失敗）無法判定
  return git(dir, 'check-ignore', '-q', '--no-index', '--', resolve(filePath)).status === 1;
}

/** 移除 heredoc 內文（`<<EOF` 到單獨一行 `EOF`），只留指令行。 */
function stripHeredocs(command) {
  const lines = command.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    kept.push(lines[i]);
    const delimiters = [...lines[i].matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].map(match => match[2]);
    for (const delimiter of delimiters) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== delimiter) i += 1;
      i += 1;
    }
  }
  return kept.join('\n');
}

/**
 * 依 shell 引號規則切成 token；運算子（&& || ; | & 換行）與重導向（> >> 2> &>）各自成 token。
 * @returns {Array<{word?: string, op?: string}>}
 */
function tokenize(command) {
  const tokens = [];
  let word = null;
  const flush = () => { if (word !== null) tokens.push({ word }); word = null; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'") { const end = command.indexOf("'", i + 1); if (end < 0) throw new Error('quote'); word = (word ?? '') + command.slice(i + 1, end); i = end; }
    else if (c === '"') {
      let j = i + 1; let text = '';
      for (; j < command.length && command[j] !== '"'; j += 1) { if (command[j] === '\\' && j + 1 < command.length) j += 1; text += command[j]; }
      if (j >= command.length) throw new Error('quote');
      word = (word ?? '') + text; i = j;
    } else if (c === '\\' && i + 1 < command.length) { word = (word ?? '') + command[i + 1]; i += 1; }
    else if (/\s/.test(c) && c !== '\n') flush();
    else if (c === '\n' || c === ';') { flush(); tokens.push({ op: ';' }); }
    else if (c === '&' || c === '|') {
      flush();
      if (c === '&' && command[i + 1] === '>') { tokens.push({ op: '>' }); i += command[i + 2] === '>' ? 2 : 1; continue; }
      if (command[i + 1] === c) i += 1;
      tokens.push({ op: ';' });
    } else if (c === '>') {
      if (word !== null && /^\d$/.test(word)) word = null; else flush();
      if (command[i + 1] === '>') i += 1;
      if (command[i + 1] === '&') { i += 1; continue; }
      tokens.push({ op: '>' });
    } else if (c === '<') { flush(); if (command[i + 1] === '<') i += 1; tokens.push({ op: '<' }); }
    else word = (word ?? '') + c;
  }
  flush();
  return tokens;
}

/** 展開 `pre{a,b}post`（單層、可多組）；沒有大括號時原樣。 */
function expandBraces(word) {
  const match = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(word);
  return match ? match[2].split(',').flatMap(part => expandBraces(`${match[1]}${part}${match[3]}`)) : [word];
}

/**
 * Bash 指令寫入的檔案路徑（啟發式）：sed -i／perl -i 的檔案引數、`>`／`>>` 重導向目標、tee 的檔案引數。
 * @param {string} command Bash tool 的 command
 * @param {string} cwd hook 輸入的 cwd；指令內的 `cd <dir>` 依序套用
 * @returns {string[]} 絕對路徑；無法解析時丟錯（呼叫端 fail-open）
 */
export function bashWriteTargets(command, cwd) {
  const targets = [];
  let dir = cwd;
  const tokens = tokenize(stripHeredocs(command));
  const segments = [[]];
  for (const token of tokens) {
    if (token.op === ';') segments.push([]);
    else segments.at(-1).push(token);
  }
  const absolute = path => (isAbsolute(path) ? path : resolve(dir, path));
  for (const segment of segments) {
    const words = [];
    for (let i = 0; i < segment.length; i += 1) {
      const { word, op } = segment[i];
      if (op === '>' && segment[i + 1]?.word !== undefined) { targets.push(...expandBraces(segment[i + 1].word).map(absolute)); i += 1; }
      else if (op === '<') i += 1;
      else if (word !== undefined) words.push(word);
    }
    const [name, ...args] = words;
    if (name === 'cd' && args[0]) { dir = absolute(args[0]); continue; }
    if (name === 'tee') targets.push(...args.filter(arg => !arg.startsWith('-')).flatMap(expandBraces).map(absolute));
    if ((name === 'sed' || name === 'perl') && args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) {
      const files = [];
      let scriptSeen = args.some(arg => arg === '-e' || arg === '-f' || /^-[a-zA-Z]*e$/.test(arg));
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-e' || arg === '-f' || /^-[a-zA-Z]*e$/.test(arg)) { i += 1; continue; }
        if (arg.startsWith('-')) continue;
        if (!scriptSeen) { scriptSeen = true; continue; }
        files.push(arg);
      }
      targets.push(...files.flatMap(expandBraces).map(absolute));
    }
  }
  return targets.filter(path => path !== '/dev/null');
}

/** 主 checkout 防護訊息。 */
function deny(paths) {
  process.stderr.write(`主 checkout 防護：${paths.join('、')} 在主 checkout 內且未被 gitignore，未提交的修改或新檔會擋住 integration 合併。`
    + '請改在該任務的 worktree 修改後合併（沒有 worktree 時用 `node scripts/orca-worktree-create.mjs --name <name> --base-branch <integration>` 開一個）；確需在主 checkout 修改時交由使用者手動處理。\n');
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const command = input?.tool_input?.command;
  if (typeof command === 'string' && command) {
    let paths = [];
    try { paths = bashWriteTargets(command, typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()); } catch { process.exit(0); }
    const dirty = [...new Set(paths)].filter(dirtiesMainCheckout);
    if (dirty.length) deny(dirty);
    process.exit(0);
  }
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) process.exit(0);
  if (dirtiesMainCheckout(filePath)) deny([filePath]);
}
