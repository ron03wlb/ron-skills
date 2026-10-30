import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./pilot-counterpart.mjs', import.meta.url));
const run = body => spawnSync('node', [SCRIPT], { input: body, encoding: 'utf8' });

test('本文有對應單：每張印一行 COUNTERPART <owner>/<repo>#<m>，依序去重，exit 0', () => {
  const result = run('來源：grill 2026-10-30。app 對應單：acme/app#7。\n\nweb 對應單:acme/web#12；app 對應單：acme/app#7\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART acme/app#7\nCOUNTERPART acme/web#12\n');
});

test('ref 本身包在 code span 裡仍是對應單', () => {
  const result = run('app 對應單：`acme/app#7`\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART acme/app#7\n');
});

test('沒有「對應單」字樣的跨 repo 引用不算', () => {
  const result = run('來源：acme/app#7 refine。Blocked by #45。\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

// 一張 Issue 用「」或 code 引用另一張的對應單時，Close 不能到那張單留下假的交接。
test('整句包在「」、code span 或 code block 裡的對應單是引用，不算', () => {
  const result = run('#30 本文寫明「app 對應單：acme/app#7」。\n\n- 測試：本文含 `app 對應單：acme/app#7` 的 fixture。\n\n```\n對應單：acme/web#1\n```\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
