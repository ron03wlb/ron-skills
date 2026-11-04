#!/usr/bin/env node
// setup-workflow 正本。在單行很長的文件裡只取比對處前後的字：docs/agents/*.md 的條目都是單行（**Probe lines.** 約 5 KB），直接 grep 會印整行。
// `grep -o '.\\{0,60\\}<詞>.\\{0,60\\}'` 在 ugrep 報 `exceeds complexity limits`、exit 2（#295，兩個 session 都踩到），所以不靠 grep 的引擎。
// 用法：node scripts/doc-excerpt.mjs <regex> <檔案>... [--width <n>]（前後各取 n 個字，預設 60）
// stdout：每處一行 `<檔案>:<行號>: …<前後文>…`。exit：0 有相符；1 沒有；2 用法錯誤或讀不到檔。
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--width');
const width = at < 0 ? 60 : Number(args[at + 1]);
if (at >= 0) args.splice(at, 2);
const [pattern, ...files] = args;
let regex;
try { regex = pattern && new RegExp(pattern, 'gu'); } catch { regex = undefined; }
if (!regex || !files.length || !Number.isInteger(width) || width < 0) {
  console.error('用法：node scripts/doc-excerpt.mjs <regex> <檔案>... [--width <n>]');
  process.exit(2);
}
let found = false;
for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { console.error(error.message); process.exit(2); }
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(regex)) {
      if (!match[0]) continue;
      found = true;
      const start = Math.max(0, match.index - width);
      const end = Math.min(line.length, match.index + match[0].length + width);
      console.log(`${file}:${index + 1}: ${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`);
    }
  });
}
process.exit(found ? 0 : 1);
