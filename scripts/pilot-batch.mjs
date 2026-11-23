#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// pilot 的 batch checkpoint（PILOT-STORE.md 的 `.scratch/pilot/batch-<key>.md`）搬移成員：coordinator 不再手抄表頭與成員行（#163：三個 coordinator
// 各自用 sed、head、python 拼，抄過去的 state 還是 done，probe 又印 STAGEABLE；全員搬走的 batch 沒有固定的 current: 值）。
// 用法：node scripts/pilot-batch.mjs <checkout> move <key> <n> [--state stop]
//       node scripts/pilot-batch.mjs <checkout> park <key> <n> --after <m> [--fresh] --reason <原因>
//       node scripts/pilot-batch.mjs <checkout> unpark <n>
//       node scripts/pilot-batch.mjs <checkout> resume <key> <n> --note <text>（需要 ORCA_CLI_COMMAND）
//       node scripts/pilot-batch.mjs <checkout> accept <key> <n> <sha>
//   move   把 batch-<key> 的成員 #n 搬到 batch-<n>.md：表頭（標題換成 `# batch <n>`、current:、integration:）與成員行照抄，
//          `--state stop` 時新行的 state 寫 stop、candidate 清空；舊行的 state 改成 `moved batch-<n>`，其他格不動。成員最後一行 `resumed:`（見 resume）與它的每一行 `postland:`（#502）也抄到新檔。
//          沒帶 --state、成員是 running、有 ORCA_CLI_COMMAND 時（#437：watcher 已印 DONE、Probe 還沒寫回就搬，新列仍是 running，pilot-land 只會 STOP member running），
//          拿鎖前先讀該列 handle 的畫面最後一個結果行（pilot-probe 的 resultMatch；就是 resumed 記下的那一行時不算）：`DONE <n> <sha>` 的 sha 是成員分支（branch 欄）在 checkout 的 HEAD 時
//          新行寫 done＋完整 SHA，不是 HEAD 或分支不存在時 `STOP <n> unapplied-result <結果行>`、不動檔（先查清楚或跑 pilot-probe.mjs --apply）；`STOP <n> <cause>` 寫 stop、candidate 不動。
//          讀不到畫面時 stderr 印 `WARN move <n> orca <錯誤>`，照舊搬成 running。
//   park   同 move，但新行的 state 寫 `parked after #<m>`、candidate 保留，表格下方加一行 `parked: after #<m> <time> <原因>`；
//          成員要是 done（暫緩已完成、等 #m 先合入的成員）。<key> 就是 <n> 時就地改 state，不搬；這時 batch 要只有它一個成員。
//          `--fresh`（#482：等 #m 合入後要 fresh 重派、不該 unpark 再 stage 的成員）讓 state 寫成 `parked after #<m> fresh`，Probe 對它印 UNPARK_FRESH 而不是 UNPARK。
//          就地 park 也收已是 `parked after #<k>[ fresh]` 的成員（#469：不必先 unpark，中間不會有一瞬間是 done）：改寫 state 與最後一行 `parked:`，
//          印 `PARKED_MEMBER <n> after #<m> (was #<k>)`；after 與 fresh 都沒變時當作重跑，不寫檔。
//   unpark 把 batch-<n>.md 裡 `parked after #<m>` 的成員 #n 改回 done（probe 印 UNPARK <n> 之後），candidate 不動。
//   resume 請停下的 worker 繼續（#356）：batch-<key> 的成員 #n 要是 stop 或 done。先讀該列 handle 的畫面，記下最後一個結果行（`DONE <n> <sha>`／`STOP <n> <cause>`，
//          pilot-probe 的 resultMatch），再以 orca-session-send 的 sendToSession 送 --note（等 tui-idle、讀畫面確認送達；不用 --wait-submit，WSL 上它常不送出）。
//          送達後才在鎖內改列：state running、candidate 清空、started 設為現在，表格下方加 `resumed: #<n> <time> <那一行|->`；
//          送達後鎖內重檢失敗（`STOP <n> delivered …`）或等鎖逾時（CHECKPOINT_LOCKED，resume 只在送達後才拿鎖）時檔案不動，但 note 已送到：不要重跑（會再送一次），手動改列。
//          Probe 讀到最後一個結果行就是它時不算結果（畫面殘留的舊 STOP／DONE 不再被 --apply 寫回），之後出現的新結果行照常寫回。
//   accept 採用 worker 已回報的 candidate（#338 第 1 項：coordinator 代決 STOP decision、選了候選的做法）：成員要是 running 或 stop，
//          <sha> 要等於成員分支（branch 欄）在 checkout 的 HEAD；寫 state done、candidate 完整 SHA，Probe 下一輪照常印 STAGEABLE。
//   搬完舊 batch 的成員全是 moved 時，把 `current:` 寫成 `closed moved`（重跑已做完的 move 也補寫，pilot-dispatch --fresh 共用同一個函式，#205）。
// stdout：`MOVED <key> <n> batch-<n>`，舊 batch 因此關閉時行尾加 ` closed`，照畫面結果行寫了新列時前面多一行 `APPLIED <n> done <完整 sha>` 或 `APPLIED <n> stop`；park 就地改時印 `PARKED_MEMBER <n> after #<m>`（改寫已 parked 的成員時加 ` (was #<k>)`）；`UNPARKED <n>`；
//   `RESUMED <key> <n>`；`ACCEPTED <key> <n> <完整 sha>`。
//   重跑已做完的 move／park 照樣印同一行（中斷在寫新檔與改舊行之間時只補完舊行，目標檔已有這個成員就不重寫）。
//   重跑以目標檔已有這個成員為準，不核對那一列的 state（probe --apply 可能已改過它）：中斷後要換成另一個子命令或 --state 時，先看目標檔。
//   STOP（檔案不動）：`STOP <key> missing`（沒有 batch-<key>.md）、`STOP <n> rows <列數>`（成員列不是剛好一列）、`STOP <n> same-batch`（move 的 <key> 就是 <n>）、
//   `STOP <n> members <數目>`（就地 park 的 batch 還有別的成員）、`STOP <n> state <state>`（park 的成員不是 done（就地 park 也收 parked）、unpark 的不是 parked、move／park 的成員已移到別處）、`STOP <n> target batch-<n>.md`（目標檔已存在卻沒有這個成員）、
//   `STOP <n> unapplied-result <結果行>`（move 見上）、`STOP <n> state missing`（resume／accept 的成員不在 batch 裡）、resume 的成員不是 stop／done 或 accept 的不是 running／stop 時 `STOP <n> state <state>`、
//   `STOP <n> orca <錯誤碼>`／`STOP <n> send <handle>`／`STOP <n> tui-timeout <handle>`（resume 讀不到畫面或沒送達）、`STOP <n> sha <分支 HEAD|missing>`（accept 的 SHA 不是分支 HEAD、分支不存在）、`STOP <n> delivered <原因>`（resume 送達 note 後鎖內重檢失敗，例如 `delivered state running`：note 已送到，不要重跑）。
//   讀改寫都在 batch-<key>.md 與 batch-<n>.md 的 checkpoint 鎖內（lib/pilot-store.mjs 的 withCheckpointLock，#345）：逾時印 `CHECKPOINT_LOCKED <lock> <持鎖內容>`，什麼都沒寫。
// exit：0 成功；4 STOP；3 CHECKPOINT_LOCKED；2 用法錯誤（--reason 不能空白、含換行、三個連續空白或 `|`；--note 不能空白或含換行；resume 沒有 ORCA_CLI_COMMAND；accept 的 <sha> 不是 7–40 碼十六進位）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeIfAllMoved, exitIfLocked, isField, now, storeDir, tableCells, usage, withCheckpointLock, writeCheckpoint } from './lib/pilot-store.mjs';
import { orca, sendToSession } from './orca-session-send.mjs';
import { resultMatch } from './pilot-probe.mjs';

