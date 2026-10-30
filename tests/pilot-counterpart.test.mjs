import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// scripts/pilot-counterpart.mjs 是 setup-workflow 正本的副本，通用行為由正本測試涵蓋；這裡只留本 repo 真實 Issue 本文的驗收（#53）。
const script = new URL('../scripts/pilot-counterpart.mjs', import.meta.url).pathname;
const run = body => spawnSync('node', [script], { input: body, encoding: 'utf8' });

// 重現真實歷史：#30 本文第一行寫「spay2 對應單：spay/spay2#692」，Close 卻沒有交接步驟（#53）。
test('本文有對應單：印出 COUNTERPART <owner>/<repo>#<n>、exit 0', () => {
  const result = run('來源：grill-with-docs 2026-10-30，決策 R1-Q2。依賴 #29（正本）。spay2 對應單：spay/spay2#692。\n\n## 背景\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART spay/spay2#692\n');
});

test('沒有對應單：跨 repo 引用不算，不輸出、exit 0', () => {
  const result = run('來源：spay/spay2#692 refine 2026-10-30。Blocked by #45。\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

// #53 自己的背景用「」、驗收條件用 code span 引用 #30 的對應單；不排除的話，Close 關 #53 時會到 spay2#692 留下假的交接。
test('「」、code span 與 code block 裡的對應單是引用，不算', () => {
  const result = run('#30 本文寫明「spay2 對應單：spay/spay2#692」。\n\n## 驗收\n\n- 測試：本文含 `spay2 對應單：spay/spay2#692` 的 fixture 抽出 `spay/spay2#692`。\n\n```\n對應單：a/b#1\n```\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
