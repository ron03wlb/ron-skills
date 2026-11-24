#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本。在單行很長的文件裡只取比對處前後的字：docs/agents/*.md 的條目都是單行（**Probe lines.** 約 5 KB），直接 grep 會印整行。
// `grep -o '.\\{0,60\\}<詞>.\\{0,60\\}'` 在 ugrep 報 `exceeds complexity limits`、exit 2（#295，兩個 session 都踩到），所以不靠 grep 的引擎。
// 用法：node scripts/doc-excerpt.mjs <regex> <檔案或目錄>... [--width <n>]（前後各取 n 個字，預設 60）
//   目錄參數遞迴讀底下的 *.md（略過 node_modules、.git、.scratch；#586：`doc-excerpt.mjs RECORDED docs skills` 原本只印 EISDIR）；檔案參數照舊，不限副檔名。
// stdout：每個有相符的行印一行 `<檔案>:<行號>: …<前後文>…`。同一行的多處相符，前後文重疊或相鄰的併成一段，不相鄰的各段以 `…` 串接在同一行
//   （#528：一行 18 KB 的 **Probe lines.** 命中八次，原本各印一份大半重疊的前後文）。exit：0 有相符；1 沒有；2 用法錯誤或讀不到檔。
import { readFileSync, readdirSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--width');
const width = at < 0 ? 60 : Number(args[at + 1]);
if (at >= 0) args.splice(at, 2);
const [pattern, ...files] = args;
let regex;
try { regex = pattern && new RegExp(pattern, 'gu'); } catch { regex = undefined; }
if (!regex || !files.length || !Number.isInteger(width) || width < 0) {
  console.error('用法：node scripts/doc-excerpt.mjs <regex> <檔案或目錄>... [--width <n>]');
  process.exit(2);
}
const SKIP = new Set(['node_modules', '.git', '.scratch']);
const expand = path => {
  let stat;
  try { stat = statSync(path); } catch (error) { console.error(error.message); process.exit(2); }
  if (!stat.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap(entry => {
    if (SKIP.has(entry.name)) return [];
    const child = `${path.replace(/\/$/, '')}/${entry.name}`;
    if (entry.isDirectory()) return expand(child);
    return entry.name.endsWith('.md') ? [child] : [];
  });
};
let found = false;
for (const file of files.flatMap(expand)) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { console.error(error.message); process.exit(2); }
  text.split('\n').forEach((line, index) => {
    const windows = [];
    for (const match of line.matchAll(regex)) {
      if (!match[0]) continue;
      const start = Math.max(0, match.index - width);
      const end = Math.min(line.length, match.index + match[0].length + width);
      const last = windows.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else windows.push({ start, end });
    }
    if (!windows.length) return;
    found = true;
    const body = windows.map(({ start, end }) => line.slice(start, end)).join('…');
    console.log(`${file}:${index + 1}: ${windows[0].start ? '…' : ''}${body}${windows.at(-1).end < line.length ? '…' : ''}`);
  });
}
process.exit(found ? 0 : 1);
