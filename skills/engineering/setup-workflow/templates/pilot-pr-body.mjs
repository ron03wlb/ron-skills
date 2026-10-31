#!/usr/bin/env node
// Push gate 第 1 步的 PR body：從 `current: merged <sha>` 的 batch checkpoint（PILOT-STORE.md 的 `.scratch/pilot/batch-<key>.md`）產生。
// 用法：node scripts/pilot-pr-body.mjs <checkout> [--out <file>]
//   每個 merged batch 一列（依 key 排序）：key（請求 batch 附分支名稱）、staged SHA、最後一個 `regression:` 行；
//   每個 done 的 Issue 成員一行 `Closes #<n>`（依號碼）；請求分支成員（Issue 欄 `-`）只列 batch。結尾是署名。
//   staged、dispatched、pushed、closed 的 batch 不列（pushed 已在 main 上）；moved 的成員不算。
// stdout：沒有 --out 時印 body；有 --out 時寫進檔案，印 `PR_BODY <file> batches <n> closes <m>`。
//   沒有 merged batch 印 `STOP no-merged-batch`；某個 batch 最後的 regression 不是它的 staged SHA exit 0 印 `STOP regression <key>`。
// exit 0；4 STOP；用法錯誤 2。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeDir, tableCells, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-pr-body.mjs <checkout> [--out <file>]';
const SIGNATURE = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

const args = process.argv.slice(2);
const [checkout] = args;
const out = args[1] === '--out' ? args[2] : undefined;
if (!checkout || checkout.startsWith('--') || !(args.length === 1 || (args.length === 3 && out && !out.startsWith('--')))) usage(USAGE);

function stop(cause) {
  console.log(`STOP ${cause}`);
  process.exit(4);
}

/** batch checkpoint：merged 的 staged SHA（不是 merged 時為 undefined）、成員列、最後一個 regression 行的值。 */
function readBatch(text) {
  const sha = text.match(/^current:[ \t]*merged[ \t]+([0-9a-f]{7,40})\b/m)?.[1];
  const members = text.split('\n').filter(line => line.trim().startsWith('|')).map(line => tableCells(line.trim()))
    .filter(row => row.length >= 8 && /^(\d+|-)$/.test(row[0]))
    .map(([n, branch, , , , , state]) => ({ n, branch, state }));
  const regression = [...text.matchAll(/^regression:[ \t]*(.*)$/gm)].at(-1)?.[1].trim();
  return { sha, members, regression };
}

const dir = storeDir(checkout);
let files = [];
try { files = readdirSync(dir); } catch { /* 沒有存檔目錄：當作沒有 batch */ }
const batches = files.filter(name => /^batch-.+\.md$/.test(name))
  .map(name => ({ key: name.slice('batch-'.length, -'.md'.length), ...readBatch(readFileSync(join(dir, name), 'utf8')) }))
  .filter(batch => batch.sha)
  .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
if (!batches.length) stop('no-merged-batch');

const lines = [];
const closes = new Set();
for (const { key, sha, members, regression } of batches) {
  const [regSha, exit, code] = (regression ?? '').split(/\s+/);
  if (!/^[0-9a-f]{7,40}$/.test(regSha ?? '') || !(sha.startsWith(regSha) || regSha.startsWith(sha)) || exit !== 'exit' || code !== '0') stop(`regression ${key}`);
  const done = members.filter(member => member.state === 'done');
  const branches = done.filter(member => member.n === '-').map(member => member.branch);
  lines.push(`- batch ${key}${branches.length ? `（${branches.join('、')}）` : ''}：staged ${sha}，\`regression: ${regression}\``);
  for (const member of done) if (member.n !== '-') closes.add(Number(member.n));
}
const closeLines = [...closes].sort((a, b) => a - b).map(n => `Closes #${n}`);
const body = ['## Batches', '', ...lines, '', ...(closeLines.length ? [...closeLines, ''] : []), SIGNATURE, ''].join('\n');

if (out) {
  writeFileSync(out, body);
  console.log(`PR_BODY ${out} batches ${batches.length} closes ${closeLines.length}`);
} else process.stdout.write(body);
