#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本。adapter 檔大小預算（#344）：worker 整份讀 docs/agents/issue-run.md、coordinator 整份讀 docs/agents/pilot.md，
// 兩份是必讀核心，各 14000 bytes；只在部分情況才讀的拆出檔，以 Read 單次上限 58000 bytes 為預算。核心超過時，把只在某步驟或某情況才用到的條目
// 搬到拆出檔，核心留一行 pointer 寫明何時讀，並以 `node scripts/adapter-line.mjs <條目名>` 取整條。
// 預算表在 scripts/adapter-size-budget.json（{ 路徑: bytes }），adapter-line.mjs 也以它的檔為範圍；拆出新檔時加一行 58000。
// 用法：node scripts/check-adapter-size.mjs [--root <dir>]（預設 repo 根目錄）
// 通過：stdout 每檔一行 `<檔> <bytes>／<預算>，餘裕 <n> bytes`，最後一行 `adapter 檔大小預算檢查通過。`，exit 0；清單上不存在的檔略過。
//   餘裕低於 1024 bytes 的檔另印一行 `WARN <檔> 餘裕 <n> bytes`（在通過行之前，exit 不變；#470：下一張改這檔的單就得先刪別人的字，趁現在拆檔）。
// 超過：stderr 每檔一行 `ADAPTER_SIZE_OVER <檔> <bytes> > <預算>` 加一行拆檔提示，exit 1。沒有預算表 exit 2。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUDGET_FILE = 'scripts/adapter-size-budget.json';
export const WARN_MARGIN = 1024;

/** root 的預算表 { 路徑: bytes }；沒有預算表時 null。 */
export function budgets(root) {
  const file = join(root, BUDGET_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** 預算表上存在的檔：[{ file, bytes, budget }]，依預算表順序。 */
export function sizes(root, table) {
  return Object.entries(table).filter(([file]) => existsSync(join(root, file)))
    .map(([file, budget]) => ({ file, bytes: statSync(join(root, file)).size, budget }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const at = process.argv.indexOf('--root');
  const root = at >= 0 ? process.argv[at + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  if (!root) { console.error('用法：node scripts/check-adapter-size.mjs [--root <dir>]'); process.exit(2); }
  const table = budgets(root);
  if (!table) { console.error(`找不到 ${join(root, BUDGET_FILE)}`); process.exit(2); }
  const all = sizes(root, table);
  const over = all.filter(({ bytes, budget }) => bytes > budget);
  if (over.length) {
    console.error(over.map(({ file, bytes, budget }) => `ADAPTER_SIZE_OVER ${file} ${bytes} > ${budget}`).join('\n'));
    console.error('adapter 檔超過大小預算：把只在某步驟或某情況才用到的條目搬到拆出檔（預算表加一行 58000），核心留一行 pointer 寫明何時讀，以 `node scripts/adapter-line.mjs <條目名>` 取整條。');
    process.exit(1);
  }
  for (const { file, bytes, budget } of all) console.log(`${file} ${bytes}／${budget}，餘裕 ${budget - bytes} bytes`);
  for (const { file, bytes, budget } of all) if (budget - bytes < WARN_MARGIN) console.log(`WARN ${file} 餘裕 ${budget - bytes} bytes`);
  console.log('adapter 檔大小預算檢查通過。');
}
