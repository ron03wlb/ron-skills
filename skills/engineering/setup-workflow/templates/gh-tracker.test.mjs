import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

// gh-tracker 是 auto mode 放行的 tracker 寫入（ron-skills #96、#244）：寫入目標只來自 adapter 的 `## Tracker` 段，命令列改不了。
const template = name => fileURLToPath(new URL(`./${name}`, import.meta.url));
const ADAPTER = repo => `# issue-run adapter

## Tracker

Issues live at ${repo}. Writes go through \`node scripts/gh-tracker.mjs\`; see [HOSTS.md](HOSTS.md).

## Delivery

Code host https://github.com/other/elsewhere (not the tracker).
`;

/**
 * 在暫存 repo 的 scripts/ 放正本副本與 lib/hosts.mjs，docs/agents/issue-run.md 寫 adapter（null 時不寫），PATH 上放假 gh：
 * 每次呼叫記一行 JSON argv；`api --hostname <h> repos/<o>/<r>/issues/<n> --jq .id` 回 9000+n（Issue 的 database id），#404 失敗；
 * `api … --method …` 回一大段 issue JSON（同真的 REST 回應，ron-skills #140）；`issue create` 依序回 #500、#501…的網址（計數存在 temp），
 * 其他 `issue …` 回該 Issue 的網址；參數串含 `fail` 時 exit 4。`temp` 可沿用上一次的暫存 repo（續跑），`files` 先寫進暫存 repo 根目錄。
 */
