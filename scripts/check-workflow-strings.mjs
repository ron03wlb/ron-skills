#!/usr/bin/env node
// docs/workflow/ 是給其他專案參考的通用流程站，由 spay2 的導讀改寫而來；spay2 的專案名、內網位址與分支命名混進來就不再通用（#8，R2-Q7）。
// 掃描來源資料夾內的 Markdown 與圖的來源 JSON（不含產出的 site/），不得出現 spay（不分大小寫）、192.168.、feature/ron/#；
// 唯一白名單是 spay2 公開站網址（L3 實例的連結），比對前先移除；只移除網址本身，以它開頭的其他網域照樣擋。
// 用法：node scripts/check-workflow-strings.mjs [來源資料夾]（預設 docs/workflow）
// stdout：每個違規一行 `WORKFLOW_SPECIFIC_STRING <相對路徑>:<行號> <命中字串>`，有違規時最後一行是修正提示；exit 0 無違規、1 有違規。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? join(root, 'docs/workflow');
const ALLOWED = /https:\/\/spay2-workflow-docs\.pages\.dev(?![\w.-])/g;
const FORBIDDEN = /spay|192\.168\.|feature\/ron\/#/gi;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (path !== join(source, 'site')) yield* files(path); }
    else if (/\.(md|json)$/.test(entry.name)) yield path;
  }
}

const failures = [];
for (const file of files(source)) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const [hit] of line.replace(ALLOWED, '').matchAll(FORBIDDEN)) {
      failures.push(`WORKFLOW_SPECIFIC_STRING ${relative(source, file)}:${index + 1} ${hit}`);
    }
  });
}
for (const line of failures) console.log(line);
if (failures.length) console.log('docs/workflow/ 是通用版：改寫成不帶 spay2 專屬內容的說法；要指向 spay2 的實例只能用公開站網址。');
process.exit(failures.length ? 1 : 0);
