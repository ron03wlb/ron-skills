// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-heavy-slot-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { holdersField, parseArgs, percentile, slotCommand, slotCount, slotDir, slotTimeoutLine, statsLines, SLOT_TIMEOUT_EXIT } from './heavy-slot.mjs';

const script = new URL('./heavy-slot.mjs', import.meta.url).pathname;

function fixture(t, slots = 2) {
  const dir = mkdtempSync(join(realTmpdir(), 'heavy-slot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HEAVY_CHECK_DIR: join(dir, 'locks'), HEAVY_CHECK_SLOTS: String(slots), HEAVY_CHECK_POLL: '0.05' };
  delete env.HEAVY_SLOT_HELD;
  const children = [];
  t.after(() => children.forEach(child => child.kill('SIGKILL')));
  /** 背景跑 run：傳回 { child, done（{ code, stderr }）, stderr() }。 */
  const start = (label, command, extra = []) => {
    const child = spawn(process.execPath, [script, 'run', '--label', label, '--interval', '0.1', ...extra, '--', 'sh', '-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
    return { child, done, stderr: () => stderr };
  };
  const status = () => spawnSync(process.execPath, [script, 'status'], { env, encoding: 'utf8' });
  const until = async (predicate, what) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(25); }
    assert.fail(`等不到：${what}`);
  };
  return { dir, env, start, status, until };
}

test('同時最多 HEAVY_CHECK_SLOTS 支，第三支排隊印 SLOT_WAIT（帶持有者），有人釋放才執行', async t => {
  const { dir, start, status, until } = fixture(t, 2);
  const gate = join(dir, 'release');
  // 每支命令記下開始，等 gate 檔出現才結束。
  const hold = name => `echo ${name} >> ${dir}/started; while [ ! -e ${gate} ]; do sleep 0.05; done`;
  const a = start('t:a', hold('a'));
  const b = start('t:b', hold('b'));
  const started = () => (existsSync(join(dir, 'started')) ? readFileSync(join(dir, 'started'), 'utf8').trim().split('\n') : []);
  await until(() => started().length === 2, 'a、b 都開始');
  const c = start('t:c', `echo c >> ${dir}/started`);
  await until(() => /SLOT_WAIT t:c \d+s holders=t:[ab]@\d+:\d+s,t:[ab]@\d+:\d+s/.test(c.stderr()), 'c 印 SLOT_WAIT 與兩個持有者');
  assert.deepEqual(started().sort(), ['a', 'b'], 'slot 滿時 c 不執行');
  const listed = status();
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^SLOTS 2\/2 dir=/m);
  assert.match(listed.stdout, /^HOLDER slot-\d t:a pid=\d+ held=\d+s cwd=/m);
  assert.match(listed.stdout, /^WAITER t:c pid=\d+ waited=\d+s cwd=/m);
  spawnSync('touch', [gate]);
  const results = await Promise.all([a.done, b.done, c.done]);
  assert.deepEqual(results.map(r => r.code), [0, 0, 0]);
  assert.deepEqual(started().sort(), ['a', 'b', 'c']);
  assert.match(results[2].stderr, /^SLOT_ACQUIRED t:c slot-[12]\/2 waited=\d+s$/m);
  assert.match(status().stdout, /^SLOTS 0\/2 /m, '都結束後沒有持有者');
  assert.doesNotMatch(status().stdout, /^WAITER/m, '排隊檔已清掉');
});

test('exit code 照傳；命令拿到 HEAVY_SLOT_HELD，巢狀 run 直接執行不再拿 slot', async t => {
  const { start } = fixture(t, 1);
  const failed = await start('t:fail', 'exit 7').done;
  assert.equal(failed.code, 7);
  // 只有 1 個 slot：巢狀的 run 若再去拿就會等到逾時。
  const nested = await start('t:outer', `echo "held=$HEAVY_SLOT_HELD"; node ${script} run --label t:inner --timeout 1 -- sh -c 'exit 5'`).done;
  assert.equal(nested.code, 5, nested.stderr);
  assert.match(nested.stdout, /^held=t:outer slot-1$/m);
  assert.match(nested.stderr, /^SLOT_NESTED t:inner held=t:outer slot-1$/m);
});

test('持有者被 SIGKILL：flock 隨行程釋放，排隊的下一支拿到 slot', async t => {
  const { dir, start, until } = fixture(t, 1);
  const holder = start('t:dies', `echo $$ > ${dir}/sh.pid; exec sleep 30`);
  await until(() => /SLOT_ACQUIRED t:dies/.test(holder.stderr()), 't:dies 拿到 slot');
  // 等到 pid 寫完整：空字串會變成 process.kill(0)，殺到整個行程群組。
  await until(() => existsSync(join(dir, 'sh.pid')) && /^\d+\n$/.test(readFileSync(join(dir, 'sh.pid'), 'utf8')), 't:dies 的命令開始');
  // 命令本身是孤兒，測完要收掉（t.after 只殺得到 heavy-slot 本身）。
  // 先讀 pid 再註冊：t.after 依註冊順序執行，fixture 的刪目錄排在前面。
  const orphan = Number(readFileSync(join(dir, 'sh.pid'), 'utf8'));
  t.after(() => { try { process.kill(orphan, 'SIGKILL'); } catch { /* 已結束 */ } });
  const next = start('t:next', 'echo ran');
  await until(() => /SLOT_WAIT t:next/.test(next.stderr()), 't:next 排隊');
  holder.child.kill('SIGKILL');
  const result = await next.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ran$/m);
  assert.match(result.stderr, /^SLOT_ACQUIRED t:next slot-1\/1 /m);
});

