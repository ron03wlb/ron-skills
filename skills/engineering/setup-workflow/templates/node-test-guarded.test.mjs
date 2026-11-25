// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failedFiles, hasTestChannel, lostFiles, missingFiles, parseRan, recordedPass, reportedTotal, saveFlakeOutput, soloOptions, untraced, withConcurrency } from './node-test-guarded.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./node-test-guarded.mjs', import.meta.url));

/** 暫存目錄放 fixture 測試檔，以 wrapper 執行。 */
function fixture(t, files, extraEnv = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'node-test-guarded-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_TEST_COUNT_FILE', 'NODE_TEST_COUNT_ROOT', 'NODE_TEST_COUNTED', 'NODE_OPTIONS', 'NODE_TEST_GUARD_WAIT_MS', 'NODE_TEST_RERUN_TIMEOUT_MS', 'NODE_TEST_FLAKE_MAX_FILES', 'NODE_TEST_CONCURRENCY']) delete env[key];
  // flake 首輪輸出在不在 git repo 時放 tmpdir()：每個 fixture 用自己的 TMPDIR，並行跑多份（或別的 worktree 同時跑）時才不共用 /tmp/node-test-flake-output 互相覆寫、清除
  mkdirSync(join(dir, '.tmp'));
  env.TMPDIR = join(dir, '.tmp');
  Object.assign(env, extraEnv);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--test-force-exit', ...args], { cwd: dir, encoding: 'utf8', env });
  run.dir = dir;
  return run;
}

// Node 22 沒有 node.test tracing channel：wrapper 放行、不偵測遺失，偵測遺失的測試只在有 channel 時跑
const PROBE = "import { tracingChannel } from 'node:diagnostics_channel';\nlet seen = false;\n"
  + "tracingChannel('node.test').subscribe({ start() {}, asyncStart() {}, asyncEnd() {}, error() {}, end() { seen = true; } });\n"
  + "process.on('exit', () => process.stderr.write(String(seen)));\nconst { test } = await import('node:test');\ntest('probe', () => {});\n";
const NO_CHANNEL = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { encoding: 'utf8' }).stderr.trim() !== 'true'
  && `${process.version} 沒有 node.test tracing channel`;

const PASS = "import { test, describe, it } from 'node:test';\ndescribe('g', () => { it('x', () => {}); it('y', () => {}); it.todo('later'); });\ntest('o', async t => { await t.test('sub', () => {}); });\ntest.skip('s', () => {});\ntest('r', { skip: 'why' }, () => {});\ntest('w', { todo: 'soon' }, () => {});\n";

test('parseRan／reportedTotal／lostFiles：以 spec 輸出的名稱逐檔比對；同名分屬多檔時兩檔都算', () => {
  const ran = parseRan('{"file":"/a.test.mjs","names":["x","y"]}\n{"file":"/b.test.mjs","names":["z","w","y"]}\n{"file":"/a.test.mjs","names":["v"]}\n');
  assert.deepEqual([...ran], [['/a.test.mjs', ['x', 'y', 'v']], ['/b.test.mjs', ['z', 'w', 'y']]]);
  const output = '▶ g\n  ✔ x (1.2ms)\n✔ g (3ms)\n✔ v (1ms)\n✔ y (2ms)\n✔ z (1ms)\n﹣ skipped (0.5ms) # SKIP\nℹ tests 5\nℹ suites 1\n';
  assert.equal(reportedTotal(output), 5);
  assert.equal(reportedTotal('no summary'), null);
  assert.deepEqual(lostFiles(ran, output), [{ file: '/a.test.mjs', ran: 3, missing: 1 }, { file: '/b.test.mjs', ran: 3, missing: 2 }]);
  assert.deepEqual(lostFiles(parseRan('{"file":"/a.test.mjs","names":["x","v"]}\n'), output), []);
  // skip／todo 帶原因字串時 spec 印 `# <原因>`；名稱本身含 ` # ` 時 duration 在最後（#517 的捷徑改用 lostFiles 後不能多印）
  const reasons = '✔ t (1.02ms) # later\n﹣ s (0.25ms) # why\n✔ a # b (0.15ms)\nℹ tests 3\n';
  assert.deepEqual(lostFiles(parseRan('{"file":"/c.test.mjs","names":["t","s","a # b"]}\n'), reasons), []);
  assert.equal(untraced('{"file":"/a.test.mjs","names":[],"traced":false}\n{"file":"/b.test.mjs","names":[],"traced":false}\n'), true);
  assert.equal(untraced('{"file":"/a.test.mjs","names":[],"traced":false}\n{"file":"/b.test.mjs","names":["z"],"traced":true}\n'), false);
  assert.equal(untraced(''), false);
});

