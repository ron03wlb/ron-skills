// scripts/project-sync.mjs（#487）：看板七欄鏡像 issue-pool 的分桶，與整體進度 Status update。
// gh 用假 CLI（tests 暫存目錄的 bin/gh，狀態在 gh.json），不打真 API；git 用暫存 repo，涵蓋「已合入·待上 main」的已合入、未合入、沒有分支。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, git } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { COLUMNS, statusAction, summarize, taipeiDate } from '../scripts/project-sync.mjs';

const SCRIPT = new URL('../scripts/project-sync.mjs', import.meta.url).pathname;
const REPO = 'acme/app';
const NOW = '2026-11-22T12:00:00Z'; // 台北 20:00
const SEVEN = COLUMNS;

// 假 gh：repo view 回 REPO；api graphql --input - 依 query 的關鍵字回應，mutation 改 gh.json 並記在 calls。
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
const out = data => { process.stdout.write(JSON.stringify({ data })); save(); };
if (args[0] === 'repo' && args[1] === 'view') { process.stdout.write(state.repo + '\\n'); process.exit(0); }
if (args[0] !== 'api' || args[1] !== 'graphql') { console.error('fake gh: unknown ' + args.join(' ')); process.exit(1); }
const { query, variables: v } = JSON.parse(fs.readFileSync(0, 'utf8'));
const call = name => { state.calls.push(name + ' ' + JSON.stringify(v)); };
const issueNode = (n, i) => ({
  id: 'I_' + n, number: Number(n), title: 't' + n, body: '', state: i.state ?? 'OPEN',
  labels: { nodes: (i.labels ?? []).map(name => ({ name })) },
  assignees: { nodes: (i.assignees ?? []).map(login => ({ login })) },
  subIssuesSummary: { total: i.subIssues ?? 0 },
  blockedBy: { nodes: (i.blockedBy ?? []).map(m => ({ number: m, state: 'OPEN', repository: { nameWithOwner: state.repo } })) },
  blocking: { nodes: [] },
  comments: { nodes: (i.comments ?? []).map(createdAt => ({ createdAt, body: 'x' })) },
  timelineItems: { nodes: [] },
  closedByPullRequestsReferences: { nodes: i.pr ? [{ state: 'OPEN' }] : [] },
  parent: i.parent ? { number: i.parent, repository: { nameWithOwner: state.repo } } : null,
  repository: { nameWithOwner: state.repo },
});
const project = state.project;
const field = () => ({ id: 'F_status', options: project.options.map(name => ({ id: 'O_' + name, name })) });
if (query.includes('projectsV2(first:20)')) out({ repository: { projectsV2: { nodes: state.linked.map(number => ({ number, title: 'p' + number, owner: { login: 'acme' } })) } } });
else if (query.includes('repositoryOwner')) out({ repositoryOwner: v.number === project.number ? { projectV2: { id: 'P_1', number: project.number, title: 'board', owner: { login: 'acme' }, field: field(),
  statusUpdates: { nodes: project.updates.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1) } } } : { projectV2: null } });
else if (query.includes('items(first:100')) out({ node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: project.items.map(item => ({
  id: item.id, fieldValueByName: item.status ? { name: item.status } : null,
  content: item.kind === 'pr' ? { __typename: 'PullRequest' } : item.kind === 'other' ? { ...issueNode(item.n, {}), __typename: 'Issue', repository: { nameWithOwner: 'other/repo' } } : { __typename: 'Issue', ...issueNode(item.n, state.issues[item.n]) },
})) } } });
else if (query.includes('issues(first:100')) out({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null },
  nodes: Object.entries(state.issues).filter(([, i]) => (i.state ?? 'OPEN') === 'OPEN').map(([n, i]) => issueNode(n, i)) } } });
