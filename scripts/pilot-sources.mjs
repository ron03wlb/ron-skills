#!/usr/bin/env node
// pilot 的來源檢查：coordinator 的規則檔（AGENTS.md、adapter、skill）改了就要重讀。記錄每個來源的 sha256，回報哪些變了。
// 來源清單由 adapter 的 Pilot 段指定，以參數傳入，script 不寫死；記錄在 `.scratch/pilot/sources`，
// 每個來源的內容快照存在 `.scratch/pilot/source-snapshots/<sha256>`（PILOT-STORE.md），repo 外的來源一樣存。
// 用法：node scripts/pilot-sources.mjs <checkout> [--record] <source>...
//   source 是相對 checkout 的路徑或絕對路徑（checkout 裡的絕對路徑記成相對路徑）。
// stdout：與記錄不同的來源每個一行 `SOURCE_CHANGED <source>`（沒有記錄也算），不存在的 `SOURCE_MISSING <source>`（記錄時已不存在的不再印）；
//   有舊快照時 `SOURCE_CHANGED` 下面每個改動的單位縮排一行（依新版出現的順序，刪掉的接在後面）：
//   `  entry <名稱>`（`- **<名稱>.**` 條目，含它縮排的續行）｜`  heading <標題>`（`##` 以下標題本身，或它底下條目以外的內容）｜
//   `  outside`（第一個 `##` 標題之前、條目以外的內容）；沒有舊快照（第一次記錄或舊格式記錄）時只印 `SOURCE_CHANGED`。
//   新舊兩版都有、而且有一版超過 600 字的單位，下面再縮排印改動的片段（詞級 diff，git `--word-diff=plain` 的寫法），一段一行：
//   `    …<前文>[-<刪除>-]{+<新增>+}<後文>…`；片段合計超過 1500 字時改印一行 `    (diff <n> chars, reread)`，要重讀整個單位（#236、#239）。
//   --record 先照樣回報，再以這次的清單整份改寫記錄與快照（不在清單裡的快照刪掉），最後印 `RECORDED <n>`。exit 0；沒給來源 exit 2。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-sources.mjs <checkout> [--record] <source>...';
const MISSING = 'missing';
const ENTRY = /^- \*\*(.+?)\.\*\*/;
const HEADING = /^#{2,6}\s+(.*?)\s*$/;

