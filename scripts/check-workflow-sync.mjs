#!/usr/bin/env node
// docs/workflow/ 是給人讀的交付流程，內容轉述自下列 skill 與 adapter 範本；規範改了而沒人對照，兩邊會默默說法不一（#8，R3-Q5）。
// scripts/workflow-doc-sync.json 記錄最後一次對照時各來源的 sha256；任一來源不同（含新增、移除）就失敗。
// 用法：node scripts/check-workflow-sync.mjs [--restamp]
//   --restamp  對照並同步 docs/workflow/（或確認不需改）之後，重寫記錄
// stdout：每個未對照的來源一行 `WORKFLOW_SYNC_STALE <來源>`；exit 0 已同步、1 有未對照的來源。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = 'scripts/workflow-doc-sync.json';
const SOURCES = [
  'skills/engineering/issue-run/SKILL.md',
  'skills/engineering/issue-pilot/SKILL.md',
  'skills/engineering/retro-collect/SKILL.md',
  'skills/engineering/setup-workflow/SKILL.md',
  'skills/engineering/issue-run/ADAPTER.md',
];

const current = Object.fromEntries(SOURCES.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
if (process.argv.includes('--restamp')) {
  writeFileSync(join(root, STAMP), `${JSON.stringify({ sources: current }, null, 2)}\n`);
  console.log(`已重寫 ${STAMP}（${SOURCES.length} 個來源）。`);
  process.exit(0);
}
let recorded = {};
try { recorded = JSON.parse(readFileSync(join(root, STAMP), 'utf8')).sources ?? {}; } catch { /* 沒有記錄視為全部未對照 */ }
const stale = [...new Set([...Object.keys(recorded), ...SOURCES])].filter(path => recorded[path] !== current[path]).sort();
if (stale.length) {
  console.log(`${stale.map(path => `WORKFLOW_SYNC_STALE ${path}`).join('\n')}\n`
    + '流程規範已變更：對照 `docs/workflow/` 後執行 `--restamp`'
    + '（改了 Markdown 先跑 node scripts/build-workflow-site.mjs 重產；不需改也要 restamp：node scripts/check-workflow-sync.mjs --restamp）。');
  process.exit(1);
}
console.log('流程站與 skill 同步檢查通過。');