else if (query.includes('addProjectV2ItemById')) { call('add'); const id = 'PVTI_' + v.content.slice(2); project.items.push({ id, n: Number(v.content.slice(2)), status: null }); out({ addProjectV2ItemById: { item: { id } } }); }
else if (query.includes('updateProjectV2ItemFieldValue')) { call('set'); const name = v.option.slice(2); if (!project.options.includes(name)) { console.error('bad option'); process.exit(1); } project.items.find(i => i.id === v.item).status = name; out({}); }
else if (query.includes('clearProjectV2ItemFieldValue')) { call('clear'); project.items.find(i => i.id === v.item).status = null; out({}); }
else if (query.includes('updateProjectV2Field')) { call('field'); project.options = v.options.map(o => o.name); for (const i of project.items) i.status = null; out({}); }
else if (query.includes('createProjectV2StatusUpdate')) { call('create-update'); project.updates.push({ id: 'SU_' + project.updates.length, body: v.body, createdAt: state.now }); out({}); }
else if (query.includes('updateProjectV2StatusUpdate')) { call('update-update'); project.updates.find(u => u.id === v.id).body = v.body; out({}); }
else { console.error('fake gh: unknown query ' + query.slice(0, 80)); process.exit(1); }
`;

/** 每個桶各一張，加上看板上既有的卡（已關閉、母單、PR、別的 repo）。 */
function baseState() {
  const claimed = { assignees: ['me'], comments: [NOW] };
  return {
    repo: REPO, now: NOW, calls: [], linked: [7],
    issues: {
      1: { labels: ['retro-candidates'] },
      2: { labels: ['needs-triage'] },
      3: { labels: ['needs-info'] },
      4: {},
      5: { labels: ['ready-for-agent'], blockedBy: [6] },
      6: { labels: ['ready-for-agent'], parent: 8 },
      7: { labels: ['ready-for-human'] },
      8: { labels: ['parent'], subIssues: 2 },
      9: { labels: ['parent'], subIssues: 1 },
      11: { labels: ['ready-for-agent'], ...claimed },
      12: { labels: ['ready-for-agent'], ...claimed },
      13: { labels: ['ready-for-agent'], ...claimed },
      14: { labels: ['ready-for-agent'], ...claimed },
      15: { labels: ['ready-for-agent'], pr: true },
      16: { labels: ['ready-for-agent'], assignees: ['me'], comments: ['2026-11-01T00:00:00Z'] },
      20: { state: 'CLOSED', labels: ['ready-for-agent'] },
      21: { state: 'CLOSED', labels: ['retro-candidates'] },
    },
    project: {
      number: 7, options: SEVEN.slice(), updates: [],
      items: [
        { id: 'PVTI_6', n: 6, status: '可開工' },
        { id: 'PVTI_9', n: 9, status: '待討論' },
        { id: 'PVTI_20', n: 20, status: '可開工' },
        { id: 'PVTI_21', n: 21, status: '完成' },
        { id: 'PVTI_pr', kind: 'pr', status: '處理中' },
        { id: 'PVTI_other', n: 99, kind: 'other', status: '被擋' },
      ],
    },
  };
}

/** 暫存 repo：main、pilot/integration；#11 的分支已合入整合分支、#12 的沒有、#13 沒有分支、#14 的分支已在 main。 */
function fixture(t, state = baseState()) {
  const temp = mkdtempSync(join(realTmpdir(), 'project-sync-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const commit = (file, message) => { writeFileSync(join(repo, file), message); git(repo, 'add', file); git(repo, 'commit', '-q', '-m', message); };
  commit('a', 'base');
  git(repo, 'checkout', '-q', '-b', 'issue/14-done'); commit('d', 'fourteen');
  git(repo, 'checkout', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', 'land 14', 'issue/14-done');
  git(repo, 'branch', 'pilot/integration');
  git(repo, 'checkout', '-q', '-b', 'issue/11-merged'); commit('b', 'eleven');
  git(repo, 'checkout', '-q', '-b', 'ron/12-open', 'main'); commit('c', 'twelve');
  git(repo, 'checkout', '-q', 'pilot/integration'); git(repo, 'merge', '-q', '--no-ff', '-m', 'stage 11', 'issue/11-merged');
  git(repo, 'checkout', '-q', 'main');
  mkdirSync(join(temp, 'bin'));
  writeFileSync(join(temp, 'bin/gh'), FAKE_GH);
  chmodSync(join(temp, 'bin/gh'), 0o755);
  const stateFile = join(temp, 'gh.json');
  writeFileSync(stateFile, JSON.stringify(state));
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const edit = fn => { const s = read(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };
  const sync = (args = [], now = NOW) => {
    edit(s => { s.now = now; });
    const result = spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8',
      env: { ...env, PATH: `${join(temp, 'bin')}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, PROJECT_SYNC_NOW: now } });
    return { ...result, lines: result.stdout.trim().split('\n') };
  };
  return { sync, read, edit };
}

