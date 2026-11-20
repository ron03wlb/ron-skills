#!/usr/bin/env node
// skill script 的 main guard 要先 realpath argv[1]：skill 經 ~/.claude/skills 的 symlink 執行時，import.meta.url 已解析成實際路徑，
// process.argv[1] 卻還是 symlink 路徑，兩者永遠不等，script 什麼都不做就 exit 0（4a8c831 修 day-sessions.mjs；#329 ci.mjs 又踩一次）。
// 規則：同一行同時出現 import.meta.url 與 process.argv[1]（就是拿兩者比對的 guard），卻沒有 realpathSync(process.argv[1]) 就失敗。
// 正確寫法：if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
// 用法：node scripts/check-main-guard.mjs [<檔案>...]（沒給時掃本 repo skills/**/scripts/*.mjs，templates/ 除外：範本另有 tests/template-main-guard.test.mjs）
// stdout：每個命中一行 `CHECK_FAIL main-guard <檔案>:<行>`，最後一行是修正提示；exit 0 沒有、1 有命中。
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 回傳沒有先 realpath argv[1] 的 main guard 行號（1 起算）。 */
export function unresolvedGuards(text) {
  return text.split('\n').flatMap((line, i) =>
    line.includes('import.meta.url') && line.includes('process.argv[1]') && !/realpathSync\(\s*process\.argv\[1\]\s*\)/.test(line) ? [i + 1] : []);
}

function skillScripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'templates' || entry.name === 'node_modules' ? [] : skillScripts(path);
    return entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') && basename(dir) === 'scripts' ? [path] : [];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = process.argv.length > 2 ? process.argv.slice(2) : skillScripts(join(repo, 'skills'));
  const hits = files.flatMap(file => unresolvedGuards(readFileSync(file, 'utf8')).map(line => `${relative(process.cwd(), file) || file}:${line}`));
  for (const hit of hits) console.log(`CHECK_FAIL main-guard ${hit}`);
  if (hits.length) {
    console.log('修正：main guard 改成 `process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href`，否則經 ~/.claude/skills 的 symlink 執行時靜靜什麼都不做。');
    process.exit(1);
  }
  console.log(`main guard 檢查通過（${files.length} 支）。`);
}
