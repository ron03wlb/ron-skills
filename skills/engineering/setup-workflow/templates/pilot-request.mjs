#!/usr/bin/env node
// pilot 的 request（PILOT-STORE.md 的 `.scratch/pilot/requests.md`）：列出還開著的，或把一項標成 applied／declined，coordinator 不手寫標記。
// 用法：node scripts/pilot-request.mjs <checkout> list
//       node scripts/pilot-request.mjs <checkout> apply <行號> [--note <text>]
//       node scripts/pilot-request.mjs <checkout> decline <行號> --reason <text> [--note <text>]
// 行號是 requests.md 的行號（從 1 起，附加式檔案的行號不會變），由 list 取得。
// stdout：list 每項一行 `REQUEST <行號>   <原文>`（沒有就不輸出）；apply 在同一行附加 `   applied <time>[   <note>]`，印 `APPLIED <行號>`；
//   decline 附加 `   declined <reason>[   <note>]`，印 `DECLINED <行號>`；那一行不是開著的 request 時印 `NOT_OPEN <行號>`、exit 1、不改檔。
// exit：0 成功；1 NOT_OPEN；2 用法錯誤（reason、note 不能含三個連續空白、換行或 source 字樣）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isField, isOpenRequest, now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-request.mjs <checkout> list | apply <行號> [--note <text>] | decline <行號> --reason <text> [--note <text>]';
const [checkout, command, lineArg, ...rest] = process.argv.slice(2);
if (!checkout) usage(USAGE);
const file = join(storeDir(checkout), 'requests.md');
const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];

if (command === 'list' && lineArg === undefined) {
  lines.forEach((line, index) => { if (isOpenRequest(line)) console.log(`REQUEST ${index + 1}   ${line}`); });
  process.exit(0);
}
if (!['apply', 'decline'].includes(command) || !/^[1-9]\d*$/.test(lineArg ?? '')) usage(USAGE);
const options = {};
for (let i = 0; i < rest.length; i += 2) {
  const name = rest[i]?.replace(/^--/, '');
  if (!['note', ...(command === 'decline' ? ['reason'] : [])].includes(name) || !rest[i].startsWith('--') || !isField(rest[i + 1])) usage(USAGE, `參數錯誤：${rest[i]}`);
  // 標記後面再出現 source 欄，reader 只看它之後的字，這一行就又變回開著。
  if (/(?:^|\s)source(?:\s|$)/.test(rest[i + 1])) usage(USAGE, `--${name} 不能含 source 字樣`);
  options[name] = rest[i + 1];
}
if (command === 'decline' && !options.reason) usage(USAGE, '缺少 --reason');

const index = Number(lineArg) - 1;
if (!isOpenRequest(lines[index] ?? '')) { console.log(`NOT_OPEN ${lineArg}`); process.exit(1); }
const mark = command === 'apply' ? `applied ${now()}` : `declined ${options.reason}`;
lines[index] = [lines[index].trimEnd(), mark, ...(options.note ? [options.note] : [])].join('   ');
writeFileSync(file, lines.join('\n'));
console.log(`${command === 'apply' ? 'APPLIED' : 'DECLINED'} ${lineArg}`);