test('等到上限：印 SLOT_TIMEOUT、exit 75，不執行命令', async t => {
  const { dir, start, until } = fixture(t, 1);
  const gate = join(dir, 'release');
  const holder = start('t:hold', `while [ ! -e ${gate} ]; do sleep 0.05; done`);
  await until(() => /SLOT_ACQUIRED t:hold/.test(holder.stderr()), 't:hold 拿到 slot');
  const late = await start('t:late', `touch ${dir}/late-ran`, ['--timeout', '0.5']).done;
  assert.equal(late.code, SLOT_TIMEOUT_EXIT);
  assert.match(late.stderr, /^SLOT_TIMEOUT t:late \d+s holders=t:hold@\d+:\d+s$/m);
  assert.ok(!existsSync(join(dir, 'late-ran')), '逾時不執行命令');
  assert.equal(slotTimeoutLine(late.code, late.stderr), late.stderr.match(/^SLOT_TIMEOUT .*$/m)[0]);
  spawnSync('touch', [gate]);
  assert.equal((await holder.done).code, 0);
});

test('參數：label、--、數值都要合法；環境變數給預設值', () => {
  assert.match(parseArgs(['run', '--', 'true']).error, /--label/);
  assert.match(parseArgs(['run', '--label', 'a b', '--', 'true']).error, /--label/);
  assert.match(parseArgs(['run', '--label', 'x:y']).error, /--/);
  assert.match(parseArgs(['run', '--label', 'x:y', '--timeout', '-1', '--', 'true']).error, /--timeout/);
  assert.match(parseArgs(['run', '--label', 'x:y', '--interval', '0', '--', 'true']).error, /--interval/);
  assert.match(parseArgs(['nope']).error, /子命令/);
  assert.deepEqual(parseArgs(['run', '--label', 'x:y', '--', 'bin/check', '--upstream'], { HEAVY_CHECK_TIMEOUT: '60' }),
    { command: 'run', label: 'x:y', timeoutSec: 60, intervalSec: 30, argv: ['bin/check', '--upstream'] });
  assert.deepEqual(parseArgs(['status']), { command: 'status' });
  const usage = spawnSync(process.execPath, [script, 'run', '--label', 'x:y'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const badSlots = spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8', env: { ...process.env, HEAVY_CHECK_SLOTS: '0' } });
  assert.equal(badSlots.status, 2);
});

test('slotCommand、slotTimeoutLine、holdersField：給呼叫端的 helper', () => {
  const [command, args] = slotCommand('repo:regression', ['sh', '-c', 'bin/check'], { timeoutSec: 120 });
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [script, 'run', '--label', 'repo:regression', '--timeout', '120', '--', 'sh', '-c', 'bin/check']);
  assert.deepEqual(slotCommand('r:x', ['true'])[1], [script, 'run', '--label', 'r:x', '--', 'true']);
  assert.equal(slotCommand('個人 wiki:regression', ['true'])[1][3], '___wiki:regression', '目錄名的空白、中文換成 _');
  assert.equal(slotTimeoutLine(75, 'x\nSLOT_TIMEOUT r:x 9s holders=-\n'), 'SLOT_TIMEOUT r:x 9s holders=-');
  assert.equal(slotTimeoutLine(1, 'SLOT_TIMEOUT r:x 9s holders=-'), undefined, '不是 75 不算');
  assert.equal(slotTimeoutLine(75, 'CHECK_FAIL x'), undefined, '沒有 SLOT_TIMEOUT 行不算');
  assert.equal(holdersField([]), '-');
  assert.equal(holdersField([{ label: 'a:b', pid: 3, since: '2026-01-01T00:00:00Z' }], Date.parse('2026-01-01T00:01:05Z')), 'a:b@3:65s');
});

test('slot 數：環境變數 > ~/.config/orca-heavy-check/slots > 2；鎖檔目錄預設 ~/.local/state/orca-heavy-check', t => {
  const home = mkdtempSync(join(realTmpdir(), 'heavy-slot-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(slotCount({ HOME: home }), 2, '沒有設定檔');
  mkdirSync(join(home, '.config/orca-heavy-check'), { recursive: true });
  writeFileSync(join(home, '.config/orca-heavy-check/slots'), '3\n');
  assert.equal(slotCount({ HOME: home }), 3, '設定檔');
  assert.equal(slotCount({ HOME: home, HEAVY_CHECK_SLOTS: '1' }), 1, '環境變數優先');
  writeFileSync(join(home, '.config/orca-heavy-check/slots'), 'two');
  assert.equal(slotCount({ HOME: home }), undefined, '設定檔不是正整數');
  assert.equal(slotDir({ HOME: home }), join(home, '.local/state/orca-heavy-check'));
  assert.equal(slotDir({ HOME: home, HEAVY_CHECK_DIR: '/x' }), '/x');
});

test('每次 run 在 log.jsonl 記一行（含逾時）；stats 依 label 印件數、中位數與 P90', async t => {
  const { dir, env, start, until } = fixture(t, 1);
  const gate = join(dir, 'release');
  const ok = await start('r:pass', 'exit 0').done;
  assert.equal(ok.code, 0);
  const holder = start('r:hold', `while [ ! -e ${gate} ]; do sleep 0.05; done; exit 3`);
  await until(() => /SLOT_ACQUIRED r:hold/.test(holder.stderr()), 'r:hold 拿到 slot');
  assert.equal((await start('r:late', 'true', ['--timeout', '0.3']).done).code, SLOT_TIMEOUT_EXIT);
  spawnSync('touch', [gate]);
  assert.equal((await holder.done).code, 3);
  const records = readFileSync(join(env.HEAVY_CHECK_DIR, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(r => [r.label, r.exit, r.timed_out]), [['r:pass', 0, false], ['r:late', 75, true], ['r:hold', 3, false]]);
  for (const r of records) {
    assert.equal(r.repo, 'r');
    assert.ok(Number.isInteger(r.pid) && Number.isInteger(r.wait_ms) && Number.isInteger(r.run_ms) && typeof r.load1 === 'number', JSON.stringify(r));
    assert.ok(!Number.isNaN(Date.parse(r.started_at)), r.started_at);
  }
  assert.ok(records[1].wait_ms >= 300 && records[1].run_ms === 0, '逾時的等待時間到上限、沒有執行時間');
  const stats = spawnSync(process.execPath, [script, 'stats', '--label', 'r:*'], { env, encoding: 'utf8' });
  assert.equal(stats.status, 0, stats.stderr);
  assert.match(stats.stdout, /^STATS r:late n=1 timeouts=1 wait_p50=\d+ wait_p90=\d+ run_p50=- run_p90=-$/m);
  assert.match(stats.stdout, /^STATS r:pass n=1 timeouts=0 wait_p50=\d+ wait_p90=\d+ run_p50=\d+ run_p90=\d+$/m);
  const future = spawnSync(process.execPath, [script, 'stats', '--since', '2999-01-01T00:00:00Z'], { env, encoding: 'utf8' });
  assert.equal(future.stdout, 'STATS none\n');
});

test('statsLines：nearest-rank 中位數與 P90、--since、--label glob、壞行略過', () => {
  const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((wait, i) => JSON.stringify({ label: 'a:x', wait_ms: wait, run_ms: wait * 2, started_at: `2026-11-23T0${i % 10}:00:00Z`, timed_out: false }));
  const text = [...rows, 'not json', JSON.stringify({ label: 'b:y', wait_ms: 5, run_ms: 0, started_at: '2026-11-23T00:00:00Z', timed_out: true })].join('\n');
  assert.deepEqual(statsLines(text), [
    'STATS a:x n=10 timeouts=0 wait_p50=50 wait_p90=90 run_p50=100 run_p90=180',
    'STATS b:y n=1 timeouts=1 wait_p50=5 wait_p90=5 run_p50=- run_p90=-',
  ]);
  assert.deepEqual(statsLines(text, { label: 'b:?' }), ['STATS b:y n=1 timeouts=1 wait_p50=5 wait_p90=5 run_p50=- run_p90=-']);
  assert.deepEqual(statsLines(text, { since: '2026-11-23T08:00:00Z', label: 'a:*' }), ['STATS a:x n=2 timeouts=0 wait_p50=90 wait_p90=100 run_p50=180 run_p90=200']);
  assert.equal(percentile([], 50), undefined);
  assert.match(parseArgs(['stats', '--since', 'nope']).error, /--since/);
});