const USAGE = '用法：node scripts/pilot-batch.mjs <checkout> move <key> <n> [--state stop] | <checkout> park <key> <n> --after <m> [--fresh] --reason <原因> | <checkout> unpark <n>'
  + ' | <checkout> resume <key> <n> --note <text> | <checkout> accept <key> <n> <sha>';

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

/** 把一列的 state（與給了的 candidate、started）換掉，其他格的 byte 不動；`split('|')` 的第 5、7、8 段是 started、state、candidate。 */
function setCells(line, state, candidate, started) {
  const parts = line.split('|');
  parts[7] = ` ${state} `;
  if (candidate !== undefined) parts[8] = candidate ? ` ${candidate} ` : ' ';
  if (started !== undefined) parts[5] = ` ${started} `;
  return parts.join('|');
}

const isMember = line => tableCells(line).length >= 8 && /^\d+$/.test(tableCells(line)[0]);
const stateOf = line => tableCells(line)[6];
const isMoved = line => /^moved\b/.test(stateOf(line));

/** `ref` 在 checkout 解析出的完整 SHA，解析不到時空字串。 */
function rev(checkout, ref) {
  const result = spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/**
 * move 前在鎖外讀 running 成員的畫面（#437）：傳回最後一個結果行（pilot-probe 的 resultMatch），resume 記下的舊結果行不算。
 * 成員不是剛好一列 running、沒有 ORCA_CLI_COMMAND 時 undefined；讀不到畫面時 stderr 印 `WARN move <n> orca <錯誤>`，也是 undefined（照舊搬）。
 */
async function screenResult(pilot, key, n) {
  const cli = process.env.ORCA_CLI_COMMAND;
  const file = join(pilot, `batch-${key}.md`);
  if (!cli || !existsSync(file)) return undefined;
  const source = load(file);
  const rows = source.rows(n);
  if (rows.length !== 1 || stateOf(source.lines[rows[0]]) !== 'running') return undefined;
  let tail;
  try {
    tail = (await orca({ cli }, 'terminal', 'read', '--terminal', tableCells(source.lines[rows[0]])[3], '--screen')).terminal?.tail ?? [];
  } catch (error) {
    console.error(`WARN move ${n} orca ${error.message}`);
    return undefined;
  }
  const resumed = source.lines.map(line => line.match(new RegExp(`^resumed: #${n} \\S+ (.*)$`))?.[1]).filter(Boolean).at(-1);
  const match = resultMatch(tail, n);
  return match && match.line !== resumed ? match : undefined;
}

/**
 * move 與 park 的搬移：`state` 是新行的 state，`candidate` 給了就換掉 candidate 格，`note` 是加在新檔表格下方的一行。
 * `result`（screenResult）給了、成員仍是 running 時照它寫新列：DONE 的 sha 要是成員分支在 `checkout` 的 HEAD，寫 done＋完整 SHA，否則 STOP unapplied-result；STOP 寫 stop。
 */
function move(pilot, key, n, { state, candidate, note, requireDone, result, checkout }) {
  const file = join(pilot, `batch-${key}.md`);
  if (!existsSync(file)) throw new Stop(`${key} missing`);
  const source = load(file);
  const i = onlyRow(source, n);
  const target = join(pilot, `batch-${n}.md`);
  const moved = `moved batch-${n}`;
  const memberState = stateOf(source.lines[i]);
  // 目標檔已有這個成員：之前的 move 寫好了新檔（之後 probe --apply 可能改過它），這次只補舊行，不重寫目標檔。
  const copied = existsSync(target) && load(target).rows(n).length === 1;
  // 重跑已做完的搬移時也補關舊 batch：#205 之前 --fresh 搬走全部成員卻沒寫 `closed moved` 的舊 batch，對任一成員重跑就關掉。
  if (memberState === moved && copied) {
    const closed = closeIfAllMoved(source.lines);
    if (closed) writeCheckpoint(file, source.lines.join('\n'));
    return `MOVED ${key} ${n} batch-${n}${closed ? ' closed' : ''}`;
  }
  if (isMoved(source.lines[i])) throw new Stop(`${n} state ${memberState}`);
  if (existsSync(target) && !copied) throw new Stop(`${n} target batch-${n}.md`);
  let applied = '';
  if (!copied) {
    if (requireDone && memberState !== 'done') throw new Stop(`${n} state ${memberState}`);
    const header = source.lines.slice(0, source.lines.findIndex(isMember)).map(line => (/^# batch /.test(line) ? `# batch ${n}` : line));
    let member = state === undefined ? source.lines[i] : setCells(source.lines[i], state, candidate);
    // watcher 已印結果、Probe 還沒寫回的 running 成員（#437）：搬過去仍是 running，pilot-land 只會 STOP member running。
    if (state === undefined && result && memberState === 'running') {
      if (result.kind === 'DONE') {
        const head = rev(checkout, `refs/heads/${tableCells(source.lines[i])[1]}^{commit}`);
        if (!head || rev(checkout, `${result.value}^{commit}`) !== head) throw new Stop(`${n} unapplied-result ${result.line}`);
        member = setCells(member, 'done', head);
        applied = `APPLIED ${n} done ${head}\n`;
      } else {
        member = setCells(member, 'stop');
        applied = `APPLIED ${n} stop\n`;
      }
    }
    // resume 記下的那一行跟著成員走（#356）：搬走的 running 成員在新檔也要忽略畫面上的舊結果行。
    const resumed = source.lines.filter(line => line.startsWith(`resumed: #${n} `)).slice(-1);
    // POSTLAND 指令（#502）也跟著成員走：park 之後落地的 batch 才印得出 POSTLAND_PENDING。
    const postland = source.lines.filter(line => line.startsWith(`postland: #${n} `));
    writeCheckpoint(target, `${[...header, member, ...resumed, ...postland, ...(note ? [note] : [])].join('\n')}\n`);
  }
  source.lines[i] = setCells(source.lines[i], moved);
  const closed = closeIfAllMoved(source.lines);
  writeCheckpoint(file, source.lines.join('\n'));
  return `${applied}MOVED ${key} ${n} batch-${n}${closed ? ' closed' : ''}`;
}

/** park 的 <key> 就是 <n>：就地把 done 改成 parked、加上原因行；已 parked 的改寫 state 與最後一行 `parked:`（#469）。 */
function parkInPlace(pilot, n, after, parked, note) {
  const file = join(pilot, `batch-${n}.md`);
  if (!existsSync(file)) throw new Stop(`${n} missing`);
  const batch = load(file);
  const i = onlyRow(batch, n);
  const members = batch.lines.filter(isMember).length;
  if (members !== 1) throw new Stop(`${n} members ${members}`);
  const state = stateOf(batch.lines[i]);
  if (state === parked) return `PARKED_MEMBER ${n} after #${after}`;
  const was = state.match(/^parked after #(\d+)(?: fresh)?$/)?.[1];
  if (was) {
    batch.lines[i] = setCells(batch.lines[i], parked);
    const last = batch.lines.findLastIndex(line => line.startsWith('parked: '));
    if (last >= 0) batch.lines[last] = note;
    else batch.lines.splice(batch.lines.findLastIndex(line => line.trim()) + 1, 0, note);
    writeCheckpoint(file, batch.lines.join('\n').replace(/\n*$/, '\n'));
    return `PARKED_MEMBER ${n} after #${after} (was #${was})`;
  }
  if (state !== 'done') throw new Stop(`${n} state ${state}`);
  batch.lines[i] = setCells(batch.lines[i], parked);
  const text = batch.lines.join('\n').replace(/\n*$/, '\n');
  writeCheckpoint(file, `${text}${note}\n`);
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
  writeCheckpoint(file, batch.lines.join('\n'));
  return `UNPARKED ${n}`;
}

/** resume、accept 的成員列：batch 檔不在時 `STOP <key> missing`，沒有這個成員 `STOP <n> state missing`，state 不在 `states` 裡 `STOP <n> state <state>`。 */
function memberRow(file, key, n, states) {
  if (!existsSync(file)) throw new Stop(`${key} missing`);
  const batch = load(file);
  if (!batch.rows(n).length) throw new Stop(`${n} state missing`);
  const i = onlyRow(batch, n);
  const state = stateOf(batch.lines[i]);
  if (!states.includes(state)) throw new Stop(`${n} state ${state}`);
  return { batch, i, cells: tableCells(batch.lines[i]) };
}

/**
 * resume：鎖外先檢查列、讀畫面最後一個結果行、送出 note（送達要等數十秒，不持鎖），送達後才在鎖內重讀、改列並記 resumed 行。
 * 送不出時檔案不動，重跑同一行即可。
 */
async function resume(file, key, n, note, ctx) {
  const RESUMABLE = ['stop', 'done'];
  const { cells } = memberRow(file, key, n, RESUMABLE);
  const handle = cells[3];
  let last;
  try {
    const { terminal } = await orca(ctx, 'terminal', 'read', '--terminal', handle, '--screen');
    last = resultMatch(terminal?.tail ?? [], n)?.line ?? '-';
  } catch (error) {
    throw new Stop(`${n} orca ${error.message}`);
  }
  const sent = await sendToSession(ctx, handle, note);
  if (sent.stop) throw new Stop(`${n} ${sent.stop}`);
  return withCheckpointLock(file, () => {
    let row;
    try {
      row = memberRow(file, key, n, RESUMABLE);
    } catch (error) {
      // note 已送到：與送出前同字樣的 STOP 區分開，讀者才知道不要重跑（重跑會送兩次）。
      if (error instanceof Stop) throw new Stop(error.message.startsWith(`${n} `) ? `${n} delivered ${error.message.slice(n.length + 1)}` : `${n} delivered ${error.message}`);
      throw error;
    }
    const { batch, i } = row;
    const at = now();
    batch.lines[i] = setCells(batch.lines[i], 'running', '', at);
    writeCheckpoint(file, `${batch.lines.join('\n').replace(/\n*$/, '\n')}resumed: #${n} ${at} ${last}\n`);
    return `RESUMED ${key} ${n}`;
  });
}

/** accept：成員 running 或 stop，<sha> 要是成員分支的 HEAD；寫 done 與完整 SHA。 */
function accept(checkout, file, key, n, sha) {
  const { batch, i, cells } = memberRow(file, key, n, ['running', 'stop']);
  const head = rev(checkout, `refs/heads/${cells[1]}^{commit}`);
  if (!head) throw new Stop(`${n} sha missing`);
  if (rev(checkout, `${sha}^{commit}`) !== head) throw new Stop(`${n} sha ${head}`);
  batch.lines[i] = setCells(batch.lines[i], 'done', head);
  writeCheckpoint(file, batch.lines.join('\n'));
  return `ACCEPTED ${key} ${n} ${head}`;
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
let files;
if (command === 'move') {
  const [key, n, ...more] = rest;
  const { state } = flags(more, ['state']);
  if (!isKey(key) || !isNumber(n) || (state !== undefined && state !== 'stop')) usage(USAGE);
  files = [join(pilot, `batch-${key}.md`), join(pilot, `batch-${n}.md`)];
  if (key === n) run = () => { throw new Stop(`${n} same-batch`); };
  // 畫面在拿鎖前讀（#437）：Orca 可能要幾秒，不讓 probe --apply 等鎖；鎖內 move 重讀列，成員已不是 running 時不用它。
  else if (state) run = () => move(pilot, key, n, { state, candidate: '' });
  else {
    const result = await screenResult(pilot, key, n);
    run = () => move(pilot, key, n, { result, checkout });
  }
} else if (command === 'park') {
  const [key, n, ...args] = rest;
  // `--fresh` 不帶值：拿掉後其餘照 `--<name> <value>` 解析，給兩次是用法錯誤。
  const more = args.filter(arg => arg !== '--fresh');
  const fresh = args.length - more.length;
  if (fresh > 1) usage(USAGE, '--fresh 只能給一次');
  const { after, reason } = flags(more, ['after', 'reason']);
  if (!isKey(key) || !isNumber(n) || !isNumber(after) || after === n) usage(USAGE);
  if (!isField(reason) || reason.includes('|')) usage(USAGE, '--reason 要是一行，不能空白、含三個連續空白或 |');
  files = [join(pilot, `batch-${key}.md`), join(pilot, `batch-${n}.md`)];
  const note = `parked: after #${after} ${now()} ${reason}`;
  const parked = `parked after #${after}${fresh ? ' fresh' : ''}`;
  run = key === n ? () => parkInPlace(pilot, n, after, parked, note) : () => move(pilot, key, n, { state: parked, note, requireDone: true });
} else if (command === 'unpark') {
  const [n, ...more] = rest;
  if (!isNumber(n) || more.length) usage(USAGE);
  files = [join(pilot, `batch-${n}.md`)];
  run = () => unpark(pilot, n);
} else if (command === 'resume') {
  const [key, n, ...more] = rest;
  const { note } = flags(more, ['note']);
  if (!isKey(key) || !isNumber(n)) usage(USAGE);
  if (typeof note !== 'string' || !note.trim() || note.includes('\n')) usage(USAGE, '--note 要是一行文字');
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!cli) usage(USAGE, 'resume 需要 ORCA_CLI_COMMAND');
  const file = join(pilot, `batch-${key}.md`);
  // 鎖在 resume 裡、送達之後才拿：送出要等數十秒，不能讓 probe --apply 一直等到逾時。
  files = [];
  run = () => resume(file, key, n, note, { cli });
} else if (command === 'accept') {
  const [key, n, sha, ...more] = rest;
  if (!isKey(key) || !isNumber(n) || !/^[0-9a-f]{7,40}$/.test(sha ?? '') || more.length) usage(USAGE);
  files = [join(pilot, `batch-${key}.md`)];
  run = () => accept(checkout, files[0], key, n, sha);
} else usage(USAGE);

try {
  console.log(await withCheckpointLock(files, run));
} catch (error) {
  if (!(error instanceof Stop)) {
    exitIfLocked(error);
    throw error;
  }
  console.log(`STOP ${error.message}`);
  process.exit(4);
}
