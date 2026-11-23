// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-batch.mjs', import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const HEADER = '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n';
// 空的 candidate 照 pilot-dispatch 寫成 `| |`。
const row = (n, state, candidate = '') => `| ${n} | issue/${n}-x | /w/issue-${n} | term_${n} | 2026-10-31T11:29:04+08:00 | 90m | ${state} |${candidate ? ` ${candidate} ` : ' '}|`;
const batchText = (key, current, rows) => `# batch ${key}\ncurrent: ${current}\nintegration: pilot/integration @ 370114b\n\n${HEADER}${rows.join('\n')}\n`;

/** 只有 `.scratch/pilot/` 與給定 batch checkpoint 的 checkout（ORCA_CLI_COMMAND 預設清空：move 才不讀真的 Orca）；`run` 跑 pilot-batch，`read` 讀 batch 檔（不存在回 null）。 */
function fixture(t, batches, env = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pilot = join(dir, '.scratch/pilot');
  mkdirSync(pilot, { recursive: true });
  for (const [key, text] of Object.entries(batches)) writeFileSync(join(pilot, `batch-${key}.md`), text);
  const run = (...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8', env: { ...process.env, ORCA_CLI_COMMAND: '', ...env } });
  const read = key => (existsSync(join(pilot, `batch-${key}.md`)) ? readFileSync(join(pilot, `batch-${key}.md`), 'utf8') : null);
  return { run, read, pilot, dir };
}

// d8f8c8fa 手抄過去的成員 state 還是 done，probe 下一輪印 STAGEABLE 124，又多一步改成 stop（#163）。
test('move --state stop：成員搬到 batch-<n>（表頭與成員行照抄、state stop、candidate 清空），舊行寫 moved batch-<n>', t => {
  const { run, read } = fixture(t, { '123-124': batchText('123-124', 'dispatched 2026-10-31T11:29:04+08:00', [row(123, 'done', A), row(124, 'done', B)]) });
  const result = run('move', '123-124', '124', '--state', 'stop');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MOVED 123-124 124 batch-124\n');
  assert.equal(read('124'), batchText('124', 'dispatched 2026-10-31T11:29:04+08:00', [row(124, 'stop')]));
  assert.equal(read('123-124'), batchText('123-124', 'dispatched 2026-10-31T11:29:04+08:00', [row(123, 'done', A), row(124, 'moved batch-124', B)]));
});

// batch 133-134 兩個成員都搬走後只能手寫 `current: closed all members moved …`，前任寫的是 `closed not dispatchable …`（#163）。
test('最後一個成員搬走時舊 batch 的 current: 寫成 closed moved，結果行加 closed', t => {
  const { run, read } = fixture(t, { '133-134': batchText('133-134', 'dispatched 2026-10-31T11:29:04+08:00', [row(133, 'moved batch-133'), row(134, 'running')]) });
  const result = run('move', '133-134', '134');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MOVED 133-134 134 batch-134 closed\n');
  assert.equal(read('134'), batchText('134', 'dispatched 2026-10-31T11:29:04+08:00', [row(134, 'running')]));
  assert.equal(read('133-134'), batchText('133-134', 'closed moved', [row(133, 'moved batch-133'), row(134, 'moved batch-134')]));
});

// batch 123-131 的兩個成員都由 pilot-dispatch --fresh 搬走，current: 卻還是 dispatched，status.md 一直列成開著（#205）。
test('move 重跑已做完的搬移：舊 batch 成員全是 moved 卻沒關時補寫 closed moved，結果行加 closed', t => {
  const stale = batchText('123-131', 'dispatched 2026-10-31T12:34:02+08:00', [row(123, 'moved batch-123'), row(131, 'moved batch-131')]);
  const { run, read } = fixture(t, { '123-131': stale, 123: batchText('123', 'dispatched 2026-10-31T13:00:00+08:00', [row(123, 'running')]) });
  const result = run('move', '123-131', '123');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MOVED 123-131 123 batch-123 closed\n');
  assert.equal(read('123-131'), batchText('123-131', 'closed moved', [row(123, 'moved batch-123'), row(131, 'moved batch-131')]));
  assert.equal(read('123'), batchText('123', 'dispatched 2026-10-31T13:00:00+08:00', [row(123, 'running')]));
  assert.equal(run('move', '123-131', '123').stdout, 'MOVED 123-131 123 batch-123\n');
});

// #94 與 #123 改同一列：#94 已 done（candidate 7246dfe），只能寫成 stop 並清掉 candidate，事實記錄失真（#163）。
test('park：done 成員搬到 batch-<n>，state 記 parked after #<m>、candidate 保留，表格下方記原因', t => {
  const { run, read } = fixture(t, { '88-94': batchText('88-94', 'dispatched 2026-10-31T13:57:05+08:00', [row(88, 'done', A), row(94, 'done', B)]) });
  const result = run('park', '88-94', '94', '--after', '123', '--reason', '與 #123 改 PILOT-STORE.md 同一列');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MOVED 88-94 94 batch-94\n');
  const [table, note] = read('94').split(/\n(?=parked: )/);
  assert.equal(`${table}\n`, batchText('94', 'dispatched 2026-10-31T13:57:05+08:00', [row(94, 'parked after #123', B)]));
  assert.match(note, /^parked: after #123 \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d 與 #123 改 PILOT-STORE\.md 同一列\n$/);
  assert.equal(read('88-94'), batchText('88-94', 'dispatched 2026-10-31T13:57:05+08:00', [row(88, 'done', A), row(94, 'moved batch-94', B)]));
});

test('park 只收 done 成員；batch 只有它時就地改成 parked，unpark 改回 done 且 candidate 不動', t => {
  const { run, read } = fixture(t, {
    94: batchText('94', 'dispatched 2026-10-31T13:57:05+08:00', [row(94, 'done', B)]),
    '30-31': batchText('30-31', 'dispatched 2026-10-31T13:57:05+08:00', [row(30, 'stop'), row(31, 'done', A)]),
  });
  const refused = run('park', '30-31', '30', '--after', '31', '--reason', '等 #31');
  assert.equal(refused.status, 4);
  assert.equal(refused.stdout, 'STOP 30 state stop\n');
  assert.equal(read('30'), null);

  const parked = run('park', '94', '94', '--after', '123', '--reason', '等 #123');
  assert.equal(parked.status, 0, parked.stderr);
  assert.equal(parked.stdout, 'PARKED_MEMBER 94 after #123\n');
  assert.match(read('94'), /\| parked after #123 \| b{40} \|\nparked: after #123 \S+ 等 #123\n$/);

  const unparked = run('unpark', '94');
  assert.equal(unparked.status, 0, unparked.stderr);
  assert.equal(unparked.stdout, 'UNPARKED 94\n');
  assert.match(read('94'), /\| done \| b{40} \|\nparked: after #123 /);
  assert.equal(run('unpark', '94').stdout, 'STOP 94 state done\n');
});

// #469：`park 398 398 --after 344` 印 `STOP 398 state parked after #345`，只能先 unpark 再 park，中間成員是 done、Probe 會印 STAGEABLE。
test('park 已 parked 的成員就地改寫 --after 與原因，candidate 保留；同一行重跑不再寫；stop、running 仍 STOP', t => {
  const parked = `${batchText('398', 'dispatched 2026-11-20T10:00:00+08:00', [row(398, 'parked after #345', B)])}parked: after #345 2026-11-20T11:00:00+08:00 等 #345\n`;
  const { run, read } = fixture(t, {
    398: parked,
    40: batchText('40', 'dispatched 2026-11-20T10:00:00+08:00', [row(40, 'stop')]),
    41: batchText('41', 'dispatched 2026-11-20T10:00:00+08:00', [row(41, 'running')]),
  });
  const result = run('park', '398', '398', '--after', '344', '--reason', '改等 #344');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'PARKED_MEMBER 398 after #344 (was #345)\n');
  const [table, note] = read('398').split(/\n(?=parked: )/);
  assert.equal(`${table}\n`, batchText('398', 'dispatched 2026-11-20T10:00:00+08:00', [row(398, 'parked after #344', B)]));
  assert.match(note, /^parked: after #344 \S+ 改等 #344\n$/);
  const again = read('398');
  assert.equal(run('park', '398', '398', '--after', '344', '--reason', '改等 #344').stdout, 'PARKED_MEMBER 398 after #344\n');
  assert.equal(read('398'), again);
  for (const n of ['40', '41']) {
    const refused = run('park', n, n, '--after', '9', '--reason', '等 #9');
    assert.equal(refused.status, 4);
    assert.equal(refused.stdout, `STOP ${n} state ${n === '40' ? 'stop' : 'running'}\n`);
  }
});

// #482：原因是「要 fresh 重派」的成員，Probe 照樣印 UNPARK，unpark 再 stage 必然撞同一個整合衝突；--fresh 記在 state 讓 Probe 分得出來。
test('park --fresh 在 state 記 fresh（搬移與就地都是），重 park 可加上或拿掉', t => {
  const { run, read } = fixture(t, {
    '88-94': batchText('88-94', 'dispatched 2026-10-31T13:57:05+08:00', [row(88, 'done', A), row(94, 'done', B)]),
    95: batchText('95', 'dispatched 2026-10-31T13:57:05+08:00', [row(95, 'done', A)]),
  });
  const moved = run('park', '88-94', '94', '--after', '123', '--fresh', '--reason', '要 fresh 重派');
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.stdout, 'MOVED 88-94 94 batch-94\n');
  assert.match(read('94'), /\| parked after #123 fresh \| b{40} \|\nparked: after #123 \S+ 要 fresh 重派\n$/);

  assert.equal(run('park', '95', '95', '--after', '123', '--reason', '等 #123', '--fresh').stdout, 'PARKED_MEMBER 95 after #123\n');
  assert.match(read('95'), /\| parked after #123 fresh \| a{40} \|\n/);
  assert.equal(run('park', '95', '95', '--after', '123', '--reason', '改成 unpark 就好').stdout, 'PARKED_MEMBER 95 after #123 (was #123)\n');
  assert.match(read('95'), /\| parked after #123 \| a{40} \|\nparked: after #123 \S+ 改成 unpark 就好\n$/);
  assert.equal(run('park', '95', '95', '--after', '123', '--fresh', '--fresh', '--reason', 'x').status, 2);
});

// 中斷在寫好新檔、還沒改舊行時，重跑同一行補完舊行；全部做完後重跑只再印一次結果。
test('move 重跑：補完舊行、已完成時照印同一行；目標檔已有別的內容或成員不在時 STOP 不動檔', t => {
  const { run, read } = fixture(t, {
    '1-2': batchText('1-2', 'dispatched 2026-10-31T11:29:04+08:00', [row(1, 'done', A), row(2, 'stop')]),
    2: batchText('2', 'dispatched 2026-10-31T11:29:04+08:00', [row(2, 'stop')]),
    '3-4': batchText('3-4', 'dispatched 2026-10-31T11:29:04+08:00', [row(3, 'done', A), row(4, 'stop')]),
    4: batchText('4', 'closed', [row(5, 'done', A)]),
  });
  assert.equal(run('move', '1-2', '2', '--state', 'stop').stdout, 'MOVED 1-2 2 batch-2\n');
  assert.equal(read('1-2'), batchText('1-2', 'dispatched 2026-10-31T11:29:04+08:00', [row(1, 'done', A), row(2, 'moved batch-2')]));
  assert.equal(run('move', '1-2', '2', '--state', 'stop').stdout, 'MOVED 1-2 2 batch-2\n');
  assert.equal(read('2'), batchText('2', 'dispatched 2026-10-31T11:29:04+08:00', [row(2, 'stop')]));

  const before = read('3-4');
  for (const [args, stop] of [
    [['move', '3-4', '4'], 'STOP 4 target batch-4.md'],
    [['move', '3-4', '9'], 'STOP 9 rows 0'],
    [['move', '3-4', '3-4'], null],
    [['move', '4', '4'], 'STOP 4 same-batch'],
    [['move', '7-8', '7'], 'STOP 7-8 missing'],
  ]) {
    const result = run(...args);
    if (stop === null) assert.equal(result.status, 2, args.join(' '));
    else {
      assert.equal(result.status, 4, args.join(' '));
      assert.equal(result.stdout, `${stop}\n`);
    }
  }
  assert.equal(read('3-4'), before);
});

test('用法錯誤 exit 2：--state 只收 stop，park 要 --after 與一行沒有 | 的 --reason', t => {
  const { run } = fixture(t, { '1-2': batchText('1-2', 'dispatched x', [row(1, 'done', A), row(2, 'done', A)]) });
  for (const args of [
    ['move', '1-2', '2', '--state', 'done'],
    ['park', '1-2', '2', '--reason', '等'],
    ['park', '1-2', '2', '--after', '2', '--reason', '等'],
    ['park', '1-2', '2', '--after', '1', '--reason', 'a | b'],
    ['park', '1-2', '2', '--after', '1', '--reason', 'a\nb'],
    ['unpark'],
    ['nope'],
  ]) assert.equal(run(...args).status, 2, args.join(' '));
});

// review：中斷在寫好新檔、還沒改舊行時，probe --apply 可能已經改了新檔的列；重跑只補舊行，不能用舊列蓋回去。
test('move 重跑時目標檔已有這個成員就不重寫目標檔', t => {
  const { run, read } = fixture(t, {
    '53-55': batchText('53-55', 'dispatched 2026-10-31T11:29:04+08:00', [row(53, 'done', A), row(55, 'running')]),
    55: `${batchText('55', 'dispatched 2026-10-31T11:29:04+08:00', [row(55, 'done', B)])}regression: ${B} exit 0\n`,
  });
  const result = run('move', '53-55', '55');
  assert.equal(result.stdout, 'MOVED 53-55 55 batch-55\n');
  assert.equal(read('55'), `${batchText('55', 'dispatched 2026-10-31T11:29:04+08:00', [row(55, 'done', B)])}regression: ${B} exit 0\n`);
  assert.match(read('53-55'), /\| 55 \|.*\| moved batch-55 \|/);
});

// review：batch-<n> 還有別的成員時就地 park，probe 會印 MOVE <n> <n>，move 又是 same-batch，沒有指令能解開。
test('park 的 <key> 是 <n> 但 batch 還有別的成員時 STOP 不動檔', t => {
  const text = batchText('94', 'dispatched 2026-10-31T13:57:05+08:00', [row(94, 'done', A), row(95, 'done', B)]);
  const { run, read } = fixture(t, { 94: text });
  const result = run('park', '94', '94', '--after', '123', '--reason', '等 #123');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 94 members 2\n');
  assert.equal(read('94'), text);
});

// #345：coordinator 的 probe --apply 與手動 pilot-batch 同時讀改寫同一份 checkpoint，後寫的整檔蓋掉先寫的（spay2 679ce48fd）。
const holdLock = (file, pid = process.pid) => writeFileSync(`${file}.lock`, `pid=${pid} at=2026-11-21T00:00:00.000Z test\n`);

test('鎖被占用時 move 等持鎖者寫完才讀，兩邊的修改都留著', async t => {
  const { read, pilot, dir } = fixture(t, { '123-124': batchText('123-124', 'dispatched 2026-10-31T11:29:04+08:00', [row(123, 'running'), row(124, 'done', B)]) });
  const file = join(pilot, 'batch-123-124.md');
  holdLock(file);
  const child = spawn('node', [SCRIPT, dir, 'move', '123-124', '124', '--state', 'stop'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exited = once(child, 'exit');
  await sleep(1000);
  assert.equal(child.exitCode, null, '持鎖期間 move 不該已結束');
  // 持鎖者（例如 probe --apply）以它開頭讀到的內容寫回 123 的結果，再放鎖。
  writeFileSync(file, batchText('123-124', 'dispatched 2026-10-31T11:29:04+08:00', [row(123, 'done', A), row(124, 'done', B)]));
  rmSync(`${file}.lock`);
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(stdout, 'MOVED 123-124 124 batch-124\n');
  assert.equal(read('123-124'), batchText('123-124', 'dispatched 2026-10-31T11:29:04+08:00', [row(123, 'done', A), row(124, 'moved batch-124', B)]));
  assert.equal(existsSync(`${file}.lock`), false);
});

test('持鎖 pid 已不存在時搶回殘留鎖照常寫入', t => {
  const { run, read, pilot } = fixture(t, { '123-124': batchText('123-124', 'dispatched 2026-10-31T11:29:04+08:00', [row(123, 'running'), row(124, 'done', B)]) });
  const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  holdLock(join(pilot, 'batch-123-124.md'), dead);
  holdLock(join(pilot, 'batch-124.md'), dead);
  const result = run('move', '123-124', '124');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MOVED 123-124 124 batch-124\n');
  assert.match(read('123-124'), /\| 124 \|.*\| moved batch-124 \|/);
  assert.equal(existsSync(join(pilot, 'batch-123-124.md.lock')), false);
  assert.equal(existsSync(join(pilot, 'batch-124.md.lock')), false);
});

test('持鎖 pid 還活著、等到逾時就印 CHECKPOINT_LOCKED、exit 3，檔案與鎖都不動', t => {
  const text = batchText('94', 'dispatched 2026-10-31T13:57:05+08:00', [row(94, 'parked after #123', A)]);
  const { read, pilot, dir } = fixture(t, { 94: text });
  const file = join(pilot, 'batch-94.md');
  holdLock(file);
  // 鎖齡一小時：pid 還活著就不論鎖齡都等，不當成殘留鎖。
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  utimesSync(`${file}.lock`, hourAgo, hourAgo);
  const result = spawnSync('node', [SCRIPT, dir, 'unpark', '94'], { encoding: 'utf8', env: { ...process.env, PILOT_STORE_LOCK_TIMEOUT_MS: '300' } });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, `CHECKPOINT_LOCKED ${file}.lock pid=${process.pid} at=2026-11-21T00:00:00.000Z test\n`);
  assert.equal(read('94'), text);
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), `pid=${process.pid} at=2026-11-21T00:00:00.000Z test\n`);
});

test('鎖檔讀不出 pid、超過 2 秒時當成殘留鎖搶回；不到 2 秒時照樣等', t => {
  const text = batchText('94', 'dispatched 2026-10-31T13:57:05+08:00', [row(94, 'parked after #123', A)]);
  const { read, pilot, dir } = fixture(t, { 94: text });
  const lock = join(pilot, 'batch-94.md.lock');
  writeFileSync(lock, '');
  const fresh = spawnSync('node', [SCRIPT, dir, 'unpark', '94'], { encoding: 'utf8', env: { ...process.env, PILOT_STORE_LOCK_TIMEOUT_MS: '300' } });
  assert.equal(fresh.status, 3, fresh.stdout + fresh.stderr);
  assert.equal(read('94'), text);
  const old = new Date(Date.now() - 5000);
  utimesSync(lock, old, old);
  const result = spawnSync('node', [SCRIPT, dir, 'unpark', '94'], { encoding: 'utf8', env: { ...process.env, PILOT_STORE_LOCK_TIMEOUT_MS: '300' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'UNPARKED 94\n');
  assert.equal(existsSync(lock), false);
});

// resume（#356、#325 第 1 項）：請停下的 worker 繼續原本只能 terminal send＋sed 改列；started 沒重設，Probe 印假的 STUCK；
// 畫面殘留的舊結果行又被 probe --apply 寫回。
// 假 Orca：`screens` 是 handle → `terminal read` 的 tail；`send` 收下的文字之後以 `> <text>` 出現在畫面上（orca-session-send 以此確認送達）；
// `reject` 時 send 回 accepted false；`<orca.log>.mutate`（JSON `{ file, text }`）存在時，send 把 text 寫進 file 一次（模擬送出時列被改）。每次呼叫記進 orca.log。
function orcaFixture(t, batches, { screens = {}, reject = false } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-batch-orca-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
const screens = ${JSON.stringify(screens)};
const sentFile = ${JSON.stringify(log)} + '.sent';
const sent = fs.existsSync(sentFile) ? fs.readFileSync(sentFile, 'utf8').split('\\n').filter(Boolean) : [];
if (!screens[arg('--terminal')]) { fail('terminal_handle_stale'); process.exit(1); }
if (b === 'wait') reply('wait', { wait: { satisfied: true } });
else if (b === 'send') {
  if (!${reject}) fs.appendFileSync(sentFile, arg('--text') + '\\n');
  const mutate = ${JSON.stringify(log)} + '.mutate';
  if (fs.existsSync(mutate)) { const { file, text } = JSON.parse(fs.readFileSync(mutate, 'utf8')); fs.writeFileSync(file, text); fs.rmSync(mutate); }
  reply('send', { send: { accepted: ${!reject} } });
}
else reply('read', { terminal: { status: 'running', tail: [...screens[arg('--terminal')], ...sent.map(text => '> ' + text)], draft: '' } });
`);
  chmodSync(cli, 0o755);
  const fx = fixture(t, batches, { ORCA_CLI_COMMAND: cli, ...FAST });
  const sends = () => readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('terminal send '));
  return { ...fx, log, sends };
}

const OLD_STOP = 'STOP 234 decision pilot-close 與兩個 git 步驟偏離待 Operator 決定';
const rowAt = text => n => text.split('\n').find(line => line.startsWith(`| ${n} |`));

test('resume：stop 列改回 running、清 candidate、started 設為現在，記下畫面最後一個結果行，送出 --note', t => {
  const { run, read, sends } = orcaFixture(t, { 234: batchText('234', 'dispatched 2026-11-16T10:00:00+08:00', [row(234, 'stop')]) }, {
    screens: { term_234: ['● 報告', `│ ${OLD_STOP}      │`, '╰──────╯', '❯'] },
  });
  const before = Date.now();
  const result = run('resume', '234', '234', '--note', 'G18 選 A，照 A 繼續');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESUMED 234 234\n');
  const text = read('234');
  const cells = rowAt(text)(234).split('|').map(cell => cell.trim());
  assert.equal(cells[7], 'running');
  assert.equal(cells[8], '');
  assert.ok(Date.parse(cells[5]) >= before - 1000, cells[5]);
  assert.match(text, new RegExp(`\\nresumed: #234 \\S+ ${OLD_STOP}\\n$`));
  assert.deepEqual(sends().map(line => line.includes('--text G18 選 A，照 A 繼續 --enter')), [true]);
  // 其他行不動：只有成員列變了、多了 resumed 行。
  const old = batchText('234', 'dispatched 2026-11-16T10:00:00+08:00', [row(234, 'stop')]).split('\n');
  assert.deepEqual(text.split('\n').filter(line => !old.includes(line)).map(line => line.slice(0, 9)), ['| 234 | i', 'resumed: ']);
});

test('resume：done 列清掉舊 SHA；畫面沒有結果行時記 -', t => {
  const { run, read } = orcaFixture(t, { '318-319': batchText('318-319', 'dispatched 2026-11-18T10:00:00+08:00', [row(318, 'done', A), row(319, 'done', B)]) }, {
    screens: { term_319: [`DONE 319 ${B}`, '❯'], term_318: ['❯'] },
  });
  assert.equal(run('resume', '318-319', '319', '--note', '請先合入 pilot/integration').stdout, 'RESUMED 318-319 319\n');
  assert.equal(run('resume', '318-319', '318', '--note', '請重跑').stdout, 'RESUMED 318-319 318\n');
  const text = read('318-319');
  assert.match(rowAt(text)(319), /\| running \| \|$/);
  assert.match(rowAt(text)(318), /\| running \| \|$/);
  assert.match(text, new RegExp(`\\nresumed: #319 \\S+ DONE 319 ${B}\\nresumed: #318 \\S+ -\\n$`));
});

test('resume：不是 stop／done 的列、不存在的成員印 STOP <n> state <state>，不送出、不改檔；送不出時 STOP <n> send，不改檔', t => {
  const batches = { '5-6': batchText('5-6', 'dispatched 2026-11-18T10:00:00+08:00', [row(5, 'running'), row(6, 'parked after #4', A)]) };
  const { run, read, sends } = orcaFixture(t, batches, { screens: { term_5: ['❯'], term_6: ['❯'] } });
  for (const [n, state] of [['5', 'running'], ['6', 'parked after #4'], ['7', 'missing']]) {
    const result = run('resume', '5-6', n, '--note', '繼續');
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.stdout, `STOP ${n} state ${state}\n`);
  }
  assert.equal(run('resume', '9', '9', '--note', '繼續').stdout, 'STOP 9 missing\n');
  assert.deepEqual(sends(), []);
  assert.equal(read('5-6'), batches['5-6']);
  const stopped = { 7: batchText('7', 'dispatched 2026-11-18T10:00:00+08:00', [row(7, 'stop')]) };
  const rejected = orcaFixture(t, stopped, { screens: { term_7: ['STOP 7 decision x', '❯'] }, reject: true });
  const result = rejected.run('resume', '7', '7', '--note', '繼續');
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, 'STOP 7 send term_7\n');
  assert.equal(rejected.read('7'), stopped[7]);
  const stale = orcaFixture(t, stopped, { screens: {} });
  assert.match(stale.run('resume', '7', '7', '--note', '繼續').stdout, /^STOP 7 orca terminal_handle_stale\n$/);
  assert.equal(stale.read('7'), stopped[7]);
});

test('resume：送達後鎖內重檢發現列已變，印 STOP <n> delivered state <state>（與送出前的 STOP <n> state 區分），不改檔', t => {
  const stopped = batchText('7', 'dispatched 2026-11-18T10:00:00+08:00', [row(7, 'stop')]);
  const changed = batchText('7', 'dispatched 2026-11-18T10:00:00+08:00', [row(7, 'running')]);
  const { run, read, pilot, log, sends } = orcaFixture(t, { 7: stopped }, { screens: { term_7: ['STOP 7 decision x', '❯'] } });
  writeFileSync(`${log}.mutate`, JSON.stringify({ file: join(pilot, 'batch-7.md'), text: changed }));
  const result = run('resume', '7', '7', '--note', '繼續');
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, 'STOP 7 delivered state running\n');
  assert.equal(sends().length, 1);
  assert.equal(read('7'), changed);
});

test('resume 用法錯誤 exit 2：要 --note 一行文字；沒有 ORCA_CLI_COMMAND', t => {
  const { run } = orcaFixture(t, { 7: batchText('7', 'dispatched 2026-11-18T10:00:00+08:00', [row(7, 'stop')]) }, { screens: { term_7: ['❯'] } });
  assert.equal(run('resume', '7', '7').status, 2);
  assert.equal(run('resume', '7', '7', '--note', '  ').status, 2);
  assert.equal(run('resume', '7', '7', '--note', 'a\nb').status, 2);
  const plain = fixture(t, { 7: batchText('7', 'dispatched 2026-11-18T10:00:00+08:00', [row(7, 'stop')]) }, { ORCA_CLI_COMMAND: '' });
  assert.equal(plain.run('resume', '7', '7', '--note', '繼續').status, 2);
});

// accept（#338 第 1 項、#356 留言）：coordinator 代決 STOP decision、採用 worker 已回報的候選時，只能 sed 手改列（investing batch-372），
// 或重派一個 worker 只為交付已驗過的 candidate（#347 的 f688405）。
function gitFixture(t, batches) {
  return withGit(fixture(t, batches));
}

/** 在 fixture 的 checkout 開 git：main 一個 commit，`issue/372-x` 多一個；head 是分支 HEAD、base 是 main。 */
function withGit(fx) {
  const git = (...args) => spawnSync('git', ['-C', fx.dir, ...args], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('branch', 'issue/372-x');
  git('checkout', '-q', 'issue/372-x');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'candidate');
  git('checkout', '-q', 'main');
  return { ...fx, head: git('rev-parse', 'issue/372-x'), base: git('rev-parse', 'main') };
}

test('accept：running 或 stop 成員、SHA 是成員分支的 HEAD 時寫 done＋完整 SHA，印 ACCEPTED', t => {
  for (const state of ['running', 'stop']) {
    const { run, read, head } = gitFixture(t, { 372: batchText('372', 'dispatched 2026-11-19T10:00:00+08:00', [row(372, state)]) });
    const result = run('accept', '372', '372', head.slice(0, 7));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `ACCEPTED 372 372 ${head}\n`);
    assert.equal(read('372'), batchText('372', 'dispatched 2026-11-19T10:00:00+08:00', [row(372, 'done', head)]));
  }
});

test('accept：SHA 不是分支 HEAD、分支不存在、成員不是 running／stop 時 STOP，不改檔', t => {
  const batches = { '372-373': batchText('372-373', 'dispatched 2026-11-19T10:00:00+08:00', [row(372, 'stop'), row(373, 'stop'), row(374, 'done', A)]) };
  const { run, read, head, base } = gitFixture(t, batches);
  let result = run('accept', '372-373', '372', base);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, `STOP 372 sha ${head}\n`);
  assert.equal(run('accept', '372-373', '373', base).stdout, 'STOP 373 sha missing\n');
  assert.equal(run('accept', '372-373', '374', head).stdout, 'STOP 374 state done\n');
  assert.equal(run('accept', '372-373', '375', head).stdout, 'STOP 375 state missing\n');
  assert.equal(read('372-373'), batches['372-373']);
  assert.equal(run('accept', '372-373', '372').status, 2);
  assert.equal(run('accept', '372-373', '372', 'xyz').status, 2);
});

// review（#356 P2）：resume 後的 running 成員被 move 搬走時，resumed 行要跟著到新檔，Probe 才不會在新檔讀回畫面上的舊結果行。
test('move 把成員最後一行 resumed 帶到新檔；別的成員的 resumed 行不帶', t => {
  const text = `${batchText('5-6', 'dispatched 2026-11-18T10:00:00+08:00', [row(5, 'running'), row(6, 'running')])}resumed: #6 2026-11-18T11:00:00+08:00 STOP 6 old\nresumed: #5 2026-11-18T11:00:00+08:00 STOP 5 older\nresumed: #5 2026-11-18T12:00:00+08:00 DONE 5 ${A}\n`;
  const { run, read } = fixture(t, { '5-6': text });
  assert.equal(run('move', '5-6', '5').stdout, 'MOVED 5-6 5 batch-5\n');
  assert.equal(read('5'), `${batchText('5', 'dispatched 2026-11-18T10:00:00+08:00', [row(5, 'running')])}resumed: #5 2026-11-18T12:00:00+08:00 DONE 5 ${A}\n`);
});

// #502：成員的 postland 行（pilot-watch 記下的 POSTLAND 指令）跟著成員搬，否則 park 之後落地的 batch 不會印 POSTLAND_PENDING。
test('move 把成員的每一行 postland 帶到新檔；別的成員的 postland 行不帶', t => {
  const text = `${batchText('5-6', 'dispatched 2026-11-18T10:00:00+08:00', [row(5, 'running'), row(6, 'running')])}postland: #6 echo six\npostland: #5 make sync\npostland: #5 echo b\n`;
  const { run, read } = fixture(t, { '5-6': text });
  assert.equal(run('move', '5-6', '5').stdout, 'MOVED 5-6 5 batch-5\n');
  assert.equal(read('5'), `${batchText('5', 'dispatched 2026-11-18T10:00:00+08:00', [row(5, 'running')])}postland: #5 make sync\npostland: #5 echo b\n`);
});

// investing#549 第 1 項（#437）：watcher 已印 DONE 538 <sha>、Probe 還沒寫回時 move 530 538，新列仍是 running，pilot-land 538 印 STOP member 538 running。
test('move：running 成員畫面已有 DONE <n> <sha>、sha 是分支 HEAD 時新列寫 done＋完整 SHA，先印 APPLIED', t => {
  const batches = { '371-372': batchText('371-372', 'dispatched 2026-11-19T10:00:00+08:00', [row(371, 'running'), row(372, 'running')]) };
  const fx = orcaFixture(t, batches, { screens: { term_372: ['● 報告', '│ DONE 372 PLACEHOLDER │', '❯'], term_371: ['❯'] } });
  const { head } = withGit(fx);
  // 畫面上的 sha 要在 withGit 之後才知道：重寫假 Orca 的 screens 太繞，改寫 orca 腳本裡的佔位字。
  const cli = readFileSync(join(fx.log, '../orca'), 'utf8');
  writeFileSync(join(fx.log, '../orca'), cli.replace('PLACEHOLDER', head.slice(0, 7)));
  const result = fx.run('move', '371-372', '372');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `APPLIED 372 done ${head}\nMOVED 371-372 372 batch-372\n`);
  assert.equal(fx.read('372'), batchText('372', 'dispatched 2026-11-19T10:00:00+08:00', [row(372, 'done', head)]));
  assert.equal(fx.read('371-372'), batchText('371-372', 'dispatched 2026-11-19T10:00:00+08:00', [row(371, 'running'), row(372, 'moved batch-372')]));
});

