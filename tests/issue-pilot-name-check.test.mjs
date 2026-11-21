import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #364：pid 變了、coordinator 仍傳舊 --name，coordinator 與 sessions.md 寫入舊名，別的 session SendMessage 找不到它。
const read = path => readFileSync(new URL(`../skills/engineering/issue-pilot/${path}`, import.meta.url), 'utf8');
const skill = read('SKILL.md');
const start = skill.indexOf('\n## Entry\n');
const entry = skill.slice(start, skill.indexOf('\n## ', start + 1));
const reconcile = skill.split('\n').find(line => line.startsWith('1. **Reconcile.**'));

test('Entry：名稱照順序在跑 entry／register 之前就從 ListAgents 重取，pid 變了也算', () => {
  const rule = entry.indexOf("The session name the entry or register command takes comes from `ListAgents` in this session, never from an earlier turn or the store: when this session's pid differs from the one it last registered");
  assert.ok(rule >= 0, '缺少取名的句子');
  assert.ok(rule < entry.indexOf("Before anything else, run the adapter's entry command"), '取名要排在跑 entry command 之前');
});

test('Entry：NAME_CHECK 的處理在 fallback 段之外，entry command 與 register command 都適用', () => {
  const paragraphs = entry.split('\n\n');
  const rule = paragraphs.find(text => text.includes('`NAME_CHECK`'));
  assert.ok(rule, '缺少 NAME_CHECK 的句子');
  assert.doesNotMatch(rule, /only the fallback/);
  assert.match(rule, /When the entry or register command prints `NAME_CHECK`.*take the name from `ListAgents` again and rerun the command with it/);
});

test('Reconcile：每輪重跑 register 也給 ListAgents 名稱，NAME_CHECK 照 Entry', () => {
  assert.ok(reconcile, '缺少第 1 步');
  assert.match(reconcile, /give it the `ListAgents` name, and on `NAME_CHECK` rerun it as in \[Entry\]\(#entry\)/);
});

test('PILOT-STORE.md 的 pilot-register 結果行列出 NAME_CHECK', () => {
  const row = read('PILOT-STORE.md').split('\n').find(line => line.startsWith('| `pilot-register.mjs` |'));
  assert.match(row, /`NAME_CHECK <current name> registered <--name>`.*exit 0/);
});
