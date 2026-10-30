import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { source, run, git, repoFixture } from './test/repo-fixture.mjs';

const script = join(source, 'orca-worktree-create.mjs');
const NAME = 'issue-9';

// 假 orca：每次呼叫記一行；FAKE_ORCA_MODE 決定 ok（立即建立）、late（回 runtime_unavailable，1 秒後才建好）、
// timeout（回 runtime_timeout，1 秒後才建好）、never（回 runtime_unavailable 且不建立）、other（其他錯誤）。比照 Orca 把名稱的 / 換成 -（dir）：
// worktree 建在 <temp>/workspaces/<dir>，分支 user/<dir>。
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs'); const { execFileSync, spawn } = require('node:child_process');
const args = process.argv.slice(2); fs.appendFileSync(process.env.FAKE_ORCA_LOG, args.join(' ') + '\\n');
const dir = args[args.indexOf('--name') + 1].replaceAll('/', '-'); const path = process.env.FAKE_ORCA_ROOT + '/' + dir;
const add = ['-C', process.env.FAKE_ORCA_REPO, 'worktree', 'add', '-q', '-b', 'user/' + dir, path];
const fail = code => { process.stdout.write(JSON.stringify({ ok: false, error: { code, message: code } })); process.exit(1); };
const mode = process.env.FAKE_ORCA_MODE;
if (mode === 'ok') { execFileSync('git', add); process.stdout.write(JSON.stringify({ ok: true, result: { worktree: { id: 'w1', path } } })); process.exit(0); }
if (mode === 'late') { spawn('sh', ['-c', 'sleep 1; exec git "$@"', 'sh', ...add], { detached: true, stdio: 'ignore' }).unref(); fail('runtime_unavailable'); }
if (mode === 'timeout') { spawn('sh', ['-c', 'sleep 1; exec git "$@"', 'sh', ...add], { detached: true, stdio: 'ignore' }).unref(); fail('runtime_timeout'); }
if (mode === 'never') fail('runtime_unavailable');
fail('invalid_argument');
`;

function fixture(t, mode) {
  const f = repoFixture(t);
  const bin = join(f.temp, 'orca'); writeFileSync(bin, FAKE_ORCA); chmodSync(bin, 0o755);
  const log = join(f.temp, 'orca.log');
  const create = (extra = {}, name = NAME) => {
    const result = run(f.repo, ['node', script, '--name', name, '--base-branch', 'main', '--no-parent'], { timeout: 60000, env: {
      ORCA_BIN: bin, ORCA_CLI_COMMAND: '', FAKE_ORCA_MODE: mode, FAKE_ORCA_LOG: log, FAKE_ORCA_REPO: f.repo,
      FAKE_ORCA_ROOT: join(f.temp, 'workspaces'), ORCA_POLL_SECONDS: '5', ...extra } });
    return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n');
  return { ...f, create, calls, path: join(f.temp, 'workspaces', NAME) };
}

test('建立成功：輸出 git worktree list 中新出現的路徑與分支，只呼叫一次 create 並帶 --json', t => {
  const f = fixture(t, 'ok');
  const r = f.create();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json, { status: 'CREATED', path: f.path, branch: `user/${NAME}` });
  assert.deepEqual(f.calls(), [`worktree create --name ${NAME} --base-branch main --no-parent --json`]);
});

test('名稱含 /：比照 Orca 以 - 取代後的目錄名比對，回 CREATED 而非 NOT_FOUND', t => {
  const f = fixture(t, 'ok');
  const r = f.create({ ORCA_POLL_SECONDS: '1' }, 'user/issue-9-inc1');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json, {
    status: 'CREATED',
    path: join(f.temp, 'workspaces', 'user-issue-9-inc1'),
    branch: 'user/user-issue-9-inc1',
  });
});

test('runtime_unavailable 但背景稍後建好：不重試，輪詢到後回 CREATED_LATE', t => {
  const f = fixture(t, 'late');
  const r = f.create();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json, { status: 'CREATED_LATE', path: f.path, branch: `user/${NAME}` });
  assert.equal(f.calls().length, 1);
});

// Orca 回 runtime_timeout 後仍可能在背景建好 worktree，本腳本卻立即回 FAILED。
test('runtime_timeout 但背景稍後建好：同 runtime_unavailable，不重試，輪詢到後回 CREATED_LATE', t => {
  const f = fixture(t, 'timeout');
  const r = f.create();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json, { status: 'CREATED_LATE', path: f.path, branch: `user/${NAME}` });
  assert.equal(f.calls().length, 1);
});

test('runtime_unavailable 且輪詢期限內沒出現：NOT_FOUND exit 1，仍不重試', t => {
  const f = fixture(t, 'never');
  const r = f.create({ ORCA_POLL_SECONDS: '1' });
  assert.equal(r.status, 1);
  assert.equal(r.json.status, 'NOT_FOUND');
  assert.match(r.json.error, /不得重試/);
  assert.equal(f.calls().length, 1);
});

test('其他錯誤：立即 FAILED，不輪詢、不重試', t => {
  const f = fixture(t, 'other');
  const started = Date.now();
  const r = f.create();
  assert.equal(r.status, 1);
  assert.equal(r.json.status, 'FAILED');
  assert.match(r.json.error, /invalid_argument/);
  assert.ok(Date.now() - started < 4000);
  assert.equal(f.calls().length, 1);
});

test('先前已存在的同名 worktree 不算新建；Orca 改名為 -2 時照樣找到', t => {
  const f = fixture(t, 'ok');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'existing', join(f.temp, 'workspaces', 'other'));
  const r = f.create();
  assert.equal(r.json.path, f.path);
  const again = fixture(t, 'never');
  git(again.repo, 'worktree', 'add', '-q', '-b', `user/${NAME}`, again.path);
  git(again.repo, 'worktree', 'add', '-q', '-b', `user/${NAME}-2`, `${again.path}-2`);
  // 建立前就存在的 -2 也不算本次新建。
  assert.equal(again.create({ ORCA_POLL_SECONDS: '1' }).json.status, 'NOT_FOUND');
});

test('沒有 Orca CLI：參數錯誤 exit 2', t => {
  const f = fixture(t, 'ok');
  const r = run(f.repo, ['node', script, '--name', NAME], { env: { ORCA_BIN: '', ORCA_CLI_COMMAND: '' } });
  assert.equal(r.status, 2);
});

test('帶 --repo：exit 2 並提示省略，不呼叫 orca', t => {
  const f = fixture(t, 'ok');
  const r = run(f.repo, ['node', script, '--name', NAME, '--repo', 'path:/x'], { env: {
    ORCA_BIN: join(f.temp, 'orca'), ORCA_CLI_COMMAND: '', FAKE_ORCA_MODE: 'ok', FAKE_ORCA_LOG: join(f.temp, 'orca.log') } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /不要帶 --repo/);
  assert.throws(() => f.calls());
});
