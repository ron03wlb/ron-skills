// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// token-usage.mjs 測試（#373 通用化：專案篩選改成 --project）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { aggregate, classify, parseTranscript, summaryLine, weighted } from './token-usage.mjs';

const SCRIPT = fileURLToPath(new URL('./token-usage.mjs', import.meta.url));

const user = (text, extra = {}) => JSON.stringify({ type: 'user', timestamp: '2026-11-02T01:00:00Z', message: { role: 'user', content: text }, ...extra });
const toolResult = () => JSON.stringify({ type: 'user', timestamp: '2026-11-02T01:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '機密對話內容' }] } });
const assistant = (id, ts, model, usage) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, content: [], usage } });
const usage = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
const command = (name, args) => `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`;

test('weighted：input + 1.25×cache write + 0.1×cache read + 5×output', () => {
  assert.equal(weighted({ input: 10, cacheWrite: 100, cacheRead: 1000, output: 2 }), 10 + 125 + 100 + 10);
});

test('parseTranscript：第一則非 tool_result 的使用者訊息、同 message id 只算一次且 output 取最大值、壞行計數', () => {
  const text = [
    toolResult(), user(command('/issue-run', '905 --worker /x/state.md')),
    assistant('m1', '2026-11-02T01:00:02Z', 'claude-opus-5-5', usage(3, 100, 1000, 1)),
    assistant('m1', '2026-11-02T01:00:03Z', 'claude-opus-5-5', usage(3, 100, 1000, 40)),
    '{壞行', user('第二則'),
    assistant('m2', '2026-11-02T01:01:00Z', 'claude-sonnet-5-5', usage(1, 0, 10, 2)),
  ].join('\n');
  const parsed = parseTranscript(text);
  assert.match(parsed.firstUser, /<command-name>\/issue-run<\/command-name>/);
  assert.equal(parsed.badLines, 1);
  assert.deepEqual(parsed.turns, [
    { id: 'm1', ts: Date.parse('2026-11-02T01:00:02Z'), model: 'claude-opus-5-5', input: 3, cacheWrite: 100, cacheRead: 1000, output: 40 },
    { id: 'm2', ts: Date.parse('2026-11-02T01:01:00Z'), model: 'claude-sonnet-5-5', input: 1, cacheWrite: 0, cacheRead: 10, output: 2 },
  ]);
});

