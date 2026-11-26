// setup-workflow 的 templates/test/isolate-git-env.mjs：測試檔 import 它之後，子行程看不到 Claude session 繼承的變數（retro spay2 d5492792#1）。
// spay2 #1186：merge-into-integration.sh 寫 `Coordinator-Session: $CLAUDE_CODE_SESSION_ID`，queue-regression.test.mjs、close-issue.test.mjs
// 的精確比對只在 Claude 裡失敗、CI 上通過。這裡在設了這些變數的環境 import 正本，再看 spawn 出的子行程讀到什麼。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const isolate = new URL('../skills/engineering/setup-workflow/templates/test/isolate-git-env.mjs', import.meta.url).href;

// 測試檔的樣子：先 import 隔離檔，再 spawn 一個印出變數的子行程（同被測腳本以 `...process.env` 繼承）。
const probe = `
import ${JSON.stringify(isolate)};
import { spawnSync } from 'node:child_process';
const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({ session: process.env.CLAUDE_CODE_SESSION_ID ?? null, pid: process.env.CLAUDE_PID ?? null, keep: process.env.CLAUDE_CONFIG_DIR ?? null }))'], { encoding: 'utf8', env: { ...process.env } });
process.stdout.write(child.stdout);
`;

function run(extra) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, ...extra } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('isolate-git-env：繼承的 CLAUDE_CODE_SESSION_ID、CLAUDE_PID 不會傳到子行程', () => {
  const seen = run({ CLAUDE_CODE_SESSION_ID: 'd5492792-5206-4ef9-ab6a-bb69fbf63dff', CLAUDE_PID: '4242', CLAUDE_CONFIG_DIR: '/tmp/claude-config' });
  assert.equal(seen.session, null);
  assert.equal(seen.pid, null);
  // 不是 session 值的設定（設定目錄）照舊傳下去：只清會被寫進輸出的 session 識別。
  assert.equal(seen.keep, '/tmp/claude-config');
});

test('isolate-git-env：測試自己設的 session 照樣傳到子行程（要用的測試自己設）', () => {
  const own = `
import ${JSON.stringify(isolate)};
import { spawnSync } from 'node:child_process';
const child = spawnSync(process.execPath, ['-e', 'console.log(process.env.CLAUDE_CODE_SESSION_ID ?? "none")'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1' } });
process.stdout.write(child.stdout);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', own], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'inherited' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'sess-1');
});