const EXPECTED_CHANGES = [
  '#1 新增 → Retro 候選',
  '#2 新增 → 待討論',
  '#3 新增 → 待討論',
  '#4 新增 → 待討論',
  '#5 新增 → 被擋',
  '#7 新增 → 可開工',
  '#8 新增 → （無）',
  '#9 待討論 → （無）',
  '#11 新增 → 已合入·待上 main',
  '#12 新增 → 處理中',
  '#13 新增 → 處理中',
  '#14 新增 → 處理中',
  '#15 新增 → 處理中',
  '#16 新增 → 處理中',
  '#20 可開工 → 完成',
];

test('dry-run 依桶分欄：每個桶、母單不設值、已合入／未合入／沒有分支／已在 main，不寫入', t => {
  const f = fixture(t);
  const r = f.sync();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.lines.filter(line => line.startsWith('#')), EXPECTED_CHANGES);
  assert.deepEqual(f.read().calls, []);
  assert.equal(r.lines.at(-1), 'PROJECT_SYNC dry-run acme/7 changes 15');
});

test('--apply 寫入差異：PR 與別的 repo 的卡不動，再跑一次沒有變更；七欄張數與六項數字', t => {
  const f = fixture(t);
  const r = f.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  const s = f.read();
  const status = Object.fromEntries(s.project.items.map(item => [item.id, item.status]));
  assert.equal(status.PVTI_pr, '處理中');
  assert.equal(status.PVTI_other, '被擋');
  assert.equal(status.PVTI_8, null);
  assert.equal(status.PVTI_9, null);
  assert.equal(status.PVTI_11, '已合入·待上 main');
  assert.equal(status.PVTI_20, '完成');
  assert.deepEqual(r.lines.filter(line => line.startsWith('COLUMN ')), [
    'COLUMN Retro 候選 1', 'COLUMN 待討論 3', 'COLUMN 被擋 1', 'COLUMN 可開工 2', 'COLUMN 處理中 5', 'COLUMN 已合入·待上 main 1', 'COLUMN 完成 2',
  ]);
  // 範圍：非母單、非 Retro 候選 → #2–7、#11–16、#20 共 13 張；完成＝#20 與 #11。無母單：除去 #6 共 12 張。
  assert.deepEqual(r.lines.filter(line => line.startsWith('STATUS_LINE ')), [
    'STATUS_LINE 整體進度：15%（2／13）', 'STATUS_LINE 無母單進度：17%（2／12）', 'STATUS_LINE 剩下：11 張',
    'STATUS_LINE 已合入·待上 main：1 張', 'STATUS_LINE 被擋與待討論：4 張', 'STATUS_LINE Retro 候選：1 張',
  ]);
  assert.equal(s.project.updates.length, 1);
  assert.match(s.project.updates[0].body, /^整體進度：15%（2／13）\n/);
  const again = f.sync(['--apply']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.lines.filter(line => line.startsWith('#')).length, 0);
  assert.equal(again.lines.at(-1), 'PROJECT_SYNC applied acme/7 changes 0');
});

