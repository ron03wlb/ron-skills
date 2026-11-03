import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failedFiles, lostFiles, parseRan, recordedPass, reportedTotal, soloOptions, untraced } from './node-test-guarded.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./node-test-guarded.mjs', import.meta.url));

/** 暫存目錄放 fixture 測試檔，以 wrapper 執行。 */
function fixture(t, files, extraEnv = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'node-test-guarded-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_TEST_COUNT_FILE', 'NODE_TEST_COUNT_ROOT', 'NODE_TEST_COUNTED', 'NODE_OPTIONS', 'NODE_TEST_GUARD_WAIT_MS', 'NODE_TEST_RERUN_TIMEOUT_MS', 'NODE_TEST_FLAKE_MAX_FILES']) delete env[key];
  Object.assign(env, extraEnv);
  return (...args) => spawnSync(process.execPath, [SCRIPT, '--test-force-exit', ...args], { cwd: dir, encoding: 'utf8', env });
}

// Node 22 沒有 node.test tracing channel：wrapper 放行、不偵測遺失，偵測遺失的測試只在有 channel 時跑
const PROBE = "import { tracingChannel } from 'node:diagnostics_channel';\nlet seen = false;\n"
  + "tracingChannel('node.test').subscribe({ start() {}, asyncStart() {}, asyncEnd() {}, error() {}, end() { seen = true; } });\n"
  + "process.on('exit', () => process.stderr.write(String(seen)));\nconst { test } = await import('node:test');\ntest('probe', () => {});\n";
const NO_CHANNEL = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { encoding: 'utf8' }).stderr.trim() !== 'true'
  && `${process.version} 沒有 node.test tracing channel`;

const PASS = "import { test, describe, it } from 'node:test';\ndescribe('g', () => { it('x', () => {}); it('y', () => {}); });\ntest('o', async t => { await t.test('sub', () => {}); });\ntest.skip('s', () => {});\n";

test('parseRan／reportedTotal／lostFiles：以 spec 輸出的名稱逐檔比對；同名分屬多檔時兩檔都算', () => {
  const ran = parseRan('{"file":"/a.test.mjs","names":["x","y"]}\n{"file":"/b.test.mjs","names":["z","w","y"]}\n{"file":"/a.test.mjs","names":["v"]}\n');
  assert.deepEqual([...ran], [['/a.test.mjs', ['x', 'y', 'v']], ['/b.test.mjs', ['z', 'w', 'y']]]);
  const output = '▶ g\n  ✔ x (1.2ms)\n✔ g (3ms)\n✔ v (1ms)\n✔ y (2ms)\n✔ z (1ms)\n﹣ skipped (0.5ms) # SKIP\nℹ tests 5\nℹ suites 1\n';
  assert.equal(reportedTotal(output), 5);
  assert.equal(reportedTotal('no summary'), null);
  assert.deepEqual(lostFiles(ran, output), [{ file: '/a.test.mjs', ran: 3, missing: 1 }, { file: '/b.test.mjs', ran: 3, missing: 2 }]);
  assert.deepEqual(lostFiles(parseRan('{"file":"/a.test.mjs","names":["x","v"]}\n'), output), []);
  assert.equal(untraced('{"file":"/a.test.mjs","names":[],"traced":false}\n{"file":"/b.test.mjs","names":[],"traced":false}\n'), true);
  assert.equal(untraced('{"file":"/a.test.mjs","names":[],"traced":false}\n{"file":"/b.test.mjs","names":["z"],"traced":true}\n'), false);
  assert.equal(untraced(''), false);
});

