import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'bin/check'), 'utf8');
const GUARD = join(root, 'skills/engineering/setup-workflow/templates/node-test-guarded.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST') && key !== 'NODE_OPTIONS' && key !== 'CHECK_LOCK_PID'));

// #483：`tests/*.test.mjs` 組裸跑 `node --test --test-force-exit`，高負載時少了 31 個測試仍印 CHECK_PASS、exit 0。
// 帶 force-exit 的組要經 node-test-guarded（它比對子行程紀錄，補跑或判失敗；遺失的重現見 node-test-guarded.mjs 檔頭）。
test('bin/check 裡帶 --test-force-exit 的 node --test 都經 node-test-guarded 跑', () => {
  const bare = source.split('\n').filter(line => !line.trimStart().startsWith('#') && /\bnode --test\b/.test(line) && line.includes('--test-force-exit'));
  assert.deepEqual(bare, [], `這些行裸跑 node --test --test-force-exit，遺失的測試不會被發現：\n${bare.join('\n')}`);
  // tests/*.test.mjs 是 test_files 的預設（--changed 時換成挑出的子集，CoS item 67），整組經 guard 跑。
  assert.match(source, /^test_files=\(tests\/\*\.test\.mjs\)$/m);
  assert.match(source, /node-test-guarded\.mjs [^\n]*"\$\{test_files\[@\]\}"/);
});

// #483 的 fixture：一個測試檔的後段結果整段沒出現（子行程中途結束），bin/check 原本的裸跑寫法 exit 0、總數變少；經 guard 判失敗。
// cut 前放兩個測試；只有一個時紀錄數恰好等於回報總數（遺失的檔算一個）的情形見 node-test-guarded.test.mjs 的 #517 測試。
test('測試檔後段結果整段遺失：裸跑 node --test exit 0，經 node-test-guarded exit 非 0 並印 MISSING_RESULTS', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'bin-check-lossy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'lossy.test.mjs'), "import { test } from 'node:test';\ntest('a', () => {});\ntest('b', () => {});\ntest('cut', () => { process.exit(0); });\nfor (const n of [1, 2, 3]) test(`t${n}`, () => {});\n");
  writeFileSync(join(dir, 'ok.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
  const files = ['lossy.test.mjs', 'ok.test.mjs'];
  const bare = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-force-exit', ...files], { cwd: dir, encoding: 'utf8', env });
  assert.equal(bare.status, 0, '裸跑把遺失當通過：這正是 #483 的現象');
  assert.ok(Number(bare.stdout.match(/^ℹ tests (\d+)$/m)?.[1]) < 6, bare.stdout);
  const guarded = spawnSync(process.execPath, [GUARD, '--test-reporter=spec', '--test-force-exit', ...files], { cwd: dir, encoding: 'utf8', env });
  assert.notEqual(guarded.status, 0, guarded.stdout + guarded.stderr);
  assert.match(guarded.stderr, /^MISSING_RESULTS lossy\.test\.mjs /m);
});

/**
 * 暫存 git repo 放真的 bin/check；scripts/check-node-version.mjs 換成等 HOLD_MS 毫秒的替身（模擬跑很久的 bin/check），
 * 其後的檢查腳本不存在，bin/check 走到那裡就以 CHECK_FAIL 結束。
 */
function fixture(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'bin-check-lock-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, env }).status, 0);
  mkdirSync(join(repo, 'bin'));
  mkdirSync(join(repo, 'scripts'));
  cpSync(join(root, 'bin/check'), join(repo, 'bin/check'));
  chmodSync(join(repo, 'bin/check'), 0o755);
  writeFileSync(join(repo, 'scripts/check-node-version.mjs'), "await new Promise(done => setTimeout(done, Number(process.env.HOLD_MS ?? 0)));\n");
  const lock = join(repo, '.git/check.pid');
  const run = (extra = {}) => spawnSync('bin/check', { cwd: repo, encoding: 'utf8', env: { ...env, ...extra }, timeout: 60_000 });
  return { repo, lock, run };
}

/** 背景起一份會停在替身 30 秒的 bin/check，等它寫好 pid 檔後回傳它的 pid。 */
async function startHolder(t, { repo, lock }) {
  const first = spawn('bin/check', { cwd: repo, env: { ...env, HOLD_MS: '30000' }, stdio: 'ignore', detached: true });
  t.after(() => first.kill());
  // bin/check 底下等待中的 node 替身也要收掉：detached 讓它自成行程群組。
  t.after(() => { try { process.kill(-first.pid, 'SIGKILL'); } catch { /* 已結束 */ } });
  for (const until = Date.now() + 30_000; !(existsSync(lock) && readFileSync(lock, 'utf8').trim() === String(first.pid)) && Date.now() < until;) await sleep(50);
  assert.equal(readFileSync(lock, 'utf8').trim(), String(first.pid));
  return first.pid;
}

test('同一棵工作樹已有一份 bin/check 在跑：第二份印 CHECK_BUSY <pid>、exit 3，不開跑（#479）', async t => {
  const fx = fixture(t);
  const pid = await startHolder(t, fx);
  const second = fx.run();
  assert.equal(second.stdout, `CHECK_BUSY ${pid}\n`, second.stderr);
  assert.equal(second.status, 3);
  assert.equal(readFileSync(fx.lock, 'utf8').trim(), String(pid), '第二份不能動第一份的 pid 檔');
});

test('持有者是自己的祖先（繼承的 CHECK_LOCK_PID 相同）：不擋、不改 pid 檔', async t => {
  const fx = fixture(t);
  const pid = await startHolder(t, fx);
  const nested = fx.run({ CHECK_LOCK_PID: String(pid) });
  assert.doesNotMatch(nested.stdout, /CHECK_BUSY/);
  assert.match(nested.stdout, /^CHECK_FAIL /m);
  assert.equal(readFileSync(fx.lock, 'utf8').trim(), String(pid));
});

test('pid 檔記的行程已結束：照常開跑，結束時清掉自己的 pid 檔', t => {
  const { lock, run } = fixture(t);
  const gone = spawnSync('true');
  writeFileSync(lock, `${gone.pid}\n`);
  const result = run();
  assert.doesNotMatch(result.stdout, /CHECK_BUSY/);
  assert.match(result.stdout, /^CHECK_FAIL /m);
  assert.equal(existsSync(lock), false);
});

test('pid 檔記的行程還活著但不是 bin/check（pid 被重用）：照常開跑', t => {
  const { lock, run } = fixture(t);
  writeFileSync(lock, `${process.pid}\n`);
  const result = run();
  assert.doesNotMatch(result.stdout, /CHECK_BUSY/);
  assert.match(result.stdout, /^CHECK_FAIL /m);
});
