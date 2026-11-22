import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'bin/check'), 'utf8');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST') && key !== 'CHECK_LOCK_PID'));

// #483：`tests/*.test.mjs` 組裸跑 `node --test --test-force-exit`，高負載時少了 31 個測試仍印 CHECK_PASS、exit 0。
// 帶 force-exit 的組要經 node-test-guarded（它比對子行程紀錄，補跑或判失敗；遺失的重現見 node-test-guarded.mjs 檔頭）。
test('bin/check 裡帶 --test-force-exit 的 node --test 都經 node-test-guarded 跑', () => {
  const bare = source.split('\n').filter(line => !line.trimStart().startsWith('#') && /\bnode --test\b/.test(line) && line.includes('--test-force-exit'));
  assert.deepEqual(bare, [], `這些行裸跑 node --test --test-force-exit，遺失的測試不會被發現：\n${bare.join('\n')}`);
  assert.match(source, /node-test-guarded\.mjs [^\n]*tests\/\*\.test\.mjs/);
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

test('同一棵工作樹已有一份 bin/check 在跑：第二份印 CHECK_BUSY <pid>、exit 3，不開跑（#479）', async t => {
  const { repo, lock, run } = fixture(t);
  const first = spawn('bin/check', { cwd: repo, env: { ...env, HOLD_MS: '30000' }, stdio: 'ignore', detached: true });
  t.after(() => first.kill());
  // bin/check 底下等待中的 node 替身也要收掉：detached 讓它自成行程群組。
  t.after(() => { try { process.kill(-first.pid, 'SIGKILL'); } catch { /* 已結束 */ } });
  for (const until = Date.now() + 30_000; !(existsSync(lock) && readFileSync(lock, 'utf8').trim() === String(first.pid)) && Date.now() < until;) await sleep(50);
  assert.equal(readFileSync(lock, 'utf8').trim(), String(first.pid));
  const second = run();
  assert.equal(second.stdout, `CHECK_BUSY ${first.pid}\n`, second.stderr);
  assert.equal(second.status, 3);
  assert.equal(readFileSync(lock, 'utf8').trim(), String(first.pid), '第二份不能動第一份的 pid 檔');
});

test('持有者是自己的祖先（繼承的 CHECK_LOCK_PID 相同）：不擋、不改 pid 檔', async t => {
  const { repo, lock, run } = fixture(t);
  const first = spawn('bin/check', { cwd: repo, env: { ...env, HOLD_MS: '30000' }, stdio: 'ignore', detached: true });
  t.after(() => first.kill());
  t.after(() => { try { process.kill(-first.pid, 'SIGKILL'); } catch { /* 已結束 */ } });
  for (const until = Date.now() + 30_000; !(existsSync(lock) && readFileSync(lock, 'utf8').trim() === String(first.pid)) && Date.now() < until;) await sleep(50);
  const nested = run({ CHECK_LOCK_PID: String(first.pid) });
  assert.doesNotMatch(nested.stdout, /CHECK_BUSY/);
  assert.match(nested.stdout, /^CHECK_FAIL /m);
  assert.equal(readFileSync(lock, 'utf8').trim(), String(first.pid));
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
