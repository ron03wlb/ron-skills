import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSample } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./issue-pool.mjs', import.meta.url));
// 真實 gh 回應的樣本（ron03wlb/ron-skills 2026-10-31）：issues.json 是列表用的 `gh api graphql`，issue-view.json 是 claim 讀的
// `gh issue view --json assignees,comments`。fixture 只能覆寫樣本有的欄位，替身才不會長出 GitHub 沒有的形狀。
const fixture = name => JSON.parse(readFileSync(new URL(`./test/fixtures/github/${name}.json`, import.meta.url), 'utf8'));
const SAMPLE = fixture('issues');
const NODE = SAMPLE.data.repository.issues.nodes[0];
const VIEW = fixture('issue-view');
const hoursAgo = hours => new Date(Date.now() - hours * 3600_000).toISOString();

/** 一張開著的 Issue：沒指定的欄位是空的（沒 label、沒指派、沒相依、沒留言）。 */
function issue(number, { labels = [], assignees = [], subIssues = 0, blockedBy = [], blocking = [], commentAt, assignedAt } = {}) {
  // 數字是本 repo 的開著的單；`<owner>/<repo>#<n>` 是別的 repo 的。
  const nodes = list => list.map(ref => {
    const [, repo = 'acme/app', n] = String(ref).match(/^(?:(.+)#)?(\d+)$/);
    return { number: Number(n), state: 'OPEN', repository: { nameWithOwner: repo } };
  });
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

/** claim 讀到的 Issue：assignees 是登入名，comments 是 [作者, 內文, 建立時間（省略時沿用樣本，是很久以前）]。 */
const view = ({ assignees = [], comments = [] } = {}) => mergeSample(VIEW, {
  assignees: assignees.map(login => ({ login })),
  comments: comments.map(([login, body, createdAt = VIEW.comments[0].createdAt]) => ({ author: { login }, body, createdAt })),
}, 'view');

/** PATH 上的假 gh：`api graphql` 回 issues 頁面；`issue view` 依序回 views 的第 i 個（用完就一直回最後一個），其餘只記錄 argv；
 * 每次呼叫一行 JSON 寫進 calls.log。 */
function fakeGh({ issues = [], views = [view()] } = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'issue-pool-'));
  const page = mergeSample(SAMPLE, { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues } } } }, 'page');
  writeFileSync(join(dir, 'page.json'), JSON.stringify(page));
  writeFileSync(join(dir, 'views.json'), JSON.stringify(views));
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(join(dir, 'calls.log'))};
let previous = [];
try { previous = readFileSync(log, 'utf8').trim().split('\\n').map(line => JSON.parse(line)); } catch {}
appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === 'graphql') process.stdout.write(readFileSync(${JSON.stringify(join(dir, 'page.json'))}));
else if (args[0] === 'issue' && args[1] === 'view') {
  const views = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'views.json'))}, 'utf8'));
  const i = previous.filter(([cmd, sub]) => cmd === 'issue' && sub === 'view').length;
  process.stdout.write(JSON.stringify(views[Math.min(i, views.length - 1)]));
}
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

