#!/usr/bin/env node
// pilot 的 batch checkpoint（PILOT-STORE.md 的 `.scratch/pilot/batch-<key>.md`）搬移成員：coordinator 不再手抄表頭與成員行（#163：三個 coordinator
// 各自用 sed、head、python 拼，抄過去的 state 還是 done，probe 又印 STAGEABLE；全員搬走的 batch 沒有固定的 current: 值）。
// 用法：node scripts/pilot-batch.mjs <checkout> move <key> <n> [--state stop]
//       node scripts/pilot-batch.mjs <checkout> park <key> <n> --after <m> --reason <原因>
//       node scripts/pilot-batch.mjs <checkout> unpark <n>
//   move   把 batch-<key> 的成員 #n 搬到 batch-<n>.md：表頭（標題換成 `# batch <n>`、current:、integration:）與成員行照抄，
//          `--state stop` 時新行的 state 寫 stop、candidate 清空；舊行的 state 改成 `moved batch-<n>`，其他格不動。
//   park   同 move，但新行的 state 寫 `parked after #<m>`、candidate 保留，表格下方加一行 `parked: after #<m> <time> <原因>`；
//          成員要是 done（暫緩已完成、等 #m 先合入的成員）。<key> 就是 <n> 時就地改 state，不搬；這時 batch 要只有它一個成員。
//   unpark 把 batch-<n>.md 裡 `parked after #<m>` 的成員 #n 改回 done（probe 印 UNPARK <n> 之後），candidate 不動。
//   搬完舊 batch 的成員全是 moved 時，把 `current:` 寫成 `closed moved`。
// stdout：`MOVED <key> <n> batch-<n>`，舊 batch 因此關閉時行尾加 ` closed`；park 就地改時印 `PARKED_MEMBER <n> after #<m>`；`UNPARKED <n>`。
//   重跑已做完的 move／park 照樣印同一行（中斷在寫新檔與改舊行之間時只補完舊行，目標檔已有這個成員就不重寫）。
//   重跑以目標檔已有這個成員為準，不核對那一列的 state（probe --apply 可能已改過它）：中斷後要換成另一個子命令或 --state 時，先看目標檔。
//   STOP（檔案不動）：`STOP <key> missing`（沒有 batch-<key>.md）、`STOP <n> rows <列數>`（成員列不是剛好一列）、`STOP <n> same-batch`（move 的 <key> 就是 <n>）、
//   `STOP <n> members <數目>`（就地 park 的 batch 還有別的成員）、`STOP <n> state <state>`（park 的成員不是 done、unpark 的不是 parked、move／park 的成員已移到別處）、`STOP <n> target batch-<n>.md`（目標檔已存在卻沒有這個成員）。
// exit：0 成功；4 STOP；2 用法錯誤（--reason 不能空白、含換行、三個連續空白或 `|`）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isField, now, storeDir, tableCells, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-batch.mjs <checkout> move <key> <n> [--state stop] | <checkout> park <key> <n> --after <m> --reason <原因> | <checkout> unpark <n>';

class Stop extends Error {}

/** 讀 batch 檔成行陣列；`rows(n)` 是成員 #n 的列號。 */
function load(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rows = n => lines.flatMap((line, i) => (tableCells(line).length >= 8 && tableCells(line)[0] === n ? [i] : []));
  return { lines, rows };
}

/** 成員 #n 唯一的那一列號；不是剛好一列時 STOP。 */
function onlyRow(batch, n) {
  const rows = batch.rows(n);
  if (rows.length !== 1) throw new Stop(`${n} rows ${rows.length}`);
  return rows[0];
}

/** 把一列的 state（與給了的 candidate）換掉，其他格的 byte 不動；`split('|')` 的第 7、8 段是 state、candidate。 */
function setCells(line, state, candidate) {
  const parts = line.split('|');
  parts[7] = ` ${state} `;
  if (candidate !== undefined) parts[8] = candidate ? ` ${candidate} ` : ' ';
  return parts.join('|');
}

const isMember = line => tableCells(line).length >= 8 && /^\d+$/.test(tableCells(line)[0]);
const stateOf = line => tableCells(line)[6];
const isMoved = line => /^moved\b/.test(stateOf(line));

/** 舊 batch 的成員都是 moved 時把 current: 寫成 `closed moved`；傳回是否關閉。 */
function closeIfEmpty(lines) {
  const members = lines.filter(isMember);
  if (!members.length || !members.every(isMoved)) return false;
  const i = lines.findIndex(line => /^current:/.test(line));
  if (i < 0 || /^current:\s*closed moved$/.test(lines[i])) return false;
  lines[i] = 'current: closed moved';
  return true;
}

