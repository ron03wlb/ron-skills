// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSample } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { git } from './test/repo-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('./issue-pool.mjs', import.meta.url));
// 真實 gh 回應的樣本（ron03wlb/ron-skills 2026-10-31；`parent` 是 2026-11-21 對 #108 補查的）：issues.json 是列表用的 `gh api graphql`，issue-view.json 是 claim 讀的
// `gh issue view --json assignees,comments`。fixture 只能覆寫樣本有的欄位，替身才不會長出 GitHub 沒有的形狀。
const fixture = name => JSON.parse(readFileSync(new URL(`./test/fixtures/github/${name}.json`, import.meta.url), 'utf8'));
const SAMPLE = fixture('issues');
const NODE = SAMPLE.data.repository.issues.nodes[0];
const VIEW = fixture('issue-view');
const hoursAgo = hours => new Date(Date.now() - hours * 3600_000).toISOString();

/** 一張開著的 Issue：沒指定的欄位是空的（沒 label、沒指派、沒相依、沒留言）。comments 是 [內文, 建立時間]，給了就取代 commentAt。 */
function issue(number, { labels = [], assignees = [], subIssues = 0, blockedBy = [], blocking = [], commentAt, assignedAt, prs = [], body = '', comments, parent } = {}) {
  // 數字是本 repo 的開著的單；`<owner>/<repo>#<n>` 是別的 repo 的。
  const nodes = list => list.map(ref => {
    const [, repo = 'acme/app', n] = String(ref).match(/^(?:(.+)#)?(\d+)$/);
    return { number: Number(n), state: 'OPEN', repository: { nameWithOwner: repo } };
  });
  return mergeSample(NODE, {
    number, title: `標題 ${number}`, body,
    labels: { nodes: labels.map(name => ({ name })) },
    assignees: { nodes: assignees.map(login => ({ login })) },
    subIssuesSummary: { total: subIssues },
    blockedBy: { nodes: nodes(blockedBy) }, blocking: { nodes: nodes(blocking) },
    comments: { nodes: comments ? comments.map(([text, createdAt]) => ({ body: text, createdAt })) : commentAt ? [{ createdAt: commentAt, body: '' }] : [] },
    timelineItems: { nodes: assignedAt ? [{ createdAt: assignedAt }] : [] },
    closedByPullRequestsReferences: { nodes: prs.map(state => ({ state })) },
    // parent 同 blockedBy 的寫法：數字是本 repo 的母單，`<owner>/<repo>#<n>` 是別的 repo 的；沒給時沒有母單。
    parent: parent === undefined ? null : (({ number, repository }) => ({ number, repository }))(nodes([parent])[0]),
  }, 'issue');
}

/** claim 讀到的 Issue：assignees 是登入名，comments 是 [作者, 內文, 建立時間（省略時沿用樣本，是很久以前）]。 */
const view = ({ assignees = [], comments = [] } = {}) => mergeSample(VIEW, {
  assignees: assignees.map(login => ({ login })),
  comments: comments.map(([login, body, createdAt = VIEW.comments[0].createdAt]) => ({ author: { login }, body, createdAt })),
}, 'view');

/** PATH 上的假 gh：`api graphql` 回 issues 頁面；`issue view` 依序回 views 的第 i 個（用完就一直回最後一個），其餘只記錄 argv；
 * 每次呼叫一行 JSON 寫進 calls.log。script 在暫存的 git repo 裡跑，sessions 給了就寫成它的 `.scratch/pilot/sessions.md`。
 * CLAUDE_CONFIG_DIR 指向暫存目錄，不讀使用者的 ~/.claude；transcripts 是 { <session>: [最後寫入幾小時前, 內容] }。 */
function fakeGh({ issues = [], views = [view()], sessions, transcripts = {}, children, linkedPrs = [], env = {} } = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'issue-pool-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  if (sessions !== undefined) {
    mkdirSync(join(repo, '.scratch/pilot'), { recursive: true });
    writeFileSync(join(repo, '.scratch/pilot/sessions.md'), sessions);
  }
  const projects = join(dir, 'claude/projects/-Users-ron-Documents-Workspace-ron-skills');
  mkdirSync(projects, { recursive: true });
  for (const [session, [hours, body]] of Object.entries(transcripts)) {
    const file = join(projects, `${session}.jsonl`);
    writeFileSync(file, body);
    const at = new Date(Date.now() - hours * 3600_000);
    utimesSync(file, at, at);
  }
  const page = mergeSample(SAMPLE, { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues } } } }, 'page');
  writeFileSync(join(dir, 'page.json'), JSON.stringify(page));
  writeFileSync(join(dir, 'views.json'), JSON.stringify(views));
  if (children) writeFileSync(join(dir, 'children.json'), JSON.stringify(children));
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(join(dir, 'calls.log'))};
let previous = [];
try { previous = readFileSync(log, 'utf8').trim().split('\\n').map(line => JSON.parse(line)); } catch {}
appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === 'graphql' && args.some(arg => arg.includes('headRefName'))) process.stdout.write(JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: ${JSON.stringify(linkedPrs)} } } } } }));
else if (args[0] === 'api' && args[1] === 'graphql' && args.some(arg => arg.includes('subIssues('))) process.stdout.write(readFileSync(${JSON.stringify(join(dir, 'children.json'))}));
else if (args[0] === 'api' && args[1] === 'graphql') process.stdout.write(readFileSync(${JSON.stringify(join(dir, 'page.json'))}));
else if (args[0] === 'issue' && args[1] === 'view') {
  const views = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'views.json'))}, 'utf8'));
  const i = previous.filter(([cmd, sub]) => cmd === 'issue' && sub === 'view').length;
  process.stdout.write(JSON.stringify(views[Math.min(i, views.length - 1)]));
}
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const runAt = (cwd, ...args) => spawnSync('node', [SCRIPT, '--repo', 'acme/app', ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), PATH: `${dir}:${process.env.PATH}`, ...env } });
  const run = (...args) => runAt(repo, ...args);
  // 不帶 --repo：tracker 專案由 script 自己判定。
  const runBare = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), PATH: `${dir}:${process.env.PATH}` } });
  const calls = () => { try { return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  return { run, runAt, runBare, calls, repo };
}

// #284：#278、#281 都有開著的 PR，卻沒有指派、沒有認領留言，Probe 印 POOL_READY，只靠 coordinator 剛好多看一眼才沒重複派工。
test('有開著的 PR 指向它的 ready 單歸到 in-review，不進池子；PR 已合併或關閉的留在 ready', () => {
  const { run } = fakeGh({ issues: [
    issue(278, { labels: ['enhancement', 'ready-for-agent'], prs: ['OPEN'] }),
    issue(281, { labels: ['enhancement', 'ready-for-agent'], prs: ['MERGED'] }),
    issue(282, { labels: ['enhancement', 'ready-for-agent'], prs: ['CLOSED'] }),
  ] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #281 標題 281\nready #282 標題 282\nin-review #278 標題 278\n');
});

test('標 ready-for-agent、沒被 block、不是母單、沒被認領的 Issue 歸到 ready', () => {
  const { run } = fakeGh({ issues: [issue(7, { labels: ['enhancement', 'ready-for-agent'] })] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 標題 7\n');
});

// #397（retro 1120a 的 #391 第 5 項）：Shared registry 要知道 ready 單的母單，coordinator 原本對每張母單另跑 `gh api …/sub_issues`。
test('有母單的 ready 行在號碼與標題之間附 parent #<p>（別的 repo 的母單寫全名）；沒有母單的行不變，其他桶不附', () => {
  const result = fakeGh({ issues: [
    issue(362, { labels: ['enhancement', 'ready-for-agent'], parent: 351 }),
    issue(363, { labels: ['enhancement', 'ready-for-agent'] }),
    issue(364, { labels: ['enhancement', 'ready-for-agent'], parent: 'other/repo#9' }),
    issue(365, { labels: ['enhancement', 'needs-triage'], parent: 351 }),
    issue(366, { labels: ['enhancement', 'ready-for-agent'], blockedBy: [3], parent: 351 }),
  ] }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #362 parent #351 標題 362\nready #363 標題 363\nready #364 parent other/repo#9 標題 364\n'
    + 'blocked #366 ready-for-agent by #3 標題 366\nneeds-triage #365 標題 365\n');
});

const BUCKET_CASES = [
  ['blocked', '有開著的 blocked_by', issue(7, { labels: ['bug', 'ready-for-agent'], blockedBy: [3] }), 'ready-for-agent by #3 '],
  // #337：被別的 repo 開著的 Issue 擋住也歸 blocked（investing#332 依賴 ron-skills#335 卻被當 ready 派工）。
  ['blocked', '被別的 repo 開著的 Issue 擋住（跨 repo 原生 blocked_by）', issue(7, { labels: ['bug', 'ready-for-agent'], blockedBy: ['acme/tools#335'] }), 'ready-for-agent by acme/tools#335 '],
  ['blocked', '掛 retro 也照樣被開著的 blocked_by 擋住', issue(7, { labels: ['enhancement', 'ready-for-agent', 'retro'], blockedBy: [3] }), 'ready-for-agent by #3 '],
  ['parent', '有 sub-issue 的母單，即使標了 ready-for-agent', issue(7, { labels: ['ready-for-agent'], subIssues: 2 })],
  ['needs-triage', '標 needs-triage', issue(7, { labels: ['bug', 'needs-triage'] })],
  ['needs-info', '標 needs-info', issue(7, { labels: ['bug', 'needs-info'] })],
  ['human', '標 ready-for-human', issue(7, { labels: ['enhancement', 'ready-for-human'] })],
  ['unlabeled', '沒有任何 triage label', issue(7, { labels: ['enhancement'] })],
  ['claimed', '已被指派、24 小時內有留言', issue(7, { labels: ['bug', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(2) })],
  ['stale', '已被指派、超過 24 小時沒有新留言', issue(7, { labels: ['bug', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(25) })],
  ['retro-candidates', '標 retro-candidates（retro 的候選清單，等 /retro-collect）', issue(7, { labels: ['retro-candidates', 'ready-for-agent'] })],
  // #270：/retro-collect 認領候選清單後它被指派，不能混進 claimed、stale，和真的在跑的 worker 並列。
  ['retro-candidates', '標 retro-candidates、已被 /retro-collect 認領（指派、最近有認領留言）', issue(7, { labels: ['retro-candidates'], assignees: ['ron'], assignedAt: hoursAgo(1), commentAt: hoursAgo(1) })],
  ['retro-candidates', '標 retro-candidates、認領超過 24 小時沒有新留言', issue(7, { labels: ['retro-candidates'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(25) })],
  ['human', '標 ready-for-human、指派給人很久沒留言（不是 agent 的認領）', issue(7, { labels: ['enhancement', 'ready-for-human'], assignees: ['ron'], assignedAt: hoursAgo(72) })],
];
// blocked 行在號碼與標題之間多了狀態與 blocker（#352），第四欄就是這一段。
for (const [bucket, why, fixture, detail = ''] of BUCKET_CASES) {
  test(`${why}的 Issue 歸到 ${bucket}`, () => {
    const result = fakeGh({ issues: [fixture] }).run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${bucket} #7 ${detail}標題 7\n`);
  });
}

// #337：跨 repo 的 blocker 關閉後恢復 ready（同 repo blocker 的行為不變，見上表）。
test('跨 repo 的 blocker 關閉後，Issue 回到 ready', () => {
  const blocked = issue(7, { labels: ['bug', 'ready-for-agent'], blockedBy: ['acme/tools#335'] });
  blocked.blockedBy.nodes[0].state = 'CLOSED';
  const result = fakeGh({ issues: [blocked] }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 標題 7\n');
});

test('認領時限可以用 --stale-hours 覆寫，過期只歸到 stale、不釋放', () => {
  const { run, calls } = fakeGh({ issues: [issue(7, { labels: ['bug', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(3) })] });
  assert.equal(run().stdout, 'claimed #7 標題 7\n');
  assert.equal(run('--stale-hours', '2').stdout, 'stale #7 標題 7\n');
  assert.ok(calls().every(([cmd, sub]) => cmd === 'api' && sub === 'graphql'), '列出時只讀，不改 Issue');
});

test('已認領的 retro-candidates 超過 --stale-hours 仍歸 retro-candidates（#270）', () => {
  const { run } = fakeGh({ issues: [issue(7, { labels: ['retro-candidates'], assignees: ['ron'], assignedAt: hoursAgo(3), commentAt: hoursAgo(3) })] });
  assert.equal(run().stdout, 'retro-candidates #7 標題 7\n');
  assert.equal(run('--stale-hours', '2').stdout, 'retro-candidates #7 標題 7\n');
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
  assert.equal(result.stdout, 'ready #11 標題 11\nblocked #2 ready-for-agent by #11 標題 2\nneeds-triage #1 標題 1\nneeds-triage #12 標題 12\n');
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

// #352（investing#199 第 2 項）：每張一行時 `| tail` 只看得到 NO_CATEGORY，擠掉 ready 行，所以彙總成一行。
test('NO_CATEGORY 涵蓋每個 triage 狀態與每個桶，彙總成一行、號碼升冪', () => {
  assert.deepEqual(noCategory([
    issue(9, { labels: ['wontfix'] }),
    issue(3, { labels: ['needs-triage'] }),
    issue(5, { labels: ['ready-for-human'] }),
    issue(4, { labels: ['needs-info'] }),
    issue(8, { labels: ['ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(1) }),
    issue(6, { labels: ['ready-for-agent'], blockedBy: [3] }),
  ]), ['NO_CATEGORY 3 4 5 6 8 9']);
});

test('分類 label 可以用 --categories 覆寫（adapter 的分類 label 不是 bug、enhancement 時）', () => {
  const { run } = fakeGh({ issues: [issue(7, { labels: ['ready-for-agent', 'type:feature'] }), issue(8, { labels: ['ready-for-agent', 'bug'] })] });
  assert.equal(run('--categories', 'type:feature,type:bug').stdout, 'ready #7 標題 7\nready #8 標題 8\nNO_CATEGORY 8\n');
});

// #326：investing 的 `ci-report` 報告單（每週 CI 健康報告）和 retro-candidates 一樣不會被實作，adapter 以 --skip-labels 宣告，
// 歸到以該 label 命名的桶（排在 retro-candidates 之後），不進 ready、needs-triage，不印 NO_CATEGORY，指派了也不算 claimed、stale。
test('--skip-labels 的 label 和 retro-candidates 一樣自成一桶、不進 ready／needs-triage、不印 NO_CATEGORY', () => {
  const { run } = fakeGh({ issues: [
    issue(7, { labels: ['ci-report', 'ready-for-agent'] }),
    issue(8, { labels: ['ci-report', 'needs-triage'] }),
    issue(9, { labels: ['ci-report'], assignees: ['ron'], assignedAt: hoursAgo(30), commentAt: hoursAgo(25) }),
    issue(10, { labels: ['wip-log', 'needs-triage'] }),
    issue(11, { labels: ['bug', 'ready-for-agent'] }),
    issue(12, { labels: ['retro-candidates'] }),
    issue(13, { labels: ['bug', 'needs-info'] }),
  ] });
  const result = run('--skip-labels', 'ci-report,wip-log');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #11 標題 11\nretro-candidates #12 標題 12\nci-report #7 標題 7\nci-report #8 標題 8\nci-report #9 標題 9\nwip-log #10 標題 10\nneeds-info #13 標題 13\n');
});

test('沒帶 --skip-labels 時 ci-report 照一般 triage label 分桶、照印 NO_CATEGORY（行為不變）', () => {
  const { run } = fakeGh({ issues: [issue(7, { labels: ['ci-report', 'ready-for-agent'] }), issue(8, { labels: ['ci-report', 'needs-triage'] })] });
  assert.equal(run().stdout, 'ready #7 標題 7\nneeds-triage #8 標題 8\nNO_CATEGORY 7 8\n');
});

test('--skip-labels 沒給值時印用法、exit 2', () => {
  const { run } = fakeGh();
  assert.equal(run('--skip-labels').status, 2);
});

// #352（#324 第 1 項，investing#190）：#133 本文寫 `Operator prerequisite：開跑前由 Operator 確認`，照列 ready，到 worker preflight 才停。
test('ready 單本文的 Operator prerequisite 不是「無」時另印 PREREQ <n> <內容>；寫「無」、不在 ready 桶的不印', () => {
  const result = fakeGh({ issues: [
    issue(133, { labels: ['enhancement', 'ready-for-agent'], body: '## 背景\n\n保留期。\n\nOperator prerequisite：開跑前由 Operator 確認（保留期只能用一次）\n' }),
    issue(134, { labels: ['enhancement', 'ready-for-agent'], body: 'Operator prerequisite：無' }),
    issue(135, { labels: ['enhancement', 'ready-for-agent'], blockedBy: [3], body: 'Operator prerequisite：要先開 gate' }),
    issue(136, { labels: ['enhancement', 'ready-for-agent'] }),
    issue(137, { labels: ['enhancement', 'ready-for-agent'], body: 'Operator prerequisite：無（不需 Operator）' }),
    issue(138, { labels: ['enhancement', 'ready-for-agent'], body: '**Operator prerequisite：** 無' }),
  ] }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #133 標題 133\nready #134 標題 134\nready #136 標題 136\nready #137 標題 137\nready #138 標題 138\nblocked #135 ready-for-agent by #3 標題 135\n'
    + 'PREREQ 133 開跑前由 Operator 確認（保留期只能用一次）\n');
});

/** 在 fakeGh 的暫存 repo 做出整合分支 pilot/integration：main 一個起始 commit；subjects 依序 commit 在整合分支上；
 * merged 的分支各從 main 開、commit 一次再 `merge --no-ff` 進整合分支（git 預設主旨 `Merge branch '<分支>' into pilot/integration`）；
 * fresh 的分支開在整合分支的 tip、沒有自己的 commit；unmerged 的分支從 main 開、有自己的 commit、沒合入。回傳 rev-parse。 */
function integrationBranch(repo, { subjects = [], merged = [], fresh = [], unmerged = [] } = {}) {
  const g = (...args) => git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args);
  g('commit', '-q', '--allow-empty', '-m', 'init');
  g('checkout', '-q', '-b', 'pilot/integration');
  for (const subject of subjects) g('commit', '-q', '--allow-empty', '-m', subject);
  for (const branch of [...merged, ...unmerged]) {
    g('checkout', '-q', '-b', branch, 'main');
    g('commit', '-q', '--allow-empty', '-m', `work on ${branch}`);
    g('checkout', '-q', 'pilot/integration');
    if (merged.includes(branch)) g('merge', '-q', '--no-ff', '--no-edit', branch);
  }
  for (const branch of fresh) g('branch', branch, 'pilot/integration');
  g('checkout', '-q', 'main');
  return ref => git(repo, 'rev-parse', ref);
}

// #352（#330 第 1 項，investing#330）：blocked 行看不出狀態與 blocker，blocker 已在 develop 也看不出來；investing retro 1120b 的 #434…#438 都是 needs-triage。
test('blocked 行附狀態 label 與開著的 blocker；沒有狀態 label 時寫 unlabeled，別的 repo 的 blocker 寫全名', () => {
  const result = fakeGh({ issues: [
    issue(247, { labels: ['enhancement', 'needs-triage'], blockedBy: [151, 'other/repo#9'] }),
    issue(248, { labels: ['enhancement'], blockedBy: [151] }),
  ] }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'blocked #247 needs-triage by #151,other/repo#9 標題 247\nblocked #248 unlabeled by #151 標題 248\n');
});

test('--integration：blocker 在整合分支有 (#<m>) commit 時標 (landed <整合分支>)；(#1510) 不算 #151', () => {
  const f = fakeGh({ issues: [
    issue(247, { labels: ['enhancement', 'needs-triage'], blockedBy: [151, 152] }),
    issue(249, { labels: ['enhancement', 'ready-for-agent'], blockedBy: [151, 1510] }),
  ] });
  integrationBranch(f.repo, { subjects: ['加報價來源 (#152)', '別張 (#1510)'] });
  const result = f.run('--integration', 'pilot/integration');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'blocked #247 needs-triage by #151,#152 (landed pilot/integration) 標題 247\n'
    + 'blocked #249 ready-for-agent by #151,#1510 (landed pilot/integration) 標題 249\n');
});

// #352（#332 第 1 項，investing#269）：已合入 develop、只等 main 的單列成 claimed／stale，照字面釋放會重做；/issue-queue 報「進行中 4／上限 3」。
const LANDED_ISSUES = [
  // 最近一則認領之後有 DONE 結果行。
  issue(229, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30),
    comments: [['認領：box／s1', hoursAgo(30)], ['**worker 結果**\n\nDONE 229 1a4726f', hoursAgo(29)]] }),
  // DONE 在最近一則認領之前：之後又被認領重做，不算。
  issue(230, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(1),
    comments: [['DONE 230 aaf0927', hoursAgo(40)], ['認領：box／s2', hoursAgo(1)]] }),
  // 分支已合入整合分支。
  issue(231, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(2) }),
  // 分支剛開、沒有自己的 commit（它的 tip 當然是整合分支的祖先），不算。
  issue(232, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(2) }),
  // 分支有自己的 commit 但沒合入，不算。
  issue(233, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(30) }),
];
const landedFixture = () => {
  const f = fakeGh({ issues: LANDED_ISSUES });
  integrationBranch(f.repo, { merged: ['issue/231-landed'], fresh: ['issue/232-fresh'], unmerged: ['issue/233-wip'] });
  return f;
};

test('--integration：已指派、最近認領之後有 DONE 結果行，或分支已合入整合分支的歸 landed，排在 stale、claimed 之前', () => {
  const result = landedFixture().run('--integration', 'pilot/integration');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'landed #229 標題 229\nlanded #231 標題 231\nstale #233 標題 233\nclaimed #230 標題 230\nclaimed #232 標題 232\n');
});

// #379（#330 第 3 項）：main 暫停期間已在整合分支的單越積越多，逐張列出洗版；main-paused 旗標有效時 landed 桶收成一行計數，過期或讀不懂時恢復逐行。
test('--integration 且 main 暫停旗標有效：landed 桶收成 LANDED_COUNT <數量> <整合分支>，過期恢復逐行', () => {
  const f = landedFixture();
  mkdirSync(join(f.repo, '.scratch/pilot'), { recursive: true });
  const flag = text => writeFileSync(join(f.repo, '.scratch/pilot/main-paused'), text);
  flag(`${JSON.stringify({ since: '2026-11-21T10:00:00+08:00', reason: '過渡期', until: '2999-12-01', session: 's' })}\n`);
  let result = f.run('--integration', 'pilot/integration');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'LANDED_COUNT 2 pilot/integration\nstale #233 標題 233\nclaimed #230 標題 230\nclaimed #232 標題 232\n');
  // 沒帶 --integration 時沒有 landed 桶，旗標不影響。
  assert.equal(f.run().stdout, 'stale #229 標題 229\nstale #233 標題 233\nclaimed #230 標題 230\nclaimed #231 標題 231\nclaimed #232 標題 232\n');
  for (const text of [`${JSON.stringify({ reason: '過渡期', until: '2000-01-01' })}\n`, 'not json\n']) {
    flag(text);
    result = f.run('--integration', 'pilot/integration');
    assert.equal(result.stdout, 'landed #229 標題 229\nlanded #231 標題 231\nstale #233 標題 233\nclaimed #230 標題 230\nclaimed #232 標題 232\n', text);
  }
});

test('沒帶 --integration 時不判斷落地：沒有 landed 桶、blocked 行不標 landed，其餘逐行同以前', () => {
  const f = fakeGh({ issues: [...LANDED_ISSUES, issue(247, { labels: ['enhancement', 'needs-triage'], blockedBy: [151] })] });
  integrationBranch(f.repo, { subjects: ['加報價來源 (#151)'], merged: ['issue/231-landed'] });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'stale #229 標題 229\nstale #233 標題 233\nclaimed #230 標題 230\nclaimed #231 標題 231\nclaimed #232 標題 232\n'
    + 'blocked #247 needs-triage by #151 標題 247\n');
});

test('--integration 指向不存在的分支時 stderr 印原因、exit 1', () => {
  const f = fakeGh({ issues: [issue(7, { labels: ['enhancement', 'ready-for-agent'] })] });
  integrationBranch(f.repo);
  const result = f.run('--integration', 'no/such-branch');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no\/such-branch/);
});

// #501（investing retro 1122a）：POOL_EMPTY 時 coordinator 逐張手寫 gh api 迴圈查 blocker 是否已在整合分支，每輪約 40 次 gh 呼叫。
test('--pickable-blocked：blocker 都已落地在整合分支的 blocked 單印 PICKABLE <n>，有 blocker 未合入的印 WAIT <n> <m>:not-integrated', () => {
  const f = fakeGh({ issues: [
    // blocker #151 已指派、分支已合入：做完等關單。
    issue(151, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(2) }),
    issue(247, { labels: ['enhancement', 'ready-for-agent'], blockedBy: [151] }),
    // 第一個 blocker 已合入、第二個沒有：取第一個擋住的。
    issue(248, { labels: ['enhancement', 'ready-for-agent'], blockedBy: [151, 152] }),
  ] });
  integrationBranch(f.repo, { merged: ['issue/151-done'], unmerged: ['issue/152-wip'] });
  const result = f.run('--pickable-blocked', '--integration', 'pilot/integration');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'PICKABLE 247\nWAIT 248 152:not-integrated\n');
  assert.deepEqual(f.calls().map(([cmd, sub]) => `${cmd} ${sub}`), ['api graphql'], '唯讀：只讀一次 graphql，不留言、不指派');
});

test('--pickable-blocked：blocker 已落地但範圍還開著（BLOCKER_OPEN_SCOPE）印 WAIT <n> <m>:open-scope；別的 repo 的 blocker 印 other-repo', () => {
  const f = fakeGh({ issues: [
    // blocker #151 已合入，卻沒指派、還掛 ready-for-agent：範圍回到池子。
    issue(151, { labels: ['enhancement', 'ready-for-agent'] }),
    issue(247, { labels: ['enhancement', 'ready-for-agent'], blockedBy: [151] }),
    issue(249, { labels: ['enhancement', 'ready-for-agent'], blockedBy: ['other/repo#9'] }),
  ] });
  integrationBranch(f.repo, { subjects: ['加報價來源 (#151)'] });
  const result = f.run('--pickable-blocked', '--integration', 'pilot/integration');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WAIT 247 151:open-scope\nWAIT 249 other/repo#9:other-repo\n');
});

test('--pickable-blocked 沒帶 --integration 時以目前分支判斷落地；和子命令一起用時印用法、exit 2', () => {
  const f = fakeGh({ issues: [
    issue(151, { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], assignedAt: hoursAgo(2) }),
    issue(247, { labels: ['enhancement', 'needs-triage'], blockedBy: [151] }),
  ] });
  integrationBranch(f.repo, { subjects: ['加報價來源 (#151)'] });
  // fixture 最後切回 main：main 上沒有 (#151)，切到整合分支才有。
  assert.equal(f.run('--pickable-blocked').stdout, 'WAIT 247 151:not-integrated\n');
  git(f.repo, 'checkout', '-q', 'pilot/integration');
  assert.equal(f.run('--pickable-blocked').stdout, 'PICKABLE 247\n');
  const result = f.run('--pickable-blocked', 'claim', '247');
  assert.equal(result.status, 2);
  assert.deepEqual(f.calls().filter(([cmd]) => cmd === 'issue'), []);
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

// #573：前任 c84ffc81 暫停（沒有 handoff 行、pid 已不在），transcript 才剛寫過；舊版一小時內都 STOP claimed，新版 takeover。
const DEAD_PID = (() => { const child = spawnSync(process.execPath, ['-e', '']); return child.pid; })();
const SUSPENDED = `2026-10-31T09:00:00+08:00   session old-coord   pid ${DEAD_PID}   ron-skills-15\n2026-10-31T10:00:05+08:00   session sess-1   pid ${process.pid}   ron-skills-16\n`;
test('claim：前任 coordinator 暫停（沒有 handoff 行、start 行的 pid 已不存在、transcript 很新）時 takeover', () => {
  const theirs = `認領：${HOST}／old-coord`;
  const { run, calls } = fakeGh({ sessions: SUSPENDED, transcripts: { 'old-coord': [0.1, INTERRUPTED] }, views: [
    view({ assignees: ['ron'], comments: [['ron', theirs]] }),
    view({ assignees: ['ron'], comments: [['ron', theirs], ['ron', theirs]] }),
  ] });
  const result = run('claim', '7', '--session', 'sess-1', '--take-stale');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7 takeover old-coord\n');
  assert.equal(writes(calls()).length, 2);
});

test('claim：前任 pid 還活著（沒交接、transcript 很新）時照舊停下', () => {
  const theirs = `認領：${HOST}／old-coord`;
  const { run, calls } = fakeGh({ sessions: SUSPENDED.replace(`pid ${DEAD_PID}`, `pid ${process.pid}`), transcripts: { 'old-coord': [0.1, INTERRUPTED] }, views: [view({ assignees: ['ron'], comments: [['ron', theirs]] })] });
  const result = run('claim', '7', '--session', 'sess-1', '--take-stale');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, `STOP 7 claimed ${theirs.slice(3)}\n`);
  assert.deepEqual(writes(calls()), []);
});

const STOP_CASES = [
  ['認領者還在任（只有 start 行、沒交接出去、pid 還活著）', `${HOST}／live-coord`, `2026-10-31T09:00:00+08:00   session live-coord   pid ${process.pid}   ron-skills-15\n2026-10-31T09:00:05+08:00   session sess-1   pid 4343   ron-skills-16\n`],
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

// #212：#201 的認領者 6e451c5c 在 09:57 認領、一分鐘後被使用者中斷，之後沒有動靜；指派還在，--stale-hours 也不釋放，retro-collect 每次都 STOP 略過它。
const DEAD = '6e451c5c-21e4-47de-bf1b-83122cbcb781';
const INTERRUPTED = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}\n';

test('claim：本機認領者的 transcript 超過 1 小時沒寫入時，STOP 前先印 STALE_CLAIM 與最後寫入時間，不改 Issue', () => {
  const { run, calls } = fakeGh({ transcripts: { [DEAD]: [3, INTERRUPTED] }, views: [view({ assignees: ['ron'], comments: [['ron', `認領：${HOST}／${DEAD}`]] })] });
  const result = run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 4);
  assert.match(result.stdout, new RegExp(`^STALE_CLAIM 7 ${HOST}／${DEAD} \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\nSTOP 7 claimed ${HOST}／${DEAD}\n$`));
  assert.deepEqual(writes(calls()), []);
});