function run(t, args, { adapter = ADAPTER('https://github.com/acme/app'), cwd, temp = mkdtempSync(join(realTmpdir(), 'gh-tracker-')), files = {}, fail } = {}) {
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(temp, name), typeof content === 'string' ? content : JSON.stringify(content));
  mkdirSync(join(temp, 'scripts', 'lib'), { recursive: true });
  rmSync(join(temp, 'calls.jsonl'), { force: true });
  copyFileSync(template('gh-tracker.mjs'), join(temp, 'scripts', 'gh-tracker.mjs'));
  copyFileSync(template('lib/hosts.mjs'), join(temp, 'scripts', 'lib', 'hosts.mjs'));
  if (adapter !== null) {
    mkdirSync(join(temp, 'docs', 'agents'), { recursive: true });
    writeFileSync(join(temp, 'docs', 'agents', 'issue-run.md'), adapter);
  }
  const bin = join(temp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(temp, 'calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (process.env.GH_HOST || process.env.GH_REPO) require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['ENV', process.env.GH_HOST, process.env.GH_REPO]) + '\\n');
const fail = process.env.FAKE_GH_FAIL;
if (fail && args.join(' ').includes(fail)) { console.error('fake gh: fail'); process.exit(4); }
if (args[0] === 'issue' && args[1] === 'create') {
  const file = ${JSON.stringify(join(temp, 'created'))};
  const n = (require('fs').existsSync(file) ? Number(require('fs').readFileSync(file, 'utf8')) : 499) + 1;
  require('fs').writeFileSync(file, String(n));
  console.log('Creating issue in acme/app\\n\\nhttps://github.com/acme/app/issues/' + n);
}
if (args[0] === 'issue' && args[1] !== 'create') console.log('https://github.com/acme/app/issues/' + args[2]);
const id = args.join(' ').match(/^api --hostname [^ ]+ repos\\/[^ ]+\\/issues\\/(\\d+) --jq \\.id$/);
if (id && id[1] === '404') process.exit(1);
if (id) console.log(9000 + Number(id[1]));
if (args.includes('--method')) console.log(JSON.stringify({ number: 1, user: { login: 'x' }, body: 'x'.repeat(40000) }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync('node', ['scripts/gh-tracker.mjs', ...args], {
    cwd: cwd ?? temp, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'other/repo', GH_HOST: 'other.example', FAKE_GH_FAIL: fail ?? '' },
  });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch {}
  return { ...result, calls, temp };
}

test('repo 與 host 來自 adapter 的 Tracker 段：comment 帶 --repo <host>/<owner>/<repo>，gh 收不到 GH_HOST、GH_REPO', t => {
  const result = run(t, ['comment', '96', '--body-file', 'note.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [['issue', 'comment', '96', '--body-file=note.md', '--repo', 'github.com/acme/app']]);
});

test('換一份 adapter 就換目標：GitHub Enterprise 主機與它的專案，關係 API 也帶同一個 --hostname', t => {
  const adapter = ADAPTER('https://github.example.com/team/svc/issues');
  assert.deepEqual(run(t, ['close', '7', '-c', 'done'], { adapter }).calls,
    [['issue', 'close', '7', '--comment=done', '--repo', 'github.example.com/team/svc']]);
  assert.deepEqual(run(t, ['blocked-by', 'add', '7', '5'], { adapter }).calls, [
    ['api', '--hostname', 'github.example.com', 'repos/team/svc/issues/5', '--jq', '.id'],
    ['api', '--hostname', 'github.example.com', '--method', 'POST', 'repos/team/svc/issues/7/dependencies/blocked_by', '-F', 'issue_id=9005'],
  ]);
});

test('Tracker 段同一個專案的多個網址算一個；Tracker 段以外的網址不算', t => {
  const adapter = ADAPTER('https://github.com/acme/app').replace('## Delivery', 'See https://github.com/acme/app/issues/3 and https://github.com/acme/app.\n\n## Delivery');
  assert.deepEqual(run(t, ['reopen', '3'], { adapter }).calls, [['issue', 'reopen', '3', '--repo', 'github.com/acme/app']]);
});

test('adapter 讀不到目標：沒有檔、沒有 Tracker 段、段裡沒有或有兩個 GitHub 專案、只有 GitLab 網址，都 exit 2、不呼叫 gh', t => {
  for (const [label, adapter] of [
    ['沒有 adapter', null],
    ['沒有 Tracker 段', '# adapter\n\n## Delivery\n\nhttps://github.com/acme/app\n'],
    ['沒有網址', ADAPTER('the usual place')],
    ['兩個專案', ADAPTER('https://github.com/acme/app and https://github.com/acme/other')],
    ['GitLab', ADAPTER('https://gitlab.example.com/group/app')],
  ]) {
    const result = run(t, ['comment', '96', '--body', 'x'], { adapter });
    assert.equal(result.status, 2, `${label}：${result.stderr}`);
    assert.match(result.stderr, /Tracker/, label);
    assert.deepEqual(result.calls, [], label);
  }
});

test('不是專案的 GitHub 網址不算：文件站、API、gist、raw 與 orgs／users 這類保留路徑', t => {
  const adapter = ADAPTER('https://github.com/acme/app; docs https://docs.github.com/en/rest, https://api.github.com/repos/x/y, https://gist.github.com/u/abc, https://raw.githubusercontent.com/x/y/main/f, https://github.com/orgs/acme/projects/1, https://github.com/users/u/projects/2, https://github.com/settings/tokens');
  assert.deepEqual(run(t, ['comment', '5', '-b', 'x'], { adapter }).calls, [['issue', 'comment', '5', '--body=x', '--repo', 'github.com/acme/app']]);
  const only = run(t, ['comment', '5', '-b', 'x'], { adapter: ADAPTER('see https://docs.github.com/en/issues') });
  assert.equal(only.status, 2);
  assert.deepEqual(only.calls, []);
});

test('adapter 依腳本位置找，不依 cwd：從別的目錄跑仍寫同一個專案', t => {
  const first = run(t, ['comment', '1', '-b', 'x']);
  const result = spawnSync('node', [join(first.temp, 'scripts', 'gh-tracker.mjs'), 'comment', '1', '-b', 'x'], {
    cwd: realTmpdir(), encoding: 'utf8', env: { ...process.env, PATH: `${join(first.temp, 'bin')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(first.temp, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1),
    ['issue', 'comment', '1', '--body=x', '--repo', 'github.com/acme/app']);
});

test('改寫目標 repo 或主機的參數：exit 2、不呼叫 gh', t => {
  for (const args of [
    ['comment', '96', '--body', 'x', '-R', 'other/repo'],
    ['comment', '96', '--body', 'x', '--repo=other/repo'],
    ['comment', '96', '--body', 'x', '--repo', 'other/repo'],
    ['comment', '96', '--body', 'x', '--hostname', 'other.example'],
    ['comment', '96', '-wR', 'other/repo'],
    ['comment', 'https://github.com/other/repo/issues/1', '--body', 'x'],
    ['comment', '96', 'https://github.com/other/repo/issues/1', '--body', 'x'],
    ['comment', '96', '--body', 'x', '--', '--repo', 'other/repo'],
    ['constructor', '96'],
    ['__proto__', '96'],
    ['comment', '096', '--body', 'x'],
    ['create', '96', '--title', 'T'],
    ['close', '96', '--duplicate-of', 'https://github.com/other/repo/issues/1'],
    ['reopen', '164', '--repo', 'other/repo'],
    ['sub-issue', 'add', '90'],
    ['blocked-by', 'add', '96', '79', 'x'],
    ['blocked-by', 'add', '96', 'other/repo#1'],
    ['blocked-by', 'list', '96', '79'],
    ['sub-issue', 'add', '90', '96', '--hostname', 'x'],
  ]) {
    const result = run(t, args);
    assert.equal(result.status, 2, `${args.join(' ')}：${result.stderr}`);
    assert.deepEqual(result.calls, [], args.join(' '));
  }
});

test('值以 - 開頭仍是值；短名換成長名', t => {
  assert.deepEqual(run(t, ['comment', '96', '-b', '-R other/repo']).calls,
    [['issue', 'comment', '96', '--body=-R other/repo', '--repo', 'github.com/acme/app']]);
  assert.deepEqual(run(t, ['edit', '96', '--add-label', 'parent', '--remove-label', 'ready-for-agent', '--add-assignee', '@me', '-t', 'T']).calls,
    [['issue', 'edit', '96', '--add-label=parent', '--remove-label=ready-for-agent', '--add-assignee=@me', '--title=T', '--repo', 'github.com/acme/app']]);
  assert.deepEqual(run(t, ['create', '-t', 'T', '-F', 'body.md', '-l', 'needs-triage', '-a', '@me']).calls,
    [['issue', 'create', '--title=T', '--body-file=body.md', '--label=needs-triage', '--assignee=@me', '--repo', 'github.com/acme/app']]);
  assert.deepEqual(run(t, ['reopen', '164', '-c', '子單還開著']).calls,
    [['issue', 'reopen', '164', '--comment=子單還開著', '--repo', 'github.com/acme/app']]);
});

test('sub-issue、blocked-by：先查 database id，stdout 每個對象只印一行結果', t => {
  const lookup = n => ['api', '--hostname', 'github.com', `repos/acme/app/issues/${n}`, '--jq', '.id'];
  const sub = run(t, ['sub-issue', 'add', '90', '96']);
  assert.equal(sub.stdout, 'SUB_ISSUE add 90 96\n');
  assert.deepEqual(sub.calls, [lookup(96), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/acme/app/issues/90/sub_issues', '-F', 'sub_issue_id=9096']]);
  assert.deepEqual(run(t, ['sub-issue', 'remove', '90', '96']).calls.at(-1),
    ['api', '--hostname', 'github.com', '--method', 'DELETE', 'repos/acme/app/issues/90/sub_issue', '-F', 'sub_issue_id=9096']);
  assert.deepEqual(run(t, ['blocked-by', 'remove', '96', '79']).calls.at(-1),
    ['api', '--hostname', 'github.com', '--method', 'DELETE', 'repos/acme/app/issues/96/dependencies/blocked_by/9079']);
  const many = run(t, ['blocked-by', 'add', '193', '130', '404', '192']);
  assert.equal(many.status, 1);
  assert.equal(many.stdout, 'BLOCKED_BY add 193 130\nBLOCKED_BY add 193 192\n');
  assert.match(many.stderr, /blocked-by add 193 404 失敗/);
});

test('沒有子命令或子命令不認得：stderr 印用法、exit 2、不呼叫 gh', t => {
  for (const args of [[], ['label']]) {
    const result = run(t, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /edit <n> \[--title/);
    assert.match(result.stderr, /blocked-by add\|remove <n> <blocker>\.\.\./);
    assert.deepEqual(result.calls, []);
  }
});

const lookup = n => ['api', '--hostname', 'github.com', `repos/acme/app/issues/${n}`, '--jq', '.id'];
const BATCH = [
  { op: 'create', code: 'spec', title: 'Spec', bodyFile: 'spec.md', labels: ['parent'] },
  { op: 'create', code: 'a', title: 'A', body: 'part a', parent: 'spec', labels: ['ready-for-agent'] },
  { op: 'create', code: 'b', title: 'B', body: 'part b', parent: 'spec', blockedBy: ['a', '#350'] },
  { op: 'comment', issue: '#383', body: '拆成 a、b' },
  { op: 'edit', issue: 'b', addLabels: ['needs-info'], blockedBy: ['#12'] },
  { op: 'close', issue: '#383', reason: 'completed', comment: '見子單' },
];

test('batch：依序執行，同批 code 換成單號，設好 parent 與 blocked-by，每步一行結果', t => {
  const result = run(t, ['batch', 'tickets.json'], { files: { 'tickets.json': BATCH, 'spec.md': 'spec body' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'CREATED spec 500', 'CREATED a 501', 'SUB_ISSUE add 500 501', 'CREATED b 502', 'SUB_ISSUE add 500 502',
    'BLOCKED_BY add 502 501', 'BLOCKED_BY add 502 350', 'COMMENTED 383', 'EDITED 502', 'BLOCKED_BY add 502 12', 'CLOSED 383', 'BATCH_DONE 6',
  ].join('\n') + '\n');
  const repo = ['--repo', 'github.com/acme/app'];
  assert.deepEqual(result.calls, [
    ['issue', 'create', `--title=Spec`, `--body-file=${join(result.temp, 'spec.md')}`, '--label=parent', ...repo],
    ['issue', 'create', '--title=A', '--body=part a', '--label=ready-for-agent', ...repo],
    lookup(501), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/acme/app/issues/500/sub_issues', '-F', 'sub_issue_id=9501'],
    ['issue', 'create', '--title=B', '--body=part b', ...repo],
    lookup(502), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/acme/app/issues/500/sub_issues', '-F', 'sub_issue_id=9502'],
    lookup(501), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/acme/app/issues/502/dependencies/blocked_by', '-F', 'issue_id=9501'],
    lookup(350), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/acme/app/issues/502/dependencies/blocked_by', '-F', 'issue_id=9350'],
    ['issue', 'comment', '383', '--body=拆成 a、b', ...repo],
    ['issue', 'edit', '502', '--add-label=needs-info', ...repo],
    lookup(12), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/acme/app/issues/502/dependencies/blocked_by', '-F', 'issue_id=9012'],
    ['issue', 'close', '383', '--comment=見子單', '--reason=completed', ...repo],
  ]);
});

test('batch：中途失敗就停、以 gh 的 exit code 結束；重跑只做剩下的步驟', t => {
  const files = { 'tickets.json': BATCH, 'spec.md': 'spec body' };
  const first = run(t, ['batch', 'tickets.json'], { files, fail: 'issues/502/dependencies/blocked_by -F issue_id=9350' });
  assert.equal(first.status, 4);
  assert.equal(first.stdout, ['CREATED spec 500', 'CREATED a 501', 'SUB_ISSUE add 500 501', 'CREATED b 502', 'SUB_ISSUE add 500 502', 'BLOCKED_BY add 502 501', ''].join('\n'));
  assert.match(first.stderr, /blocked-by add 502 350 失敗/);
  const again = run(t, ['batch', 'tickets.json'], { temp: first.temp });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, ['BLOCKED_BY add 502 350', 'COMMENTED 383', 'EDITED 502', 'BLOCKED_BY add 502 12', 'CLOSED 383', 'BATCH_DONE 6', ''].join('\n'));
  assert.deepEqual(again.calls.filter(call => call[1] === 'create'), []);
  const done = run(t, ['batch', 'tickets.json'], { temp: first.temp });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, 'BATCH_DONE 6\n');
  assert.deepEqual(done.calls, []);
});

test('batch：不合白名單或引用不到的內容 exit 2、不呼叫 gh', t => {
  for (const [label, steps] of [
    ['不認得的 op', [{ op: 'transfer', issue: '#1' }]],
    ['不認得的欄位', [{ op: 'create', title: 'T', body: 'x', repo: 'other/repo' }]],
    ['comment 帶 create 的欄位', [{ op: 'comment', issue: '#1', body: 'x', title: 'T' }]],
    ['create 沒有標題', [{ op: 'create', body: 'x' }]],
    ['create 沒有內文', [{ op: 'create', title: 'T' }]],
    ['body 與 bodyFile 並用', [{ op: 'comment', issue: '#1', body: 'x', bodyFile: 'spec.md' }]],
    ['不存在的 bodyFile', [{ op: 'comment', issue: '#1', bodyFile: 'missing.md' }]],
    ['別的 repo 的單', [{ op: 'comment', issue: 'other/repo#1', body: 'x' }]],
    ['網址', [{ op: 'close', issue: 'https://github.com/other/repo/issues/1' }]],
    ['裸數字', [{ op: 'close', issue: 1 }]],
    ['之後才建立的 code', [{ op: 'comment', issue: 'a', body: 'x' }, { op: 'create', code: 'a', title: 'A', body: 'x' }]],
    ['重複的 code', [{ op: 'create', code: 'a', title: 'A', body: 'x' }, { op: 'create', code: 'a', title: 'B', body: 'x' }]],
    ['code 像單號', [{ op: 'create', code: '#5', title: 'A', body: 'x' }]],
    ['labels 不是字串陣列', [{ op: 'create', title: 'A', body: 'x', labels: 'bug' }]],
    ['值不是字串', [{ op: 'comment', issue: '#1', body: { x: 1 } }]],
    ['__proto__', JSON.parse('[{"op":"comment","issue":"#1","body":"x","__proto__":{"repo":"o/r"}}]')],
    ['不是陣列', { steps: [] }],
    ['空陣列', []],
  ]) {
    const result = run(t, ['batch', 'tickets.json'], { files: { 'tickets.json': steps, 'spec.md': 'x' } });
    assert.equal(result.status, 2, `${label}：${result.stderr}`);
    assert.deepEqual(result.calls, [], label);
  }
  for (const args of [['batch'], ['batch', 'missing.json'], ['batch', 'tickets.json', 'more.json'], ['batch', 'tickets.json', '--repo', 'o/r']]) {
    const result = run(t, args, { files: { 'tickets.json': [{ op: 'comment', issue: '#1', body: 'x' }] } });
    assert.equal(result.status, 2, `${args.join(' ')}：${result.stderr}`);
    assert.deepEqual(result.calls, [], args.join(' '));
  }
  const broken = run(t, ['batch', 'tickets.json'], { files: { 'tickets.json': '{ not json' } });
  assert.equal(broken.status, 2);
  assert.deepEqual(broken.calls, []);
});

test('batch：狀態檔和批次檔對不上（改過步驟順序）時 exit 2、不呼叫 gh', t => {
  const steps = [{ op: 'create', code: 'a', title: 'A', body: 'x' }, { op: 'comment', issue: 'a', body: 'y' }];
  const first = run(t, ['batch', 'tickets.json'], { files: { 'tickets.json': steps }, fail: 'issue comment' });
  assert.equal(first.status, 4);
  const swapped = run(t, ['batch', 'tickets.json'], { temp: first.temp, files: { 'tickets.json': [{ op: 'comment', issue: '#9', body: 'y' }, ...steps] } });
  assert.equal(swapped.status, 2, swapped.stderr);
  assert.match(swapped.stderr, /狀態檔/);
  assert.deepEqual(swapped.calls, []);
});
