import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

// #304：#289、#291 本文寫 `spay/spay2#692`，spay2 在自架 GitLab，Close 才發現（#295）。adapter 宣告 spay/spay2 後，
// 帶 --adapter 時印 COUNTERPART_BARE（Probe 用同一個判斷）；改成網址後不再印。fixture 是 #289 當時的本文開頭。
const adapter = new URL('../docs/agents/issue-run.md', import.meta.url).pathname;
const issue289 = ref => `來源：http://192.168.200.202/spay/spay2/-/issues/692 refine（使用者採用建議，只共用通用工具、pilot 腳本各自保留）。spay2 對應單：${ref}。

## 問題

\`detect.mjs\` 只認固定名稱，把已在跑常駐 pilot 的專案判低。
`;

test('#289 本文寫裸 ref spay/spay2#692：本 repo adapter 宣告了 spay/spay2，印 COUNTERPART_BARE', () => {
  const result = spawnSync('node', [script, '--adapter', adapter], { input: issue289('spay/spay2#692'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART spay/spay2#692\nCOUNTERPART_BARE spay/spay2#692\n');
});

test('#289 改成 issue 網址後不再印 COUNTERPART_BARE', () => {
  const result = spawnSync('node', [script, '--adapter', adapter], { input: issue289('http://192.168.200.202/spay/spay2/-/issues/692'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART spay/spay2#692 gitlab http://192.168.200.202/spay/spay2\n');
});

// Probe 那一層（counterpartLines，pilot-probe.mjs 用同一份 adapter 宣告）：#289 本文的裸 ref 在派工前印出，同一張單改成網址後不再印。
test('Probe：#289 本文寫裸 ref 時印 COUNTERPART_BARE 289 spay/spay2#692，改成網址後不印', async () => {
  const { counterpartLines } = await import('../scripts/pilot-probe.mjs');
  const { declaredProjects } = await import('../scripts/pilot-counterpart.mjs');
  const projects = declaredProjects(readFileSync(adapter, 'utf8'));
  const node = body => ({ number: 289, title: '', body, createdAt: '2026-11-02T00:00:00Z', labels: { nodes: [{ name: 'ready-for-agent' }] },
    assignees: { nodes: [] }, blocking: { nodes: [] }, blockedBy: { nodes: [] }, comments: { nodes: [] }, timelineItems: { nodes: [] },
    closedByPullRequestsReferences: { nodes: [] }, subIssuesSummary: { total: 0 }, parent: null });
  const repo = 'ron03wlb/ron-skills';
  assert.deepEqual(counterpartLines([node(issue289('spay/spay2#692'))], repo, new Set(), projects), ['COUNTERPART_BARE 289 spay/spay2#692']);
  assert.deepEqual(counterpartLines([node(issue289('http://192.168.200.202/spay/spay2/-/issues/692'))], repo, new Set(), projects), []);
});
