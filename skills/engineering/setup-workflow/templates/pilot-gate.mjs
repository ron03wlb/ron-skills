#!/usr/bin/env node
// pilot 的人工 gate（PILOT-STORE.md 的 `.scratch/pilot/gates.md`）：開、解、列出 gate，coordinator 不手改檔案（手寫曾把 resolved 寫進別的欄位，probe 才有 GATE_MALFORMED）。
// 用法：node scripts/pilot-gate.mjs <checkout> open --title <text> --issue <text> --question <text> --options <text> --default <text> --parked <text>
//       node scripts/pilot-gate.mjs <checkout> resolve <G<n>> --how <text>
//       node scripts/pilot-gate.mjs <checkout> list
// stdout：open 以表格與段落中最大的 G<n> 加一為 id，附加 `## G<n> <title>` 段落（六個欄位，`- opened：<time>`），檔案不存在或是空的就先寫 `# Gates`；印 `GATE_OPENED G<n>`。
//   resolve 在該段落最後一個 `- ` 欄位之後插入 `- resolved <time> <how>`（表格列則把 status 欄換成 `resolved <time> <how>`），印 `GATE_RESOLVED G<n>`；
//   gate 已 resolved 印 `STOP G<n> resolved`、找不到印 `STOP G<n> missing`，都不改檔。
//   list 印開著的 gate，與 pilot-probe 的 `GATE …`、`GATE_MALFORMED <id> <行>` 相同（沒有就不輸出）。
// exit：0 成功；4 STOP；2 用法錯誤（每個旗標給一次；欄位不能空白、含換行或三個連續空白，--how 也不能含 `|`）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateLines, gateRow, gateSections, isField, isResolvedRow, isResolvedSection, now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-gate.mjs <checkout> open --title <text> --issue <text> --question <text> --options <text> --default <text> --parked <text> | <checkout> resolve <G<n>> --how <text> | <checkout> list';
// 旗標名與段落欄位名：只有 Issue 的大小寫不同。
const FIELDS = [['issue', 'Issue'], ['question', 'question'], ['options', 'options'], ['default', 'default'], ['parked', 'parked']];

const [checkout, command, ...rest] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const file = join(storeDir(checkout), 'gates.md');
const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** 解析 `--<name> <value>`：names 每個都要給且只給一次，值是一個欄位（isField），不能以 `--` 開頭（漏給值時吃到下一個旗標）。 */
function requiredFlags(args, names) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !names.includes(name) || name in values || args[i + 1] === undefined || args[i + 1].startsWith('--')) usage(USAGE, `參數錯誤：${args[i]}`);
    values[name] = args[i + 1];
  }
  for (const name of names) {
    if (values[name] === undefined) usage(USAGE, `缺少 --${name}`);
    if (!isField(values[name])) usage(USAGE, `--${name} 不能空白、含換行或三個連續空白`);
  }
  return values;
}

if (command === 'list' && !rest.length) {
  for (const line of gateLines(read())) console.log(line);
} else if (command === 'open') {
  const values = requiredFlags(rest, ['title', ...FIELDS.map(([name]) => name)]);
  mkdirSync(storeDir(checkout), { recursive: true });
  // 只附加不整份改寫：其他 session 同時附加的 gate 不會被蓋掉；id 從附加前重讀的內容算。
  const text = read();
  const ids = [...gateSections(text).map(({ id }) => id), ...text.split('\n').map(gateRow).filter(Boolean).map(row => row[0])];
  const id = `G${Math.max(0, ...ids.map(value => Number(value.slice(1)))) + 1}`;
  const prefix = !text.trim() ? '# Gates\n\n' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  if (!text.trim()) writeFileSync(file, '');
  appendFileSync(file, `${prefix}${[`## ${id} ${values.title}`, ...FIELDS.map(([name, label]) => `- ${label}：${values[name]}`), `- opened：${now()}`].join('\n')}\n`);
  console.log(`GATE_OPENED ${id}`);
} else if (command === 'resolve' && /^G[1-9]\d*$/.test(rest[0] ?? '')) {
  const [id, ...args] = rest;
  const { how } = requiredFlags(args, ['how']);
  if (how.includes('|')) usage(USAGE, '--how 不能含 |');
  const mark = `resolved ${now()} ${how}`;
  const text = read();
  const lines = text.split('\n');
  const rowIndex = lines.findIndex(line => gateRow(line)?.[0] === id);
  const section = gateSections(text).find(entry => entry.id === id);
  if (rowIndex >= 0) {
    const row = gateRow(lines[rowIndex]);
    if (isResolvedRow(row)) { console.log(`STOP ${id} resolved`); process.exit(4); }
    lines[rowIndex] = `| ${[...row.slice(0, -1), mark].join(' | ')} |`;
    writeFileSync(file, lines.join('\n'));
  } else if (section) {
    if (isResolvedSection(section.body)) { console.log(`STOP ${id} resolved`); process.exit(4); }
    // 插在段落最後一個 `- ` 欄位之後：段落後面的空行、下一個 `## ` 或接在後面的表格都不動。
    const body = text.slice(section.start, section.end);
    const at = section.start + Math.max(...[...body.matchAll(/^- .*$/gm)].map(match => match.index + match[0].length), body.includes('\n') ? body.indexOf('\n') : body.length);
    const after = text.slice(at);
    writeFileSync(file, `${text.slice(0, at)}\n- ${mark}${after || '\n'}`);
  } else { console.log(`STOP ${id} missing`); process.exit(4); }
  console.log(`GATE_RESOLVED ${id}`);
} else usage(USAGE);