test('全部回報：exit 0，輸出照舊是 spec（含 suite、子測試、skip）', t => {
  const run = fixture(t, { 'a.test.mjs': PASS, 'b.test.mjs': "import { test } from 'node:test';\ntest('b', () => {});\n" });
  const result = run('a.test.mjs', 'b.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ tests 9$/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_LOST|MISSING_RESULTS/);
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
  assert.match(result.stderr, /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs output=\S+$/m);
  assert.doesNotMatch(result.stderr, /ok\.test\.mjs/);
  assert.equal(result.stdout.match(/^✔ ok\b/gm).length, 1, '通過的檔不重跑');
});

// followups 430：.git/spay-push-gate.log 每輪覆寫，followups 419 查不到首輪失敗的輸出。
test('flake 的首輪失敗輸出另存，flake 行印路徑；不在 git repo 也存得到（followups 430）', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'flaky.test.mjs': FLAKY, 'ok.test.mjs': OK, FAIL_ONCE: '' });
  const result = run('flaky.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs output=(\S+)$/m.exec(result.stderr)?.[1];
  assert.ok(saved, result.stderr);
  t.after(() => rmSync(saved, { force: true }));
  assert.match(readFileSync(saved, 'utf8'), /boom/, '首輪的失敗原因要留著');
});

test('saveFlakeOutput：同一檔只留最新、尾段有上限、過期的檔刪除；寫不成傳回 null（followups 430）', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'node-test-flake-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = saveFlakeOutput('scripts/x.test.mjs', 'first', dir);
  assert.equal(file, join(dir, 'scripts_x.test.mjs.log'));
  assert.equal(saveFlakeOutput('scripts/x.test.mjs', `${'a'.repeat(3 * 1024 * 1024)}tail`, dir), file);
  const kept = readFileSync(file, 'utf8');
  assert.equal(kept.length, 2 * 1024 * 1024);
  assert.ok(kept.endsWith('tail'));
  const later = Date.now() + 15 * 24 * 60 * 60 * 1000;
  const other = saveFlakeOutput('other.test.mjs', 'x', dir, later);
  assert.equal(existsSync(file), false, '超過 14 天的刪除');
  assert.equal(existsSync(other), true);
  assert.equal(saveFlakeOutput('y.test.mjs', 'x', join(other, 'not-a-dir')), null);
});

// followups 264：flake 只有 push gate 會寫 followups；batch-merge verify、fix-land 跑 check-contracts 時只留在 log 且 exit 0。
const FAKE_FOLLOWUPS = "import { appendFileSync } from 'node:fs';\nappendFileSync('followups.log', `${process.argv.slice(2).join(' ')}\\n`);\nprocess.exit(Number(process.env.FOLLOWUPS_EXIT ?? 0));\n";

