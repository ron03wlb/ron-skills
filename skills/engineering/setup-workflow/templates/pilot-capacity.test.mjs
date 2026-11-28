// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PENDING, check, closeSession, machineTotal, missingEnv, readLedger, renameSession, report, reserveSession, sessionRows, touchSessions } from './pilot-capacity.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-capacity.mjs', import.meta.url));
const ledger = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-capacity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state/pilot-workers.tsv');
};
const run = (file, args, extra = {}) => {
  const env = { ...process.env, PILOT_WORKERS_LEDGER: file, ...extra };
  if (!('PILOT_MACHINE_WORKER_CAP' in extra)) delete env.PILOT_MACHINE_WORKER_CAP;
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
};
const NOW = new Date('2026-10-31T12:00:00+08:00');
const ago = minutes => new Date(NOW.getTime() - minutes * 60000).toISOString();

test('report 只改寫自己那一列，其他 repo 的列原樣保留；沒有帳本時建出來', t => {
  const file = ledger(t);
  assert.deepEqual(report(file, 'ron-skills', 2, { now: NOW, cap: 4 }), { running: 2, total: 2, cap: 4 });
  assert.equal(readFileSync(file, 'utf8'), `ron-skills\t2\t${NOW.toISOString()}\n`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}investing\t1\t${ago(5)}\n`);
  assert.deepEqual(report(file, 'ron-skills', 3, { now: NOW, cap: 4 }), { running: 3, total: 4, cap: 4 });
  assert.equal(readFileSync(file, 'utf8'), `ron-skills\t3\t${NOW.toISOString()}\ninvesting\t1\t${ago(5)}\n`);
});

// #353：dispatch 派出後以 add 把派出人數加進自己那一列；超過 2 小時沒更新的舊值不算。
test('report 帶 add：寫入自己那一列的現值加上人數，舊列（超過 2 小時）以 0 起算', t => {
  const file = ledger(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `ron-skills\t2\t${ago(5)}\ninvesting\t1\t${ago(5)}\n`);
  assert.deepEqual(report(file, 'ron-skills', 1, { now: NOW, cap: 4, add: true }), { running: 3, total: 4, cap: 4 });
  assert.equal(readFileSync(file, 'utf8'), `ron-skills\t3\t${NOW.toISOString()}\ninvesting\t1\t${ago(5)}\n`);
  writeFileSync(file, `ron-skills\t2\t${ago(180)}\n`);
  assert.deepEqual(report(file, 'ron-skills', 1, { now: NOW, cap: 4, add: true }), { running: 1, total: 1, cap: 4 });
  assert.deepEqual(report(file, 'new-repo', 2, { now: NOW, cap: 4, add: true }), { running: 2, total: 3, cap: 4 });
});

test('合計不算超過 2 小時沒更新的列與壞掉的列', t => {
  const file = ledger(t);
  report(file, 'x', 0, { now: NOW, cap: 4 });
  writeFileSync(file, `a\t2\t${ago(119)}\nb\t3\t${ago(121)}\nc\tmany\t${ago(1)}\nd\t1\tyesterday\ngarbage\n`);
  assert.equal(machineTotal(readLedger(file), NOW), 2);
});

test('check：合計加上新增人數不超過上限印 CAPACITY ok，超過印 STOP capacity、exit 4', t => {
  const file = ledger(t);
  report(file, 'ron-skills', 2, { cap: 4 });
  report(file, 'investing', 1, { cap: 4 });
  const ok = run(file, ['check', '1'], { PILOT_MACHINE_WORKER_CAP: '4' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'CAPACITY ok 4/4\n');
  const over = run(file, ['check', '2'], { PILOT_MACHINE_WORKER_CAP: '4' });
  assert.equal(over.status, 4, over.stderr);
  assert.equal(over.stdout, 'STOP capacity 5/4 ron-skills=2 investing=1 +2\n');
  const raised = run(file, ['check', '2'], { PILOT_MACHINE_WORKER_CAP: '6' });
  assert.equal(raised.stdout, 'CAPACITY ok 5/6\n');
});

// #494：缺變數的行自帶預設值與處理方式（設在哪裡），coordinator 不必去 adapter 的長條目找。
test('沒有帳本時 check 以 0 起算；上限沒設時先印 CAPACITY_ENV_MISSING（附預設 4 與設定位置）再用預設 4', t => {
  const file = ledger(t);
  const missing = 'CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP default 4 → 告訴人：設在 ~/.claude/settings.json 的 env\n';
  assert.equal(run(file, ['check', '4']).stdout, `${missing}CAPACITY ok 4/4\n`);
  assert.equal(run(file, ['check', '5']).stdout, `${missing}STOP capacity 5/4 +5\n`);
  assert.equal(run(file, ['check', '5'], { PILOT_MACHINE_WORKER_CAP: '' }).stdout, `${missing}STOP capacity 5/4 +5\n`);
  assert.equal(existsSync(file), false);
  assert.equal(run(file, ['report', 'ron-skills', '1']).stdout, `${missing}REPORTED ron-skills 1 1/4\n`);
});

// #396：Bash tool 的 shell 讀不到 ~/.zshrc，變數空白時容量檢查曾經默默略過 investing、默默用預設上限。
// env 子指令逐一檢查 $PILOT_MACHINE_WORKER_CAP 與帶入的名稱，空白的各印一行 CAPACITY_ENV_MISSING <名稱>，都有值時印 CAPACITY_ENV ok。
test('env：INVESTING_DATA_ROOT 未設或空字串時印 CAPACITY_ENV_MISSING INVESTING_DATA_ROOT，都有值時印 CAPACITY_ENV ok', t => {
  const file = ledger(t);
  const unset = run(file, ['env', 'INVESTING_DATA_ROOT'], { PILOT_MACHINE_WORKER_CAP: '4', INVESTING_DATA_ROOT: undefined });
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(unset.stdout, 'CAPACITY_ENV_MISSING INVESTING_DATA_ROOT → 告訴人：設在 ~/.claude/settings.json 的 env\n');
  const both = run(file, ['env', 'INVESTING_DATA_ROOT'], { PILOT_MACHINE_WORKER_CAP: '', INVESTING_DATA_ROOT: '' });
  assert.equal(both.stdout, 'CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP default 4 → 告訴人：設在 ~/.claude/settings.json 的 env\nCAPACITY_ENV_MISSING INVESTING_DATA_ROOT → 告訴人：設在 ~/.claude/settings.json 的 env\n');
  const set = run(file, ['env', 'INVESTING_DATA_ROOT'], { PILOT_MACHINE_WORKER_CAP: '4', INVESTING_DATA_ROOT: '/data' });
  assert.equal(set.stdout, 'CAPACITY_ENV ok\n');
  assert.equal(run(file, ['env'], { PILOT_MACHINE_WORKER_CAP: '4' }).stdout, 'CAPACITY_ENV ok\n');
  assert.equal(run(file, ['env', 'BAD-NAME'], { PILOT_MACHINE_WORKER_CAP: '4' }).status, 2);
  assert.equal(existsSync(file), false);
});

test('missingEnv 只把未設與空字串算缺', () => {
  assert.deepEqual(missingEnv(['A', 'B', 'C'], { A: '', C: '0' }), ['A', 'B']);
});

test('CLI report 印 REPORTED <repo> <running> <合計>/<上限>', t => {
  const file = ledger(t);
  const result = run(file, ['report', 'ron-skills', '3'], { PILOT_MACHINE_WORKER_CAP: '4' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'REPORTED ron-skills 3 3/4\n');
  assert.match(readFileSync(file, 'utf8'), /^ron-skills\t3\t\d{4}-\d\d-\d\dT/);
});

test('用法錯誤 exit 2：缺參數、人數不是非負整數、repo 帶 tab、上限不是正整數', t => {
  const file = ledger(t);
  for (const args of [[], ['check'], ['check', '-1'], ['report', 'a'], ['report', 'a\tb', '1'], ['report', 'a', '1.5'], ['bogus', '1'], ['constructor'], ['toString', '1']]) {
    assert.equal(run(file, args).status, 2, `${JSON.stringify(args)} 應該是用法錯誤`);
  }
  assert.equal(run(file, ['check', '1'], { PILOT_MACHINE_WORKER_CAP: '0' }).status, 2);
  assert.equal(existsSync(file), false);
});

test('兩個 coordinator 同時 report 各 15 次：兩列都在，沒留下暫存檔與鎖', async t => {
  const file = ledger(t);
  // 以檔案跑（node -e 沒有 argv[1]，被測腳本的進入點判斷會失敗）；放在帳本目錄外。
  const writer = join(dirname(dirname(file)), 'writer.mjs');
  writeFileSync(writer, `import { report } from ${JSON.stringify(SCRIPT)};\nfor (let i = 0; i < 15; i++) report(process.argv[2], process.argv[3], i % 3, { cap: 4 });\n`);
  const loop = repo => new Promise((resolve, reject) => {
    const child = spawn('node', [writer, file, repo], { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${repo} exit ${code}`))));
  });
  mkdirSync(dirname(file), { recursive: true });
  await Promise.all([loop('a'), loop('b'), loop('c')]);
  assert.deepEqual(readLedger(file).map(row => row.repo).sort(), ['a', 'b', 'c']);
  assert.deepEqual(readdirSync(dirname(file)), ['pilot-workers.tsv']);
});

