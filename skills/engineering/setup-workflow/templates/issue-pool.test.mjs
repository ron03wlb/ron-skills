import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSample } from './test/fake-orca.mjs';

const SCRIPT = fileURLToPath(new URL('./issue-pool.mjs', import.meta.url));
// 真實 `gh api graphql` 回應的樣本（ron03wlb/ron-skills 2026-10-31）；fixture 只能覆寫樣本有的欄位，替身才不會長出 GitHub 沒有的形狀。
const SAMPLE = JSON.parse(readFileSync(new URL('./test/fixtures/github/issues.json', import.meta.url), 'utf8'));
const NODE = SAMPLE.data.repository.issues.nodes[0];
const hoursAgo = hours => new Date(Date.now() - hours * 3600_000).toISOString();

/** 一張開著的 Issue：沒指定的欄位是空的（沒 label、沒指派、沒相依、沒留言）。 */
function issue(number, { labels = [], assignees = [], subIssues = 0, blockedBy = [], blocking = [], commentAt, assignedAt } = {}) {
  const nodes = list => list.map(n => ({ number: n, state: 'OPEN' }));
  return mergeSample(NODE, {
    number, title: `標題 ${number}`,
    labels: { nodes: labels.map(name => ({ name })) },
    assignees: { nodes: assignees.map(login => ({ login })) },
    subIssuesSummary: { total: subIssues },
    blockedBy: { nodes: nodes(blockedBy) }, blocking: { nodes: nodes(blocking) },
    comments: { nodes: commentAt ? [{ createdAt: commentAt }] : [] },
    timelineItems: { nodes: assignedAt ? [{ createdAt: assignedAt }] : [] },
  }, 'issue');
}

