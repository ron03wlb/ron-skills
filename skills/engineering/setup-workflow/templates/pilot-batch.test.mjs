import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-batch.mjs', import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const HEADER = '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n';
// 空的 candidate 照 pilot-dispatch 寫成 `| |`。
const row = (n, state, candidate = '') => `| ${n} | issue/${n}-x | /w/issue-${n} | term_${n} | 2026-10-31T11:29:04+08:00 | 90m | ${state} |${candidate ? ` ${candidate} ` : ' '}|`;
const batchText = (key, current, rows) => `# batch ${key}\ncurrent: ${current}\nintegration: pilot/integration @ 370114b\n\n${HEADER}${rows.join('\n')}\n`;

/** 只有 `.scratch/pilot/` 與給定 batch checkpoint 的 checkout；`run` 跑 pilot-batch，`read` 讀 batch 檔（不存在回 null）。 */
function fixture(t, batches) {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pilot = join(dir, '.scratch/pilot');
  mkdirSync(pilot, { recursive: true });
  for (const [key, text] of Object.entries(batches)) writeFileSync(join(pilot, `batch-${key}.md`), text);
  const run = (...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8' });
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
