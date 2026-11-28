// scripts/check-invisible-chars.mjs 以真實錯誤當 fixture（#716）：fixtures/invisible-chars/ 是 tab-sweep.mjs 105–111 行修正前後兩個版本，
// 修正前空提示列的正則 `[\s│]` 夾著原始 U+00A0（第 4、6 行），修正後寫成 `\u00a0` 跳脫。
// 本檔不能含原始的被檢字元，要用的一律以 String.fromCodePoint 產生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { invisibleChars } from '../scripts/check-invisible-chars.mjs';

const script = fileURLToPath(new URL('../scripts/check-invisible-chars.mjs', import.meta.url));
const fixture = name => fileURLToPath(new URL(`fixtures/invisible-chars/${name}`, import.meta.url));
const before = fixture('tab-sweep-before-716.mjs.txt');
const after = fixture('tab-sweep-716.mjs.txt');
const run = (...files) => spawnSync(process.execPath, [script, ...files], { encoding: 'utf8' });

test('#716 修正前的 tab-sweep 正則：報 CHECK_FAIL invisible-char 與行號、exit 1', () => {
  assert.deepEqual(invisibleChars(readFileSync(before, 'utf8')), [{ line: 4, code: 'U+00A0' }, { line: 6, code: 'U+00A0' }]);
  const result = run(before);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^CHECK_FAIL invisible-char \S*tab-sweep-before-716\.mjs\.txt:4 U\+00A0$/m);
  assert.match(result.stdout, /^CHECK_FAIL invisible-char \S*tab-sweep-before-716\.mjs\.txt:6 U\+00A0$/m);
});

test('只用 \\u00a0 跳脫的近似案例（修正後的正則、字串字面量）：通過', () => {
  const result = run(after);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(invisibleChars("assert.equal(screenBusy(['❯\\u00a0']), null);\nconst s = '\\u200b\\ufeff';\n"), []);
});

test('零寬字元各算一筆，同一行多個也各報一次', () => {
  const zw = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map(code => String.fromCodePoint(code)).join('');
  assert.deepEqual(invisibleChars(`ok\nx${zw}\n`).map(hit => `${hit.line} ${hit.code}`),
    ['2 U+200B', '2 U+200C', '2 U+200D', '2 U+2060', '2 U+FEFF']);
  assert.deepEqual(invisibleChars('a\u2009b\u3000c\n'), []); // 其他空白（thin space、全形空白）不在範圍內
});

test('本 repo git 追蹤的 .mjs 全部通過（fixtures 不在此限）', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout);
});
