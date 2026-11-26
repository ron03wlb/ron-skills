// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-heavy-slot-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { ageMs, effectivePriority, holdersField, labelPriority, parseArgs, percentile, queuePlan, repoOf, resumeKey, resumeMs, repoPriority, repoPriorityFile, slotCommand, slotCount, slotDir, slotTimeoutLine, starveMs, statsLines, SLOT_TIMEOUT_EXIT } from './heavy-slot.mjs';

const script = new URL('./heavy-slot.mjs', import.meta.url).pathname;

function fixture(t, slots = 2, extraEnv = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'heavy-slot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HEAVY_CHECK_DIR: join(dir, 'locks'), HEAVY_CHECK_SLOTS: String(slots), HEAVY_CHECK_POLL: '0.05', ...extraEnv };
  delete env.HEAVY_SLOT_HELD;
  delete env.HEAVY_CHECK_AGE_S;
  delete env.HEAVY_CHECK_RESUME_S;
  delete env.HEAVY_CHECK_STARVE_S;
  // repo 優先序固定成預設值：不讀機器上真實的 ~/.config/orca-heavy-check/repo-priority。
  env.HEAVY_CHECK_REPO_PRIORITY = 'spay2,ron-skills';
  Object.assign(env, extraEnv);
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
  /** 拿著 slot 直到 release() 的持有者；傳回 { ...start 的結果, release }。 */
  const holdUntil = async (label, name = label.replace(/\W/g, '_')) => {
    const gate = join(dir, `release-${name}`);
    // 測試目錄被刪（測試失敗中途結束）時也結束：heavy-slot 被 SIGKILL 後命令是孤兒，不能一直留著。
    const run = start(label, `while [ ! -e ${gate} ] && [ -d ${dir} ]; do sleep 0.05; done`);
    await until(() => new RegExp(`SLOT_ACQUIRED ${label} `).test(run.stderr()), `${label} 拿到 slot`);
    return { ...run, release: () => spawnSync('touch', [gate]) };
  };
  /** 背景排一支命令（記下自己的名字到 order 檔），等到 status 列出它在排隊才傳回，確保 since 依呼叫順序。 */
  const enqueue = async (label, extra = []) => {
    const run = start(label, `echo ${label} >> ${dir}/order`, extra);
    await until(() => new RegExp(`^WAITER ${label} pid=${run.child.pid} `, 'm').test(status().stdout), `${label} 排進隊伍`);
    return run;
  };
  const order = () => (existsSync(join(dir, 'order')) ? readFileSync(join(dir, 'order'), 'utf8').trim().split('\n') : []);
  return { dir, env, start, status, until, holdUntil, enqueue, order };
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

test('排隊：同優先級照先來後到（FIFO），status 依排隊順序列出名次與優先級', async t => {
  const { status, holdUntil, enqueue, order } = fixture(t, 1);
  const hold = await holdUntil('t:hold');
  const first = await enqueue('t:first');
  const second = await enqueue('t:second');
  const third = await enqueue('t:third');
  const waiters = status().stdout.split('\n').filter(line => line.startsWith('WAITER'));
  assert.deepEqual(waiters.map(line => line.split(' ')[1]), ['t:first', 't:second', 't:third']);
  assert.match(waiters[0], / cwd=\S+ rank=1 priority=normal base=normal repo_rank=3$/);
  assert.match(waiters[2], / rank=3 priority=normal base=normal repo_rank=3$/);
  assert.match(await until2(() => third.stderr(), /^SLOT_WAIT t:third \d+s holders=t:hold@\d+:\d+s rank=3\/3 priority=normal$/m), /rank=3\/3/);
  hold.release();
  const results = await Promise.all([first.done, second.done, third.done, hold.done]);
  assert.deepEqual(results.map(r => r.code), [0, 0, 0, 0]);
  assert.deepEqual(order(), ['t:first', 't:second', 't:third']);
});

/** 輪詢 get() 直到符合 pattern，傳回符合的字串。 */
async function until2(get, pattern) {
  for (let i = 0; i < 200; i++) { const text = get(); if (pattern.test(text)) return text; await sleep(25); }
  assert.fail(`等不到 ${pattern}：${get()}`);
}

test('同一個 repo 內看用途：後到的 push-gate 排在先到的 pre-commit 前面；--priority 可覆寫', async t => {
  const { status, holdUntil, enqueue, order } = fixture(t, 1);
  const hold = await holdUntil('t:hold');
  const commit = await enqueue('r:pre-commit');
  const forced = await enqueue('r:pre-commit-forced', ['--priority', 'normal']);
  const push = await enqueue('r:push-gate');
  const waiters = status().stdout.split('\n').filter(line => line.startsWith('WAITER'));
  assert.deepEqual(waiters.map(line => line.split(' ')[1]), ['r:push-gate', 'r:pre-commit-forced', 'r:pre-commit']);
  assert.match(waiters[2], / rank=3 priority=low base=low repo_rank=3$/);
  hold.release();
  await Promise.all([commit.done, forced.done, push.done, hold.done]);
  assert.deepEqual(order(), ['r:push-gate', 'r:pre-commit-forced', 'r:pre-commit']);
});

test('repo 優先序：spay2 在等時，較早排隊的 ron-skills（即使是 push-gate）也拿不到；spay2 沒在等就照常', async t => {
  const { dir, start, status, holdUntil, enqueue, order, until } = fixture(t, 2);
  const a1 = await holdUntil('ron-skills:one');
  const a2 = await holdUntil('ron-skills:two');
  const early = await enqueue('ron-skills:push-gate');
  // spay2 後到，拿到 slot 後記下名字、拿著直到 release-spay。
  const gate = join(dir, 'release-spay');
  const spay = start('spay2:pre-commit', `echo spay2:pre-commit >> ${dir}/order; while [ ! -e ${gate} ] && [ -d ${dir} ]; do sleep 0.05; done`);
  await until(() => new RegExp(`^WAITER spay2:pre-commit pid=${spay.child.pid} .* rank=1 priority=low base=low repo_rank=1$`, 'm').test(status().stdout), 'spay2 排在第一');
  assert.match(status().stdout, /^WAITER ron-skills:push-gate .* rank=2 priority=high base=high repo_rank=2$/m);
  a1.release();
  await until(() => order().includes('spay2:pre-commit'), 'spay2 拿到空出的 slot');
  assert.deepEqual(order(), ['spay2:pre-commit']);
  // spay2 已不在等：ron-skills 照常拿下一個空出的 slot（已經在跑的 spay2 不受影響）。
  a2.release();
  await until(() => order().includes('ron-skills:push-gate'), 'ron-skills:push-gate 在 spay2 沒人等之後拿到 slot');
  spawnSync('touch', [gate]);
  assert.deepEqual((await Promise.all([a1.done, a2.done, early.done, spay.done])).map(r => r.code), [0, 0, 0, 0]);
  assert.deepEqual(order(), ['spay2:pre-commit', 'ron-skills:push-gate']);
});

test('repo 優先序可設定：HEAVY_CHECK_REPO_PRIORITY 把 ron-skills 排到 spay2 前面', async t => {
  const { holdUntil, enqueue, order, status } = fixture(t, 1, { HEAVY_CHECK_REPO_PRIORITY: 'ron-skills,spay2' });
  const hold = await holdUntil('t:hold');
  const spay = await enqueue('spay2:push-gate');
  const ron = await enqueue('ron-skills:pre-commit');
  const waiters = status().stdout.split('\n').filter(line => line.startsWith('WAITER'));
  assert.deepEqual(waiters.map(line => line.split(' ')[1]), ['ron-skills:pre-commit', 'spay2:push-gate']);
  hold.release();
  await Promise.all([hold.done, spay.done, ron.done]);
  assert.deepEqual(order(), ['ron-skills:pre-commit', 'spay2:push-gate']);
});

test('repoPriority：環境變數 > ~/.config/orca-heavy-check/repo-priority（一行一個、略過空行與 #）> spay2、ron-skills', t => {
  const home = mkdtempSync(join(realTmpdir(), 'heavy-slot-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(repoPriority({ HOME: home }), ['spay2', 'ron-skills'], '沒有設定檔');
  mkdirSync(join(home, '.config/orca-heavy-check'), { recursive: true });
  writeFileSync(repoPriorityFile({ HOME: home }), '# 越前面越優先\ninvesting\n\n spay2 \n');
  assert.deepEqual(repoPriority({ HOME: home }), ['investing', 'spay2']);
  assert.deepEqual(repoPriority({ HOME: home, HEAVY_CHECK_REPO_PRIORITY: 'a,b' }), ['a', 'b'], '環境變數優先');
});

test('防餓死：pre-commit 等超過 HEAVY_CHECK_AGE_S 就升級，排到後到的 check 前面', async t => {
  const { status, holdUntil, enqueue, order, until } = fixture(t, 1, { HEAVY_CHECK_AGE_S: '1' });
  const hold = await holdUntil('t:hold');
  const commit = await enqueue('r:pre-commit');
  // 負載高時 status 一次要上百毫秒，可能直接看到第二次升級（high），兩者都算升級了。
  await until(() => / rank=1 priority=(normal|high) base=low repo_rank=3$/m.test(status().stdout), 'pre-commit 升級');
  const check = await enqueue('s:check');
  const waiters = status().stdout.split('\n').filter(line => line.startsWith('WAITER'));
  assert.deepEqual(waiters.map(line => line.split(' ')[1]), ['r:pre-commit', 's:check'], '升級後排在後到的 check 前面');
  hold.release();
  await Promise.all([commit.done, check.done, hold.done]);
  assert.deepEqual(order(), ['r:pre-commit', 's:check']);
});

test('排在前面的等待者被 SIGKILL：wait 檔被清掉，後面的照樣拿到 slot', async t => {
  const { status, holdUntil, enqueue, order, until } = fixture(t, 1);
  const hold = await holdUntil('t:hold');
  const dead = await enqueue('t:dead');
  const next = await enqueue('t:next');
  dead.child.kill('SIGKILL');
  await dead.done;
  await until(() => !/^WAITER t:dead /m.test(status().stdout), 't:dead 從隊伍消失');
  hold.release();
  const result = await next.done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(order(), ['t:next']);
  await hold.done;
});

test('log.jsonl 加 priority、effective_priority；沒有這兩欄的舊紀錄 stats 照讀', async t => {
  const { env } = fixture(t, 1);
  const child = spawnSync(process.execPath, [script, 'run', '--label', 'r:push-gate', '--', 'true'], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const log = join(env.HEAVY_CHECK_DIR, 'log.jsonl');
  const [record] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(record.priority, 'high');
  assert.equal(record.effective_priority, 'high');
  writeFileSync(log, `${JSON.stringify({ label: 'r:push-gate', wait_ms: 1, run_ms: 2, started_at: '2026-11-23T00:00:00Z', timed_out: false })}\n`, { flag: 'a' });
  const stats = spawnSync(process.execPath, [script, 'stats'], { env, encoding: 'utf8' });
  assert.match(stats.stdout, /^STATS r:push-gate n=2 timeouts=0 /m);
});

test('labelPriority、effectivePriority、queuePlan：對照表、升級與分配規則', () => {
  assert.equal(labelPriority('spay2:push-gate'), 'high');
  assert.equal(labelPriority('ron-skills:land-checks'), 'high');
  assert.equal(labelPriority('x:land'), 'high');
  assert.equal(labelPriority('x:pre-push'), 'high');
  assert.equal(labelPriority('spay2:check-contracts'), 'normal');
  assert.equal(labelPriority('ron-skills:regression'), 'normal');
  assert.equal(labelPriority('x:whatever'), 'normal');
  assert.equal(labelPriority('nolabel'), 'normal');
  assert.equal(labelPriority('ron-skills:pre-commit'), 'low');
  assert.equal(labelPriority('x:landing-page'), 'normal', '只認整個詞或 land- 開頭');
  const since = '2026-11-24T00:00:00Z';
  const at = min => Date.parse(since) + min * 60_000;
  assert.equal(effectivePriority('low', since, at(14), 900_000), 'low');
  assert.equal(effectivePriority('low', since, at(15), 900_000), 'normal');
  assert.equal(effectivePriority('low', since, at(31), 900_000), 'high');
  assert.equal(effectivePriority('high', since, at(60), 900_000), 'high');
  assert.equal(effectivePriority('low', since, at(60), 0), 'low', '0 不升級');
  assert.equal(ageMs({}), 900_000);
  assert.equal(ageMs({ HEAVY_CHECK_AGE_S: '60' }), 60_000);
  const w = (pid, label, priority, sec) => ({ pid, label, priority, since: new Date(Date.parse(since) + sec * 1000).toISOString() });
  const now = at(1);
  const repos = ['spay2', 'ron-skills'];
  // 2 個 slot 都空、只有一個 repo 在等：同 repo 內依用途與先後，用滿。
  let plan = queuePlan({ holders: [], waiters: [w(3, 'a:x', 'normal', 2), w(1, 'a:y', 'normal', 1), w(2, 'a:pre-commit', 'low', 0)], slots: 2, now, repos });
  assert.deepEqual(plan.order.map(x => x.pid), [1, 3, 2]);
  assert.deepEqual([...plan.granted], [1, 3]);
  // spay2 在等：先到的 ron-skills（push-gate）與其他 repo 都不拿，空著的第二個 slot 也不給（spay2 只有一個在等）。
  plan = queuePlan({ holders: [], waiters: [w(1, 'ron-skills:push-gate', 'high', 0), w(2, 'spay2:pre-commit', 'low', 50), w(3, 'x:check', 'normal', 0)], slots: 2, now, repos });
  assert.deepEqual(plan.order.map(x => x.pid), [2, 1, 3]);
  assert.deepEqual(plan.order.map(x => x.repoRank), [0, 1, 2]);
  assert.deepEqual([...plan.granted], [2]);
  // spay2 沒在等：ron-skills 優先於其他 repo。
  plan = queuePlan({ holders: [{ label: 'spay2:check', pid: 9 }], waiters: [w(3, 'x:push-gate', 'high', 0), w(1, 'ron-skills:pre-commit', 'low', 30)], slots: 2, now, repos });
  assert.deepEqual([...plan.granted], [1]);
  // 都滿：沒人拿到（不搶占）。
  plan = queuePlan({ holders: [{ label: 'ron-skills:h', pid: 8 }, { label: 'ron-skills:h', pid: 9 }], waiters: [w(1, 'spay2:push-gate', 'high', 0)], slots: 2, now, repos });
  assert.deepEqual([...plan.granted], []);
  // 防餓死只給最前面那一級：spay2 在等時，等了很久的 ron-skills pre-commit 不升級；spay2 不在時才升。
  const late = at(60);
  plan = queuePlan({ holders: [], waiters: [w(1, 'ron-skills:pre-commit', 'low', 0), w(2, 'spay2:pre-commit', 'low', 3500)], slots: 1, now: late, age: 900_000, repos });
  assert.equal(plan.order.find(x => x.pid === 1).effective, 'low');
  assert.deepEqual([...plan.granted], [2]);
  plan = queuePlan({ holders: [], waiters: [w(1, 'ron-skills:pre-commit', 'low', 0)], slots: 1, now: late, age: 900_000, repos });
  assert.equal(plan.order[0].effective, 'high');
  assert.match(parseArgs(['run', '--label', 'x:y', '--priority', 'urgent', '--', 'true']).error, /--priority/);
  assert.equal(parseArgs(['run', '--label', 'x:y', '--priority', 'low', '--', 'true']).priority, 'low');
});

test('沒有冒號或用途不認得的 label（例如手動跑的 dbg）：優先級 normal，整個 label 當 repo，在 repo 優先序裡排最後', async t => {
  assert.equal(labelPriority('dbg'), 'normal');
  assert.equal(labelPriority('spay2:weird-use'), 'normal');
  const since = '2026-11-24T00:00:00Z';
  const now = Date.parse(since) + 60_000;
  assert.equal(repoOf('dbg'), 'dbg');
  // dbg 是沒列在優先序裡的 repo：ron-skills 在等時排在後面、拿不到；只剩它在等時照常拿。
  const dbgWaiter = { pid: 2, label: 'dbg', priority: labelPriority('dbg'), since };
  let plan = queuePlan({ holders: [], waiters: [dbgWaiter, { pid: 1, label: 'ron-skills:pre-commit', priority: 'low', since: '2026-11-24T00:00:10Z' }], slots: 1, now, repos: ['spay2', 'ron-skills'] });
  assert.deepEqual(plan.order.map(w => w.pid), [1, 2]);
  assert.deepEqual([...plan.granted], [1]);
  plan = queuePlan({ holders: [], waiters: [dbgWaiter], slots: 1, now, repos: ['spay2', 'ron-skills'] });
  assert.deepEqual([...plan.granted], [2]);
  // 實際跑：dbg 排進隊伍、status 顯示 normal，持有者放掉後照順序拿到。
  const { status, holdUntil, enqueue, order } = fixture(t, 1);
  const hold = await holdUntil('t:hold');
  const dbg = await enqueue('dbg');
  const check = await enqueue('x:check');
  const waiters = status().stdout.split('\n').filter(line => line.startsWith('WAITER'));
  assert.match(waiters[0], /^WAITER dbg pid=\d+ .* rank=1 priority=normal base=normal repo_rank=3$/);
  hold.release();
  await Promise.all([hold.done, dbg.done, check.done]);
  assert.deepEqual(order(), ['dbg', 'x:check']);
});

/** 鎖檔目錄裡的 resume-*.json。 */
const resumeFiles = env => (existsSync(env.HEAVY_CHECK_DIR) ? readdirSync(env.HEAVY_CHECK_DIR).filter(name => /^resume-[0-9a-f]+\.json$/.test(name)) : []);

test('逾時後照原指令重跑：沿用原 since，排在逾時期間才進場的等待者前面；拿到 slot 後刪掉紀錄（retro 00abd5f9#1）', async t => {
  const { dir, env, start, status, holdUntil, enqueue, order, until } = fixture(t, 1);
  const hold = await holdUntil('t:hold');
  const command = `echo t:a >> ${dir}/order`;
  const first = await start('t:a', command, ['--timeout', '0.5']).done;
  assert.equal(first.code, SLOT_TIMEOUT_EXIT, first.stderr);
  assert.doesNotMatch(first.stderr, /^SLOT_RESUMED/m, '第一次不是沿用');
  assert.equal(resumeFiles(env).length, 1, '逾時留下 resume 紀錄');
  const b = await enqueue('t:b');
  const again = start('t:a', command);
  await until(() => new RegExp(`^WAITER t:a pid=${again.child.pid} `, 'm').test(status().stdout), 't:a 重跑後排進隊伍');
  const waiters = status().stdout.split('\n').filter(line => line.startsWith('WAITER'));
  assert.deepEqual(waiters.map(line => line.split(' ')[1]), ['t:a', 't:b'], '重跑的 t:a 仍排在後到的 t:b 前面');
  assert.match(await until2(() => again.stderr(), /^SLOT_RESUMED /m), /^SLOT_RESUMED t:a since=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/m);
  hold.release();
  const results = await Promise.all([again.done, b.done, hold.done]);
  assert.deepEqual(results.map(r => r.code), [0, 0, 0]);
  assert.deepEqual(order(), ['t:a', 't:b']);
  assert.deepEqual(resumeFiles(env), [], '拿到 slot 後刪掉紀錄');
});

test('resume 紀錄過期（HEAVY_CHECK_RESUME_S）不沿用並清掉；不同指令不共用紀錄', async t => {
  const { dir, env, start, status, holdUntil, enqueue, order, until } = fixture(t, 1, { HEAVY_CHECK_RESUME_S: '0.3' });
  const hold = await holdUntil('t:hold');
  const command = `echo t:a >> ${dir}/order`;
  assert.equal((await start('t:a', command, ['--timeout', '0.3']).done).code, SLOT_TIMEOUT_EXIT);
  assert.equal(resumeFiles(env).length, 1);
  await sleep(600);
  const b = await enqueue('t:b');
  const again = start('t:a', command);
  await until(() => new RegExp(`^WAITER t:a pid=${again.child.pid} `, 'm').test(status().stdout), 't:a 重跑後排進隊伍');
  const waiters = status().stdout.split('\n').filter(line => line.startsWith('WAITER'));
  assert.deepEqual(waiters.map(line => line.split(' ')[1]), ['t:b', 't:a'], '過期紀錄不沿用：排在 t:b 後面');
  assert.doesNotMatch(again.stderr(), /^SLOT_RESUMED/m);
  assert.deepEqual(resumeFiles(env), [], '過期紀錄已清掉');
  hold.release();
  assert.deepEqual((await Promise.all([again.done, b.done, hold.done])).map(r => r.code), [0, 0, 0]);
  assert.deepEqual(order(), ['t:b', 't:a']);
  // 鍵是 label＋cwd＋argv：任一不同就是另一筆。
  assert.equal(resumeKey('t:a', '/x', ['a']), resumeKey('t:a', '/x', ['a']));
  assert.notEqual(resumeKey('t:a', '/x', ['a']), resumeKey('t:a', '/x', ['b']));
  assert.notEqual(resumeKey('t:a', '/x', ['a']), resumeKey('t:a', '/y', ['a']));
  assert.notEqual(resumeKey('t:a', '/x', ['a b']), resumeKey('t:a', '/x', ['a', 'b']));
  assert.equal(resumeMs({}), 7_200_000);
  assert.equal(resumeMs({ HEAVY_CHECK_RESUME_S: '60' }), 60_000);
  assert.equal(resumeMs({ HEAVY_CHECK_RESUME_S: '0' }), 0);
});

test('餓死保底 queuePlan：低優先 repo 等滿門檻可拿 1 個空出的 slot；未滿、已有保底 slot、沒空 slot、門檻 0 都拿不到', () => {
  const since = '2026-11-26T00:00:00Z';
  const w = (pid, label, priority, sec) => ({ pid, label, priority, since: new Date(Date.parse(since) + sec * 1000).toISOString() });
  const repos = ['spay2', 'ron-skills'];
  const starve = 7_200_000;
  const now = Date.parse(since) + starve; // pid 1（since 0 秒）剛好等滿門檻
  const spay = w(9, 'spay2:check', 'normal', 7000);
  // 等滿門檻、1 個 slot 空出：ron-skills 拿到，spay2 這輪不拿（只剩的那個給了保底）。
  let plan = queuePlan({ holders: [{ label: 'x:h', pid: 50 }], waiters: [w(1, 'ron-skills:pre-commit', 'low', 0), spay], slots: 2, now, repos, starve });
  assert.equal(plan.starved, 1);
  assert.deepEqual([...plan.granted], [1]);
  assert.deepEqual(plan.order.map(x => [x.pid, x.starve]), [[9, false], [1, true]], '排序不變，只是標出 starve');
  // 2 個 slot 空出：保底拿 1 個，另一個照舊給 spay2。
  plan = queuePlan({ holders: [], waiters: [w(1, 'ron-skills:pre-commit', 'low', 0), spay], slots: 2, now, repos, starve });
  assert.deepEqual([...plan.granted].sort(), [1, 9]);
  // 差 1 秒未滿門檻：拿不到。
  plan = queuePlan({ holders: [{ label: 'x:h', pid: 50 }], waiters: [w(1, 'ron-skills:pre-commit', 'low', 1), spay], slots: 2, now, repos, starve });
  assert.equal(plan.starved, undefined);
  assert.deepEqual([...plan.granted], [9]);
  assert.equal(plan.order.find(x => x.pid === 1).starve, false);
  // 已有 1 個保底 slot 在用：第 2 個等滿門檻的低優先等待者拿不到，空出的 slot 給 spay2。
  plan = queuePlan({ holders: [{ label: 'ron-skills:pre-commit', pid: 1, starve: true }], waiters: [w(2, 'ron-skills:check', 'normal', 0), spay], slots: 2, now, repos, starve });
  assert.equal(plan.starved, undefined);
  assert.deepEqual([...plan.granted], [9]);
  assert.equal(plan.order.find(x => x.pid === 2).starve, true, '仍標出已符合，只是保底 slot 被佔');
  // 沒有空 slot：不搶占正在跑的檢查。
  plan = queuePlan({ holders: [{ label: 'spay2:a', pid: 50 }, { label: 'spay2:b', pid: 51 }], waiters: [w(1, 'ron-skills:pre-commit', 'low', 0), spay], slots: 2, now, repos, starve });
  assert.deepEqual([...plan.granted], []);
  assert.equal(plan.starved, undefined);
  // 門檻 0：規則關閉，等再久也不拿、不標。
  plan = queuePlan({ holders: [{ label: 'x:h', pid: 50 }], waiters: [w(1, 'ron-skills:pre-commit', 'low', -86400), spay], slots: 2, now, repos, starve: 0 });
  assert.deepEqual([...plan.granted], [9]);
  assert.equal(plan.order.find(x => x.pid === 1).starve, false);
  // 多個符合：給 since 最早的（跨 repo 級別），而且只給 1 個。
  plan = queuePlan({ holders: [], waiters: [w(1, 'ron-skills:check', 'normal', -10), w(2, 'dbg', 'normal', -20), spay], slots: 3, now, repos, starve });
  assert.equal(plan.starved, 2);
  assert.deepEqual([...plan.granted].sort(), [2, 9]);
  // 最前面那一級自己不適用保底（它本來就會拿到）。
  plan = queuePlan({ holders: [], waiters: [w(1, 'ron-skills:check', 'normal', -10)], slots: 1, now, repos, starve });
  assert.equal(plan.starved, undefined);
  assert.deepEqual([...plan.granted], [1]);
  assert.equal(starveMs({}), 7_200_000);
  assert.equal(starveMs({ HEAVY_CHECK_STARVE_S: '0' }), 0);
  assert.equal(starveMs({ HEAVY_CHECK_STARVE_S: '30' }), 30_000);
  assert.equal(starveMs({ HEAVY_CHECK_STARVE_S: 'x' }), 7_200_000);
});

test('餓死保底實跑：spay2 在等、ron-skills 等滿 HEAVY_CHECK_STARVE_S，持有者放掉後 ron-skills 拿到（status、SLOT_WAIT、log 都標 starve）；不搶占', async t => {
  const { dir, env, start, status, holdUntil, enqueue, order, until } = fixture(t, 1, { HEAVY_CHECK_STARVE_S: '1' });
  const hold = await holdUntil('t:hold');
  const gate = join(dir, 'release-ron');
  const ron = start('ron-skills:pre-commit', `echo ron-skills:pre-commit >> ${dir}/order; while [ ! -e ${gate} ] && [ -d ${dir} ]; do sleep 0.05; done`);
  await until(() => /^WAITER ron-skills:pre-commit /m.test(status().stdout), 'ron-skills 排進隊伍');
  const spay = await enqueue('spay2:check');
  await until(() => /^WAITER ron-skills:pre-commit .* repo_rank=2 starve=1$/m.test(status().stdout), 'ron-skills 標 starve=1');
  await until2(() => ron.stderr(), /^SLOT_WAIT ron-skills:pre-commit \d+s holders=t:hold@\d+:\d+s rank=2\/2 priority=low starve=1$/m);
  // 不搶占：持有者還在跑時誰都沒拿到。
  assert.deepEqual(order(), []);
  assert.match(status().stdout, /^SLOTS 1\/1 /m);
  hold.release();
  await until(() => order().includes('ron-skills:pre-commit'), 'ron-skills 用保底拿到 slot');
  assert.match(ron.stderr(), /^SLOT_ACQUIRED ron-skills:pre-commit slot-1\/1 waited=\d+s starve=1$/m);
  assert.match(status().stdout, /^HOLDER slot-1 ron-skills:pre-commit pid=\d+ held=\d+s cwd=\S+ starve=1$/m);
  spawnSync('touch', [gate]);
  assert.deepEqual((await Promise.all([hold.done, ron.done, spay.done])).map(r => r.code), [0, 0, 0]);
  assert.deepEqual(order(), ['ron-skills:pre-commit', 'spay2:check']);
  const log = readFileSync(join(env.HEAVY_CHECK_DIR, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(r => [r.label, r.starve]).sort(), [['ron-skills:pre-commit', true], ['spay2:check', false], ['t:hold', false]]);
  assert.doesNotMatch(spay.stderr(), /starve=1/);
});

test('餓死保底實跑：已有 1 個保底 slot 在用時，第 2 個等滿門檻的低優先等待者拿不到，空出的 slot 給 spay2', async t => {
  const { dir, start, status, holdUntil, order, until } = fixture(t, 2, { HEAVY_CHECK_STARVE_S: '1' });
  const h1 = await holdUntil('t:one');
  const h2 = await holdUntil('t:two');
  const gated = (label, name) => start(label, `echo ${label} >> ${dir}/order; while [ ! -e ${join(dir, `release-${name}`)} ] && [ -d ${dir} ]; do sleep 0.05; done`);
  const ronA = gated('ron-skills:pre-commit', 'a');
  await until(() => /^WAITER ron-skills:pre-commit /m.test(status().stdout), 'ron-skills:pre-commit 排進隊伍');
  const ronB = gated('ron-skills:check', 'b');
  await until(() => /^WAITER ron-skills:check /m.test(status().stdout), 'ron-skills:check 排進隊伍');
  const spay = gated('spay2:check', 's');
  await until(() => /^WAITER spay2:check /m.test(status().stdout), 'spay2 排進隊伍');
  await until(() => (status().stdout.match(/ starve=1$/gm) ?? []).length === 2, '兩個 ron-skills 都符合保底');
  h1.release();
  await until(() => order().includes('ron-skills:pre-commit'), '較早的 ron-skills 用保底拿到 slot');
  await until(() => /^HOLDER .* ron-skills:pre-commit .* starve=1$/m.test(status().stdout), '保底 slot 記在鎖檔');
  h2.release();
  await until(() => order().includes('spay2:check'), 'spay2 拿到第二個空出的 slot');
  await sleep(300);
  assert.deepEqual(order(), ['ron-skills:pre-commit', 'spay2:check'], '第 2 個低優先等待者沒拿到');
  // spay2 已不在等：ron-skills 成了最前面那一級，不再標 starve，等一般 slot 空出。
  assert.match(status().stdout, /^WAITER ron-skills:check .* repo_rank=2$/m);
  // 保底 slot 釋放後，ron-skills:check 照常拿到空出的 slot。
  spawnSync('touch', [join(dir, 'release-a')]);
  await until(() => order().includes('ron-skills:check'), '保底 slot 釋放後 ron-skills:check 拿到');
  for (const name of ['b', 's']) spawnSync('touch', [join(dir, `release-${name}`)]);
  assert.deepEqual((await Promise.all([h1.done, h2.done, ronA.done, ronB.done, spay.done])).map(r => r.code), [0, 0, 0, 0, 0]);
});

test('餓死保底：HEAVY_CHECK_STARVE_S=0 關閉，spay2 在等時 ron-skills 等再久也不拿、不標 starve', async t => {
  const { status, holdUntil, enqueue, order } = fixture(t, 1, { HEAVY_CHECK_STARVE_S: '0' });
  const hold = await holdUntil('t:hold');
  const ron = await enqueue('ron-skills:pre-commit');
  const spay = await enqueue('spay2:check');
  await sleep(1200);
  assert.doesNotMatch(status().stdout, /starve=1/);
  hold.release();
  await Promise.all([hold.done, ron.done, spay.done]);
  assert.deepEqual(order(), ['spay2:check', 'ron-skills:pre-commit']);
  assert.doesNotMatch(ron.stderr(), /starve=1/);
});

test('同一筆 resume 紀錄只給一個重跑行程沿用：同時重跑兩次，只有一支印 SLOT_RESUMED（spay2 #1159 Codex 發現）', async t => {
  const { dir, env, start, status, holdUntil, until } = fixture(t, 1);
  const hold = await holdUntil('t:hold');
  const command = `echo t:a >> ${dir}/order`;
  assert.equal((await start('t:a', command, ['--timeout', '0.3']).done).code, SLOT_TIMEOUT_EXIT);
  const one = start('t:a', command);
  const two = start('t:a', command);
  await until(() => (status().stdout.match(/^WAITER t:a /gm) ?? []).length === 2, '兩支 t:a 都排進隊伍');
  hold.release();
  const results = await Promise.all([one.done, two.done, hold.done]);
  assert.deepEqual(results.map(r => r.code), [0, 0, 0]);
  assert.equal(results.slice(0, 2).filter(r => /^SLOT_RESUMED /m.test(r.stderr)).length, 1, '只有一支沿用');
  assert.deepEqual(resumeFiles(env), []);
});

test('同鍵兩支先後逾時：resume 紀錄保留較早的 since（spay2 #1159 Codex 發現）', async t => {
  const { dir, env, start, holdUntil } = fixture(t, 1);
  const hold = await holdUntil('t:hold');
  const command = `echo t:a >> ${dir}/order`;
  const first = start('t:a', command, ['--timeout', '0.4']);
  await sleep(200);
  const second = start('t:a', command, ['--timeout', '0.6']);
  assert.equal((await first.done).code, SLOT_TIMEOUT_EXIT);
  const [file] = resumeFiles(env);
  const early = JSON.parse(readFileSync(join(env.HEAVY_CHECK_DIR, file), 'utf8')).since;
  assert.equal((await second.done).code, SLOT_TIMEOUT_EXIT);
  assert.equal(JSON.parse(readFileSync(join(env.HEAVY_CHECK_DIR, file), 'utf8')).since, early, '較晚逾時的不覆蓋較早的 since');
  hold.release();
  await hold.done;
});

test('resume 紀錄清不掉（同名路徑是目錄）不影響檢查執行（spay2 #1159 Codex 發現）', async t => {
  const { dir, env, start } = fixture(t, 1, { HEAVY_CHECK_RESUME_S: '0' });
  const argv = ['sh', '-c', `echo ran >> ${dir}/order`];
  mkdirSync(join(env.HEAVY_CHECK_DIR, `resume-${resumeKey('t:a', process.cwd(), argv)}.json`), { recursive: true });
  const result = await start('t:a', argv[2]).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'order'), 'utf8').trim(), 'ran');
});
