#!/usr/bin/env node
// Claude Code PreToolUse hook（Edit|Write|Bash）：退回會讓主 checkout 的 git status 不乾淨的修改，要求改在 worktree 進行。
// 主 checkout 的未提交改動會擋住每一次 integration 合併；事後才偵測曾兩度卡住合併，所以改在修改當下擋。
// 新檔也擋：曾有互動 session 在 pilot 執行時把未追蹤的 GLOSSARY.md 寫進主 checkout，Probe 看到改動就停止合併。
// 主 checkout 判定：目標所在 repo 的 git-dir 等於 git-common-dir（worktree 兩者不同）；gitignored 檔（如 .scratch/）與 repo 外檔案放行。
// 只管本專案：有 CLAUDE_PROJECT_DIR 時，目標 repo 的 git-common-dir 和它的不同就放行（曾擋下 ~/.claude 這個 repo 裡的 settings.json，retro 2026-10-30）；
// CLAUDE_PROJECT_DIR 取不到 git-common-dir 時照舊，任何主 checkout 都擋。
// Bash 也擋（曾有 session 在主 checkout 以 sed -i 改三支追蹤檔，Edit|Write hook 擋不到）：啟發式辨識 sed -i／perl -i、`>`／`>>` 重導向與 tee 的寫入目標，
// 依指令中的 cd 與 hook 輸入的 cwd 解析相對路徑並展開 `{a,b}`，每個目標用和 Edit|Write 同一個判斷；heredoc 內文與引號內文字不算。eval、子 shell 字串等寫法不在辨識範圍。
// `$NAME`／`${NAME}` 先用同一條指令裡的賦值、再用 hook 的環境變數代換；解析不了的（未賦值、`$(…)`、`${X:-y}`）不算寫入目標，
// 否則 `cat > "$SP/x.md"` 會被接在 cwd 底下誤判成主 checkout 內的新檔（#71）。
// 主 checkout 切分支也擋（git switch、git checkout -b 或切到其他本機分支，切回預設分支放行）：曾有兩個 session 先後在主 checkout 開分支，
// 一方的 commit 落到另一方的分支上，送出的是沒有新 commit 的空分支（retro 2026-10-30）。
// 輸入不合法、git 失敗等任何無法判定的情況 exit 0 不輸出（fail-open），避免卡住正常工作。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
 * @param {string} [projectCommon] 本專案的 git-common-dir（見 projectCommonDir()）；給了就只管同一個 repo 的主 checkout
 * @returns {boolean} 無法判定時為 false
 */
export function dirtiesMainCheckout(filePath, projectCommon) {
  const dir = existingDir(resolve(filePath));
  const dirs = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  if (dirs.status !== 0) return false;
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  if (!gitDir || gitDir !== commonDir) return false;
  if (projectCommon && projectCommon !== commonDir) return false;
  if (git(dir, 'ls-files', '--error-unmatch', '--', resolve(filePath)).status === 0) return true;
  // check-ignore：0 為 gitignored、1 為未忽略，其他（git 失敗）無法判定
  return git(dir, 'check-ignore', '-q', '--no-index', '--', resolve(filePath)).status === 1;
}