test('classify：指令與 brief 開頭決定角色，worker 帶 iid', () => {
  const cases = [
    [command('/issue-run', '905 --worker /x'), { role: 'worker', iid: 905 }],
    [command('/issue-run', '#812'), { role: 'worker', iid: 812 }],
    [command('/loop', '/issue-pilot'), { role: 'pilot', iid: null }],
    [command('/issue-pilot', ''), { role: 'pilot', iid: null }],
    [command('/loop', '/issue-queue'), { role: 'queue', iid: null }],
    [command('/issue-queue', '812'), { role: 'queue', iid: null }],
    [command('/retro', ''), { role: 'retro', iid: null }],
    [command('/retro-collect', ''), { role: 'retro', iid: null }],
    [command('/grilling', '開發速度'), { role: 'grilling', iid: null }],
    [command('/grill-with-docs', ''), { role: 'grilling', iid: null }],
    [command('/diagnosing-bugs', ''), { role: 'interactive', iid: null }],
    ['讀 /w/feature-ron-issue-761/.scratch/deliver-761/scenario/brief.md 並照做；報告寫到 …', { role: 'scenario', iid: 761 }],
    ['讀 /home/u/code/acme/.scratch/pilot/briefs/verify-732.md 並照做', { role: 'scenario', iid: 732 }],
    ['你是獨立驗證者，驗 #700', { role: 'scenario', iid: 700 }],
    ['讀 /w/feature-ron-issue-595/.scratch/deliver-595/fix-sync-1027.md 並照做', { role: 'worker', iid: 595 }],
    ['讀 /w/feature-ron-issue-732/.scratch/deliver-732/ruling-1104-2.md 並照做', { role: 'worker', iid: 732 }],
    ['讀 /home/u/code/acme/.scratch/pilot/briefs/handoff-1.md 並照做', { role: 'pilot', iid: null }],
    ['幫我看一下這個錯誤', { role: 'interactive', iid: null }],
    [null, { role: 'interactive', iid: null }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(classify(text), expected, String(text));
});

const sessions = () => [
  { sid: 'w1', parent: null, firstUser: command('/issue-run', '901 --worker /x'), turns: [
    { id: 'a', ts: Date.parse('2026-11-01T16:30:00Z'), model: 'claude-opus-5-5', input: 0, cacheWrite: 0, cacheRead: 1000000, output: 0 }, // 台北 11-02
    { id: 'old', ts: Date.parse('2026-10-31T15:00:00Z'), model: 'claude-opus-5-5', input: 0, cacheWrite: 0, cacheRead: 9000000, output: 0 }, // 台北 10-31，期間外
  ] },
  { sid: 'w2', parent: null, firstUser: command('/issue-run', '902 --worker /x'), turns: [
    { id: 'b', ts: Date.parse('2026-11-02T02:00:00Z'), model: 'claude-opus-5-5', input: 0, cacheWrite: 0, cacheRead: 2000000, output: 0 },
  ] },
  { sid: 'w3', parent: null, firstUser: '讀 /w/.scratch/deliver-902/fix-sync-1102.md 並照做', turns: [
    { id: 'c', ts: Date.parse('2026-11-02T03:00:00Z'), model: 'claude-opus-5-5', input: 0, cacheWrite: 0, cacheRead: 1000000, output: 0 },
  ] },
  { sid: 'w4', parent: null, firstUser: command('/issue-run', '903 --worker /x'), turns: [
    { id: 'd', ts: Date.parse('2026-11-03T03:00:00Z'), model: 'claude-opus-5-5', input: 0, cacheWrite: 0, cacheRead: 5000000, output: 0 },
    { id: 'b', ts: Date.parse('2026-11-03T03:00:00Z'), model: 'claude-opus-5-5', input: 0, cacheWrite: 0, cacheRead: 2000000, output: 0 }, // 重複 message id
  ] },
  { sid: 'agent-1', parent: 'w1', firstUser: '子代理', turns: [
    { id: 'e', ts: Date.parse('2026-11-02T02:00:00Z'), model: 'claude-sonnet-5-5', input: 0, cacheWrite: 0, cacheRead: 1000000, output: 0 },
  ] },
  { sid: 'r', parent: null, firstUser: command('/retro', ''), turns: [
    { id: 'f', ts: Date.parse('2026-11-04T03:00:00Z'), model: 'claude-opus-5-5', input: 100, cacheWrite: 0, cacheRead: 0, output: 0 },
  ] },
  { sid: 'agent-2', parent: 'r', firstUser: 'x', turns: [{ id: 'g', ts: Date.parse('2026-11-04T03:00:00Z'), model: 'claude-opus-5-5', input: 300, cacheWrite: 0, cacheRead: 0, output: 0 }] },
  { sid: 'agent-3', parent: 'r', firstUser: 'x', turns: [{ id: 'h', ts: Date.parse('2026-11-04T03:00:00Z'), model: 'claude-sonnet-5-5', input: 100, cacheWrite: 0, cacheRead: 0, output: 0 }] },
  { sid: 'agent-4', parent: 'gone', firstUser: 'x', turns: [{ id: 'i', ts: Date.parse('2026-11-04T03:00:00Z'), model: 'claude-haiku-5-5', input: 7, cacheWrite: 0, cacheRead: 0, output: 0 }] },
];

test('aggregate：依台北日、模型、角色彙總；子代理算進父 session 的角色；worker 依 iid 合計、同 message id 去重；期間外不算；父 session 不在時 WARN', () => {
  const warnings = [];
  const result = aggregate(sessions(), { since: '2026-11-01', warn: line => warnings.push(line) });
  assert.deepEqual(Object.fromEntries([...result.workers].map(([iid, item]) => [iid, item.weighted])), { 901: 200000, 902: 300000, 903: 500000 });
  assert.equal(result.workerMedian, 300000);
  assert.equal(result.roles.get('worker').weighted, 1000000);
  assert.equal(result.roles.get('worker').subagents, 1);
  assert.equal(result.roles.get('retro').weighted, 500);
  assert.equal(result.roles.get('interactive').weighted, 7);
  assert.deepEqual([...result.days.keys()], ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.equal(result.models.get('claude-sonnet-5-5').cacheRead, 1000000);
  assert.deepEqual(result.retro, { opusWeighted: 300, weighted: 400, opusAgents: 1, agents: 2 });
  assert.deepEqual(result.period, { since: '2026-11-01', until: '2026-11-04' });
  assert.deepEqual(warnings, ['WARN agent-4 子代理的父 session gone 讀不到，角色記 interactive']);
  assert.equal(summaryLine(result), 'TOKENS_SUMMARY since=2026-11-01 until=2026-11-04 workerMedian=0.30M workers=3 retroOpus=75.0% retroOpusAgents=1/2');
});

test('aggregate：跨檔同 message id 只算一次，output 取各檔最大值，與讀取順序無關', () => {
  const turn = output => ({ id: 'm', ts: Date.parse('2026-11-02T01:00:00Z'), model: 'claude-opus-5-5', input: 1, cacheWrite: 0, cacheRead: 0, output });
  const pair = [
    { sid: 'w1', parent: null, firstUser: command('/issue-run', '901 --worker /x'), turns: [turn(1)] },
    { sid: 'w1', parent: null, firstUser: command('/issue-run', '901 --worker /x'), turns: [turn(1000)] },
  ];
  for (const list of [pair, [...pair].reverse()]) {
    const result = aggregate(list, { since: '2026-11-01' });
    assert.equal(result.workers.get(901).weighted, 5001);
    assert.equal(result.models.get('claude-opus-5-5').output, 1000);
  }
});

function setup(t) {
  const root = mkdtempSync(join(realTmpdir(), 'token-usage-'));
  t.root = root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '-home-u-code-acme');
  mkdirSync(join(dir, 'w1/subagents'), { recursive: true });
  mkdirSync(join(root, '-home-u-other'), { recursive: true });
  writeFileSync(join(dir, 'w1.jsonl'), [user(command('/issue-run', '901 --worker /x')), assistant('a', '2026-11-02T01:00:00Z', 'claude-opus-5-5', usage(0, 0, 1000000, 0))].join('\n'));
  writeFileSync(join(dir, 'w1/subagents/agent-1.jsonl'), [user('子代理'), assistant('s', '2026-11-02T01:00:00Z', 'claude-sonnet-5-5', usage(0, 0, 500000, 0))].join('\n'));
  writeFileSync(join(dir, 'w2.jsonl'), [user(command('/issue-run', '902 --worker /x')), '{壞', assistant('b', '2026-11-02T02:00:00Z', 'claude-opus-5-5', usage(0, 0, 3000000, 0))].join('\n'));
  writeFileSync(join(dir, 'old.jsonl'), [user(command('/issue-run', '800 --worker /x')), assistant('o', '2026-10-01T02:00:00Z', 'claude-opus-5-5', usage(0, 0, 3000000, 0))].join('\n'));
  utimesSync(join(dir, 'old.jsonl'), new Date('2026-10-01T03:00:00Z'), new Date('2026-10-01T03:00:00Z'));
  writeFileSync(join(root, '-home-u-other/x.jsonl'), [user(command('/issue-run', '999 --worker /x')), assistant('x', '2026-11-02T02:00:00Z', 'claude-opus-5-5', usage(0, 0, 9000000, 0))].join('\n'));
  const run = (args, options = {}) => spawnSync('node', [SCRIPT, '--root', root, ...(args.includes('--project') ? [] : ['--project', 'acme']), ...args], { encoding: 'utf8', ...options });
  return { run };
}

test('CLI：--project 只讀名稱含該子字串的目錄（含 <session>/subagents）；--summary 只印 TOKENS_SUMMARY；壞行 WARN 只帶 session id 不帶內容', t => {
  const { run } = setup(t);
  const full = run(['--since', '2026-11-01']);
  assert.equal(full.status, 0, full.stderr);
  const lines = full.stdout.trim().split('\n');
  assert.ok(lines.includes('TOKENS_DAY 2026-11-02 input=0 cacheWrite=0 cacheRead=4500000 output=0 weighted=450000'), full.stdout);
  assert.ok(lines.includes('TOKENS_ROLE worker sessions=2 subagents=1 input=0 cacheWrite=0 cacheRead=4500000 output=0 weighted=450000'), full.stdout);
  assert.ok(lines.includes('TOKENS_WORKER #901 weighted=150000 sessions=1'), full.stdout);
  assert.ok(lines.includes('TOKENS_WORKER #902 weighted=300000 sessions=1'), full.stdout);
  assert.equal(lines.at(-1), 'TOKENS_SUMMARY since=2026-11-01 until=2026-11-02 workerMedian=0.23M workers=2 retroOpus=- retroOpusAgents=0/0');
  assert.match(full.stderr, /^WARN w2 1 行無法解析$/m);
  assert.doesNotMatch(full.stderr, /壞|子代理/);
  const summary = run(['--since', '2026-11-01', '--summary']);
  assert.equal(summary.stdout, `${lines.at(-1)}\n`);
});

test('CLI：子代理目錄讀不到時 WARN（session id 與原因）並略過，報表照出', t => {
  const { run } = setup(t);
  const dir = join(t.root, '-home-u-code-acme');
  mkdirSync(join(dir, 'w2'), { recursive: true });
  writeFileSync(join(dir, 'w2/subagents'), '不是目錄');
  const result = run(['--since', '2026-11-01', '--summary']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^WARN w2 子代理目錄讀不到（ENOTDIR），略過其子代理$/m);
  assert.match(result.stdout, /^TOKENS_SUMMARY .* workers=2 /);
});

test('CLI：不同專案目錄的同名 session 逐檔讀，共享的 message id 只算一次、各自新增的都算', t => {
  const { run } = setup(t);
  const other = join(t.root, '-home-u-orca-workspaces-acme-x');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'w2.jsonl'), [user(command('/issue-run', '902 --worker /x')), assistant('b', '2026-11-02T02:00:00Z', 'claude-opus-5-5', usage(0, 0, 3000000, 0)),
    assistant('b2', '2026-11-02T03:00:00Z', 'claude-opus-5-5', usage(0, 0, 2000000, 0))].join('\n'));
  const result = run(['--since', '2026-11-01']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes('TOKENS_WORKER #902 weighted=500000 sessions=2'), result.stdout);
});

