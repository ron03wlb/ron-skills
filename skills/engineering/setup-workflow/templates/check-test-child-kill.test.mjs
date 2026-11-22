// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { findLeaks } from './check-test-child-kill.mjs';

const SCRIPT = new URL('./check-test-child-kill.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

// spay2 #279 實作時漏殺子行程的原始寫法：assertion 失敗時 a.kill() 不會執行，sleep 300 讓 node --test 卡到外層逾時（spay2 #284）。
const HISTORY = [
  "test('stale 鎖留有衝突殘留：不自動取回', t => {",
  '  const f = fixture(t);',
  "  const a = spawn('sleep', ['300'], { stdio: 'ignore' });",
  '  conflicted(t, f, a.pid);',
  "  a.kill(); spawnSync('sleep', ['0.2']);",
  "  const stale = merge(f.repo, 'y');",
  "  assert.equal(stale.word, 'INTEGRATION_STALE');",
  '});',
  '',
].join('\n');
// 當時的修正：在 spawn 的下一行補上 t.after。
const FIXED = HISTORY.replace("{ stdio: 'ignore' });\n  conflicted", "{ stdio: 'ignore' });\n  t.after(() => a.kill());\n  conflicted");

test('漏殺的歷史寫法被抓到，行號指向 spawn 那行', () => {
  assert.deepEqual(findLeaks(HISTORY), [{ line: 3, name: 'a', call: 'spawn' }]);
});

test('修正版（下一行 t.after kill）通過', () => {
  assert.notEqual(FIXED, HISTORY);
  assert.deepEqual(findLeaks(FIXED), []);
});

test('同一行以分號接 t.after、多行引數、try 包住的 kill、process.kill 都算有註冊', () => {
  assert.deepEqual(findLeaks("const owner = spawn('sleep', ['300'], { stdio: 'ignore' }); t.after(() => owner.kill());\n"), []);
  assert.deepEqual(findLeaks("const holder = spawn('node', ['-e', `setTimeout(() => {\n  x(); }, 700)`], { stdio: 'ignore' });\nt.after(() => holder.kill());\n"), []);
  assert.deepEqual(findLeaks("const w = fork(script);\nt.after(() => { try { w.kill('SIGKILL'); } catch { /* 已結束 */ } });\n"), []);
  assert.deepEqual(findLeaks("const w = execFile('x');\nctx.after(() => process.kill(w.pid));\n"), []);
});

test('下一個語句不是 t.after、或 t.after 沒有 kill 這個子行程，都算漏殺', () => {
  assert.deepEqual(findLeaks("const c = spawn('sleep', ['300']);\nassert.equal(1, 2);\nt.after(() => c.kill());\n").map(leak => leak.line), [1]);
  assert.deepEqual(findLeaks("let c;\nc = fork('x');\nt.after(() => other.kill());\n"), [{ line: 2, name: 'c', call: 'fork' }]);
  assert.deepEqual(findLeaks("const c = child_process.execFile('x');\n").map(leak => leak.call), ['execFile']);
});

test('等待 close／exit 的一次性子行程、沒有變數的 spawn、Sync 版本、字串與註解內的 spawn 不檢查', () => {
  assert.deepEqual(findLeaks("await new Promise(done => {\n  const child = spawn('bash', [s]);\n  let out = ''; child.stdout.on('data', d => { out += d; });\n  child.on('close', status => done(status));\n});\n"), []);
  assert.deepEqual(findLeaks("const c = spawn('x');\nc.once('exit', resolve);\n"), []);
  assert.deepEqual(findLeaks("return spawn(process.execPath, ['-e', 'x'], options);\nspawn('sh', ['-c', 'sleep 1']).unref();\n"), []);
  assert.deepEqual(findLeaks("const r = spawnSync('sleep', ['1']);\nconst e = execFileSync('git', ['status']);\n"), []);
  assert.deepEqual(findLeaks("const src = `const c = spawn('sleep', ['300']);`;\n// const d = spawn('sleep');\n/* const e = fork('x'); */\nconst re = /const f = spawn\\(/;\n"), []);
});

test('鏈上 .on() 仍回傳子行程，照樣檢查；鏈上直接監聽 close 視為一次性', () => {
  assert.deepEqual(findLeaks("const child = spawn('sleep', ['300']).on('error', handler);\nassert.ok(child.pid);\n"), [{ line: 1, name: 'child', call: 'spawn' }]);
  assert.deepEqual(findLeaks("const child = spawn('sleep', ['300'])\n  .on('error', handler);\nt.after(() => child.kill());\n"), []);
  assert.deepEqual(findLeaks("const child = spawn('bash', [s]).on('close', done);\n"), []);
});

test('註解或字串裡的 .on(\'close\') 不算監聽', () => {
  const commented = HISTORY.replace('  conflicted(t, f, a.pid);', "  // a.on('close', done);\n  conflicted(t, f, a.pid);");
  assert.equal(findLeaks(commented).length, 1);
  assert.deepEqual(findLeaks("const c = spawn('x');\nconst s = \"c.on('close', r)\";\n").map(leak => leak.name), ['c']);
});

test('CLI：違規時每處印一行 檔案:行 與修正方式並 exit 1；只掃 *.test.mjs；沒有違規 exit 0', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'child-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'history.test.mjs'), HISTORY);
  writeFileSync(join(dir, 'helper.mjs'), HISTORY);
  const bad = run(dir);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  const lines = bad.stderr.trim().split('\n');
  assert.equal(lines.length, 1, '只掃 *.test.mjs');
  assert.match(lines[0], new RegExp(`^${join(dir, 'history.test.mjs')}:3 `));
  assert.match(lines[0], /t\.after\(\(\) => a\.kill\(\)\);/);
  writeFileSync(join(dir, 'history.test.mjs'), FIXED);
  const good = run(dir);
  assert.equal(good.status, 0, good.stdout + good.stderr);
});

test('CLI：目錄不存在 exit 2', () => {
  const result = run(join(realTmpdir(), 'no-such-dir-child-kill'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /讀不到/);
});

test('本目錄（不帶參數的預設範圍）所有 *.test.mjs 都通過檢查', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});
