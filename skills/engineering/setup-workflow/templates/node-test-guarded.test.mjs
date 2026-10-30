import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lostFiles, parseRan, reportedTotal, untraced } from './node-test-guarded.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./node-test-guarded.mjs', import.meta.url));

/** 暫存目錄放 fixture 測試檔，以 wrapper 執行。 */
function fixture(t, files, extraEnv = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'node-test-guarded-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_TEST_COUNT_FILE', 'NODE_TEST_COUNT_ROOT', 'NODE_TEST_COUNTED', 'NODE_OPTIONS', 'NODE_TEST_GUARD_WAIT_MS']) delete env[key];
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

test('測試失敗：原樣回傳 node --test 的 exit code，不另印 NODE_TEST_LOST', t => {
  const run = fixture(t, { 'f.test.mjs': "import { test } from 'node:test';\ntest('f', () => { throw new Error('boom'); });\n" });
  const result = run('f.test.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /boom/);
  assert.doesNotMatch(result.stderr, /NODE_TEST_LOST/);
});

// 第二個測試起吞掉子行程送往父行程的結果，模擬長跑測試檔尾段靜默消失；FLAKY_ONCE 檔存在時只吞第一次，之後單獨重跑正常
const LOSSY = "import { test } from 'node:test';\nimport { existsSync, rmSync } from 'node:fs';\ntest('a', () => {});\n"
  + "test('mute', () => { if (existsSync('MUTE')) { if (existsSync('FLAKY_ONCE')) rmSync('MUTE'); process.stdout.write = () => true; } });\n"
  + "for (const n of [1, 2, 3]) test(`t${n}`, () => {});\n";

test('子行程跑完的測試沒有回報到父行程且 exit 0：印 NODE_TEST_LOST，單獨重跑通過即 exit 0', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'lossy.test.mjs': LOSSY, 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n", MUTE: '', FLAKY_ONCE: '' });
  const result = run('lossy.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_LOST lossy\.test\.mjs ran=5 missing=[1-5]\nNODE_TEST_RERUN lossy\.test\.mjs PASS$/m);
  assert.doesNotMatch(result.stderr, /ok\.test\.mjs/);
});

test('單獨重跑仍遺失：NODE_TEST_RERUN FAIL、exit 1', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'lossy.test.mjs': LOSSY, MUTE: '' });
  const result = run('lossy.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_LOST lossy\.test\.mjs ran=5 missing=[1-5]\nNODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
});

test('測試內再起的 node --test（fixture）不計入、不誤報', t => {
  const nested = "import { test } from 'node:test';\nimport { spawnSync } from 'node:child_process';\n"
    + "test('nested', () => { const r = spawnSync(process.execPath, ['--test', 'inner.fixture.mjs'], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stdout); });\n";
  const run = fixture(t, { 'nested.test.mjs': nested, 'inner.fixture.mjs': PASS });
  const result = run('nested.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ tests 1$/m);
});