/** 本專案目錄（主 checkout 或其 worktree）的 git-common-dir；沒給或取不到時為 undefined。 */
export function projectCommonDir(projectDir) {
  if (!projectDir || !existsSync(projectDir)) return undefined;
  const dirs = git(projectDir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return dirs.status === 0 && dirs.stdout.trim() ? dirs.stdout.trim() : undefined;
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

/** 單引號或跳脫後的字面 `$`，在 token 裡先換成這個字元，和要代換的 `$` 分開。 */
const LITERAL_DOLLAR = '\u0000';
const literal = word => word.replaceAll(LITERAL_DOLLAR, '$');

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
    if (c === "'") { const end = command.indexOf("'", i + 1); if (end < 0) throw new Error('quote'); word = (word ?? '') + command.slice(i + 1, end).replaceAll('$', LITERAL_DOLLAR); i = end; }
    else if (c === '"') {
      let j = i + 1; let text = '';
      for (; j < command.length && command[j] !== '"'; j += 1) {
        if (command[j] === '\\' && j + 1 < command.length) { j += 1; text += command[j] === '$' ? LITERAL_DOLLAR : command[j]; } else text += command[j];
      }
      if (j >= command.length) throw new Error('quote');
      word = (word ?? '') + text; i = j;
    } else if (c === '\\' && i + 1 < command.length) { word = (word ?? '') + (command[i + 1] === '$' ? LITERAL_DOLLAR : command[i + 1]); i += 1; }
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
    else if (c === '~' && (word === null || /^[A-Za-z_][A-Za-z0-9_]*=$/.test(word)) && (i + 1 === command.length || /[\s/;&|<>]/.test(command[i + 1]))) word = `${word ?? ''}\${HOME}`;
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

/** 代換 `$NAME`／`${NAME}`（`$(pwd)` 當成 `$PWD`）：先查指令內賦值（值為 null 表示賦值時就解析不了；PWD 是目前目錄），再查環境變數；有解析不了的 `$` 時回傳 null。 */
function expandVars(word, vars) {
  let unresolved = false;
  const expanded = word.replaceAll('$(pwd)', '${PWD}').replace(/\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g, (_, plain, braced) => {
    const name = plain ?? braced;
    const value = vars.has(name) ? vars.get(name) : process.env[name];
    if (typeof value !== 'string') unresolved = true;
    return value ?? '';
  });
  return unresolved || expanded.includes('$') ? null : expanded;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const DECLARE = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

/**
 * 依序走過指令的每一段（以 && || ; | 換行分隔），套用 `NAME=value`、`export／declare／readonly／local NAME=value` 與 `cd`。
 * 每段回傳指令名與引數（字面，供比對旗標）、未代換的引數與重導向目標，以及把未代換的字解析成絕對路徑的 resolvePaths()：
 * 先展開大括號、再代換變數、最後依目前目錄解析；解析不了的字略過。cd 到解析不了的目錄（如 `cd "$(git rev-parse --show-toplevel)"`）
 * 時目錄維持不變，後面的相對路徑照原本的目錄判斷，不放掉主 checkout 裡常見的寫法；`git -C` 解析不了時同理。
 * @returns {Generator<{name: string, args: string[], rawArgs: string[], redirects: string[], resolvePaths: (word: string) => string[]}>}
 */
function* walkSegments(command, cwd) {
  const vars = new Map();
  let dir = cwd;
  const segments = [[]];
  for (const token of tokenize(stripHeredocs(command))) {
    if (token.op === ';') segments.push([]);
    else segments.at(-1).push(token);
  }
  const scope = () => new Map([...vars, ['PWD', dir]]);
  const resolvePaths = word => expandBraces(word)
    .map(part => expandVars(part, scope()))
    .filter(path => path !== null)
    .map(path => resolve(dir, literal(path)));
  for (const segment of segments) {
    const words = [];
    const redirects = [];
    for (let i = 0; i < segment.length; i += 1) {
      const { word, op } = segment[i];
      if (op === '>' && segment[i + 1]?.word !== undefined) { redirects.push(segment[i + 1].word); i += 1; }
      else if (op === '<') i += 1;
      else if (word !== undefined) words.push(word);
    }
    // 開頭的 NAME=value：後面沒有指令時是 shell 變數賦值；有指令時只進那個指令的環境，不影響本段引數的代換
    let first = 0;
    while (first < words.length && ASSIGNMENT.test(words[first])) first += 1;
    const assignments = first === words.length ? words : DECLARE.has(words[0]) ? words.slice(1).filter(word => ASSIGNMENT.test(word)) : [];
    for (const word of assignments) {
      const [, name, value] = ASSIGNMENT.exec(word);
      vars.set(name, expandVars(value, scope()));
    }
    const raw = words.slice(first);
    const [name, ...args] = raw.map(literal);
    if (name === 'cd' && raw[1]) { dir = resolvePaths(raw[1])[0] ?? dir; continue; }
    yield { name, args, rawArgs: raw.slice(1), redirects, resolvePaths };
  }
}

/**
 * Bash 指令寫入的檔案路徑（啟發式）：sed -i／perl -i 的檔案引數、`>`／`>>` 重導向目標、tee 的檔案引數。
 * @param {string} command Bash tool 的 command
 * @param {string} cwd hook 輸入的 cwd；指令內的 `cd <dir>` 依序套用
 * @returns {string[]} 絕對路徑；無法解析時丟錯（呼叫端 fail-open）
 */
export function bashWriteTargets(command, cwd) {
  const targets = [];
  for (const { name, args, rawArgs, redirects, resolvePaths } of walkSegments(command, cwd)) {
    targets.push(...redirects.flatMap(resolvePaths));
    if (name === 'tee') targets.push(...rawArgs.filter((_, i) => !args[i].startsWith('-')).flatMap(resolvePaths));
    if ((name === 'sed' || name === 'perl') && args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) {
      const files = [];
      let scriptSeen = args.some(arg => arg === '-e' || arg === '-f' || /^-[a-zA-Z]*e$/.test(arg));
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-e' || arg === '-f' || /^-[a-zA-Z]*e$/.test(arg)) { i += 1; continue; }
        // BSD sed 的 `-i ''`：緊接的空字串是備份後綴，不是 sed script（#100）
        if (/^-[a-zA-Z]*i$/.test(arg) && args[i + 1] === '') { i += 1; continue; }
        if (arg.startsWith('-')) continue;
        if (!scriptSeen) { scriptSeen = true; continue; }
        files.push(rawArgs[i]);
      }
      targets.push(...files.flatMap(resolvePaths));
    }
  }
  return targets.filter(path => path !== '/dev/null');
}

/** 目錄是不是主 checkout（git-dir 等於 git-common-dir）；無法判定時為 false。 */
function isMainCheckout(dir) {
  const dirs = git(existingDir(dir), 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  if (dirs.status !== 0) return false;
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  return Boolean(gitDir) && gitDir === commonDir;
}

/** repo 的預設分支：origin/HEAD 指向的分支；沒有 origin/HEAD 時 main 與 master 都算。 */
function defaultBranches(dir) {
  const head = git(dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  return head.status === 0 ? [head.stdout.trim().replace(/^origin\//, '')] : ['main', 'master'];
}

const CREATE_FLAGS = new Set(['-c', '-C', '--create', '--force-create', '-b', '-B', '--orphan', '--detach', '-d']);

/**
 * Bash 指令在主 checkout 切換或新開分支的位置（啟發式）：git switch、git checkout -b／-B／--orphan／--detach，或 git checkout <本機分支>；
 * 切到預設分支、`git checkout -- <檔案>` 放行。
 * @param {string} command Bash tool 的 command
 * @param {string} cwd hook 輸入的 cwd；指令內的 `cd <dir>` 與 `git -C <dir>` 依序套用
 * @returns {string[]} 會被切走分支的主 checkout 目錄；無法解析時丟錯（呼叫端 fail-open）
 */
export function bashBranchSwitches(command, cwd) {
  const found = [];
  for (const { name, args, rawArgs, resolvePaths } of walkSegments(command, cwd)) {
    if (name !== 'git') continue;
    let repo = resolvePaths('.')[0];
    let i = 0;
    for (; i < args.length && args[i].startsWith('-'); i += 1) {
      if (args[i] === '-C') { repo = rawArgs[i + 1] === undefined ? undefined : resolvePaths(rawArgs[i + 1])[0] ?? repo; i += 1; }
      else if (args[i] === '-c') i += 1;
    }
    if (repo === undefined) continue;
    const [sub, ...rest] = args.slice(i);
    if (sub !== 'switch' && sub !== 'checkout') continue;
    if (sub === 'checkout' && rest.includes('--')) continue;
    if (!isMainCheckout(repo)) continue;
    const target = rest.find(arg => !arg.startsWith('-'));
    const creates = rest.some(arg => CREATE_FLAGS.has(arg));
    if (!creates && defaultBranches(repo).includes(target)) continue;
    if (sub === 'checkout' && !creates && git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}`).status !== 0) continue;
    found.push(repo);
  }
  return found;
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
  const projectCommon = projectCommonDir(process.env.CLAUDE_PROJECT_DIR);
  if (typeof command === 'string' && command) {
    let paths = [];
    try { paths = bashWriteTargets(command, typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()); } catch { process.exit(0); }
    const dirty = [...new Set(paths)].filter(path => dirtiesMainCheckout(path, projectCommon));
    if (dirty.length) deny(dirty);
    let switches = [];
    try { switches = bashBranchSwitches(command, typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()); } catch { process.exit(0); }
    if (switches.length) {
      process.stderr.write(`主 checkout 防護：不在主 checkout（${switches[0]}）切換或新開分支，它要一直停在預設分支；其他 session 同時在這裡開分支時，commit 會落到別人的分支上。`
        + '請用 `node scripts/orca-worktree-create.mjs --name <name> --base-branch <integration> --branch <branch>` 開 worktree 再 commit。\n');
      process.exit(2);
    }
    process.exit(0);
  }
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) process.exit(0);
  if (dirtiesMainCheckout(filePath, projectCommon)) deny([filePath]);
}
