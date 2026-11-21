import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisionsIn, parentHints, refsNeeded } from './parent-hints.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./parent-hints.mjs', import.meta.url));
const REPO = 'acme/app';

const child = (number, { state = 'OPEN', body = '## 驗收\n\n- [ ] ok', blockedBy = [] } = {}) => ({
  number, state, body,
  blockedBy: { nodes: blockedBy.map(([m, s = 'OPEN', repo = REPO]) => ({ number: m, state: s, repository: { nameWithOwner: repo } })) },
});
const parent = ({ number = 50, state = 'OPEN', labels = ['parent'], body = '', children = [] } = {}) => ({
  number, state, body, labels: { nodes: labels.map(name => ({ name })) }, subIssues: { nodes: children },
});
const hints = (p, others = {}) => parentHints(p, new Map(Object.entries(others).map(([n, v]) => [Number(n), v])), REPO);

test('子單、標籤、本文都沒問題時沒有提示', () => {
  const p = parent({ body: '## 已確認的決策\n\n- R1-Q1 甲\n- R1-Q2 乙', children: [child(51, { body: '## 驗收\n\nR1-Q1、R1-Q2' }), child(52, { state: 'CLOSED', body: '' })] });
  assert.deepEqual(hints(p), []);
});

test('第 1 類：子單全關、母單還開著', () => {
  assert.deepEqual(hints(parent({ children: [child(51, { state: 'CLOSED' }), child(52, { state: 'CLOSED' })] })), ['PARENT_ALL_CLOSED 50 #51 #52']);
  assert.deepEqual(hints(parent({ state: 'CLOSED', children: [child(51, { state: 'CLOSED' })] })), []);
});

test('第 2 類：母單掛 triage 狀態 label', () => {
  assert.deepEqual(hints(parent({ labels: ['parent', 'ready-for-agent', 'needs-info'], children: [child(51)] })), ['PARENT_TRIAGE_LABEL 50 ready-for-agent,needs-info']);
});

test('第 3 類：開著的子單本文依賴開著、不在 blocked_by 的單；已關、已列、否定、自己都不算', () => {
  const p = parent({ children: [
    child(51, { body: '依賴 #60、#61（同檔）。不依賴 #62。\n## 驗收\n- x', blockedBy: [[61]] }),
    child(52, { body: '排在 #63 之後；依賴 #64、#52\n## 驗收條件\n- x' }),
    child(53, { state: 'CLOSED', body: '依賴 #60' }),
  ] });
  assert.deepEqual(refsNeeded(p, REPO), [60, 63, 64]);
  assert.deepEqual(hints(p, { 60: { state: 'OPEN', body: '' }, 63: { state: 'OPEN', body: '' }, 64: { state: 'CLOSED', body: '' } }), ['PARENT_PROSE_DEPS 50 #51:#60 #52:#63']);
});

test('第 4 類：開著的子單沒有 `## 驗收`（`## 驗收條件` 也算），關著的不看', () => {
  const p = parent({ children: [child(51, { body: '### 驗收\n- x' }), child(52, { body: '## 驗收條件\n- x' }), child(53, { body: '無' }), child(54, { state: 'CLOSED', body: '' })] });
  assert.deepEqual(hints(p), ['PARENT_NO_ACCEPTANCE 50 #51 #53']);
});

test('第 5 類：已確認決策段的編號沒出現在子單，同輪範圍兩邊都展開，段外的編號不算', () => {
  const body = '來源：決策 R1-Q1～R3-Q9。\n\n## 已確認的決策\n\n- R1-Q1 甲\n- R2-Q1～Q4 乙\n- R2-Q5～R2-Q6 丙\n\n## 說明\n\nR4-Q1 不在段裡';
  const p = parent({ body, children: [child(51, { body: '## 驗收\nR1-Q1、R2-Q2～R2-Q3' }), child(52, { state: 'CLOSED', body: 'R2-Q1～Q1、R2-Q10' })] });
  assert.deepEqual(hints(p), ['PARENT_DECISIONS_MISSING 50 R2-Q4 R2-Q5 R2-Q6']);
});

test('第 5 類：決策那一行送到別張單（→ #88）時，那張單的本文提到就算有', () => {
  const p = parent({ body: '## 已確認決策\n\n- R1-Q1 → #88\n- R1-Q2 #89 的內文補充\n', children: [child(51)] });
  assert.deepEqual(refsNeeded(p, REPO), [88, 89]);
  assert.deepEqual(hints(p, { 88: { state: 'CLOSED', body: '照 R1-Q1 做' }, 89: { state: 'OPEN', body: '無' } }), ['PARENT_DECISIONS_MISSING 50 R1-Q2']);
});