test('持有者被殺留下的鎖超過 30 秒就拿掉重來', t => {
  const file = ledger(t);
  mkdirSync(`${file}.lock`, { recursive: true });
  const old = new Date(Date.now() - 60000);
  utimesSync(`${file}.lock`, old, old);
  assert.deepEqual(report(file, 'a', 1, { cap: 4 }), { running: 1, total: 1, cap: 4 });
  assert.equal(existsSync(`${file}.lock`), false);
});

// #622：fix unit 與 /retro-collect 分頁也跑完整檢查，記成 session 列算進合計。
test('CLI open 記一筆 fix session 後 check 的合計多 1；剛好滿時 STOP capacity exit 4；close 之後不計', t => {
  const file = ledger(t);
  const env = { PILOT_MACHINE_WORKER_CAP: '3' };
  assert.equal(run(file, ['report', 'ron-skills', '2'], env).status, 0);
  assert.equal(run(file, ['check', '1'], env).stdout.trim(), 'CAPACITY ok 3/3');
  const opened = run(file, ['open', 'ron-skills', 'fix', 'term_fix'], env);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout.trim(), 'SESSION_OPENED term_fix ron-skills fix 3/3');
  assert.equal(run(file, ['check', '0'], env).stdout.trim(), 'CAPACITY ok 3/3');
  const full = run(file, ['check', '1'], env);
  assert.equal(full.status, 4);
  assert.equal(full.stdout.trim(), 'STOP capacity 4/3 ron-skills=2 ron-skills:fix=1 +1');
  assert.equal(run(file, ['report', 'ron-skills', '2'], env).stdout.trim(), 'REPORTED ron-skills 2 3/3');
  const closed = run(file, ['close', 'term_fix'], env);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(closed.stdout.trim(), 'SESSION_CLOSED term_fix');
  assert.equal(run(file, ['check', '1'], env).stdout.trim(), 'CAPACITY ok 3/3');
  assert.equal(run(file, ['close', 'term_fix'], env).stdout.trim(), 'SESSION_NONE term_fix');
});