// investing#481 第 3 項：主機名沒有注入點，測試只能靠 other-host.local 避開本機判斷。ISSUE_POOL_HOSTNAME 取代 os.hostname()。
test('ISSUE_POOL_HOSTNAME：認領留言、本機認領者判斷都用它取代主機名', () => {
  const env = { ISSUE_POOL_HOSTNAME: 'box-a' };
  const mine = '認領：box-a／sess-1';
  const claimed = fakeGh({ env, views: [view(), view({ assignees: ['ron'], comments: [['ron', mine]] })] });
  const result = claimed.run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7\n');
  assert.deepEqual(writes(claimed.calls())[0], ['issue', 'comment', '7', '--repo', 'acme/app', '--body', mine]);
  // 認領者的機器名等於覆寫值才讀本機 transcript：box-a 的認領印 STALE_CLAIM，真正主機名的認領當成別台機器。
  for (const [host, stale] of [['box-a', true], [HOST, false]]) {
    const { run } = fakeGh({ env, transcripts: { [DEAD]: [3, INTERRUPTED] }, views: [view({ assignees: ['ron'], comments: [['ron', `認領：${host}／${DEAD}`]] })] });
    const stopped = run('claim', '7', '--session', 'sess-1');
    assert.equal(stopped.status, 4);
    assert.equal(stopped.stdout.startsWith('STALE_CLAIM '), stale, `${host}: ${stopped.stdout}`);
  }
});