/** 把文字切成單位：Map<`entry <名稱>`|`heading <標題>`|`outside`, 內容>；空行不算內容，同名的單位合在一起。 */
function units(text) {
  const out = new Map();
  let heading = null;
  let entry = null;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // code fence 裡的行（含 `## `、`- **x.**`）只是內容，算在 fence 所在的單位。
    const fence = /^\s*(```|~~~)/.test(line);
    const title = fenced || fence ? undefined : line.match(HEADING)?.[1];
    const name = fenced || fence ? undefined : line.match(ENTRY)?.[1];
    if (title !== undefined) {
      heading = title;
      entry = null;
    } else if (name) entry = name;
    else if (!fenced && !fence && !/^\s/.test(line)) entry = null;
    if (fence) fenced = !fenced;
    const key = entry ? `entry ${entry}` : heading !== null ? `heading ${heading}` : 'outside';
    out.set(key, out.has(key) ? `${out.get(key)}\n${line}` : line);
  }
  return out;
}

const LONG_UNIT = 600;
const SNIPPET_LIMIT = 1500;
const CONTEXT = 20;
const MAX_CELLS = 4e6;

/** 詞級 diff 的單位：英數字串、空白串，或其他單一字元（中文一字一詞）。 */
const tokens = text => text.match(/[A-Za-z0-9_.\/-]+|\s+|[^]/gu) ?? [];

/**
 * 兩段文字的詞級改動，回傳 `…<前文>[-<刪除>-]{+<新增>+}<後文>…` 片段；
 * 改動之間相隔不到 3 個詞就併成一段；比對太大或片段合計超過上限時回傳 null（要重讀整個單位）。
 */
export function wordDiff(before, after) {
  const [a, b] = [tokens(before), tokens(after)];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const [n, m] = [endA - start, endB - start];
  if (n * m > MAX_CELLS) return null;
  // LCS 表（倒著填），再順著走出 equal／delete／insert 的序列。
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[start + i] === b[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = a.slice(0, start).map(t => ['=', t]);
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[start + i] === b[start + j]) { ops.push(['=', a[start + i]]); i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push(['+', b[start + j++]]);
    else ops.push(['-', a[start + i++]]);
  }
  ops.push(...a.slice(endA).map(t => ['=', t]));
  // 找出改動的區段 [from, to)，相隔不到 3 個 equal 詞的併在一起。
  const hunks = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === '=') continue;
    const last = hunks.at(-1);
    let to = k + 1;
    while (to < ops.length && ops[to][0] !== '=') to++;
    if (last && k - last[1] < 3) last[1] = to; else hunks.push([k, to]);
    k = to - 1;
  }
  const text = list => list.map(([, t]) => t).join('');
  const clip = (str, tail) => (str.length <= CONTEXT ? str : tail ? `…${str.slice(-CONTEXT)}` : `${str.slice(0, CONTEXT)}…`);
  const lines = hunks.map(([from, to]) => {
    let body = '';
    for (let k = from; k < to;) {
      const kind = ops[k][0];
      let run = '';
      while (k < to && ops[k][0] === kind) run += ops[k++][1];
      body += kind === '-' ? `[-${run}-]` : kind === '+' ? `{+${run}+}` : run;
    }
    const before = text(ops.slice(Math.max(0, from - CONTEXT), from)).replace(/\s+/g, ' ');
    const after = text(ops.slice(to, to + CONTEXT)).replace(/\s+/g, ' ');
    return `${clip(before, true)}${body.replace(/\n/g, '⏎')}${clip(after, false)}`;
  });
  return lines.join('').length > SNIPPET_LIMIT ? null : lines;
}

/** 舊版到新版改了哪些單位，依新版順序、刪掉的接在後面；長單位下面接詞級片段（已縮排）。 */
function changedSections(before, after) {
  const [old, now] = [units(before), units(after)];
  return [...new Set([...now.keys(), ...old.keys()])].filter(key => old.get(key) !== now.get(key)).flatMap(key => {
    const [was, is] = [old.get(key), now.get(key)];
    if (was === undefined || is === undefined || Math.max(was.length, is.length) <= LONG_UNIT) return [`  ${key}`];
    const snippets = wordDiff(was, is);
    const total = is.length;
    return [`  ${key}`, ...(snippets ? snippets.map(line => `    ${line}`) : [`    (diff ${total} chars, reread)`])];
  });
}

/** 比對來源與記錄，回傳結果行；record 為 true 時改寫記錄並加上 `RECORDED <n>`。 */
export function checkSources(checkout, sources, { record = false } = {}) {
  const root = resolve(checkout);
  const file = join(storeDir(root), 'sources');
  const snapshots = join(storeDir(root), 'source-snapshots');
  const recorded = new Map(existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { const [hash, ...path] = line.split('   '); return [path.join('   '), hash]; })
    : []);
  const out = [];
  const current = sources.map(source => {
    const path = resolve(root, source);
    const rel = relative(root, path);
    const name = rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : path;
    const content = existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
    const hash = content ? createHash('sha256').update(content).digest('hex') : MISSING;
    const old = recorded.get(name);
    if (hash === MISSING) { if (old !== MISSING) out.push(`SOURCE_MISSING ${name}`); } else if (old !== hash) {
      out.push(`SOURCE_CHANGED ${name}`);
      const snapshot = old && old !== MISSING ? join(snapshots, old) : null;
      if (snapshot && existsSync(snapshot)) out.push(...changedSections(readFileSync(snapshot, 'utf8'), content.toString('utf8')));
    }
    return [name, hash, content];
  });
  if (record) {
    mkdirSync(storeDir(root), { recursive: true });
    writeFileSync(file, current.map(([name, hash]) => `${hash}   ${name}\n`).join(''));
    mkdirSync(snapshots, { recursive: true });
    const keep = new Set(current.map(([, hash]) => hash));
    for (const [, hash, content] of current) if (content) writeFileSync(join(snapshots, hash), content);
    for (const name of readdirSync(snapshots)) if (!keep.has(name)) rmSync(join(snapshots, name), { force: true });
    out.push(`RECORDED ${current.length}`);
  }
  return out;
}

// 經由 symlink 執行時 argv[1] 不是真實路徑（macOS 的 /tmp），不先 realpath 就會安靜地什麼都不做，等於回報「都沒變」。
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [checkout, ...args] = process.argv.slice(2);
  const sources = args.filter(arg => arg !== '--record');
  if (!checkout || !sources.length || sources.some(arg => arg.startsWith('--'))) usage(USAGE);
  for (const line of checkSources(checkout, sources, { record: args.includes('--record') })) console.log(line);
}
