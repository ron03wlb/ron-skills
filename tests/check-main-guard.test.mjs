// scripts/check-main-guard.mjs 以真實錯誤當 fixture：fixtures/main-guard/ 是 git 歷史裡 day-sessions.mjs 的兩個版本，
// 4a8c831^ 的 guard 是 import.meta.url === `file://${process.argv[1]}`（經 symlink 執行時不輸出），4a8c831 改成先 realpathSync。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unresolvedGuards } from '../scripts/check-main-guard.mjs';

const script = fileURLToPath(new URL('../scripts/check-main-guard.mjs', import.meta.url));
const fixture = name => fileURLToPath(new URL(`fixtures/main-guard/${name}`, import.meta.url));
const before = fixture('day-sessions-before-4a8c831.mjs.txt');
const after = fixture('day-sessions-4a8c831.mjs.txt');
const run = (...files) => spawnSync(process.execPath, [script, ...files], { encoding: 'utf8' });

test('4a8c831 修之前的 day-sessions.mjs：報 CHECK_FAIL main-guard 與行號、exit 1', () => {
  assert.deepEqual(unresolvedGuards(readFileSync(before, 'utf8')), [173]);
  const result = run(before);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^CHECK_FAIL main-guard \S*day-sessions-before-4a8c831\.mjs\.txt:173$/m);
});

test('4a8c831 修好的 day-sessions.mjs：通過', () => {
  const result = run(after);
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /CHECK_FAIL/);
});

test('pathToFileURL(process.argv[1]) 沒有 realpath 也算（ci.mjs 的寫法）', () => {
  assert.deepEqual(unresolvedGuards('if (import.meta.url === pathToFileURL(process.argv[1]).href) main();\n'), [1]);
});

test('本 repo 的 skill scripts 全部通過', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout);
});