test('Status 選項不符：沒帶 --setup-status-field 時 exit 3；帶了 --apply 改成七個並同一次補回，母單不設值', t => {
  const state = baseState();
  state.project.options = ['Todo', 'In Progress', 'Done'];
  for (const item of state.project.items) if (!item.kind) item.status = 'Todo';
  const f = fixture(t, state);
  const r = f.sync(['--apply']);
  assert.equal(r.status, 3);
  assert.equal(r.lines[0], 'STATUS_FIELD_MISMATCH Todo,In Progress,Done');
  assert.deepEqual(f.read().calls, []);

  const dry = f.sync(['--setup-status-field']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.lines[0], `STATUS_FIELD Todo,In Progress,Done → ${SEVEN.join(',')}`);
  assert.ok(dry.lines.includes('#6 （無） → 可開工'));
  assert.deepEqual(f.read().calls, []);

  const apply = f.sync(['--setup-status-field', '--apply']);
  assert.equal(apply.status, 0, apply.stderr);
  const s = f.read();
  assert.deepEqual(s.project.options, SEVEN);
  assert.equal(s.calls[0].split(' ')[0], 'field');
  const status = Object.fromEntries(s.project.items.filter(item => !item.kind).map(item => [item.n, item.status]));
  assert.equal(status[6], '可開工');
  assert.equal(status[9], null);
  assert.equal(status[8], null);
  assert.equal(status[20], '完成');
  assert.equal(status[21], '完成');
  assert.equal(f.sync(['--setup-status-field']).lines[0], 'STATUS_FIELD ok');
});

test('Status update：數字沒變不寫；同一天第二次有變改寫當天那筆；隔天有變新增一筆', t => {
  const f = fixture(t);
  assert.equal(f.sync(['--apply']).status, 0);
  const count = name => f.read().calls.filter(call => call.startsWith(`${name} `)).length;
  assert.equal(count('create-update'), 1);

  const same = f.sync(['--apply'], '2026-11-22T14:00:00Z');
  assert.match(same.lines.find(line => line.startsWith('STATUS_UPDATE ')), /^STATUS_UPDATE skip /);
  assert.equal(count('create-update') + count('update-update'), 1);

  f.edit(s => { s.issues[2].labels = ['ready-for-agent']; });
  const sameDay = f.sync(['--apply'], '2026-11-22T15:00:00Z'); // 台北 23:00，同一天
  assert.match(sameDay.lines.find(line => line.startsWith('STATUS_UPDATE ')), /^STATUS_UPDATE update /);
  assert.equal(f.read().project.updates.length, 1);
  assert.match(f.read().project.updates[0].body, /被擋與待討論：3 張/);

  f.edit(s => { s.issues[3].labels = ['ready-for-agent']; });
  const nextDay = f.sync(['--apply'], '2026-11-22T16:30:00Z'); // 台北隔天 00:30
  assert.match(nextDay.lines.find(line => line.startsWith('STATUS_UPDATE ')), /^STATUS_UPDATE create /);
  assert.equal(f.read().project.updates.length, 2);
});

test('連結的 Project 不是剛好一個時 exit 3 並列出；--owner 與 --project 可指定', t => {
  const f = fixture(t);
  f.edit(s => { s.linked = [7, 8]; });
  const two = f.sync();
  assert.equal(two.status, 3);
  assert.deepEqual(two.lines, ['PROJECT acme/7 p7', 'PROJECT acme/8 p8']);
  f.edit(s => { s.linked = []; });
  assert.equal(f.sync().status, 3);
  const chosen = f.sync(['--owner', 'acme', '--project', '7']);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.equal(f.sync(['--owner', 'acme']).status, 2);
});

test('summarize 與 statusAction：台北日期、沒有範圍時不除以零', () => {
  assert.equal(taipeiDate('2026-11-22T16:30:00Z'), '2026-11-23');
  const { lines } = summarize([]);
  assert.equal(lines[0], '整體進度：—（0／0）');
  assert.equal(statusAction(undefined, lines).action, 'create');
});