test('claim --take-stale：本機認領者已無活動時改以這個 session 認領，印 CLAIMED <n> stale <session>', () => {
  const mine = `認領：${HOST}／sess-1`;
  const theirs = `認領：${HOST}／${DEAD}`;
  const { run, calls } = fakeGh({ transcripts: { [DEAD]: [3, INTERRUPTED] }, views: [
    view({ assignees: ['ron'], comments: [['ron', theirs]] }),
    view({ assignees: ['ron'], comments: [['ron', theirs], ['ron', mine]] }),
  ] });
  const result = run('claim', '7', '--session', 'sess-1', '--take-stale');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^STALE_CLAIM 7 .*\nCLAIMED 7 stale ${DEAD}\n$`));
  assert.deepEqual(writes(calls()), [
    ['issue', 'comment', '7', '--repo', 'acme/app', '--body', mine],
    ['issue', 'edit', '7', '--repo', 'acme/app', '--add-assignee', '@me'],
  ]);
});

// #352（#328 第 1 項，investing#240）：#145 的 commit 早已進 develop，Issue 仍開著，claim 照樣認領，worker 花 8 分鐘查證後回 DONE。
test('claim --integration：整合分支有 (#<n>) commit 時印 LANDED <n> <sha>、exit 4，不留認領也不指派', () => {
  const f = fakeGh({ views: [view()] });
  const sha = integrationBranch(f.repo, { subjects: ['加 X (#145)', '別張 (#1450)'] });
  const result = f.run('claim', '145', '--session', 'sess-1', '--integration', 'pilot/integration');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, `LANDED 145 ${sha('pilot/integration~1')}\n`);
  assert.deepEqual(writes(f.calls()), []);
});

test('claim --integration：分支已合入整合分支時印 LANDED <n> <合入的 merge commit>', () => {
  const f = fakeGh({ views: [view()] });
  const sha = integrationBranch(f.repo, { merged: ['issue/146-x'] });
  const result = f.run('claim', '146', '--session', 'sess-1', '--integration', 'pilot/integration');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, `LANDED 146 ${sha('pilot/integration')}\n`);
  assert.deepEqual(writes(f.calls()), []);
});

test('claim --integration：已指派、最近認領之後有 DONE 結果行時印 LANDED <n> <DONE 的 sha>，不改 Issue', () => {
  const f = fakeGh({ views: [view({ assignees: ['ron'], comments: [['ron', `認領：${HOST}／sess-1`], ['ron', '**worker 結果**\n\nDONE 7 10aee61']] })] });
  integrationBranch(f.repo);
  const result = f.run('claim', '7', '--session', 'sess-1', '--integration', 'pilot/integration');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'LANDED 7 10aee61\n');
  assert.deepEqual(writes(f.calls()), []);
});

test('claim 沒帶 --integration 時不查落地：整合分支有 (#<n>) commit、留言有 DONE 也照常認領', () => {
  const mine = `認領：${HOST}／sess-1`;
  const f = fakeGh({ views: [view({ assignees: ['ron'], comments: [['ron', mine], ['ron', 'DONE 7 10aee61']] }), view({ assignees: ['ron'], comments: [['ron', mine], ['ron', 'DONE 7 10aee61'], ['ron', mine]] })] });
  integrationBranch(f.repo, { subjects: ['加 X (#7)'] });
  const result = f.run('claim', '7', '--session', 'sess-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLAIMED 7\n');
});

const LIVE_CASES = [
  ['本機認領者 1 小時內還有寫入 transcript', `${HOST}／${DEAD}`, { [DEAD]: [0.5, INTERRUPTED] }],
  ['找不到本機認領者的 transcript（例如 session 是 terminal handle）', `${HOST}／term_1`, { [DEAD]: [3, INTERRUPTED] }],
  ['認領者在別台機器（看不到它的 transcript），即使本機有同名的舊檔', `other-box／${DEAD}`, { [DEAD]: [3, INTERRUPTED] }],
];
for (const [why, claimer, transcripts] of LIVE_CASES) {
  test(`claim --take-stale：${why}時照舊停下，不印 STALE_CLAIM、不改 Issue`, () => {
    const { run, calls } = fakeGh({ transcripts, views: [view({ assignees: ['ron'], comments: [['ron', `認領：${claimer}`]] })] });
    const result = run('claim', '7', '--session', 'sess-1', '--take-stale');
    assert.equal(result.status, 4);
    assert.equal(result.stdout, `STOP 7 claimed ${claimer}\n`);
    assert.deepEqual(writes(calls()), []);
  });
}

// children（#251）：母單視圖。樣本 sub-issues.json 錄自 `gh api graphql`（ron03wlb/ron-skills #102 的子單，2026-11-01），子單全是已關閉、
// 最後留言是合入通知；提問與非提問的子單是以錄下的節點為殼、用 mergeSample 改欄位合成的，形狀不超出真實回應。
const SUB_SAMPLE = fixture('sub-issues');
const SUB_NODE = SUB_SAMPLE.data.repository.issue.subIssues.nodes[0];

/** 一張子單：comment 是最後一則留言的全文（省略時沒有留言）；blockedBy 同 issue()，`<n>:CLOSED` 是已關閉的。 */
function child(number, { state = 'OPEN', labels = [], blockedBy = [], comment } = {}) {
  return mergeSample(SUB_NODE, {
    number, title: `子單 ${number}`, state,
    labels: { nodes: labels.map(name => ({ name })) },
    blockedBy: { nodes: blockedBy.map(ref => {
      const [, repo = 'acme/app', n, refState = 'OPEN'] = String(ref).match(/^(?:(.+)#)?(\d+)(?::(\w+))?$/);
      return { number: Number(n), state: refState, repository: { nameWithOwner: repo } };
    }) },
    comments: { nodes: comment === undefined ? [] : [{ body: comment }] },
  }, 'child');
}
const subIssues = (parent, nodes) => mergeSample(SUB_SAMPLE, { data: { repository: { issue: { number: parent, subIssues: { nodes } } } } }, 'children');

const ASKING = '> 🤖 AI（issue-run worker，batch 9）\n\nOrchestrator：照規則要問你，A／B／C 選哪個？';
const DECIDED = '> 🤖 AI（coordinator）\n\nOperator 決策：選 A。';
const FAMILY = subIssues(9, [
  child(10, { labels: ['enhancement', 'ready-for-agent'], comment: ASKING }),
  child(11, { labels: ['bug', 'ready-for-agent'], blockedBy: [10, '3:CLOSED', 'other/repo#4'], comment: DECIDED }),
  child(12, { state: 'CLOSED', comment: 'Orchestrator：已結案前的提問' }),
]);

test('children：每張子單一行；最後一則留言（略過開頭的 AI 聲明引言）以 --ask-prefix 開頭的開著子單標 ask', () => {
  const { run, calls } = fakeGh({ children: FAMILY });
  const result = run('children', '9', '--ask-prefix', 'Orchestrator：');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'ask #10 open labels:enhancement,ready-for-agent blocked-by:- 子單 10',
    'child #11 open labels:bug,ready-for-agent blocked-by:#10,other/repo#4 子單 11',
    'child #12 closed labels:- blocked-by:- 子單 12',
    '',
  ].join('\n'));
  assert.equal(calls().length, 1, '一次 GraphQL 取回全部子單');
  assert.deepEqual(calls()[0].slice(0, 8), ['api', 'graphql', '-F', 'owner=acme', '-F', 'name=app', '-F', 'number=9']);
});

test('children：沒給 --ask-prefix 時沒有子單標 ask', () => {
  const result = fakeGh({ children: FAMILY }).run('children', '9');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => line.split(' ')[0]), ['child', 'child', 'child']);
});

test('children：--ask-prefix 可以重複，任一個符合就標 ask', () => {
  const result = fakeGh({ children: FAMILY }).run('children', '9', '--ask-prefix', 'STOP：', '--ask-prefix', 'Operator 決策');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => line.split(' ').slice(0, 2).join(' ')), ['child #10', 'ask #11', 'child #12']);
});

test('children：--repo 指向別的 repo 時 GraphQL 查那個 owner/name', () => {
  // run 先帶 --repo acme/app，後面的 --repo 覆寫它。
  const { run, calls } = fakeGh({ children: subIssues(126, [child(136, { comment: ASKING })]) });
  const result = run('children', '126', '--repo', 'ron03wlb/investing', '--ask-prefix', 'Orchestrator：');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ask #136 open labels:- blocked-by:- 子單 136\n');
  assert.deepEqual(calls()[0].slice(0, 8), ['api', 'graphql', '-F', 'owner=ron03wlb', '-F', 'name=investing', '-F', 'number=126']);
});

test('children：tracker 是 GitLab 時是用法錯誤（只支援 GitHub 的 subIssues），不呼叫 glab', () => {
  const { run, calls } = fakeGlab();
  const result = run('children', '9');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /children/);
  assert.deepEqual(calls(), []);
});

test('children：母單沒有子單時印 STOP <n> no-children、exit 4', () => {
  const result = fakeGh({ children: subIssues(9, []) }).run('children', '9');
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP 9 no-children\n');
});

test('children：號碼不是數字、或多給參數時是用法錯誤', () => {
  const { run, calls } = fakeGh({ children: FAMILY });
  assert.equal(run('children').status, 2);
  assert.equal(run('children', 'x').status, 2);
  assert.equal(run('children', '9', '10').status, 2);
  assert.deepEqual(calls(), []);
});

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
function workItem(number, { labels = [], assignees = [], children = false, parent, blockedBy = [], blocking = [], commentAt, activity = [], description = '' } = {}) {
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
      widget('WorkItemWidgetHierarchy', { hasChildren: children, parent: parent === undefined ? null : { iid: String(parent), namespace: { fullPath: 'acme/app' } } }),
      widget('WorkItemWidgetLinkedItems', { linkedItems: { nodes: [...blockedBy.map(link('is_blocked_by')), ...blocking.map(link('blocks'))] } }),
      widget('WorkItemWidgetNotes', { comments: { nodes: commentAt ? [{ createdAt: commentAt, body: '' }] : [] }, activity: { nodes: activity.map(([body, createdAt]) => ({ body, createdAt })) } }),
      widget('WorkItemWidgetDescription', { description }),
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
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), PATH: `${dir}:${process.env.PATH}` } });
  const calls = () => { try { return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  return { run, calls, repo };
}

// 每個桶各一個 GitLab fixture：子項目（hierarchy）是母單，is_blocked_by 開著的單是 blocked，認領時限看最近的留言或指派紀錄。
for (const [bucket, options, detail = ''] of [
  ['parent', { labels: ['enhancement', 'ready-for-agent'], children: true }],
  ['human', { labels: ['enhancement', 'ready-for-human'] }],
  ['stale', { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], commentAt: hoursAgo(30), activity: [['assigned to @ron', hoursAgo(30)]] }],
  ['claimed', { labels: ['enhancement', 'ready-for-agent'], assignees: ['ron'], commentAt: hoursAgo(30), activity: [['assigned to @ron', hoursAgo(1)]] }],
  ['retro-candidates', { labels: ['retro-candidates'] }],
  ['blocked', { labels: ['enhancement', 'ready-for-agent'], blockedBy: [5] }, 'ready-for-agent by #5 '],
  ['needs-info', { labels: ['enhancement', 'needs-info'] }],
  ['needs-triage', { labels: ['enhancement', 'needs-triage'] }],
  ['ready', { labels: ['enhancement', 'ready-for-agent'], blockedBy: ['5:CLOSED'] }],
  ['unlabeled', {}],
]) {
  test(`GitLab：${bucket} 桶`, () => {
    const { run } = fakeGlab({ items: [workItem(7, options)] });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${bucket} #7 ${detail}標題 7\n`);
  });
}

