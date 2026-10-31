import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/gh-tracker.mjs 是 auto mode 唯一放行的 tracker 寫入（#96）：只寫 ron03wlb/ron-skills，其他 repo 照 #79 交給人。
const script = new URL('../scripts/gh-tracker.mjs', import.meta.url).pathname;

/** PATH 上放假 gh：每次呼叫記一行 JSON argv；`api --hostname github.com repos/.../issues/<n> --jq .id` 回 9000+n（Issue 的 database id）。 */
function run(...args) {
  const temp = mkdtempSync(join(tmpdir(), 'gh-tracker-'));
  const log = join(temp, 'calls.jsonl');
  writeFileSync(join(temp, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (process.env.GH_HOST) require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['GH_HOST', process.env.GH_HOST]) + '\\n');
const id = args.join(' ').match(/^api --hostname github\\.com repos\\/[^ ]+\\/issues\\/(\\d+) --jq \\.id$/);
if (id) console.log(9000 + Number(id[1]));
`);
  chmodSync(join(temp, 'gh'), 0o755);
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, GH_REPO: 'other/repo', GH_HOST: 'other.example' } });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch {}
  return { ...result, calls };
}

test('comment：轉成 gh issue comment，主機與 repo 固定為 github.com/ron03wlb/ron-skills', () => {
  const result = run('comment', '96', '--body-file', 'note.md');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [['issue', 'comment', '96', '--body-file=note.md', '--repo', 'github.com/ron03wlb/ron-skills']]);
});

test('改寫目標 repo 的參數：exit 2、不呼叫 gh', () => {
  for (const args of [
    ['comment', '96', '--body', 'x', '-R', 'other/repo'],
    ['comment', '96', '--body', 'x', '--repo=other/repo'],
    ['comment', '96', '-wR', 'other/repo'],
    ['comment', 'https://github.com/other/repo/issues/1', '--body', 'x'],
    ['comment', '96', 'https://github.com/other/repo/issues/1', '--body', 'x'],
    ['comment', '96', '--body', 'x', '--', '--repo', 'other/repo'],
    ['constructor', '96'],
    ['__proto__', '96'],
    ['comment', '096', '--body', 'x'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${args.join(' ')}：${result.stderr}`);
    assert.deepEqual(result.calls, [], args.join(' '));
  }
});

test('值以 - 開頭仍是值：以 --長名=值 傳給 gh', () => {
  const result = run('comment', '96', '-b', '-R other/repo');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [['issue', 'comment', '96', '--body=-R other/repo', '--repo', 'github.com/ron03wlb/ron-skills']]);
});

test('close、edit、create：短名換成長名，固定 repo', () => {
  assert.deepEqual(run('close', '96', '-c', 'done', '-r', 'not planned').calls,
    [['issue', 'close', '96', '--comment=done', '--reason=not planned', '--repo', 'github.com/ron03wlb/ron-skills']]);
  assert.deepEqual(run('edit', '96', '--add-label', 'parent', '--remove-label', 'ready-for-agent', '--add-assignee', '@me').calls,
    [['issue', 'edit', '96', '--add-label=parent', '--remove-label=ready-for-agent', '--add-assignee=@me', '--repo', 'github.com/ron03wlb/ron-skills']]);
  assert.deepEqual(run('edit', '96', '--remove-assignee', '@me').calls,
    [['issue', 'edit', '96', '--remove-assignee=@me', '--repo', 'github.com/ron03wlb/ron-skills']]);
  assert.deepEqual(run('create', '-t', 'T', '-F', 'body.md', '-l', 'needs-triage').calls,
    [['issue', 'create', '--title=T', '--body-file=body.md', '--label=needs-triage', '--repo', 'github.com/ron03wlb/ron-skills']]);
});

test('create 不收 Issue 號碼；close 不收 --duplicate-of（可帶別 repo 的 URL）', () => {
  for (const args of [['create', '96', '--title', 'T'], ['close', '96', '--duplicate-of', 'https://github.com/other/repo/issues/1']]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.deepEqual(result.calls, []);
  }
});

test('sub-issue、blocked-by：先查 database id，再呼叫本 repo 的 sub_issues、dependencies API', () => {
  const lookup = n => ['api', '--hostname', 'github.com', `repos/ron03wlb/ron-skills/issues/${n}`, '--jq', '.id'];
  assert.deepEqual(run('sub-issue', 'add', '90', '96').calls,
    [lookup(96), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/ron03wlb/ron-skills/issues/90/sub_issues', '-F', 'sub_issue_id=9096']]);
  assert.deepEqual(run('sub-issue', 'remove', '90', '96').calls,
    [lookup(96), ['api', '--hostname', 'github.com', '--method', 'DELETE', 'repos/ron03wlb/ron-skills/issues/90/sub_issue', '-F', 'sub_issue_id=9096']]);
  assert.deepEqual(run('blocked-by', 'add', '96', '79').calls,
    [lookup(79), ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/ron03wlb/ron-skills/issues/96/dependencies/blocked_by', '-F', 'issue_id=9079']]);
  assert.deepEqual(run('blocked-by', 'remove', '96', '79').calls,
    [lookup(79), ['api', '--hostname', 'github.com', '--method', 'DELETE', 'repos/ron03wlb/ron-skills/issues/96/dependencies/blocked_by/9079']]);
});

test('sub-issue、blocked-by 只收 add|remove 加兩個數字號碼', () => {
  for (const args of [['sub-issue', 'add', '90'], ['blocked-by', 'add', '96', 'other/repo#1'], ['blocked-by', 'list', '96', '79'], ['sub-issue', 'add', '90', '96', '--hostname', 'x']]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.deepEqual(result.calls, []);
  }
});

// auto mode 只認 permissions.allow：tracker 寫入只放行這支 wrapper，不放行裸 gh（前綴規則會連 -R other/repo 一起放行）。
test('.claude/settings.json 放行 gh-tracker，沒有放行任何 gh 指令', () => {
  const { permissions } = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  assert.ok(permissions.allow.includes('Bash(node scripts/gh-tracker.mjs:*)'), '沒有 Bash(node scripts/gh-tracker.mjs:*)');
  assert.deepEqual(permissions.allow.filter(rule => /^Bash\(\s*gh\b/.test(rule)), []);
});

// 文件裡的裸 gh 寫入在 auto mode 會被擋：本 repo 的寫入指令都要換成 wrapper，跨 repo（帶 --repo）的照 #79 交給人。
test('docs/agents 的本 repo tracker 寫入都走 gh-tracker', () => {
  const dir = new URL('../docs/agents/', import.meta.url);
  const bare = readdirSync(dir).filter(name => name.endsWith('.md')).flatMap(name => [...readFileSync(new URL(name, dir), 'utf8')
    .matchAll(/`(gh (?:issue (?:comment|close|edit|create)|api --method)\b[^`]*)`/g)]
    .map(([, command]) => command).filter(command => !/--repo /.test(command)).map(command => `${name}: ${command}`));
  assert.deepEqual(bare, []);
});