test('全部回報：exit 0，輸出照舊是 spec（含 suite、子測試、skip）', t => {
  const run = fixture(t, { 'a.test.mjs': PASS, 'b.test.mjs': "import { test } from 'node:test';\ntest('b', () => {});\n" });
  const result = run('a.test.mjs', 'b.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ tests 6$/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_LOST/);
});

test('子行程記下跑完的測試名稱：不必等候逾時，exit 0、不印 NODE_TEST_LOST', t => {
  const run = fixture(t, { 'a.test.mjs': PASS }, { NODE_TEST_GUARD_WAIT_MS: '1000' });
  const result = run('a.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /NODE_TEST_LOST|NODE_TEST_COUNT_MISMATCH/);
});

test('測試失敗且單獨重跑仍失敗：回傳 node --test 的 exit code，不另印 NODE_TEST_LOST', t => {
  const run = fixture(t, { 'f.test.mjs': "import { test } from 'node:test';\ntest('f', () => { throw new Error('boom'); });\n" });
  const result = run('f.test.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /boom/);
  assert.doesNotMatch(result.stderr, /NODE_TEST_LOST/);
});

// 第二個測試起吞掉子行程送往父行程的結果，模擬長跑測試檔尾段靜默消失；CUT 檔存在時第三個測試中途 exit 0，子行程紀錄留下沒有結束的測試；
// FLAKY_ONCE 檔存在時 MUTE、CUT 都只作用第一次，之後單獨重跑正常
const LOSSY = "import { test } from 'node:test';\nimport { existsSync, rmSync } from 'node:fs';\ntest('a', () => {});\n"
  + "test('mute', () => { if (existsSync('MUTE')) { if (existsSync('FLAKY_ONCE')) rmSync('MUTE'); process.stdout.write = () => true; } });\n"
  + "test('cut', () => { if (existsSync('CUT')) { if (existsSync('FLAKY_ONCE')) rmSync('CUT'); process.exit(0); } });\n"
  + "for (const n of [1, 2, 3]) test(`t${n}`, () => {});\n";

// 第一次失敗、之後通過：以 FAIL_ONCE 檔記狀態（不共用 LOSSY 的 FLAKY_ONCE，兩檔並行時才不互相影響），模擬高負載下才失敗的測試（retro spay2 92fa93fe#3：單獨重跑全過）。
const FLAKY = "import { test } from 'node:test';\nimport { existsSync, rmSync } from 'node:fs';\n"
  + "test('flaky', () => { if (existsSync('FAIL_ONCE')) { rmSync('FAIL_ONCE'); throw new Error('boom'); } });\n";
const OK = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const BROKEN = "import { test } from 'node:test';\ntest('broken', () => { throw new Error('boom'); });\n";

test('第一次失敗、單獨重跑通過：exit 0，印 NODE_TEST_FLAKE_SUSPECT，只重跑失敗的檔', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'flaky.test.mjs': FLAKY, 'ok.test.mjs': OK, FAIL_ONCE: '' });
  const result = run('flaky.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs$/m);
  assert.doesNotMatch(result.stderr, /ok\.test\.mjs/);
  assert.equal(result.stdout.match(/^✔ ok\b/gm).length, 1, '通過的檔不重跑');
});

test('兩次都失敗：回傳第一次的 exit code，印 NODE_TEST_RERUN FAIL，不印 NODE_TEST_FLAKE_SUSPECT', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'broken.test.mjs': BROKEN, 'ok.test.mjs': OK });
  const result = run('broken.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_RERUN broken\.test\.mjs FAIL$/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_FLAKE_SUSPECT/);
});

test('多檔失敗：一檔重跑通過、一檔仍失敗：exit 1，只有通過的檔算 NODE_TEST_FLAKE_SUSPECT', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'broken.test.mjs': BROKEN, 'flaky.test.mjs': FLAKY, FAIL_ONCE: '' });
  const result = run('broken.test.mjs', 'flaky.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs$/m);
  assert.match(result.stderr, /^NODE_TEST_RERUN broken\.test\.mjs FAIL$/m);
});

test('測試檔載入就失敗且重跑仍失敗：exit 非 0，不算 flake', t => {
  const run = fixture(t, { 'crash.test.mjs': "throw new Error('boom');\n" });
  const result = run('crash.test.mjs');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /NODE_TEST_FLAKE_SUSPECT/);
});

