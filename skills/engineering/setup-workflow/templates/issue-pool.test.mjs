import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSample } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { git } from './test/repo-fixture.mjs';

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
 * 每次呼叫一行 JSON 寫進 calls.log。script 在暫存的 git repo 裡跑，sessions 給了就寫成它的 `.scratch/pilot/sessions.md`。 */
function fakeGh({ issues = [], views = [view()], sessions } = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'issue-pool-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  if (sessions !== undefined) {
    mkdirSync(join(repo, '.scratch/pilot'), { recursive: true });
    writeFileSync(join(repo, '.scratch/pilot/sessions.md'), sessions);
  }
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
  const runAt = (cwd, ...args) => spawnSync('node', [SCRIPT, '--repo', 'acme/app', ...args], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const run = (...args) => runAt(repo, ...args);
  // 不帶 --repo：tracker 專案由 script 自己判定。
  const runBare = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const calls = () => { try { return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  return { run, runAt, runBare, calls, repo };
}

test('標 ready-for-agent、沒被 block、不是母單、沒被認領的 Issue 歸到 ready', () => {
  const { run } = fakeGh({ issues: [issue(7, { labels: ['enhancement', 'ready-for-agent'] })] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 標題 7\n');
});

const BUCKET_CASES = [
  ['blocked', '有開著的 blocked_by', issue(7, { labels: ['bug', 'ready-for-agent'], blockedBy: [3] })],
  ['blocked', '掛 retro 也照樣被開著的 blocked_by 擋住', issue(7, { labels: ['enhancement', 'ready-for-agent', 'retro'], blockedBy: [3] })],
  ['parent', '有 sub-issue 的母單，即使標了 ready-for-agent', issue(7, { labels: ['ready-for-agent'], subIssues: 2 })],
  ['needs-triage', '標 needs-triage', issue(7, { labels: ['bug', 'needs-triage'] })],
  ['needs-info', '標 needs-info', issue(7, { labels: ['bug', 'needs-info'] })],
  ['human', '標 ready-for-human', issue(7, { labels: ['enhancement', 'ready-for-human'] })],
  ['unlabeled', '沒有任何 triage label', issue(7, { labels: ['enhancement'] })],
  ['claimed', '已被指派、24 小時內有留言', issue(7, { labels: ['bug', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(2) })],
  ['stale', '已被指派、超過 24 小時沒有新留言', issue(7, { labels: ['bug', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(25) })],
  ['retro-candidates', '標 retro-candidates（retro 的候選清單，等 /retro-collect）', issue(7, { labels: ['retro-candidates', 'ready-for-agent'] })],
  ['human', '標 ready-for-human、指派給人很久沒留言（不是 agent 的認領）', issue(7, { labels: ['enhancement', 'ready-for-human'], assignees: ['ron'], assignedAt: hoursAgo(72) })],
];
for (const [bucket, why, fixture] of BUCKET_CASES) {
  test(`${why}的 Issue 歸到 ${bucket}`, () => {
    const result = fakeGh({ issues: [fixture] }).run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${bucket} #7 標題 7\n`);
  });
}

test('認領時限可以用 --stale-hours 覆寫，過期只歸到 stale、不釋放', () => {
  const { run, calls } = fakeGh({ issues: [issue(7, { labels: ['bug', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(3) })] });
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

// #106：`retro` 是 retro 判定太複雜、要交給 worker 的單，照一般 triage 進池子，而且先挑；候選清單另掛 `retro-candidates`。
test('ready 排序：掛 retro 的先，勝過掛 priority 的', () => {
  assert.deepEqual(readyOrder([
    issue(9, { labels: ['ready-for-agent', 'priority'] }),
    issue(12, { labels: ['ready-for-agent', 'retro'] }),
  ]), ['#12', '#9']);
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
    issue(12, { labels: ['bug', 'needs-triage'] }),
    issue(2, { labels: ['bug', 'ready-for-agent'], blockedBy: [11] }),
    issue(11, { labels: ['bug', 'ready-for-agent'], blocking: [2] }),
    issue(1, { labels: ['bug', 'needs-triage'] }),
  ] }).run();
  assert.equal(result.stdout, 'ready #11 標題 11\nblocked #2 標題 2\nneeds-triage #1 標題 1\nneeds-triage #12 標題 12\n');
});

const noCategory = issues => fakeGh({ issues }).run().stdout.split('\n').filter(line => line.startsWith('NO_CATEGORY '));

test('有 triage 狀態 label 卻沒有分類 label 的單印 NO_CATEGORY（#130 當時是 ready-for-agent,retro）', () => {
  const result = fakeGh({ issues: [issue(130, { labels: ['ready-for-agent', 'retro'] })] }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #130 標題 130\nNO_CATEGORY 130\n');
});

test('NO_CATEGORY 不印：已有分類、沒有 triage 狀態、母單（sub-issue 或 parent label）、retro-candidates', () => {
  assert.deepEqual(noCategory([
    issue(130, { labels: ['ready-for-agent', 'retro', 'bug'] }),
    issue(131, { labels: ['retro'] }),
    issue(132, { labels: ['ready-for-agent'], subIssues: 2 }),
    issue(133, { labels: ['parent', 'ready-for-agent'] }),
    issue(134, { labels: ['retro-candidates', 'ready-for-agent'] }),
  ]), []);
});

test('NO_CATEGORY 涵蓋每個 triage 狀態與每個桶，依號碼排序', () => {
  assert.deepEqual(noCategory([
    issue(9, { labels: ['wontfix'] }),
    issue(3, { labels: ['needs-triage'] }),
    issue(5, { labels: ['ready-for-human'] }),
    issue(4, { labels: ['needs-info'] }),
    issue(8, { labels: ['ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(1) }),
    issue(6, { labels: ['ready-for-agent'], blockedBy: [3] }),
  ]), ['NO_CATEGORY 3', 'NO_CATEGORY 4', 'NO_CATEGORY 5', 'NO_CATEGORY 6', 'NO_CATEGORY 8', 'NO_CATEGORY 9']);
});

test('分類 label 可以用 --categories 覆寫（adapter 的分類 label 不是 bug、enhancement 時）', () => {
  const { run } = fakeGh({ issues: [issue(7, { labels: ['ready-for-agent', 'type:feature'] }), issue(8, { labels: ['ready-for-agent', 'bug'] })] });
  assert.equal(run('--categories', 'type:feature,type:bug').stdout, 'ready #7 標題 7\nready #8 標題 8\nNO_CATEGORY 8\n');
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

// #135：handoff 之後重派，認領者是這台機器上已交接出去的前任 coordinator（sessions.md 有它的 handoff 行），
// 而 claim 的是現任 coordinator（有 start 行、沒交接出去），就直接以前任的 session 接手。
const SESSIONS = '2026-10-31T09:00:00+08:00   session old-coord   pid 4242   ron-skills-15\n'
  + '2026-10-31T10:00:00+08:00   handoff from-session old-coord → terminal term_1   reason 合入 2 批\n'
  + '2026-10-31T10:00:05+08:00   session sess-1   pid 4343   ron-skills-16\n';

test('claim：認領者是本機前任 coordinator（sessions.md 有它）時以它的 session 接手', () => {
  const theirs = `認領：${HOST}／old-coord`;
  const { run, calls } = fakeGh({ sessions: SESSIONS, views: [
    view({ assignees: ['ron'], comments: [['ron', theirs]] }),
    view({ assignees: ['ron'], comments: [['ron', theirs], ['ron', theirs]] }),
  ] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7 takeover old-coord\n');
  assert.deepEqual(writes(calls()), [
    ['issue', 'comment', '7', '--repo', 'acme/app', '--body', theirs],
    ['issue', 'edit', '7', '--repo', 'acme/app', '--add-assignee', '@me'],
  ]);
});

test('claim：別台機器的認領者即使 session 在 sessions.md 也停下，不改 Issue', () => {
  const { run, calls } = fakeGh({ sessions: SESSIONS, views: [view({ assignees: ['ron'], comments: [['ron', '認領：other-box／old-coord']] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed other-box／old-coord\n');
  assert.deepEqual(writes(calls()), []);
});

test('claim：sessions.md 不存在時本機別的 session 照舊停下，不改 Issue', () => {
  const { run, calls } = fakeGh({ views: [view({ assignees: ['ron'], comments: [['ron', `認領：${HOST}／old-coord`]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, `STOP 7 claimed ${HOST}／old-coord\n`);
  assert.deepEqual(writes(calls()), []);
});

test('claim：從 worktree 跑時讀主 checkout 的 sessions.md', () => {
  const theirs = `認領：${HOST}／old-coord`;
  const { runAt, repo } = fakeGh({ sessions: SESSIONS, views: [view({ assignees: ['ron'], comments: [['ron', theirs]] }), view({ assignees: ['ron'], comments: [['ron', theirs], ['ron', theirs]] })] });
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'issue/7', join(repo, '..', 'wt'));
  const result = runAt(join(repo, '..', 'wt'), 'claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7 takeover old-coord\n');
});

const STOP_CASES = [
  ['認領者還在任（只有 start 行、沒交接出去）', `${HOST}／live-coord`, '2026-10-31T09:00:00+08:00   session live-coord   pid 4242   ron-skills-15\n2026-10-31T09:00:05+08:00   session sess-1   pid 4343   ron-skills-16\n'],
  ['claim 的不是現任 coordinator（例如 --pool 或手動 /issue-run）', `${HOST}／old-coord`, SESSIONS.replace(/.*session sess-1 .*\n/, '')],
  ['claim 的 coordinator 自己也已交接出去', `${HOST}／old-coord`, `${SESSIONS}2026-10-31T11:00:00+08:00   handoff from-session sess-1 → terminal term_2   reason 合入 2 批\n`],
  ['認領者只撞到 sessions.md 其他欄位的字（session 名稱、terminal handle）', `${HOST}／term_1`, SESSIONS],
];
for (const [why, claimer, sessions] of STOP_CASES) {
  test(`claim：${why}時照舊停下，不改 Issue`, () => {
    const { run, calls } = fakeGh({ sessions, views: [view({ assignees: ['ron'], comments: [['ron', `認領：${claimer}`]] })] });
    const result = run('claim', '7', '--session', 'sess-1');
    assert.equal(result.status, 4);
    assert.equal(result.stdout, `STOP 7 claimed ${claimer}\n`);
    assert.deepEqual(writes(calls()), []);
  });
}

// GitLab tracker（#108）：docs/agents/issue-tracker.md 寫 glab 時改用 glab。樣本 test/fixtures/gitlab/ 不是實際回應：本機沒有 glab，
// 欄位依 GitLab GraphQL reference（WorkItemWidgetLabels、Assignees、Hierarchy、LinkedItems、Notes）與 REST issues、notes 文件組成，
// 只取 script 讀的欄位；列表的 `comments`、`activity` 是 query 裡 notes 的別名。
const glabFixture = name => JSON.parse(readFileSync(new URL(`./test/fixtures/gitlab/${name}.json`, import.meta.url), 'utf8'));
const GL_PAGE = glabFixture('work-items');
const GL_NODE = GL_PAGE.data.project.workItems.nodes[0];
const GL_ISSUE = glabFixture('issue');
const GL_NOTES = glabFixture('notes');

/** 一張 GitLab work item：參數同 issue()，children 是有沒有子項目；blockedBy、blocking 的數字是同專案 acme/app 開著的單。
 * widgets 是不同型別的陣列，逐個依 __typename 對樣本的同型 widget 合併。 */
function workItem(number, { labels = [], assignees = [], children = false, blockedBy = [], blocking = [], commentAt, activity = [] } = {}) {
  const link = linkType => ref => {
    const [, path = 'acme/app', n, state = 'OPEN'] = String(ref).match(/^(?:(.+)#)?(\d+)(?::(\w+))?$/);
    return { linkType, workItem: { iid: n, state, namespace: { fullPath: path } } };
  };
  const widget = (typename, patch) => mergeSample(GL_NODE.widgets.find(w => w.__typename === typename), patch, typename);
  return {
    ...mergeSample(GL_NODE, { iid: String(number), title: `標題 ${number}` }, 'workItem'),
    widgets: [
      widget('WorkItemWidgetLabels', { labels: { nodes: labels.map(title => ({ title })) } }),
      widget('WorkItemWidgetAssignees', { assignees: { nodes: assignees.map(username => ({ username })) } }),
      widget('WorkItemWidgetHierarchy', { hasChildren: children }),
      widget('WorkItemWidgetLinkedItems', { linkedItems: { nodes: [...blockedBy.map(link('is_blocked_by')), ...blocking.map(link('blocks'))] } }),
      widget('WorkItemWidgetNotes', { comments: { nodes: commentAt ? [{ createdAt: commentAt }] : [] }, activity: { nodes: activity.map(([body, createdAt]) => ({ body, createdAt })) } }),
    ],
  };
}

/** claim 讀到的 GitLab Issue：REST 的 issue（assignees）與 notes（[作者, 內文, 建立時間, id]；system 給 true 是系統紀錄）。 */
const glView = ({ assignees = [], notes = [] } = {}) => ({
  issue: mergeSample(GL_ISSUE, { assignees: assignees.map((username, i) => ({ id: i + 1, username, name: username })) }, 'issue'),
  notes: notes.map(([username, body, createdAt = GL_NOTES[0].created_at, id = 300, system = false]) =>
    mergeSample(GL_NOTES[0], { id, author: { id: 1, username, name: username }, body, created_at: createdAt, system }, 'note')),
});

/** PATH 上的假 glab，在 origin 指向 originUrl、docs/agents/issue-tracker.md 為 trackerDoc 的暫存 repo 裡跑。
 * `api graphql` 回 work items 頁面；`api projects/<p>` 回專案；`api user` 回登入者；`api projects/<p>/issues/<n>` 與 `.../notes` 依序回 views 的第 i 個；
 * 其餘只記錄 argv。 */
function fakeGlab({ items = [], views = [glView()], originUrl = 'https://gitlab.example.com/acme/app.git', trackerDoc = 'Issues live in GitLab; use the `glab` CLI.\n' } = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'issue-pool-glab-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  git(repo, 'init', '-q', '--initial-branch=main');
  if (originUrl) git(repo, 'remote', 'add', 'origin', originUrl);
  if (trackerDoc !== null) writeFileSync(join(repo, 'docs/agents/issue-tracker.md'), trackerDoc);
  const page = mergeSample(GL_PAGE, { data: { project: { workItems: { pageInfo: { hasNextPage: false, endCursor: null } } } } }, 'page');
  page.data.project.workItems.nodes = items;
  writeFileSync(join(dir, 'page.json'), JSON.stringify(page));
  writeFileSync(join(dir, 'views.json'), JSON.stringify(views));
  writeFileSync(join(dir, 'samples.json'), JSON.stringify({ project: glabFixture('project'), user: glabFixture('user') }));
  writeFileSync(join(dir, 'glab'), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(join(dir, 'calls.log'))};
let previous = [];
try { previous = readFileSync(log, 'utf8').trim().split('\\n').map(line => JSON.parse(line)); } catch {}
appendFileSync(log, JSON.stringify(args) + '\\n');
const read = name => JSON.parse(readFileSync(${JSON.stringify(dir)} + '/' + name, 'utf8'));
const endpoint = args[0] === 'api' ? args.slice(1).find(arg => !arg.startsWith('-') && /^(graphql|user|projects\\/)/.test(arg)) : undefined;
const nth = kind => { const views = read('views.json'); return views[Math.min(previous.filter(call => call.includes(kind)).length, views.length - 1)]; };
if (args.includes('DELETE')) {}
else if (endpoint === 'graphql') process.stdout.write(readFileSync(${JSON.stringify(join(dir, 'page.json'))}));
else if (endpoint === 'user') process.stdout.write(JSON.stringify(read('samples.json').user));
else if (/\\/notes/.test(endpoint ?? '')) {
  // 同 glab v1.126.0 的 internal/commands/api/api.go：--paginate 時每頁原樣接著印（[...][...]，不合併）；--output ndjson 每個元素一行。
  const notes = nth(endpoint).notes;
  if (args.includes('ndjson')) process.stdout.write(notes.map(note => JSON.stringify(note) + '\\n').join(''));
  else for (let i = 0; i === 0 || i < notes.length; i += 100) process.stdout.write(JSON.stringify(notes.slice(i, i + 100)));
}
else if (/\\/issues\\/\\d+$/.test(endpoint ?? '')) process.stdout.write(JSON.stringify(nth(endpoint).issue));
else if (endpoint) process.stdout.write(JSON.stringify(read('samples.json').project));
`);
  chmodSync(join(dir, 'glab'), 0o755);
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const calls = () => { try { return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  return { run, calls, repo };
}

// 每個桶各一個 GitLab fixture：子項目（hierarchy）是母單，is_blocked_by 開著的單是 blocked，認領時限看最近的留言或指派紀錄。
for (const [bucket, options] of [
  ['parent', { labels: ['enhancement', 'ready-for-agent'], children: true }],
  ['human', { labels: ['enhancement', 'ready-for-human'] }],
  ['stale', { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], commentAt: hoursAgo(30), activity: [['assigned to @ron', hoursAgo(30)]] }],
  ['claimed', { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], commentAt: hoursAgo(30), activity: [['assigned to @ron', hoursAgo(1)]] }],
  ['retro-candidates', { labels: ['retro-candidates'] }],
  ['blocked', { labels: ['enhancement', 'ready-for-agent'], blockedBy: [5] }],
  ['needs-info', { labels: ['enhancement', 'needs-info'] }],
  ['needs-triage', { labels: ['enhancement', 'needs-triage'] }],
  ['ready', { labels: ['enhancement', 'ready-for-agent'], blockedBy: ['5:CLOSED'] }],
  ['unlabeled', {}],
]) {
  test(`GitLab：${bucket} 桶`, () => {
    const { run } = fakeGlab({ items: [workItem(7, options)] });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${bucket} #7 標題 7\n`);
  });
}

test('GitLab：系統紀錄裡只有指派算認領後的動靜，改 label 這類紀錄不算', () => {
  const { run } = fakeGlab({ items: [workItem(7, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'],
    activity: [['assigned to @ron', hoursAgo(30)], ['added ~"ready-for-agent" label', hoursAgo(1)]] })] });
  assert.equal(run().stdout, 'stale #7 標題 7\n');
});

test('GitLab：ready 依 blocks 連結排序（關鍵路徑），列表以 glab api graphql 查 checkout 推得的專案', () => {
  const { run, calls } = fakeGlab({ items: [
    workItem(4, { labels: ['enhancement', 'ready-for-agent'] }),
    workItem(8, { labels: ['enhancement', 'ready-for-agent'], blocking: [20, 'other/group/app#3'] }),
    workItem(20, { labels: ['enhancement', 'ready-for-agent'], blockedBy: [8] }),
  ] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #8 標題 8\nready #4 標題 4\nblocked #20 標題 20\n');
  const [project, graphql] = calls();
  assert.deepEqual(project, ['api', 'projects/:id']);
  assert.deepEqual(graphql.slice(0, 4), ['api', 'graphql', '-f', 'fullPath=acme/app']);
  assert.match(graphql.at(-1), /^query=.*workItems\(types:\[ISSUE\],state:opened/);
});

const glMine = `${HOST}／s1`;
const glWrites = calls => calls.filter(call => call[0] === 'issue' || call.includes('DELETE'));

test('GitLab claim：先以 glab issue note 留認領，再 glab issue update --assignee +<登入者>，重讀確認最早的認領是自己', () => {
  const { run, calls } = fakeGlab({ views: [glView(), glView({ assignees: ['ron'], notes: [['ron', `認領：${glMine}`, new Date().toISOString(), 301]] })] });
  const result = run('claim', '7', '--session', 's1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7\n');
  assert.deepEqual(glWrites(calls()), [['issue', 'note', '7', '-m', `認領：${glMine}`], ['issue', 'update', '7', '--assignee', '+ron']]);
  assert.ok(calls().some(call => call[1] === 'projects/:id/issues/7/notes?sort=asc&order_by=created_at&per_page=100' && call.includes('--paginate')));
});

test('GitLab claim：留言超過一頁（100 則）也讀得到全部，最近一則認領在第二頁', () => {
  const old = Array.from({ length: 120 }, (_, i) => ['ron', `討論 ${i}`, GL_NOTES[0].created_at, 100 + i]);
  const { run, calls } = fakeGlab({ views: [glView({ assignees: ['ron'], notes: [...old, ['ron', '認領：other／s9']] })] });
  const result = run('claim', '7', '--session', 's1');
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, 'STOP 7 claimed other／s9\n');
  assert.deepEqual(glWrites(calls()), []);
});

test('GitLab claim：系統紀錄不算留言；別台的認領比自己早就依 id 刪掉自己那則並停下', () => {
  const now = new Date().toISOString();
  const { run, calls } = fakeGlab({ views: [
    glView({ notes: [['ron', 'assigned to @ron', now, 290, true]] }),
    glView({ assignees: ['ron'], notes: [['ron', 'assigned to @ron', now, 290, true], ['ron', '認領：other／s9', now, 300], ['ron', `認領：${glMine}`, now, 301]] }),
  ] });
  const result = run('claim', '7', '--session', 's1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed other／s9\n');
  assert.deepEqual(glWrites(calls()).at(-1), ['api', '-X', 'DELETE', 'projects/:id/issues/7/notes/301']);
});

test('GitLab claim：已被別的 session 認領就停下，不改 Issue', () => {
  const { run, calls } = fakeGlab({ views: [glView({ assignees: ['ron'], notes: [['ron', '認領：other／s9']] })] });
  const result = run('claim', '7', '--session', 's1');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 7 claimed other／s9\n');
  assert.deepEqual(glWrites(calls()), []);
});

// tracker host 與程式碼 host 分開：程式碼在 GitHub、Issue 在自架 GitLab 時，專案與主機取自 issue-tracker.md 的網址。
const SPLIT_DOC = 'Issues live on our GitLab (http://192.168.200.202/spay/spay2/-/issues); use the `glab` CLI. Code: https://github.com/acme/app.\n';

test('tracker 是自架 GitLab、程式碼在 GitHub：列表帶 --hostname 與文件裡的專案路徑', () => {
  const { run, calls } = fakeGlab({ originUrl: 'https://github.com/acme/app.git', trackerDoc: SPLIT_DOC, items: [workItem(3, { labels: ['enhancement', 'ready-for-agent'] })] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #3 標題 3\n');
  const [graphql] = calls();
  assert.deepEqual(graphql.slice(0, 4), ['api', 'graphql', '-f', 'fullPath=spay/spay2']);
  assert.deepEqual(graphql.slice(-2), ['--hostname', '192.168.200.202']);
});

test('tracker 是自架 GitLab、程式碼在 GitHub：claim 以 -R 專案網址留言與指派，讀取帶 --hostname', () => {
  const { run, calls } = fakeGlab({ originUrl: 'https://github.com/acme/app.git', trackerDoc: SPLIT_DOC,
    views: [glView(), glView({ assignees: ['ron'], notes: [['ron', `認領：${glMine}`, new Date().toISOString(), 301]] })] });
  const result = run('claim', '7', '--session', 's1');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(glWrites(calls()), [
    ['issue', 'note', '7', '-R', 'http://192.168.200.202/spay/spay2', '-m', `認領：${glMine}`],
    ['issue', 'update', '7', '-R', 'http://192.168.200.202/spay/spay2', '--assignee', '+ron'],
  ]);
  assert.deepEqual(calls()[0], ['api', 'projects/spay%2Fspay2/issues/7', '--hostname', '192.168.200.202']);
});

test('issue-tracker.md 沒寫 gh 或 glab（本機 Markdown tracker）時 exit 2，不呼叫任何 CLI', () => {
  const { run, calls } = fakeGlab({ trackerDoc: 'Issues are Markdown files under .scratch/issues/.\n' });
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /local/);
  assert.deepEqual(calls(), []);
});

test('tracker 是 GitHub、程式碼在 GitLab：gh 查 issue-tracker.md 網址裡的 <owner>/<repo>', () => {
  const { runBare, calls, repo } = fakeGh({ issues: [issue(7, { labels: ['enhancement', 'ready-for-agent'] })] });
  git(repo, 'remote', 'add', 'origin', 'git@gitlab.example.com:acme/app.git');
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  writeFileSync(join(repo, 'docs/agents/issue-tracker.md'), 'Issues: https://github.com/acme/tracker/issues, read with `gh`.\n');
  const result = runBare();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 標題 7\n');
  assert.deepEqual(calls()[0].slice(0, 6), ['api', 'graphql', '-F', 'owner=acme', '-F', 'name=tracker']);
});

test('還沒有 issue-tracker.md 時 tracker 照 HOSTS.md 依 origin 推：origin 在 GitLab 就用 glab', () => {
  const { run, calls } = fakeGlab({ trackerDoc: null, items: [workItem(7, { labels: ['enhancement', 'ready-for-agent'] })] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 標題 7\n');
  assert.deepEqual(calls()[0], ['api', 'projects/:id']);
});

test('同種 GitLab 加 --repo：-R 與 --hostname 都指向 origin 的主機，不落到 glab 的預設主機', () => {
  const { run, calls } = fakeGlab({ originUrl: 'git@192.168.200.202:spay/spay2.git',
    views: [glView(), glView({ assignees: ['ron'], notes: [['ron', `認領：${glMine}`, new Date().toISOString(), 301]] })] });
  const result = run('claim', '7', '--repo', 'spay/spay2', '--session', 's1');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls()[0], ['api', 'projects/spay%2Fspay2/issues/7', '--hostname', '192.168.200.202']);
  assert.deepEqual(glWrites(calls())[0], ['issue', 'note', '7', '-R', 'https://192.168.200.202/spay/spay2', '-m', `認領：${glMine}`]);
});