test('GitLab：ready 單的 description 寫了 Operator prerequisite 時印 PREREQ', () => {
  const { run } = fakeGlab({ items: [workItem(7, { labels: ['enhancement', 'ready-for-agent'], description: 'Operator prerequisite：先申請憑證' })] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 標題 7\nPREREQ 7 先申請憑證\n');
});

test('GitLab：有父項目的 ready 行附 parent #<p>，沒有的不變', () => {
  const { run } = fakeGlab({ items: [workItem(7, { labels: ['enhancement', 'ready-for-agent'], parent: 3 }), workItem(8, { labels: ['enhancement', 'ready-for-agent'] })] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready #7 parent #3 標題 7\nready #8 標題 8\n');
});

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
  assert.equal(result.stdout, 'ready #8 標題 8\nready #4 標題 4\nblocked #20 ready-for-agent by #8 標題 20\n');
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

// #300：#286 帶 ready-for-agent、沒指派、沒留言，Gate 通過；PR #288 其實已開了 15 小時，只是順手 grep 分支才沒重做一份。
const linked = (number, state, branch) => ({ number, state, url: `https://github.com/acme/app/pull/${number}`, headRefName: branch });

test('open-work：印開著的關聯 PR 與同號分支，已合併的 PR 與別張單的分支不算', () => {
  const { run, repo } = fakeGh({ linkedPrs: [linked(288, 'OPEN', 'issue/286-pilot-close-protect'), linked(250, 'MERGED', 'issue/286-old')] });
  const bare = join(repo, '..', 'origin.git');
  git(repo, 'init', '-q', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git(repo, 'branch', 'issue/286-local');
  git(repo, 'branch', 'issue/2860-other');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/issue/286-pilot-close-protect', 'HEAD:refs/heads/issue/1286-other');
  const result = run('open-work', '286');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'OPEN_PR 286 288 issue/286-pilot-close-protect https://github.com/acme/app/pull/288',
    'BRANCH 286 issue/286-local local',
    'BRANCH 286 issue/286-pilot-close-protect origin',
  ]);
});

test('open-work：沒有進行中的工作時印 NO_OPEN_WORK，沒有 origin 也不失敗', () => {
  const { run } = fakeGh({ linkedPrs: [linked(250, 'CLOSED', 'issue/286-old')] });
  const result = run('open-work', '286');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'NO_OPEN_WORK 286\n');
});