test('失敗的檔超過重跑上限：不逐檔重跑，印 NODE_TEST_FLAKE_SKIPPED、exit 非 0', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'a.test.mjs': BROKEN, 'b.test.mjs': BROKEN }, { NODE_TEST_FLAKE_MAX_FILES: '1' });
  const result = run('a.test.mjs', 'b.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_FLAKE_SKIPPED 2 /m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_RERUN/);
});

test('一檔失敗重跑通過、另一檔回報遺失且紀錄不完整：遺失照樣重跑判定', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'flaky.test.mjs': FLAKY, 'lossy.test.mjs': LOSSY, FAIL_ONCE: '', MUTE: '', CUT: '' });
  const result = run('flaky.test.mjs', 'lossy.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs$/m);
  assert.match(result.stderr, /^NODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
});

test('soloOptions：單獨重跑拿掉 --test-force-exit（retro spay2 1102a：pilot-status 135/156、0 fail 判 FAIL），其他選項不動', () => {
  assert.deepEqual(soloOptions(['--test-reporter=spec', '--test-force-exit', '--test-timeout=120000']), ['--test-reporter=spec', '--test-timeout=120000']);
});

test('failedFiles：紀錄有失敗、exit 非 0 或沒有紀錄的檔；全部沒有事件時找不出', () => {
  const rec = (file, fields) => `${JSON.stringify({ file, names: ['x'], traced: true, started: 1, failed: 0, code: 0, ...fields })}\n`;
  const text = rec('/a', {}) + rec('/b', { failed: 1, code: 1 }) + rec('/c', { code: 1 });
  assert.deepEqual(failedFiles(text, ['/a', '/b', '/c', '/d']), ['/b', '/c', '/d']);
  assert.deepEqual(failedFiles('{"file":"/a","names":[],"traced":false,"failed":0,"code":1}\n', ['/a']), []);
});

test('單獨重跑沒有 force-exit 收尾、測試檔留下掛著的 handle：逾時收掉並判 FAIL，不會卡住', { skip: NO_CHANNEL }, t => {
  const hang = "import { test } from 'node:test';\nimport { existsSync, rmSync } from 'node:fs';\n"
    + "test('flaky', () => { if (existsSync('FLAKY_ONCE')) { rmSync('FLAKY_ONCE'); throw new Error('boom'); } setInterval(() => {}, 1000); });\n";
  const run = fixture(t, { 'hang.test.mjs': hang, FLAKY_ONCE: '' }, { NODE_TEST_RERUN_TIMEOUT_MS: '3000' });
  const started = Date.now();
  const result = run('hang.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_RERUN_TIMEOUT hang\.test\.mjs 3000$/m);
  assert.match(result.stderr, /^NODE_TEST_RERUN hang\.test\.mjs FAIL$/m);
  assert.ok(Date.now() - started < 60000);
});

test('子行程紀錄不完整、回報遺失且 exit 0：印 NODE_TEST_LOST，單獨重跑通過即 exit 0', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'lossy.test.mjs': LOSSY, 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n", MUTE: '', CUT: '', FLAKY_ONCE: '' });
  const result = run('lossy.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_LOST lossy\.test\.mjs ran=2 missing=[12]\nNODE_TEST_RERUN lossy\.test\.mjs PASS$/m);
  assert.doesNotMatch(result.stderr, /ok\.test\.mjs/);
});

test('recordedPass：該檔每筆紀錄都跑完（started 等於結束數）、沒有失敗、exit 0 才算全過', () => {
  const rec = fields => `${JSON.stringify({ file: '/a.test.mjs', names: ['x', 'y'], traced: true, started: 2, failed: 0, code: 0, ...fields })}\n`;
  assert.equal(recordedPass(rec({}), '/a.test.mjs'), true);
  assert.equal(recordedPass(rec({}) + rec({ names: ['z'], started: 1 }), '/a.test.mjs'), true);
  assert.equal(recordedPass(rec({ failed: 1 }), '/a.test.mjs'), false, '有失敗');
  assert.equal(recordedPass(rec({ code: 1 }), '/a.test.mjs'), false, '子行程 exit 非 0');
  assert.equal(recordedPass(rec({ started: 3 }), '/a.test.mjs'), false, '有測試沒有結束紀錄');
  assert.equal(recordedPass(rec({}) + rec({ started: 3 }), '/a.test.mjs'), false, '同檔另一筆紀錄不完整');
  assert.equal(recordedPass(rec({ traced: false, names: [], started: 0 }), '/a.test.mjs'), false, '沒收到事件');
  assert.equal(recordedPass('{"file":"/a.test.mjs","names":["x"],"traced":true}\n', '/a.test.mjs'), false, '舊格式沒有欄位');
  assert.equal(recordedPass(rec({}), '/b.test.mjs'), false, '沒有該檔的紀錄');
});

test('回報遺失但子行程紀錄全過：印 NODE_TEST_LOST 與 NODE_TEST_RECORDED PASS，不單獨重跑、exit 0', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'lossy.test.mjs': LOSSY, MUTE: '' });
  const result = run('lossy.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_LOST lossy\.test\.mjs ran=6 missing=[1-6]\nNODE_TEST_RECORDED lossy\.test\.mjs PASS/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_RERUN/);
});