test('session 列：超過 2 小時沒刷新的不計，touchSessions 刷新後再計；report 改寫 repo 列時 session 列原樣保留', t => {
  const file = ledger(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `ron-skills\t1\t${ago(5)}\nsession\tron-skills\tretro\tterm_old\t${ago(121)}\nsession\tspay2\tfix\tterm_new\t${ago(10)}\n`);
  assert.equal(machineTotal(readLedger(file), NOW), 2);
  assert.deepEqual(check(file, 0, { now: NOW, cap: 4 }).rows.map(row => `${row.repo}=${row.running}`), ['ron-skills=1', 'spay2:fix=1']);
  report(file, 'ron-skills', 2, { now: NOW, cap: 4 });
  assert.match(readFileSync(file, 'utf8'), /session\tspay2\tfix\tterm_new\t/);
  assert.deepEqual(touchSessions(file, ['term_new'], { now: NOW }), ['term_new']);
  assert.equal(machineTotal(readLedger(file), NOW), 3);
  // 超過 2 小時的 session 列在改寫時清掉（它已不計，留著只讓帳本變長）。
  assert.doesNotMatch(readFileSync(file, 'utf8'), /term_old/);
  assert.deepEqual(sessionRows(readLedger(file)).map(row => row.handle), ['term_new']);
  assert.equal(closeSession(file, 'term_new', { now: NOW }), true);
  assert.equal(machineTotal(readLedger(file), NOW), 2);
});

test('open 用法錯誤 exit 2：kind 不是 fix|retro、handle 空或帶空白、repo 是保留字 session', t => {
  const file = ledger(t);
  for (const args of [['open', 'ron-skills', 'worker', 'term_x'], ['open', 'ron-skills', 'fix', 'term x'], ['open', 'ron-skills', 'fix'], ['open', 'session', 'fix', 'term_x'], ['close'], ['report', 'session', '1']]) {
    assert.equal(run(file, args).status, 2, args.join(' '));
  }
});

// #622 review：check 與記帳分開時，兩個 coordinator 會各自通過最後一個名額；預留在同一把鎖裡檢查並寫入。
test('reserveSession：同一把鎖裡檢查並寫一筆 pending 列，名額只給第一個；renameSession 換成真的 handle', t => {
  const file = ledger(t);
  const first = reserveSession(file, { repo: 'ron-skills', kind: 'fix' }, { now: NOW, cap: 1 });
  assert.equal(first.ok, true);
  assert.ok(first.handle.startsWith(PENDING), first.handle);
  const second = reserveSession(file, { repo: 'spay2', kind: 'retro' }, { now: NOW, cap: 1 });
  assert.deepEqual({ ok: second.ok, total: second.total, rows: second.rows }, { ok: false, total: 2, rows: [{ repo: 'ron-skills:fix', running: 1 }] });
  assert.equal(sessionRows(readLedger(file)).length, 1);
  assert.equal(renameSession(file, first.handle, 'term_fix', { now: NOW }), true);
  assert.deepEqual(sessionRows(readLedger(file)).map(row => row.handle), ['term_fix']);
});
