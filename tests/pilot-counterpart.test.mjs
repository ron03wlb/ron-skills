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

// #79 的驗收：spay2 在自架 GitLab（http、IP），對應單寫成 issue 網址；Close 要用 glab issue note -m，glab 沒有 -F／--body-file。
test('GitLab 對應單（spay/spay2#692）：印出 gitlab 與專案網址，COMMAND 是 glab issue note -R … -m', () => {
  const file = '/repo/.scratch/pilot/counterpart-30.md';
  const result = spawnSync('node', [script, '--file', file], { encoding: 'utf8',
    input: '依賴 #29（正本）。spay2 對應單：http://192.168.200.202/spay/spay2/-/issues/692。\n\n## 背景\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART spay/spay2#692 gitlab http://192.168.200.202/spay/spay2\n'
    + `COMMAND glab issue note 692 -R http://192.168.200.202/spay/spay2 -m "$(cat ${file})"\n`);
  assert.doesNotMatch(result.stdout, /--body-file|\s-F\s/);
});