const BUCKET_CASES = [
  ['blocked', '有開著的 blocked_by', issue(7, { labels: ['ready-for-agent'], blockedBy: [3] })],
  ['parent', '有 sub-issue 的母單，即使標了 ready-for-agent', issue(7, { labels: ['ready-for-agent'], subIssues: 2 })],
  ['needs-triage', '標 needs-triage', issue(7, { labels: ['bug', 'needs-triage'] })],
  ['needs-info', '標 needs-info', issue(7, { labels: ['needs-info'] })],
  ['human', '標 ready-for-human', issue(7, { labels: ['ready-for-human'] })],
  ['unlabeled', '沒有任何 triage label', issue(7, { labels: ['enhancement'] })],
  ['claimed', '已被指派、24 小時內有留言', issue(7, { labels: ['ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(2) })],
  ['stale', '已被指派、超過 24 小時沒有新留言', issue(7, { labels: ['ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(25) })],
  ['retro', '標 retro', issue(7, { labels: ['retro', 'needs-triage'] })],
  ['human', '標 ready-for-human、指派給人很久沒留言（不是 agent 的認領）', issue(7, { labels: ['ready-for-human'], assignees: ['ron'], assignedAt: hoursAgo(72) })],
];
for (const [bucket, why, fixture] of BUCKET_CASES) {
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

test('ready 排序：別的 repo 的單算一張，不沿著同號碼的本 repo 單往下走', () => {
  assert.deepEqual(readyOrder([
    issue(4, { labels: ['ready-for-agent'], blocking: [22, 23] }),
    issue(5, { labels: ['ready-for-agent'], blocking: ['acme/web#20'] }),
    issue(20, { labels: ['ready-for-agent'], blocking: [21, 24, 25] }),
  ]), ['#20', '#4', '#5']);
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
const writes = calls => calls.filter(([cmd, sub]) => cmd === 'issue' && ['edit', 'comment'].includes(sub));

test('claim：先留「認領：<機器>／<session>」，再指派給自己，重讀確認最早的認領是自己', () => {
  const mine = `認領：${HOST}／sess-1`;
  const { run, calls } = fakeGh({ views: [view(), view({ assignees: ['ron'], comments: [['ron', mine]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7\n');
  assert.deepEqual(writes(calls()), [
    ['issue', 'comment', '7', '--repo', 'acme/app', '--body', mine],
    ['issue', 'edit', '7', '--repo', 'acme/app', '--add-assignee', '@me'],
  ]);
});

// 同一個帳號在兩台機器同時 claim：兩邊讀到的都是沒人指派，GitHub 也不擋重複指派，只能靠留言先後決勝。
test('claim：寫入後重讀，別台機器的認領留言比自己早就停下', () => {
  const { run, calls } = fakeGh({ views: [view(), view({ assignees: ['ron'], comments: [['ron', '認領：other-box／sess-9'], ['ron', `認領：${HOST}／sess-1`]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed other-box／sess-9\n');
  // 搶輸的認領留言要收回，否則贏家重派時最近一則認領是輸家的，會被擋下。
  assert.deepEqual(calls().at(-1), ['issue', 'comment', '7', '--repo', 'acme/app', '--delete-last', '--yes']);
});

test('claim：已被別的機器或別的 session 認領就停下，不改 Issue', () => {
  for (const claimer of ['other-box／sess-9', `${HOST}／sess-2`]) {
    const { run, calls } = fakeGh({ views: [view({ assignees: ['ron'], comments: [['ron', `認領：${claimer}`]] })] });
    const result = run('claim', '7', '--session', 'sess-1');
    assert.equal(result.status, 4);
    assert.equal(result.stdout, `STOP 7 claimed ${claimer}\n`);
    assert.deepEqual(writes(calls()), []);
  }
});

// A 留了認領、還沒指派的空檔裡 B 讀到「沒人指派」：B 要把 A 剛留的認領當成進行中，不能也寫進去。
test('claim：還沒人指派，但 5 分鐘內有別的 session 留了認領，就停下', () => {
  const { run, calls } = fakeGh({ views: [view({ comments: [['ron', '認領：other-box／sess-9', hoursAgo(0.01)]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed other-box／sess-9\n');
  assert.deepEqual(writes(calls()), []);
});

test('claim：沒人指派、只有很久以前的認領留言（已被取消指派）時照常認領', () => {
  const mine = `認領：${HOST}／sess-1`;
  const { run } = fakeGh({ views: [view({ comments: [['ron', '認領：other-box／sess-9', hoursAgo(48)]] }), view({ assignees: ['ron'], comments: [['ron', '認領：other-box／sess-9', hoursAgo(48)], ['ron', mine]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7\n');
});

test('claim：被指派卻沒有認領留言（人手動指派、或引用文字裡的認領）就停下', () => {
  const quoted = `上次寫的是：\n\n\`\`\`\n認領：${HOST}／sess-1\n\`\`\``;
  const { run, calls } = fakeGh({ views: [view({ assignees: ['ron'], comments: [['ron', quoted]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed ron\n');
  assert.deepEqual(writes(calls()), []);
});

test('claim：認領留言的作者已不在指派名單（指派換了人）就停下', () => {
  const { run } = fakeGh({ views: [view({ assignees: ['bob'], comments: [['ron', `認領：${HOST}／sess-1`]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed bob\n');
});

// 重派同一張：再留一次認領，讓 Pool 的活動時間跟著更新，正在做的單不會被列成 stale。
test('claim：最近一則認領是同一個 session 時照常再認領一次', () => {
  const mine = `認領：${HOST}／sess-1`;
  const { run, calls } = fakeGh({ views: [view({ assignees: ['ron'], comments: [['ron', mine]] }), view({ assignees: ['ron'], comments: [['ron', mine], ['ron', mine]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7\n');
  assert.equal(writes(calls()).length, 2);
});
