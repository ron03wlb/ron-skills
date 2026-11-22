#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本。只印 adapter 的單一條目（#344）：adapter 的條目多是單行長文，coordinator 為了一兩條就整份讀，
// 壓縮後再付一次；doc-excerpt.mjs 只給比對處前後文，切不出整條。必讀核心只留每次都用的條目，其餘搬到拆出檔、核心留一行 pointer，用這支取整條。
// 用法：node scripts/adapter-line.mjs [--root <dir>] <條目名> [<條目名>…] | --list
//   範圍：scripts/adapter-size-budget.json 列的檔（check-adapter-size.mjs 的預算表；不存在的檔略過），依預算表順序。
//   查法依序：
//   1. 條目：`- **<名稱>.**` 或 `- **<名稱>**` 的 <名稱>，大小寫須相同；縮排子行一起印。每個檔的相符條目都印（核心的 pointer 與拆出檔的本文各一條）。
//   2. 標題：沒有相符條目時，找文字相同的 Markdown 標題（`#`～`######`，程式碼區塊內不算），印到下一個同級或更高標題之前。
//   3. 前綴：仍找不到時，名稱以 <條目名> 開頭、下一字不是英數字的條目只有一種名稱（核心 pointer 與拆出檔本文同名算一種），就先印 `ADAPTER_LINE_PREFIX <條目名> → <實際名稱>`
//      再照 1 的格式印那些條目（資訊輸出；名稱含反引號時引用處可只寫前綴）；有多種名稱時算找不到，stderr 逐條列 `  candidate <檔>:<行> <實際名稱>`。
// stdout：每條前一行 `== <檔>:<行>`，再印本文。--list 每條印 `<檔> <名稱>`。
// exit：0 全部找到；1 有條目找不到（stderr `ADAPTER_LINE_NOT_FOUND <條目名>`，其他條目照印）；2 用法錯誤或沒有預算表。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUDGET_FILE = 'scripts/adapter-size-budget.json';
const ENTRY = /^- \*\*(.+?)\.?\*\*/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** 文件內容 → [{ name, line, text }]：頂層 `- **…**` 開始，縮排行併入，其他行結束。 */
export function entries(content) {
  const found = [];
  let current = null;
  content.split('\n').forEach((text, index) => {
    const head = text.match(ENTRY);
    if (head) { current = { name: head[1], line: index + 1, text }; found.push(current); return; }
    if (current && /^\s+\S/.test(text)) current.text += `\n${text}`;
    else current = null;
  });
  return found;
}

/** 文件中文字等於 title 的標題各節：[{ line, text }]，到下一個同級或更高標題之前（去掉結尾空行）。 */
export function headingSections(content, title) {
  const lines = content.split('\n');
  const found = [];
  let open = null;
  let fence = false;
  const close = end => { if (open) found.push({ line: open.line, text: lines.slice(open.line - 1, end).join('\n').trimEnd() }); open = null; };
  lines.forEach((text, index) => {
    if (FENCE.test(text)) { fence = !fence; return; }
    const match = !fence && text.match(HEADING);
    if (!match) return;
    if (open && match[1].length <= open.level) close(index);
    if (!open && match[2] === title) open = { line: index + 1, level: match[1].length };
  });
  close(lines.length);
  return found;
}

/** 預算表列的 adapter 檔中存在的：[{ file, content }]；沒有預算表時 null。 */
export function adapterFiles(root) {
  const budget = join(root, BUDGET_FILE);
  if (!existsSync(budget)) return null;
  return Object.keys(JSON.parse(readFileSync(budget, 'utf8')))
    .filter(file => existsSync(join(root, file)))
    .map(file => ({ file, content: readFileSync(join(root, file), 'utf8') }));
}

/** 名稱以 wanted 開頭、下一字不是英數字的條目；完全相符者不算。 */
export function prefixEntries(all, wanted) {
  return all.filter(({ name }) => name.length > wanted.length && name.startsWith(wanted) && !/[\p{L}\p{N}_]/u.test(name[wanted.length]));
}

/** 依查法找 wanted：{ hits: [{ file, line, text }], prefix: 實際名稱或 null, candidates: [{ file, line, name }] }。 */
export function lookup(files, wanted) {
  const all = files.flatMap(({ file, content }) => entries(content).map(entry => ({ file, ...entry })));
  let hits = all.filter(({ name }) => name === wanted);
  if (!hits.length) hits = files.flatMap(({ file, content }) => headingSections(content, wanted).map(section => ({ file, ...section })));
  if (hits.length) return { hits, prefix: null, candidates: [] };
  const prefixed = prefixEntries(all, wanted);
  if (new Set(prefixed.map(({ name }) => name)).size === 1) return { hits: prefixed, prefix: prefixed[0].name, candidates: [] };
  return { hits: [], prefix: null, candidates: prefixed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = at >= 0 ? args[at + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  if (at >= 0) args.splice(at, 2);
  if (!args.length || !root) {
    console.error('用法：node scripts/adapter-line.mjs [--root <dir>] <條目名> [<條目名>…] | --list');
    process.exit(2);
  }
  const files = adapterFiles(root);
  if (!files) { console.error(`找不到 ${join(root, BUDGET_FILE)}：adapter 檔的範圍取自它`); process.exit(2); }
  if (args[0] === '--list') {
    for (const { file, content } of files) for (const { name } of entries(content)) console.log(`${file} ${name}`);
    process.exit(0);
  }
  let missing = false;
  for (const wanted of args) {
    const { hits, prefix, candidates } = lookup(files, wanted);
    if (prefix) console.log(`ADAPTER_LINE_PREFIX ${wanted} → ${prefix}`);
    if (!hits.length) {
      console.error(`ADAPTER_LINE_NOT_FOUND ${wanted}`);
      for (const { file, line, name } of candidates) console.error(`  candidate ${file}:${line} ${name}`);
      missing = true;
    }
    for (const { file, line, text } of hits) console.log(`== ${file}:${line}\n${text}`);
  }
  process.exit(missing ? 1 : 0);
}
