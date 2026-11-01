#!/usr/bin/env node
// 本機檢查入口與遠端 CI 要跑同一個 Node 主版本：PR #43 本機 Node 24 全過、CI Node 22.19.0 卻紅（node --test 在 Node 22 非 TTY 預設 TAP reporter），合入後 main 才紅。
// 讀 setup-workflow 的 ci.mjs 釘版本的地方：.github/workflows/*.yml 的每個 `node-version:`，和 .gitlab-ci.yml 的 `image: node:<版本>`（位置取自 lib/hosts.mjs 的 CI_FILES）；
// 註解行不算。釘的版本彼此要完全相同，主版本要等於執行本腳本的 Node。
// 用法：node scripts/check-node-version.mjs [repo]（預設本腳本的上一層）
// stdout：不符時每項一行 `NODE_VERSION <說明>`，最後一行是修正提示；exit 0 一致、1 不一致或找不到釘的版本。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_FILES } from './lib/hosts.mjs';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const local = process.versions.node;

const sources = [];
const workflows = join(root, CI_FILES.github);
if (existsSync(workflows) && statSync(workflows).isDirectory()) {
  for (const name of readdirSync(workflows).filter(n => /\.ya?ml$/.test(n)).sort()) {
    sources.push({ file: `${CI_FILES.github}${name}`, pattern: /^[^#\n]*?node-version:\s*['"]?([\d.]+)/gm });
  }
}
if (existsSync(join(root, CI_FILES.gitlab))) sources.push({ file: CI_FILES.gitlab, pattern: /^[^#\n]*?\bimage:\s*['"]?node:([\d.]+)/gm });

const pins = sources.flatMap(({ file, pattern }) => [...readFileSync(join(root, file), 'utf8').matchAll(pattern)].map(([, version]) => ({ file, version })));

const problems = [];
if (pins.length === 0) problems.push(`${root} 的 ${CI_FILES.github} 與 ${CI_FILES.gitlab} 都沒有任何 node-version`);
for (const pin of pins) {
  if (pin.version !== pins[0].version) problems.push(`${pin.file} 是 ${pin.version}，${pins[0].file} 是 ${pins[0].version}`);
}
if (pins.length > 0 && pins[0].version.split('.')[0] !== local.split('.')[0]) {
  problems.push(`CI 是 ${pins[0].version}，本機是 ${local}`);
}

for (const problem of problems) console.log(`NODE_VERSION ${problem}`);
if (problems.length > 0) {
  console.log('修正：把所有 CI 檔的 Node 版本改成同一版，並用同一個主版本的 Node 跑檢查入口（nvm use）。');
  process.exit(1);
}
