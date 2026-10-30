#!/usr/bin/env node
// pilot 決策紀錄（PILOT-STORE.md 的 `.scratch/pilot/decisions.md`）的唯一寫入者：coordinator 不手寫表格列。
// 用法：node scripts/pilot-decision.mjs <checkout> --decision <text> --reason <text> --evidence <text> --result <text> [--time <time>]
//       node scripts/pilot-decision.mjs <checkout> --repair
// stdout：附加時檔案不存在或是空的就先寫 `# Decisions` 標題與表頭，再附加一列；印 `DECISION <time>`。欄位不能含 `|` 或換行。
// --repair：把檔案整理成「標題、表頭、全部列」（補上 pilot-unbare.sh 在沒有檔案時只附加列的情形，移除表格中間的空行與重複表頭），
//   有改印 `REPAIRED`、本來就對（或檔案不存在）印 `OK`；有不是五欄表格列的行時每行印 `MALFORMED <行號> <行>`、exit 1、不改檔。
// exit：0 成功；1 MALFORMED；2 用法錯誤。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-decision.mjs <checkout> --decision <text> --reason <text> --evidence <text> --result <text> [--time <time>] | <checkout> --repair';
const HEADING = '# Decisions';
const HEADER = ['| time | decision | reason | evidence | result |', '|---|---|---|---|---|'];
// 手寫的表頭與分隔列可能多空白或寫成 `| --- |`；--repair 一律換成 HEADER。
const isHeader = line => /^\|\s*time\s*\|\s*decision\s*\|\s*reason\s*\|\s*evidence\s*\|\s*result\s*\|$/.test(line) || /^\|(?:\s*:?-+:?\s*\|){5}$/.test(line);
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const FIELDS = ['decision', 'reason', 'evidence', 'result'];

const [checkout, ...args] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const file = join(storeDir(checkout), 'decisions.md');

if (args.length === 1 && args[0] === '--repair') {
  if (!existsSync(file)) { console.log('OK'); process.exit(0); }
  const lines = readFileSync(file, 'utf8').split('\n');
  const rows = [];
  const malformed = [];
  lines.forEach((line, index) => {
    if (!line.trim() || line === HEADING || isHeader(line)) return;
    if (/^\|.*\|$/.test(line) && line.split('|').length === 7) rows.push(line);
    else malformed.push(`MALFORMED ${index + 1} ${line}`);
  });
  if (malformed.length) { console.log(malformed.join('\n')); process.exit(1); }
  const text = `${[HEADING, '', ...HEADER, ...rows].join('\n')}\n`;
  if (readFileSync(file, 'utf8') === text) console.log('OK');
  else { writeFileSync(file, text); console.log('REPAIRED'); }
  process.exit(0);
}

const values = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]?.replace(/^--/, '');
  if (!args[i]?.startsWith('--') || ![...FIELDS, 'time'].includes(name) || args[i + 1] === undefined) usage(USAGE, `不認得的參數：${args[i]}`);
  values[name] = args[i + 1];
}
values.time ??= now();
for (const name of ['time', ...FIELDS]) {
  if (!values[name]?.trim()) usage(USAGE, `缺少 --${name}`);
  if (/[|\n]/.test(values[name])) usage(USAGE, `--${name} 不能含 | 或換行`);
}
if (!TIME.test(values.time)) usage(USAGE, '--time 要是帶時差的 ISO 8601（如 2026-10-30T21:12:24+08:00）');

mkdirSync(storeDir(checkout), { recursive: true });
// 只附加不整份改寫：其他 session 或 pilot-unbare.sh 同時附加的列不會被蓋掉。
const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
const prefix = !text.trim() ? `${HEADING}\n\n${HEADER.join('\n')}\n` : text.endsWith('\n') ? '' : '\n';
if (!text.trim()) writeFileSync(file, '');
appendFileSync(file, `${prefix}| ${['time', ...FIELDS].map(name => values[name]).join(' | ')} |\n`);
console.log(`DECISION ${values.time}`);
