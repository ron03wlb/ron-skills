#!/usr/bin/env node
// 本機 bin/check 與 CI 要跑同一個 Node 主版本：PR #43 本機 Node 24 全過、CI Node 22.19.0 卻紅（node --test 在 Node 22 非 TTY 預設 TAP reporter），合入後 main 才紅。
// 讀 .github/workflows/*.yml 的每個 node-version：彼此要完全相同，主版本要等於執行本腳本的 Node。
// 用法：node scripts/check-node-version.mjs [workflows 資料夾]（預設 .github/workflows）
// stdout：不符時每項一行 `NODE_VERSION <說明>`，最後一行是修正提示；exit 0 一致、1 不一致或找不到 node-version。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] ?? join(root, '.github/workflows');
const local = process.versions.node;

const pins = [];
for (const name of readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort()) {
  for (const [, version] of readFileSync(join(dir, name), 'utf8').matchAll(/node-version:\s*['"]?([\d.]+)['"]?/g)) {
    pins.push({ name, version });
  }
}

const problems = [];
if (pins.length === 0) problems.push(`${dir} 沒有任何 node-version`);
for (const pin of pins) {
  if (pin.version !== pins[0].version) problems.push(`${pin.name} 是 ${pin.version}，${pins[0].name} 是 ${pins[0].version}`);
}
if (pins.length > 0 && pins[0].version.split('.')[0] !== local.split('.')[0]) {
  problems.push(`CI 是 ${pins[0].version}，本機是 ${local}`);
}

for (const problem of problems) console.log(`NODE_VERSION ${problem}`);
if (problems.length > 0) {
  console.log('修正：把所有 workflow 的 node-version 改成同一版，並用同一個主版本的 Node 跑 bin/check（nvm use）。');
  process.exit(1);
}