test('回報遺失且子行程紀錄有失敗：不判 PASS，單獨重跑仍以紀錄判定為 FAIL、exit 1', { skip: NO_CHANNEL }, t => {
  // 子行程在 exit 時把 exit code 改成 0，父行程看不到失敗、只看到回報遺失，判定只能靠子行程紀錄（error 事件與 exit 前的 code）
  const failing = "process.on('exit', () => { process.exitCode = 0; });\n"
    + LOSSY.replace('test(`t${n}`, () => {})', 'test(`t${n}`, () => { if (n === 2) throw new Error(\'boom\'); })');
  assert.notEqual(failing, "process.on('exit', () => { process.exitCode = 0; });\n" + LOSSY);
  const run = fixture(t, { 'lossy.test.mjs': failing, MUTE: '' });
  const result = run('lossy.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_LOST lossy\.test\.mjs ran=6 missing=[1-6]\nNODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_RECORDED/);
});

test('回報遺失且根層級 after hook 拋錯（子行程 exit 0、只有 <root> 發 error）：不判 PASS、exit 1', { skip: NO_CHANNEL }, t => {
  const hooked = LOSSY.replace("import { test } from 'node:test';", "import { test, after } from 'node:test';\nafter(() => { throw new Error('hook'); });");
  assert.notEqual(hooked, LOSSY);
  const run = fixture(t, { 'lossy.test.mjs': hooked, MUTE: '' });
  const result = run('lossy.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_LOST lossy\.test\.mjs ran=6 missing=[1-6]\nNODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_RECORDED/);
});

test('回報遺失且子行程紀錄不完整（有測試沒有結束紀錄）：不直接判 PASS，單獨重跑仍不完整即 FAIL、exit 1', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'lossy.test.mjs': LOSSY, MUTE: '', CUT: '' });
  const result = run('lossy.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_LOST lossy\.test\.mjs ran=2 missing=[12]\nNODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_RECORDED/);
});

test('測試內再起的 node --test（fixture）不計入、不誤報', t => {
  const nested = "import { test } from 'node:test';\nimport { spawnSync } from 'node:child_process';\n"
    + "test('nested', () => { const r = spawnSync(process.execPath, ['--test', 'inner.fixture.mjs'], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stdout); });\n";
  const run = fixture(t, { 'nested.test.mjs': nested, 'inner.fixture.mjs': PASS });
  const result = run('nested.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ tests 1$/m);
});
