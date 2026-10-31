import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-register.mjs', import.meta.url));
const SESSION = '1d6719b0-c957-4d42-84bc-8474ba2fa7c7';
const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/.source;
const checkout = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-register-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'AGENTS.md'), 'rules\n');
  return dir;
};
const run = (dir, args = [], env = {}) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8',
  env: { ...process.env, CLAUDE_PID: '553382', CLAUDE_CODE_SESSION_ID: SESSION, ...env } });
const store = (dir, name) => join(dir, '.scratch/pilot', name);
const read = (dir, name) => readFileSync(store(dir, name), 'utf8');
const ARGS = ['--name', 'demo-0c', '--loop', 'yes'];

test('第一次：寫 coordinator 的 pid 行、附加 sessions.md 的 start 行，印 REGISTERED 與 SESSION_APPENDED', t => {
  const dir = checkout(t);
  const result = run(dir, ARGS);
  assert.equal(result.status, 0, result.stderr);
  const [, since] = read(dir, 'coordinator').match(new RegExp(`^pid 553382   loop yes   since (${TIME})   name demo-0c\\n$`)) ?? [];
  assert.ok(since, read(dir, 'coordinator'));
  assert.equal(result.stdout, `REGISTERED pid 553382   since ${since}\nSESSION_APPENDED\n`);
  assert.match(read(dir, 'sessions.md'), new RegExp(`^${TIME}   session ${SESSION}   pid 553382   demo-0c\\n$`));
});

test('同一個 pid 再註冊：since 不變、loop 照新值、sessions.md 不再附加', t => {
  const dir = checkout(t);
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  writeFileSync(store(dir, 'coordinator'), 'pid 553382   loop no   since 2026-10-30T20:43:33+08:00   name demo-0c\n');
  writeFileSync(store(dir, 'sessions.md'), `2026-10-30T20:43:33+08:00   session ${SESSION}   pid 553382   demo-0c\n`);
  const result = run(dir, ARGS);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'REGISTERED pid 553382   since 2026-10-30T20:43:33+08:00\n');
  assert.equal(read(dir, 'coordinator'), 'pid 553382   loop yes   since 2026-10-30T20:43:33+08:00   name demo-0c\n');
  assert.equal(read(dir, 'sessions.md').split('\n').filter(Boolean).length, 1);
});

test('不同 pid 或 handoff 行：since 重設成現在；舊格式的 start 行也算已附加', t => {
  const dir = checkout(t);
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  writeFileSync(store(dir, 'coordinator'), 'handoff   from-session abc   from-pid 1   at 2026-10-30T20:00:00+08:00   reason x\n');
  writeFileSync(store(dir, 'sessions.md'), `2026-10-30T20:43:33+08:00  ${SESSION}  demo-0c  coordinator start\n`);
  const result = run(dir, ARGS);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(read(dir, 'coordinator'), /since 2026-10-30T20:00:00/);
  assert.ok(!result.stdout.includes('SESSION_APPENDED'));
});

test('最後以 pilot-sources --record 記錄傳入的來源', t => {
  const dir = checkout(t);
  const result = run(dir, [...ARGS, 'AGENTS.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\nSOURCE_CHANGED AGENTS\.md\nRECORDED 1\n$/);
  assert.ok(existsSync(store(dir, 'sources')));
  assert.match(run(dir, [...ARGS, 'AGENTS.md']).stdout, /\nRECORDED 1\n$/);
});

test('sessions.md 記著這個 session 交接出去：已退役，印 STOP retired、exit 4、不改 coordinator', t => {
  const dir = checkout(t);
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  writeFileSync(store(dir, 'sessions.md'), `2026-10-30T20:43:41+08:00   handoff from-session ${SESSION} → terminal term_1   reason 合入 2 批\n`);
  const result = run(dir, ARGS);
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP retired\n');
  assert.ok(!existsSync(store(dir, 'coordinator')));
});

test('缺 pid、session、name 或 loop 不是 yes/no：exit 2', t => {
  const dir = checkout(t);
  assert.equal(run(dir, ARGS, { CLAUDE_PID: '' }).status, 2);
  assert.equal(run(dir, ARGS, { CLAUDE_CODE_SESSION_ID: '' }).status, 2);
  assert.equal(run(dir, ['--loop', 'yes']).status, 2);
  assert.equal(run(dir, ['--name', 'x', '--loop', 'maybe']).status, 2);
  assert.ok(!existsSync(store(dir, 'coordinator')));
});
