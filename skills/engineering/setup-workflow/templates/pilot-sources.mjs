#!/usr/bin/env node
// pilot 的來源檢查：coordinator 的規則檔（AGENTS.md、adapter、skill）改了就要重讀。記錄每個來源的 sha256，回報哪些變了。
// 來源清單由 adapter 的 Pilot 段指定，以參數傳入，script 不寫死；記錄在 `.scratch/pilot/sources`（PILOT-STORE.md）。
// 用法：node scripts/pilot-sources.mjs <checkout> [--record] <source>...
//   source 是相對 checkout 的路徑或絕對路徑（checkout 裡的絕對路徑記成相對路徑）。
// stdout：與記錄不同的來源每個一行 `SOURCE_CHANGED <source>`（沒有記錄也算），不存在的 `SOURCE_MISSING <source>`（記錄時已不存在的不再印）；
//   --record 先照樣回報，再以這次的清單整份改寫記錄，最後印 `RECORDED <n>`。exit 0；沒給來源 exit 2。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-sources.mjs <checkout> [--record] <source>...';
const MISSING = 'missing';

/** 比對來源與記錄，回傳結果行；record 為 true 時改寫記錄並加上 `RECORDED <n>`。 */
export function checkSources(checkout, sources, { record = false } = {}) {
  const root = resolve(checkout);
  const file = join(storeDir(root), 'sources');
  const recorded = new Map(existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { const [hash, ...path] = line.split('   '); return [path.join('   '), hash]; })
    : []);
  const out = [];
  const current = sources.map(source => {
    const path = resolve(root, source);
    const rel = relative(root, path);
    const name = rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : path;
    const hash = existsSync(path) && statSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : MISSING;
    if (hash === MISSING) { if (recorded.get(name) !== MISSING) out.push(`SOURCE_MISSING ${name}`); } else if (recorded.get(name) !== hash) out.push(`SOURCE_CHANGED ${name}`);
    return [name, hash];
  });
  if (record) {
    mkdirSync(storeDir(root), { recursive: true });
    writeFileSync(file, current.map(([name, hash]) => `${hash}   ${name}\n`).join(''));
    out.push(`RECORDED ${current.length}`);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [checkout, ...args] = process.argv.slice(2);
  const sources = args.filter(arg => arg !== '--record');
  if (!checkout || !sources.length || sources.some(arg => arg.startsWith('--'))) usage(USAGE);
  for (const line of checkSources(checkout, sources, { record: args.includes('--record') })) console.log(line);
}
