import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-hold.mjs', import.meta.url));
const checkout = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-hold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const run = (dir, ...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1' } });
const hold = dir => join(dir, '.scratch/pilot/hold');

test('沒有 hold：show 印 NO_HOLD，exit 0', t => {
  const result = run(checkout(t), 'show');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'NO_HOLD\n');
});

test('set 寫一行 JSON {since,reason,session}，reason 照原文跳脫；show 印出原因', t => {
  const dir = checkout(t);
  const set = run(dir, 'set', '等 "#27" 合入');
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.stdout, 'HOLD_SET\n');
  const text = readFileSync(hold(dir), 'utf8');
  assert.match(text, /^\{.*\}\n$/);
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value), ['since', 'reason', 'session']);
  assert.equal(value.reason, '等 "#27" 合入');
  assert.equal(value.session, 'sess-1');
  assert.match(value.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d([+-]\d\d:\d\d|Z)$/);
  assert.equal(run(dir, 'show').stdout, `HOLD ${value.since}   等 "#27" 合入\n`);
});

test('舊的空檔與壞掉的內容仍是 hold，只是沒有原因', t => {
  const dir = checkout(t);
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  writeFileSync(hold(dir), '');
  assert.equal(run(dir, 'show').stdout, 'HOLD (no reason)\n');
  writeFileSync(hold(dir), 'not json');
  assert.equal(run(dir, 'show').stdout, 'HOLD (no reason)\n');
});

test('clear 刪掉 hold 印 HOLD_CLEARED；本來就沒有時印 NO_HOLD', t => {
  const dir = checkout(t);
  run(dir, 'set', 'x');
  assert.equal(run(dir, 'clear').stdout, 'HOLD_CLEARED\n');
  assert.ok(!existsSync(hold(dir)));
  const again = run(dir, 'clear');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'NO_HOLD\n');
});

test('用法錯誤：exit 2', t => {
  const dir = checkout(t);
  assert.equal(run(dir, 'set').status, 2);
  assert.equal(run(dir, 'bogus').status, 2);
  assert.equal(spawnSync('node', [SCRIPT], { encoding: 'utf8' }).status, 2);
});
