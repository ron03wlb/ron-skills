import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #56 掛著 ready-for-agent，驗收卻要讀只在別台機器上的 spay2，worker 開工就 STOP（#116）。
// 規則只寫在 adapter 的 Readiness；/triage 讀的是 triage-labels.md，所以那裡只放 pointer，不複製規則。
const adapter = readFileSync(new URL('../docs/agents/issue-run.md', import.meta.url), 'utf8');
const labels = readFileSync(new URL('../docs/agents/triage-labels.md', import.meta.url), 'utf8');
const readiness = adapter.match(/^## Readiness\n([\s\S]*?)(?=^## )/m)[1];

test('Readiness 要求驗收與做法用到的輸入都取得到，否則維持 needs-info', () => {
  assert.match(readiness, /本 repo、tracker 或公開來源/);
  assert.match(readiness, /`needs-info`/);
  assert.match(readiness, /缺的是什麼、去哪裡拿/);
});

test('triage-labels.md 以 pointer 指向 Readiness，不另寫一份規則', () => {
  const pointer = labels.match(/^.*`ready-for-agent`.*\]\(issue-run\.md#readiness\).*$/m);
  assert.ok(pointer, 'triage-labels.md 要有一行指向 issue-run.md#readiness');
  assert.doesNotMatch(labels, /本 repo、tracker 或公開來源/);
});