test('move：畫面 DONE 的 sha 不是分支 HEAD 時 STOP <n> unapplied-result，不動檔；STOP 結果行寫成 stop；resume 記下的舊結果行不算', t => {
  const batches = {
    '371-372': batchText('371-372', 'dispatched 2026-11-19T10:00:00+08:00', [row(371, 'running'), row(372, 'running')]),
    '5-6': `${batchText('5-6', 'dispatched 2026-11-18T10:00:00+08:00', [row(5, 'running'), row(6, 'running')])}resumed: #6 2026-11-18T11:00:00+08:00 STOP 6 old\n`,
  };
  const fx = orcaFixture(t, batches, { screens: { term_372: [`DONE 372 ${A}`, '❯'], term_5: ['STOP 5 decision x', '❯'], term_6: ['STOP 6 old', '❯'] } });
  withGit(fx);
  const result = fx.run('move', '371-372', '372');
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, `STOP 372 unapplied-result DONE 372 ${A}\n`);
  assert.equal(fx.read('371-372'), batches['371-372']);
  assert.equal(fx.read('372'), null);
  assert.equal(fx.run('move', '5-6', '5').stdout, 'APPLIED 5 stop\nMOVED 5-6 5 batch-5\n');
  assert.match(fx.read('5'), /\| 5 \| .*\| stop \| \|\n/);
  assert.equal(fx.run('move', '5-6', '6').stdout, 'MOVED 5-6 6 batch-6 closed\n');
  assert.match(fx.read('6'), /\| 6 \| .*\| running \| \|\n/);
});

test('move：讀不到畫面時照舊搬成 running、stderr 印 WARN move；--state stop 不讀畫面', t => {
  const batches = { '371-372': batchText('371-372', 'dispatched 2026-11-19T10:00:00+08:00', [row(371, 'running'), row(372, 'running')]) };
  const fx = orcaFixture(t, batches, { screens: { term_371: [`DONE 371 ${A}`, '❯'] } });
  const result = fx.run('move', '371-372', '372');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MOVED 371-372 372 batch-372\n');
  assert.match(result.stderr, /^WARN move 372 orca terminal_handle_stale$/m);
  assert.match(fx.read('372'), /\| running \| \|\n/);
  assert.equal(fx.run('move', '371-372', '371', '--state', 'stop').stdout, 'MOVED 371-372 371 batch-371 closed\n');
  assert.match(fx.read('371'), /\| stop \| \|\n/);
  assert.equal(readFileSync(fx.log, 'utf8').split('\n').filter(line => line.includes('--terminal term_371')).length, 0);
});
