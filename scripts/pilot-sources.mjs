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

/** 把文字切成單位：Map<`entry <名稱>`|`heading <標題>`|`outside`, 內容>；空行不算內容。 */
function units(text) {
  const out = new Map();
  let heading = null;
  let entry = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const title = line.match(HEADING)?.[1];
    const name = line.match(ENTRY)?.[1];
    if (title !== undefined) { heading = title; entry = null; } else if (name) entry = name; else if (!/^\s/.test(line)) entry = null;
    const key = entry ? `entry ${entry}` : heading !== null ? `heading ${heading}` : 'outside';
    out.set(key, out.has(key) ? `${out.get(key)}\n${line}` : line);
  }
  return out;
}

/** 舊版到新版改了哪些單位，依新版順序、刪掉的接在後面。 */
function changedUnits(before, after) {
  const [old, now] = [units(before), units(after)];
  return [...new Set([...now.keys(), ...old.keys()])].filter(key => old.get(key) !== now.get(key));
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
      if (snapshot && existsSync(snapshot)) out.push(...changedUnits(readFileSync(snapshot, 'utf8'), content.toString('utf8')).map(key => `  ${key}`));
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