test('第 5 類：決策行只提到別張單（依 #94 的規則）不算送過去；→、見、「的內文」才算', () => {
  const p = parent({ body: '## 已確認決策\n\n- R1-Q1 依 #94 的規則\n- R1-Q2 驗收見 #13\n- R1-Q3 #14 的內文補充\n', children: [child(51)] });
  assert.deepEqual(refsNeeded(p, REPO), [13, 14]);
  assert.deepEqual(hints(p, { 13: { state: 'OPEN', body: 'R1-Q2' }, 14: { state: 'OPEN', body: 'R1-Q3' }, 94: { state: 'OPEN', body: 'R1-Q1' } }), ['PARENT_DECISIONS_MISSING 50 R1-Q1']);
});

test('decisionsIn 讀列舉：R2-Q1、Q2、R2-Q4/Q5～Q6 沿用前一個輪次', () => {
  assert.deepEqual([...decisionsIn('R2-Q1、Q2，R2-Q4/Q5～Q6 與 R3-Q1, Q3').numbers], ['R2-Q1', 'R2-Q2', 'R2-Q4', 'R2-Q5', 'R2-Q6', 'R3-Q1', 'R3-Q3']);
});

test('跨輪範圍展不開：母單的另印一行請人列出，子單的不算涵蓋任何編號', () => {
  const p = parent({ body: '## 已確認的決策\n\n- R2-Q4～R3-Q2 見 B 組\n- R3-Q3 丁\n', children: [child(51, { body: '## 驗收\nR2-Q1～R3-Q5' })] });
  assert.deepEqual(hints(p), ['PARENT_DECISIONS_MISSING 50 R3-Q3', 'PARENT_DECISION_RANGE 50 R2-Q4～R3-Q2']);
});

test('decisionsIn 展開同輪範圍、收集跨輪範圍', () => {
  const { numbers, crossRanges } = decisionsIn('R1-Q2～Q3、R1-Q5~R1-Q5、R2-Q9 至 R3-Q1、R10-Q1');
  assert.deepEqual([...numbers], ['R1-Q2', 'R1-Q3', 'R1-Q5', 'R10-Q1']);
  assert.deepEqual(crossRanges, ['R2-Q9～R3-Q1']);
});

/** PATH 上的假 gh：母單列表、母單查詢與號碼查詢各回固定 JSON。 */
function fakeGh({ list = [], parents = {}, refs = {} }) {
  const dir = mkdtempSync(join(realTmpdir(), 'parent-hints-'));
  const cwd = join(dir, 'repo');
  mkdirSync(cwd);
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const query = args.find(arg => arg.startsWith('query=')) ?? '';
const number = Number((args.find(arg => arg.startsWith('number=')) ?? '').slice(7));
const parents = ${JSON.stringify(parents)};
if (args[0] !== 'api' || args[1] !== 'graphql') { console.error('unexpected ' + args.join(' ')); process.exit(1); }
if (query.includes('subIssuesSummary')) process.stdout.write(JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: ${JSON.stringify(list)} } } } }));
else if (query.includes('subIssues(')) {
  if (!parents[number]) { console.error('Could not resolve to an Issue with the number of ' + number); process.exit(1); }
  process.stdout.write(JSON.stringify({ data: { repository: { issue: parents[number] } } }));
}
else process.stdout.write(JSON.stringify({ data: { repository: ${JSON.stringify(Object.fromEntries(Object.entries(refs).map(([n, v]) => [`i${n}`, { number: Number(n), ...v }])))} } }));
`);
  chmodSync(join(dir, 'gh'), 0o755);
  return (...args) => spawnSync('node', [SCRIPT, '--repo', REPO, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
}

test('CLI：不帶號碼時查所有開著的母單，依號碼一類一行；沒有提示時不輸出、exit 0', () => {
  const run = fakeGh({
    list: [{ number: 70, subIssuesSummary: { total: 1 } }, { number: 50, subIssuesSummary: { total: 2 } }, { number: 9, subIssuesSummary: { total: 0 } }],
    parents: {
      50: parent({ labels: ['needs-triage'], children: [child(51, { body: '依賴 #60\n## 驗收\n- x' })] }),
      70: parent({ number: 70, children: [child(71)] }),
    },
    refs: { 60: { state: 'OPEN', body: '' } },
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'PARENT_TRIAGE_LABEL 50 needs-triage\nPARENT_PROSE_DEPS 50 #51:#60\n');
  const quiet = run('70');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
});

test('CLI：gh 失敗 exit 1、用法錯誤 exit 2', () => {
  const run = fakeGh({});
  const missing = run('404');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /gh api graphql 失敗/);
  assert.equal(run('--bogus').status, 2);
  assert.equal(run('abc').status, 2);
});
