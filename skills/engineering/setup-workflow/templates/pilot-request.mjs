#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// pilot 的 request（PILOT-STORE.md 的 `.scratch/pilot/requests.md`）：其他 session 交出一項、列出還開著的，或把一項標成 applied／declined，都不手寫行格式。
// 用法：node scripts/pilot-request.mjs <checkout> add <內文> --source <session>
//       node scripts/pilot-request.mjs <checkout> list
//       node scripts/pilot-request.mjs <checkout> apply <行號> [--note <text>]
//       node scripts/pilot-request.mjs <checkout> decline <行號> --reason <text> [--note <text>]
// 行號是 requests.md 的行號（從 1 起，附加式檔案的行號不會變），由 list 取得。
// stdout：add 在檔尾附加 `<time>   <內文>   source <session>`（沒有檔就建立，檔尾沒有換行先補上），印 `ADDED <行號>`（investing#472）；
//   list 每項一行 `REQUEST <行號>   <原文>`（沒有就不輸出）；apply 在同一行附加 `   applied <time>[   <note>]`，印 `APPLIED <行號>`；
//   decline 附加 `   declined <reason>[   <note>]`，印 `DECLINED <行號>`；那一行沒有 source 欄時先補 `   source unknown`；那一行不是開著的 request 時印 `NOT_OPEN <行號>`、exit 1、不改檔。
// exit：0 成功；1 NOT_OPEN；2 用法錯誤（內文、reason、note 不能含三個連續空白、換行或 source 字樣，內文不能以 `#` 開頭（那是標題行），
//   session 也不能含 applied／declined 字樣：reader 會把那一行當成已關掉）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isField, isOpenRequest, now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-request.mjs <checkout> add <內文> --source <session> | list | apply <行號> [--note <text>] | decline <行號> --reason <text> [--note <text>]';
const [checkout, command, lineArg, ...rest] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const file = join(storeDir(checkout), 'requests.md');
const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];

const SOURCE_WORD = /(?:^|\s)source(?:\s|$)/;
if (command === 'add') {
  const [flag, source, ...extra] = rest;
  if (flag !== '--source' || extra.length || !isField(lineArg) || !isField(source)) usage(USAGE);
  if (SOURCE_WORD.test(lineArg) || lineArg.trim().startsWith('#')) usage(USAGE, '內文不能含 source 字樣，也不能以 # 開頭');
  if (/\s/.test(source.trim()) || /\b(?:applied|declined)\b/.test(source)) usage(USAGE, '--source 是一個字，不能含 applied／declined');
  mkdirSync(dirname(file), { recursive: true });
  // 寫入前重讀：其他 session 可能剛附加了一行。
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const head = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  writeFileSync(file, `${head}${now()}   ${lineArg.trim()}   source ${source.trim()}\n`);
  console.log(`ADDED ${head.split('\n').length}`);
  process.exit(0);
}
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
  if (SOURCE_WORD.test(rest[i + 1])) usage(USAGE, `--${name} 不能含 source 字樣`);
  options[name] = rest[i + 1];
}
if (command === 'decline' && !options.reason) usage(USAGE, '缺少 --reason');

const index = Number(lineArg) - 1;
if (!isOpenRequest(lines[index] ?? '')) { console.log(`NOT_OPEN ${lineArg}`); process.exit(1); }
const mark = command === 'apply' ? `applied ${now()}` : `declined ${options.reason}`;
// 標記必須改寫同一行：寫入前重讀，其他 session 在這之間附加的 request 才不會被舊內容蓋掉（附加式檔案，行號不變）。
const fresh = readFileSync(file, 'utf8').split('\n');
// 沒有 source 欄的行 reader 一律當成開著，只附加標記關不掉；先補上 `source unknown`。
const line = fresh[index].trimEnd();
fresh[index] = [line, ...(/\ssource\s/.test(line) ? [] : ['source unknown']), mark, ...(options.note ? [options.note] : [])].join('   ');
writeFileSync(file, fresh.join('\n'));
console.log(`${command === 'apply' ? 'APPLIED' : 'DECLINED'} ${lineArg}`);
