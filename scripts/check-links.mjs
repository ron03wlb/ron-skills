#!/usr/bin/env node
// 檢查 README.md、skills/**/*.md 與 docs/**/*.md（含 adapter 拆出去的 docs/agents/pilot-*.md，#166）的相對連結目標存在（不檢查錨點與外部 URL）。
// 用法：node scripts/check-links.mjs；有斷連結時逐條列出並 exit 1。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');

function* markdown(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // fixtures/ 是測試資料，裡面的 .md 連結指向測試情境而非 repo 檔案（#250）
    if (name === 'node_modules' || name === 'fixtures') continue;
    if (statSync(p).isDirectory()) yield* markdown(p);
    else if (name.endsWith('.md')) yield p;
  }
}

const broken = [];
for (const file of [join(root, 'README.md'), ...markdown(join(root, 'skills')), ...markdown(join(root, 'docs'))]) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, target] of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    if (!existsSync(resolve(dirname(file), decodeURI(target)))) broken.push(`${file.slice(root.length + 1)} → ${target}`);
  }
}
for (const line of broken) console.log(`BROKEN ${line}`);
console.log(broken.length ? `連結檢查失敗：${broken.length} 個` : '連結檢查通過');
process.exit(broken.length ? 1 : 0);