/** move 與 park 的搬移：`state` 是新行的 state，`candidate` 給了就換掉 candidate 格，`note` 是加在新檔表格下方的一行。 */
function move(pilot, key, n, { state, candidate, note, requireDone }) {
  const file = join(pilot, `batch-${key}.md`);
  if (!existsSync(file)) throw new Stop(`${key} missing`);
  const source = load(file);
  const i = onlyRow(source, n);
  const target = join(pilot, `batch-${n}.md`);
  const moved = `moved batch-${n}`;
  const memberState = stateOf(source.lines[i]);
  // 目標檔已有這個成員：之前的 move 寫好了新檔（之後 probe --apply 可能改過它），這次只補舊行，不重寫目標檔。
  const copied = existsSync(target) && load(target).rows(n).length === 1;
  if (memberState === moved && copied) return `MOVED ${key} ${n} batch-${n}`;
  if (isMoved(source.lines[i])) throw new Stop(`${n} state ${memberState}`);
  if (existsSync(target) && !copied) throw new Stop(`${n} target batch-${n}.md`);
  if (!copied) {
    if (requireDone && memberState !== 'done') throw new Stop(`${n} state ${memberState}`);
    const header = source.lines.slice(0, source.lines.findIndex(isMember)).map(line => (/^# batch /.test(line) ? `# batch ${n}` : line));
    const member = state === undefined ? source.lines[i] : setCells(source.lines[i], state, candidate);
    writeFileSync(target, `${[...header, member, ...(note ? [note] : [])].join('\n')}\n`);
  }
  source.lines[i] = setCells(source.lines[i], moved);
  const closed = closeIfEmpty(source.lines);
  writeFileSync(file, source.lines.join('\n'));
  return `MOVED ${key} ${n} batch-${n}${closed ? ' closed' : ''}`;
}

/** park 的 <key> 就是 <n>：就地把 done 改成 parked，加上原因行。 */
function parkInPlace(pilot, n, after, note) {
  const file = join(pilot, `batch-${n}.md`);
  if (!existsSync(file)) throw new Stop(`${n} missing`);
  const batch = load(file);
  const i = onlyRow(batch, n);
  const members = batch.lines.filter(isMember).length;
  if (members !== 1) throw new Stop(`${n} members ${members}`);
  const state = stateOf(batch.lines[i]);
  const parked = `parked after #${after}`;
  if (state === parked) return `PARKED_MEMBER ${n} after #${after}`;
  if (state !== 'done') throw new Stop(`${n} state ${state}`);
  batch.lines[i] = setCells(batch.lines[i], parked);
  const text = batch.lines.join('\n').replace(/\n*$/, '\n');
  writeFileSync(file, `${text}${note}\n`);
  return `PARKED_MEMBER ${n} after #${after}`;
}

function unpark(pilot, n) {
  const file = join(pilot, `batch-${n}.md`);
  if (!existsSync(file)) throw new Stop(`${n} missing`);
  const batch = load(file);
  const i = onlyRow(batch, n);
  const state = stateOf(batch.lines[i]);
  if (!/^parked\b/.test(state)) throw new Stop(`${n} state ${state}`);
  batch.lines[i] = setCells(batch.lines[i], 'done');
  writeFileSync(file, batch.lines.join('\n'));
  return `UNPARKED ${n}`;
}

/** `--<name> <value>` 旗標：只認 `names`，每個最多一次，值不能缺或以 `--` 開頭。 */
function flags(args, names) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !names.includes(name) || name in values || args[i + 1] === undefined || args[i + 1].startsWith('--')) usage(USAGE, `參數錯誤：${args[i]}`);
    values[name] = args[i + 1];
  }
  return values;
}

const isNumber = value => /^\d+$/.test(value ?? '');
const isKey = value => /^[\w-]+$/.test(value ?? '');

const [checkout, command, ...rest] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const pilot = storeDir(checkout);
let run;
if (command === 'move') {
  const [key, n, ...more] = rest;
  const { state } = flags(more, ['state']);
  if (!isKey(key) || !isNumber(n) || (state !== undefined && state !== 'stop')) usage(USAGE);
  if (key === n) run = () => { throw new Stop(`${n} same-batch`); };
  else run = () => move(pilot, key, n, state ? { state, candidate: '' } : {});
} else if (command === 'park') {
  const [key, n, ...more] = rest;
  const { after, reason } = flags(more, ['after', 'reason']);
  if (!isKey(key) || !isNumber(n) || !isNumber(after) || after === n) usage(USAGE);
  if (!isField(reason) || reason.includes('|')) usage(USAGE, '--reason 要是一行，不能空白、含三個連續空白或 |');
  const note = `parked: after #${after} ${now()} ${reason}`;
  run = key === n ? () => parkInPlace(pilot, n, after, note) : () => move(pilot, key, n, { state: `parked after #${after}`, note, requireDone: true });
} else if (command === 'unpark') {
  const [n, ...more] = rest;
  if (!isNumber(n) || more.length) usage(USAGE);
  run = () => unpark(pilot, n);
} else usage(USAGE);

try {
  console.log(run());
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.log(`STOP ${error.message}`);
  process.exit(4);
}
