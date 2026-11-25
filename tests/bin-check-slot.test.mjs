// 完整 bin/check 一律經全機 heavy-slot（CoS item 67／138）：還沒持有 slot 時以 heavy-slot.mjs run --label ron-skills:bin-check 重跑自己，
// 已在 slot 裡（HEAVY_SLOT_HELD）、--changed 子集、CI 都直接跑。
// fixture：暫存 git repo 放真的 bin/check；scripts/heavy-slot.mjs 換成替身（記下參數，帶 HEAVY_SLOT_HELD 執行 `--` 後的命令，SLOT_EXIT 有值時不執行、直接以它結束），
// scripts/check-node-version.mjs 換成記下 HEAVY_SLOT_HELD 的替身；其後的檢查腳本不存在，bin/check 走到那裡就以 CHECK_FAIL 結束。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['NODE_OPTIONS', 'CHECK_LOCK_PID', 'HEAVY_SLOT_HELD', 'CI', 'CHECK_FULL']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST') && !SKIP.has(key)));

const FAKE_SLOT = `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync('slot-calls', args.join(' ') + '\\n');
if (process.env.SLOT_EXIT) process.exit(Number(process.env.SLOT_EXIT));
const command = args.slice(args.indexOf('--') + 1);
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, HEAVY_SLOT_HELD: args[args.indexOf('--label') + 1] } });
process.exit(result.status ?? 1);
`;

function fixture(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'bin-check-slot-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, env }).status, 0);
  mkdirSync(join(repo, 'bin'));
  mkdirSync(join(repo, 'scripts'));
  cpSync(join(root, 'bin/check'), join(repo, 'bin/check'));
  chmodSync(join(repo, 'bin/check'), 0o755);
  writeFileSync(join(repo, 'scripts/heavy-slot.mjs'), FAKE_SLOT);
  writeFileSync(join(repo, 'scripts/check-node-version.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('runs', `held=${process.env.HEAVY_SLOT_HELD ?? '-'}\\n`);\n");
  const read = name => (existsSync(join(repo, name)) ? readFileSync(join(repo, name), 'utf8') : '');
  const run = (args = [], extra = {}) => spawnSync('bin/check', args, { cwd: repo, encoding: 'utf8', env: { ...env, ...extra }, timeout: 60_000 });
  return { repo, run, read, lock: join(repo, '.git/check.pid') };
}

test('完整跑、還沒持有 slot：經 heavy-slot run --label ron-skills:bin-check 重跑自己並帶原參數，裡面那份在 slot 裡跑檢查', t => {
  const fx = fixture(t);
  const result = fx.run();
  assert.match(result.stdout, /^CHECK_FAIL /m, result.stderr);
  assert.equal(fx.read('slot-calls'), 'run --label ron-skills:bin-check -- bin/check\n');
  assert.equal(fx.read('runs'), 'held=ron-skills:bin-check\n');
  assert.equal(existsSync(fx.lock), false, '結束時清掉 pid 檔');
});

test('CHECK_FULL=1 的 --changed 也算完整跑：經 slot，原參數照帶', t => {
  const fx = fixture(t);
  fx.run(['--changed', 'main'], { CHECK_FULL: '1' });
  assert.equal(fx.read('slot-calls'), 'run --label ron-skills:bin-check -- bin/check --changed main\n');
  assert.equal(fx.read('runs'), 'held=ron-skills:bin-check\n');
});

test('已在 slot 裡、--changed 子集、CI：直接跑，不經 heavy-slot', t => {
  for (const [args, extra] of [[[], { HEAVY_SLOT_HELD: 'ron-skills:pre-commit' }], [['--changed'], {}], [[], { CI: 'true' }]]) {
    const fx = fixture(t);
    const result = fx.run(args, extra);
    assert.match(result.stdout, /^CHECK_FAIL /m, result.stderr);
    assert.equal(fx.read('slot-calls'), '', JSON.stringify({ args, extra }));
    assert.equal(fx.read('runs'), `held=${extra.HEAVY_SLOT_HELD ?? '-'}\n`);
  }
});

test('等 slot 逾時（heavy-slot exit 75）：bin/check 照傳 exit 75、不跑檢查，清掉 pid 檔', t => {
  const fx = fixture(t);
  const result = fx.run([], { SLOT_EXIT: '75' });
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.equal(fx.read('runs'), '');
  assert.equal(existsSync(fx.lock), false);
});
