import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

// bin/check 最後一行把各組測試的 `ℹ tests <n>` 用 + 串成 `CHECK_PASS tests <a>+<b>+…`，pilot 的 Regression 照抄進 regression: 行。
// macOS 的 BSD paste 沒有檔案參數時不讀 stdin，只印 usage；錯誤藏在 $(…) 裡，bin/check 照樣 exit 0，最後一行卻少了數字（#98）。
const line = readFileSync(new URL('../bin/check', import.meta.url), 'utf8').split('\n').find(text => text.startsWith('echo "CHECK_PASS'));
const realPaste = spawnSync('bash', ['-c', 'command -v paste'], { encoding: 'utf8' }).stdout.trim();

/** 在暫存目錄放兩組測試的輸出，跑 bin/check 的 CHECK_PASS 那一行；bsd 為 true 時 PATH 前面放模擬 BSD 的 paste。 */
function checkPass(t, { bsd }) {
  const tmp = mkdtempSync(join(realTmpdir(), 'check-pass-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'tests.log'), '✔ a (1ms)\nℹ tests 201\nℹ pass 201\n✔ b (1ms)\nℹ tests 129\nℹ pass 129\n');
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'paste'), `#!/usr/bin/env bash
# 模擬 BSD paste：要有檔案參數（\`-\` 表示 stdin）才執行，否則印 usage、exit 1。
for arg in "$@"; do [[ $arg == - || $arg != -* ]] && exec "${realPaste}" "$@"; done
echo 'usage: paste [-s] [-d delimiters] file ...' >&2; exit 1
`);
  chmodSync(join(bin, 'paste'), 0o755);
  const PATH = bsd ? `${bin}:${process.env.PATH}` : process.env.PATH;
  return spawnSync('bash', ['-c', line], { encoding: 'utf8', env: { ...process.env, PATH, tmp } });
}

test('bin/check 有 CHECK_PASS 那一行', () => {
  assert.ok(line, 'bin/check 找不到 echo "CHECK_PASS 開頭的那一行');
  // 下面的測試以環境變數 tmp 提供 $tmp/tests.log；bin/check 改了讀的檔案，這裡先失敗，不會只看到少了數字。
  assert.match(line, /"\$tmp\/tests\.log"/);
});

test('BSD paste（macOS）：CHECK_PASS 印出兩組測試數 201+129', t => {
  assert.equal(checkPass(t, { bsd: true }).stdout, 'CHECK_PASS tests 201+129\n');
});

test('本機 paste：CHECK_PASS 印出兩組測試數 201+129', t => {
  assert.equal(checkPass(t, { bsd: false }).stdout, 'CHECK_PASS tests 201+129\n');
});

// 失敗時最後一行是 `CHECK_FAIL <步驟> <失敗的測試>｜…`（#267：`bin/check | tail -8` 只拿到 stack trace，看不出哪個測試，整條重跑才 grep 到 `✖`）。
const source = readFileSync(new URL('../bin/check', import.meta.url), 'utf8');
const failFn = source.match(/^check_fail\(\) \{\n[\s\S]*?^\}\n/m)?.[0];

/** 在暫存目錄放 log，跑 bin/check 的 check_fail；step 是 $step，command 是 ERR trap 傳入的 $BASH_COMMAND。 */
function checkFail(t, log, { step = '', command = 'node scripts/check-links.mjs' } = {}) {
  const tmp = mkdtempSync(join(realTmpdir(), 'check-fail-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  if (log !== undefined) writeFileSync(join(tmp, 'tests.log'), log);
  return spawnSync('bash', ['-c', `${failFn}step=${JSON.stringify(step)}; check_fail ${JSON.stringify(command)}`], { encoding: 'utf8', env: { ...process.env, tmp } });
}

test('bin/check 以 ERR trap 呼叫 check_fail', () => {
  assert.ok(failFn, 'bin/check 找不到 check_fail() 函式');
  assert.match(source, /^trap 'check_fail "\$BASH_COMMAND"' ERR$/m);
});

test('測試失敗：CHECK_FAIL 帶步驟與失敗的測試名稱，重複的 ✖ 只列一次', t => {
  const log = '✔ a (1ms)\n✖ b 壞了 (2.5ms)\n  AssertionError: x\n    at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {\nℹ tests 2\n✖ failing tests:\n\ntest at tests/x.test.mjs:1:1\n✖ b 壞了 (2.5ms)\n';
  assert.equal(checkFail(t, log, { step: 'tests' }).stdout, 'CHECK_FAIL tests b 壞了\n');
});

test('測試之前的檢查失敗：沒有 log 時 CHECK_FAIL 帶失敗的指令', t => {
  assert.equal(checkFail(t, undefined).stdout, 'CHECK_FAIL node scripts/check-links.mjs\n');
});