/** PATH 上的假 gh：`api graphql` 回 issues 頁面、`issue view` 回 view，其餘只記錄 argv；每次呼叫一行 JSON 寫進 calls.log。 */
function fakeGh({ issues = [], view = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-pool-'));
  const page = mergeSample(SAMPLE, { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues } } } }, 'page');
  writeFileSync(join(dir, 'page.json'), JSON.stringify(page));
  writeFileSync(join(dir, 'view.json'), JSON.stringify(view));
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === 'graphql') process.stdout.write(readFileSync(${JSON.stringify(join(dir, 'page.json'))}));
else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(readFileSync(${JSON.stringify(join(dir, 'view.json'))}));
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (...args) => spawnSync('node', [SCRIPT, '--repo', 'acme/app', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const calls = () => { try { return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  return { run, calls };
}

test('標 ready-for-agent、沒被 block、不是母單、沒被認領的 Issue 歸到 ready', () => {
  const { run } = fakeGh({ issues: [issue(7, { labels: ['enhancement', 'ready-for-agent'] })] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 標題 7\n');
});

const BUCKETS = [
  ['blocked', '有開著的 blocked_by', issue(7, { labels: ['ready-for-agent'], blockedBy: [3] })],
  ['parent', '有 sub-issue 的母單，即使標了 ready-for-agent', issue(7, { labels: ['ready-for-agent'], subIssues: 2 })],
  ['needs-triage', '標 needs-triage', issue(7, { labels: ['bug', 'needs-triage'] })],
  ['needs-info', '標 needs-info', issue(7, { labels: ['needs-info'] })],
  ['human', '標 ready-for-human', issue(7, { labels: ['ready-for-human'] })],
  ['unlabeled', '沒有任何 triage label', issue(7, { labels: ['enhancement'] })],
  ['claimed', '已被指派、24 小時內有留言', issue(7, { labels: ['ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(2) })],
  ['stale', '已被指派、超過 24 小時沒有新留言', issue(7, { labels: ['ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(25) })],
  ['retro', '標 retro', issue(7, { labels: ['retro', 'needs-triage'] })],
];
for (const [bucket, why, fixture] of BUCKETS) {
  test(`${why}的 Issue 歸到 ${bucket}`, () => {
    const result = fakeGh({ issues: [fixture] }).run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${bucket} #7 標題 7\n`);
  });
}

test('認領時限可以用 --stale-hours 覆寫，過期只歸到 stale、不釋放', () => {
  const { run, calls } = fakeGh({ issues: [issue(7, { labels: ['ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(3) })] });
  assert.equal(run().stdout, 'claimed #7 標題 7\n');
  assert.equal(run('--stale-hours', '2').stdout, 'stale #7 標題 7\n');
  assert.ok(calls().every(([cmd, sub]) => cmd === 'api' && sub === 'graphql'), '列出時只讀，不改 Issue');
});

const readyOrder = issues => fakeGh({ issues }).run().stdout.split('\n').filter(line => line.startsWith('ready ')).map(line => line.split(' ')[1]);

test('ready 排序：掛 priority 的先，勝過 block 較多開著的單', () => {
  assert.deepEqual(readyOrder([
    issue(5, { labels: ['ready-for-agent'], blocking: [20, 21] }),
    issue(9, { labels: ['ready-for-agent', 'priority'] }),
    issue(20, { labels: ['ready-for-agent'], blockedBy: [5] }),
    issue(21, { labels: ['ready-for-agent'], blockedBy: [5] }),
  ]), ['#9', '#5']);
});

test('ready 排序：直接或間接 block 開著的單較多的先，勝過號碼小的', () => {
  assert.deepEqual(readyOrder([
    issue(4, { labels: ['ready-for-agent'], blocking: [22] }),
    issue(8, { labels: ['ready-for-agent'], blocking: [20] }),
    issue(20, { labels: ['ready-for-agent'], blockedBy: [8], blocking: [21] }),
    issue(21, { labels: ['ready-for-agent'], blockedBy: [20] }),
    issue(22, { labels: ['ready-for-agent'], blockedBy: [4] }),
  ]), ['#8', '#4']);
});

test('ready 排序：其餘相同時號碼小的先；已關閉的 blocking 不算', () => {
  const closed = issue(6, { labels: ['ready-for-agent'] });
  closed.blocking.nodes = [{ number: 30, state: 'CLOSED' }];
  assert.deepEqual(readyOrder([closed, issue(3, { labels: ['ready-for-agent'] })]), ['#3', '#6']);
});

test('ready 桶先印，其餘依桶的順序、桶內依號碼', () => {
  const result = fakeGh({ issues: [
    issue(12, { labels: ['needs-triage'] }),
    issue(2, { labels: ['ready-for-agent'], blockedBy: [11] }),
    issue(11, { labels: ['ready-for-agent'], blocking: [2] }),
    issue(1, { labels: ['needs-triage'] }),
  ] }).run();
  assert.equal(result.stdout, 'ready #11 標題 11\nblocked #2 標題 2\nneeds-triage #1 標題 1\nneeds-triage #12 標題 12\n');
});

const HOST = (await import('node:os')).hostname();

test('claim：指派給自己，再留一則「認領：<機器>／<session>」留言', () => {
  const { run, calls } = fakeGh({ view: { assignees: [], comments: [] } });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7\n');
  assert.deepEqual(calls().slice(1), [
    ['issue', 'edit', '7', '--repo', 'acme/app', '--add-assignee', '@me'],
    ['issue', 'comment', '7', '--repo', 'acme/app', '--body', `認領：${HOST}／sess-1`],
  ]);
});

test('claim：已被別台機器認領就停下，不改 Issue', () => {
  const { run, calls } = fakeGh({ view: { assignees: [{ login: 'ron' }], comments: [{ body: '認領：other-box／sess-9' }] } });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed other-box／sess-9\n');
  assert.ok(calls().every(([cmd, sub]) => !(cmd === 'issue' && ['edit', 'comment'].includes(sub))));
});

test('claim：最近一則認領是同一台機器時（重派同一張）不重複留言', () => {
  const { run, calls } = fakeGh({ view: { assignees: [{ login: 'ron' }], comments: [{ body: '認領：other-box／sess-9' }, { body: `認領：${HOST}／sess-0` }] } });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7 already\n');
  assert.equal(calls().length, 1);
});