test('flake 由 wrapper 自己寫 followups [tooling]：每個呼叫端都記到；followups 失敗（含 DUPLICATE）不影響結果', { skip: NO_CHANNEL }, t => {
  for (const exit of ['0', '1']) {
    const dir = mkdtempSync(join(realTmpdir(), 'node-test-guarded-followups-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'followups.mjs'), FAKE_FOLLOWUPS);
    writeFileSync(join(dir, 'flaky.test.mjs'), FLAKY);
    writeFileSync(join(dir, 'ok.test.mjs'), OK);
    writeFileSync(join(dir, 'FAIL_ONCE'), '');
    mkdirSync(join(dir, '.tmp'));
    const env = { ...process.env, FOLLOWUPS_EXIT: exit, TMPDIR: join(dir, '.tmp') };
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_TEST_COUNT_FILE', 'NODE_TEST_COUNT_ROOT', 'NODE_TEST_COUNTED', 'NODE_OPTIONS']) delete env[key];
    const result = spawnSync(process.execPath, [SCRIPT, '--test-force-exit', 'flaky.test.mjs', 'ok.test.mjs'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs output=\S+$/m);
    const saved = /output=(\S+)$/m.exec(result.stderr)[1];
    assert.equal(readFileSync(join(dir, 'followups.log'), 'utf8'), `add node-test-guarded --tooling NODE_TEST_FLAKE_SUSPECT flaky.test.mjs：首輪失敗、單獨重跑全過；首輪輸出 ${saved}\n`);
  }
});

test('真實失敗與 cwd 沒有 scripts/followups.mjs（測試 fixture）都不寫 followups；followups.mjs 壞掉也不影響結果', { skip: NO_CHANNEL }, t => {
  const dir = mkdtempSync(join(realTmpdir(), 'node-test-guarded-followups-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'followups.mjs'), FAKE_FOLLOWUPS);
  writeFileSync(join(dir, 'broken.test.mjs'), BROKEN);
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_TEST_COUNT_FILE', 'NODE_TEST_COUNT_ROOT', 'NODE_TEST_COUNTED', 'NODE_OPTIONS']) delete env[key];
  const failed = spawnSync(process.execPath, [SCRIPT, '--test-force-exit', 'broken.test.mjs'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(failed.status, 1);
  assert.equal(existsSync(join(dir, 'followups.log')), false);
  writeFileSync(join(dir, 'scripts', 'followups.mjs'), "throw new Error('壞掉');\n");
  writeFileSync(join(dir, 'flaky.test.mjs'), FLAKY);
  writeFileSync(join(dir, 'FAIL_ONCE'), '');
  const flaky = spawnSync(process.execPath, [SCRIPT, '--test-force-exit', 'flaky.test.mjs'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(flaky.status, 0, flaky.stdout + flaky.stderr);
  assert.doesNotMatch(flaky.stderr, /壞掉/);
  const bare = fixture(t, { 'flaky.test.mjs': FLAKY, FAIL_ONCE: '' });
  assert.equal(bare('flaky.test.mjs').status, 0);
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
  assert.match(result.stderr, /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs output=\S+$/m);
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
  assert.match(result.stderr, /^NODE_TEST_FLAKE_SUSPECT flaky\.test\.mjs output=\S+$/m);
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

test('子行程紀錄不完整、回報遺失且 exit 0：印 MISSING_RESULTS，單獨重跑通過即 exit 0', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'lossy.test.mjs': LOSSY, 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n", MUTE: '', CUT: '', FLAKY_ONCE: '' });
  const result = run('lossy.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^MISSING_RESULTS lossy\.test\.mjs not-finished started=3 ended=2\nNODE_TEST_RERUN lossy\.test\.mjs PASS$/m);
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
  assert.match(result.stderr, /^MISSING_RESULTS lossy\.test\.mjs exit=1\nNODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
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
  assert.match(result.stderr, /^MISSING_RESULTS lossy\.test\.mjs not-finished started=3 ended=2\nNODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
  assert.doesNotMatch(result.stderr, /NODE_TEST_RECORDED/);
});

// #517：中途 process.exit(0) 的檔被父行程算成 1 個測試；cut 前只有一個測試時，子行程紀錄數（a、ok）恰好等於回報總數 2，
// 總數相等的捷徑原本放行、exit 0。
test('中途結束的檔：紀錄數恰好等於回報總數也印 MISSING_RESULTS，單獨重跑仍不完整即 exit 1', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, {
    'lossy.test.mjs': "import { test } from 'node:test';\ntest('a', () => {});\ntest('cut', () => { process.exit(0); });\nfor (const n of [1, 2, 3]) test(`t${n}`, () => {});\n",
    'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n",
  });
  const result = run('--test-reporter=spec', 'lossy.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^MISSING_RESULTS lossy\.test\.mjs not-finished started=2 ended=1\nNODE_TEST_RERUN lossy\.test\.mjs FAIL$/m);
  assert.doesNotMatch(result.stderr, /ok\.test\.mjs/);
});

test('測試內再起的 node --test（fixture）不計入、不誤報', t => {
  const nested = "import { test } from 'node:test';\nimport { spawnSync } from 'node:child_process';\n"
    + "test('nested', () => { const r = spawnSync(process.execPath, ['--test', 'inner.fixture.mjs'], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stdout); });\n";
  const run = fixture(t, { 'nested.test.mjs': nested, 'inner.fixture.mjs': PASS });
  const result = run('nested.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ tests 1$/m);
});

test('missingFiles：逐檔核對收齊；沒紀錄、沒事件、<root> 沒跑完、開始數不等於結束數、沒有測試、父行程 exit 0 而子行程非 0 都算缺', () => {
  const rec = (file, fields) => `${JSON.stringify({ file, names: ['x'], traced: true, started: 1, failed: 0, finished: true, code: 0, ...fields })}\n`;
  const text = rec('/ok', {}) + rec('/events', { traced: false, names: [], started: 0, finished: false }) + rec('/cut', { finished: false })
    + rec('/started', { started: 2 }) + rec('/empty', { names: [], started: 0 }) + rec('/exit', { code: 7 }) + rec('/old', { finished: undefined })
    + rec('/twice', {}) + rec('/twice', { finished: false });
  const files = ['/ok', '/none', '/events', '/cut', '/started', '/empty', '/exit', '/old', '/twice'];
  assert.deepEqual(missingFiles(text, files), [
    { file: '/none', reason: 'no-record' }, { file: '/events', reason: 'no-events' }, { file: '/cut', reason: 'not-finished started=1 ended=1' },
    { file: '/started', reason: 'not-finished started=2 ended=1' }, { file: '/empty', reason: 'no-tests' }, { file: '/exit', reason: 'exit=7' },
    { file: '/old', reason: 'not-finished started=1 ended=1' }, { file: '/twice', reason: 'not-finished started=2 ended=2' },
  ]);
  assert.deepEqual(missingFiles(rec('/exit', { code: 1 }), ['/exit'], { parentCode: 1 }), [], '父行程失敗時子行程非 0 交給 failedFiles');
  // 沒有 channel（Node 22）時只核對有紀錄與 exit code
  const bare = rec('/a', { traced: false, names: [], started: 0, finished: false });
  assert.deepEqual(missingFiles(bare + rec('/b', { traced: false, code: 1 }), ['/a', '/b', '/c'], { traced: false }),
    [{ file: '/b', reason: 'exit=1' }, { file: '/c', reason: 'no-record' }]);
});

test('hasTestChannel：與實際探測一致', () => {
  assert.equal(hasTestChannel(), !NO_CHANNEL);
});

// spay2 #1099：同一 commit 三輪 `ℹ tests` 4444／4472／4496 都綠。測試檔在測試之間結束時，子行程紀錄與父行程輸出一起少、名稱都對得上，
// 總數與逐檔名稱比對（#517）都看不到；要靠逐檔核對 <root> 跑完。以下三種都要 exit 1 並印缺的檔名。
const MISSING_CASES = {
  // 整個檔的結果遺失：第一個測試前就結束，父行程只把檔名算成一個通過的測試
  'gone.test.mjs': ["import { test } from 'node:test';\nprocess.exit(0);\ntest('g1', () => {});\ntest('g2', () => {});\n", 'no-events'],
  // 只收到一半：第二個測試後結束，後面的測試從沒開始，紀錄與輸出都只有前兩個（後面的測試永不結束，只有 exit 能讓行程結束，結果不靠排程時序）
  'half.test.mjs': ["import { test } from 'node:test';\ntest('h1', () => {});\ntest('h2', () => { setImmediate(() => process.exit(0)); });\n"
    + 'for (const n of [3, 4, 5]) test(`h${n}`, async () => { await new Promise(() => {}); });\n', 'not-finished started=3 ended=2'],
  // force-exit 截斷：父行程不再收結果（吞掉輸出），子行程再跑一個測試後在收齊前結束
  'trunc.test.mjs': ["import { test } from 'node:test';\ntest('c1', () => {});\ntest('c2', () => { process.stdout.write = () => true; });\n"
    + "test('c3', () => { setImmediate(() => process.exit(0)); });\nfor (const n of [4, 5, 6]) test(`c${n}`, async () => { await new Promise(() => {}); });\n", 'not-finished started=4 ended=3'],
};

for (const [name, [source, reason]] of Object.entries(MISSING_CASES)) {
  test(`沒收齊的檔（${name}）：印 MISSING_RESULTS 與原因，單獨重跑仍沒收齊即 exit 1；收齊的檔不列（#1099）`, { skip: NO_CHANNEL }, t => {
    const run = fixture(t, { [name]: source, 'ok.test.mjs': OK });
    const result = run(name, 'ok.test.mjs');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`^MISSING_RESULTS ${name.replace('.', '\\.')} ${reason}\\nNODE_TEST_RERUN ${name.replace('.', '\\.')} FAIL$`, 'm'));
    assert.doesNotMatch(result.stderr, /ok\.test\.mjs/);
  });
}

test('half 的情境在改前的捷徑會放行：總數相等、逐檔名稱也對得上（#1099 的缺口）', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'half.test.mjs': MISSING_CASES['half.test.mjs'][0], 'ok.test.mjs': OK });
  const result = run('--test-reporter=spec', 'half.test.mjs', 'ok.test.mjs');
  const shown = result.stdout.slice(0, result.stdout.indexOf('ℹ tests'));
  assert.match(shown, /✔ h2 /);
  assert.doesNotMatch(shown, /h3/, '後面的測試從沒開始');
  assert.match(result.stdout, /^ℹ tests 3$/m, '第一輪：紀錄 h1、h2、ok 與回報總數一起少');
  assert.equal(result.status, 1);
});

test('第一次沒收齊、單獨重跑收齊：印 MISSING_RESULTS 與 NODE_TEST_RERUN PASS，exit 0', { skip: NO_CHANNEL }, t => {
  const once = "import { test } from 'node:test';\nimport { existsSync, rmSync } from 'node:fs';\ntest('h1', () => {});\n"
    + "test('h2', () => { if (existsSync('CUT_ONCE')) { rmSync('CUT_ONCE'); globalThis.cut = true; setImmediate(() => process.exit(0)); } });\n"
    + 'for (const n of [3, 4]) test(`h${n}`, async () => { await new Promise(done => { if (!globalThis.cut) setTimeout(done, 50); }); });\n';
  const run = fixture(t, { 'half.test.mjs': once, 'ok.test.mjs': OK, CUT_ONCE: '' });
  const result = run('half.test.mjs', 'ok.test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^MISSING_RESULTS half\.test\.mjs not-finished started=3 ended=2\nNODE_TEST_RERUN half\.test\.mjs PASS$/m);
});

test('子行程失敗時，另一個沒收齊的檔也要列出，不被失敗的檔蓋過', { skip: NO_CHANNEL }, t => {
  const run = fixture(t, { 'broken.test.mjs': BROKEN, 'half.test.mjs': MISSING_CASES['half.test.mjs'][0] });
  const result = run('broken.test.mjs', 'half.test.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^NODE_TEST_RERUN broken\.test\.mjs FAIL$/m);
  assert.match(result.stderr, /^MISSING_RESULTS half\.test\.mjs not-finished /m);
});

test('withConcurrency：沒帶時附加 NODE_TEST_CONCURRENCY（預設 6）；不合法時 WARN 並用 6；呼叫端帶了就以呼叫端為準', () => {
  const warns = [];
  const warn = line => warns.push(line);
  assert.deepEqual(withConcurrency(['--test-force-exit'], {}, warn), ['--test-force-exit', '--test-concurrency=6']);
  assert.deepEqual(withConcurrency([], { NODE_TEST_CONCURRENCY: '' }, warn), ['--test-concurrency=6']);
  assert.deepEqual(withConcurrency([], { NODE_TEST_CONCURRENCY: ' 3 ' }, warn), ['--test-concurrency=3']);
  assert.deepEqual(warns, []);
  for (const bad of ['0', '-2', 'abc', '2.5', '07']) {
    assert.deepEqual(withConcurrency([], { NODE_TEST_CONCURRENCY: bad }, warn), ['--test-concurrency=6']);
    assert.equal(warns.pop(), `WARN NODE_TEST_CONCURRENCY ${bad} 不是正整數，改用 6`);
  }
  assert.deepEqual(withConcurrency(['--test-concurrency=12'], { NODE_TEST_CONCURRENCY: '2' }, warn), ['--test-concurrency=12']);
  assert.deepEqual(withConcurrency(['--test-concurrency'], { NODE_TEST_CONCURRENCY: '2' }, warn), ['--test-concurrency']);
  assert.deepEqual(warns, []);
});

// 每個檔開始時在 live/ 放自己的標記、記下當下同時在跑的檔數，停一下再拿掉：同時在跑的最大值不會超過上限。
const CONCURRENT = "import { test } from 'node:test';\nimport { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';\n"
  + "test('c', async () => { mkdirSync('live', { recursive: true }); const me = `live/${process.pid}`; writeFileSync(me, '');\n"
  + "  appendFileSync('seen', `${readdirSync('live').length}\\n`); await new Promise(done => setTimeout(done, 400));\n"
  + "  appendFileSync('seen', `${readdirSync('live').length}\\n`); rmSync(me); });\n";

test('NODE_TEST_CONCURRENCY=2：同時跑的測試檔不超過 2 個；不合法的值 stderr 印 WARN 並照常跑完', t => {
  const files = Object.fromEntries([1, 2, 3, 4, 5].map(n => [`c${n}.test.mjs`, CONCURRENT]));
  const names = Object.keys(files);
  const capped = fixture(t, files, { NODE_TEST_CONCURRENCY: '2' });
  const result = capped(...names);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const seen = readFileSync(join(capped.dir, 'seen'), 'utf8').trim().split('\n').map(Number);
  assert.equal(seen.length, 10, seen.join(','));
  assert.ok(Math.max(...seen) <= 2, `同時在跑的檔數 ${seen.join(',')}`);
  const bad = fixture(t, { 'b.test.mjs': "import { test } from 'node:test';\ntest('b', () => {});\n" }, { NODE_TEST_CONCURRENCY: 'many' });
  const warned = bad('b.test.mjs');
  assert.equal(warned.status, 0, warned.stdout + warned.stderr);
  assert.match(warned.stderr, /^WARN NODE_TEST_CONCURRENCY many 不是正整數，改用 6$/m);
});