test('CLI：用法錯誤 exit 2；根目錄讀不到 WARN 並 exit 1', t => {
  const { run } = setup(t);
  assert.equal(run(['--since', '11/01']).status, 2);
  assert.equal(run(['--bogus']).status, 2);
  const missing = spawnSync('node', [SCRIPT, '--root', '/nonexistent-token-usage', '--since', '2026-11-01'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^WARN \/nonexistent-token-usage ENOENT/m);
  const file = join(t.root, 'plain-file');
  writeFileSync(file, 'x');
  const notDir = spawnSync('node', [SCRIPT, '--root', file, '--since', '2026-11-01'], { encoding: 'utf8' });
  assert.equal(notDir.status, 1);
  assert.match(notDir.stderr, /^WARN .*plain-file ENOTDIR$/m);
  assert.doesNotMatch(notDir.stderr, /at .*token-usage\.mjs/);
});

test('CLI：沒帶 --project 時取目前目錄（不在 git repo）的目錄名；沒有相符的專案目錄時 WARN 並 exit 0', t => {
  const { run } = setup(t);
  const cwd = join(t.root, 'work', 'acme');
  mkdirSync(cwd, { recursive: true });
  const byDefault = spawnSync('node', [SCRIPT, '--root', t.root, '--since', '2026-11-01', '--summary'], { encoding: 'utf8', cwd });
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.match(byDefault.stdout, /^TOKENS_SUMMARY .* workers=2 /);
  const none = run(['--since', '2026-11-01', '--project', 'nothing-here']);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stderr, /^WARN \S+ 沒有名稱含 nothing-here 的專案目錄$/m);
  assert.equal(none.stdout, 'TOKENS_SUMMARY since=2026-11-01 until=2026-11-01 workerMedian=- workers=0 retroOpus=- retroOpusAgents=0/0\n');
  assert.equal(run(['--project']).status, 2);
});
