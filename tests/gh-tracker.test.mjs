import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

// scripts/gh-tracker.mjs 是 setup-workflow 正本的副本（#244），通用行為（白名單、adapter 讀不到目標時 exit 2）由正本的 gh-tracker.test.mjs 測；
// 這裡只測本 repo 的事實：adapter 的 Tracker 段解出 ron03wlb/ron-skills、settings 只放行 wrapper、docs/agents 的寫入都走它（#96，其他 repo 照 #79 交給人）。
const script = new URL('../scripts/gh-tracker.mjs', import.meta.url).pathname;

/** PATH 上放假 gh：每次呼叫記一行 JSON argv；`api --hostname github.com repos/.../issues/<n> --jq .id` 回 9000+n（Issue 的 database id），`api … --method …` 回一大段 issue JSON（同真的 REST 回應，#140）。 */
function run(...args) {
  const temp = mkdtempSync(join(realTmpdir(), 'gh-tracker-'));
  const log = join(temp, 'calls.jsonl');
  writeFileSync(join(temp, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (process.env.GH_HOST) require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['GH_HOST', process.env.GH_HOST]) + '\\n');
const id = args.join(' ').match(/^api --hostname github\\.com repos\\/[^ ]+\\/issues\\/(\\d+) --jq \\.id$/);
if (id && id[1] === '404') process.exit(1);
if (id) console.log(9000 + Number(id[1]));
if (args.includes('--method')) console.log(JSON.stringify({ number: 1, user: { login: 'x' }, body: 'x'.repeat(40000) }));
`);
  chmodSync(join(temp, 'gh'), 0o755);
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, GH_REPO: 'other/repo', GH_HOST: 'other.example' } });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch {}
  return { ...result, calls };
}

test('本 repo 的 adapter：comment 寫到 github.com/ron03wlb/ron-skills，不理 GH_HOST、GH_REPO', () => {
  const result = run('comment', '96', '--body-file', 'note.md');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [['issue', 'comment', '96', '--body-file=note.md', '--repo', 'github.com/ron03wlb/ron-skills']]);
});

test('本 repo 的 adapter：sub-issue、blocked-by 查 database id 與呼叫 API 都在 github.com 的 ron03wlb/ron-skills', () => {
  const result = run('blocked-by', 'add', '96', '79');
  assert.equal(result.stdout, 'BLOCKED_BY add 96 79\n');
  assert.deepEqual(result.calls, [
    ['api', '--hostname', 'github.com', 'repos/ron03wlb/ron-skills/issues/79', '--jq', '.id'],
    ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/ron03wlb/ron-skills/issues/96/dependencies/blocked_by', '-F', 'issue_id=9079'],
  ]);
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
