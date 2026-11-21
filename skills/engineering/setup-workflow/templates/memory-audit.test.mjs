import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, declaredDays, listMemoryDir, memoryAuditLine, memoryDirFor } from './memory-audit.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./memory-audit.mjs', import.meta.url));
const NOW = '2026-11-21T03:00:00Z';

/** 暫存區：主 checkout（git repo，issue-tracker.md 寫 gh）、memory 目錄、PATH 上的假 gh（closed 列出的號碼回 CLOSED，fail 列出的 exit 1）。 */
function fixture(t, { closed = [], fail = [], tracker = 'Issues 用 `gh issue` 管理。\n' } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'memory-audit-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo');
  mkdirSync(join(root, 'docs/agents'), { recursive: true });
  spawnSync('git', ['init', '-q', '--initial-branch=main', root]);
  writeFileSync(join(root, 'docs/agents/issue-tracker.md'), tracker);
  const dir = join(temp, 'memory');
  mkdirSync(dir);
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const n = Number(process.argv[4]);
if (${JSON.stringify(fail)}.includes(n)) { console.error('boom'); process.exit(1); }
console.log(JSON.stringify({ state: ${JSON.stringify(closed)}.includes(n) ? 'CLOSED' : 'OPEN' }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const write = (name, text) => writeFileSync(join(dir, name), text);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, '--dir', dir, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MEMORY_AUDIT_NOW: NOW },
  });
  return { root, dir, write, run };
}

test('乾淨的 memory 目錄只印 MEMORY_AUDIT items=0', t => {
  const { write, run } = fixture(t);
  write('MEMORY.md', '- [A](a.md) — 一條規則\n');
  write('a.md', '---\nname: a\n---\n見 [[a]]\n');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MEMORY_AUDIT items=0\n');
});

/** #347 的每類問題各一的 memory 目錄（含 [[Open]] 對 open.md）。 */
function writeEveryKind(write) {
  const long = `- [Long](long.md) — ${'字'.repeat(90)}`;
  write('MEMORY.md', [
    long,
    '- [Gone](gone.md) — 檔不在',
    '- [Until](until.md) — 暫時規則 until #12',
    '- [Open](open.md) — 還沒關 until #13',
    '- [Dated](dated.md) — 09-01 起改用新流程',
    '- [Recent](recent.md) — 11-10 的決定',
    '- [Soon](soon.md) — 12-25 前完成',
    `x${'a'.repeat(6000)}`,
  ].join('\n'));
  for (const name of ['long.md', 'until.md', 'open.md', 'dated.md', 'recent.md', 'soon.md']) write(name, 'x\n');
  write('orphan.md', '見 [[Open]] 與 [[not-written-yet]]\n');
}

/** writeEveryKind 的預期輸出（INDEX_OVER 行另比對）。 */
const EVERY_KIND = [
  'INDEX_LINE_LONG line=1 len=110 limit=100',
  'ORPHAN_FILE orphan.md',
  'BROKEN_LINK MEMORY.md:2 gone.md',
  'BROKEN_LINK orphan.md:1 [[Open]]',
  'UNTIL_CLOSED line=3 #12',
  'DATED_STALE line=5 date=09-01 age=81d',
  'MEMORY_AUDIT items=7 index_over=1 long=1 orphan=1 broken=2 until_closed=1 dated_stale=1',
];

test('每一類問題各印一行，最後是摘要（#347）', t => {
  const { write, run } = fixture(t, { closed: [12] });
  writeEveryKind(write);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const [first, ...rest] = result.stdout.trim().split('\n');
  assert.match(first, /^INDEX_OVER size=6\d{3} limit=6000$/);
  assert.deepEqual(rest, EVERY_KIND);
});

test('大小寫不敏感的檔案系統（APFS）上 [[Open]] 對 open.md 仍算斷連結：比對目錄列表、不靠檔案存不存在（#347）', t => {
  const { root, dir, write } = fixture(t);
  writeEveryKind(write);
  // 模擬 APFS：Open.md 在磁碟上「存在」（existsSync 回 true），目錄列表卻只有 open.md
  write('Open.md', 'x\n');
  const listDir = path => listMemoryDir(path).filter(entry => entry.name !== 'Open.md');
  const result = audit({ dir, root, now: new Date(NOW), state: n => (n === 12 ? 'closed' : 'open'), listDir });
  assert.match(result.lines[0], /^INDEX_OVER size=6\d{3} limit=6000$/);
  assert.deepEqual([...result.lines.slice(1), ...result.warns, result.summary], EVERY_KIND);
});

test('查不到的單印 WARN tracker-unreachable、不算結案；本機 Markdown tracker 一律查不到', t => {
  const { write, run } = fixture(t, { fail: [7] });
  write('MEMORY.md', '- [A](a.md) — until #7\n');
  write('a.md', 'x\n');
  assert.equal(run().stdout, 'WARN memory-audit reason=tracker-unreachable issue=#7\nMEMORY_AUDIT items=0\n');
  const local = fixture(t, { closed: [7], tracker: 'Issues 存在 .scratch/issues/ 的 Markdown。\n' });
  local.write('MEMORY.md', '- [A](a.md) — until #7\n');
  local.write('a.md', 'x\n');
  assert.equal(local.run().stdout, 'WARN memory-audit reason=tracker-unreachable issue=#7\nMEMORY_AUDIT items=0\n');
});

test('目錄不存在或沒有 MEMORY.md 時只印 WARN，--run 不追加紀錄', t => {
  const { root, dir, run } = fixture(t);
  const missing = run('--run');
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, `WARN memory-audit reason=index-missing dir=${dir}\n`);
  assert.equal(existsSync(join(root, '.scratch/pilot/memory-audit.md')), false);
  const gone = spawnSync(process.execPath, [SCRIPT, '--root', root, '--dir', join(dir, 'nope')], { encoding: 'utf8' });
  assert.equal(gone.stdout, `WARN memory-audit reason=dir-missing dir=${join(dir, 'nope')}\n`);
});

test('--run 把 <UTC 日期> <摘要行> 追加到主 checkout 的 .scratch/pilot/memory-audit.md', t => {
  const { root, write, run } = fixture(t);
  write('MEMORY.md', '- [A](a.md) — x\n');
  write('a.md', 'x\n');
  write('b.md', 'x\n');
  assert.equal(run('--run').stdout, 'ORPHAN_FILE b.md\nMEMORY_AUDIT items=1 index_over=0 long=0 orphan=1 broken=0 until_closed=0 dated_stale=0\n');
  run('--run');
  assert.equal(readFileSync(join(root, '.scratch/pilot/memory-audit.md'), 'utf8'),
    '2026-11-21 MEMORY_AUDIT items=1 index_over=0 long=0 orphan=1 broken=0 until_closed=0 dated_stale=0\n'.repeat(2));
});

test('用法錯誤 exit 2', t => {
  const { run } = fixture(t);
  assert.equal(run('--fix').status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--root'], { encoding: 'utf8' }).status, 2);
});

test('預設 memory 目錄：主 checkout 路徑英數以外換成 -（worktree 也取主 checkout）', t => {
  const { root } = fixture(t);
  assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=x', '-c', 'user.email=x@x.invalid', 'commit', '-q', '--allow-empty', '-m', 'x']).status, 0);
  const tree = join(root, '..', 'wt');
  assert.equal(spawnSync('git', ['-C', root, 'worktree', 'add', '-q', tree], { encoding: 'utf8' }).status, 0);
  assert.equal(memoryDirFor('/home/u/code/my.repo_x'), join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', '-home-u-code-my-repo-x', 'memory'));
  const config = join(root, '..', 'config');
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: tree, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
  assert.equal(result.stdout, `WARN memory-audit reason=dir-missing dir=${join(config, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')}\n`);
});

test('memoryAuditLine：沒宣告不印；沒紀錄或滿間隔天數到期；declaredDays 讀 `Memory audit days: <n>`', () => {
  const now = Date.parse('2026-11-21T03:00:00Z');
  assert.equal(memoryAuditLine(null, null, now), null);
  assert.equal(memoryAuditLine(null, 7, now), 'MEMORY_AUDIT_DUE ?d last=none → node scripts/memory-audit.mjs --run');
  assert.equal(memoryAuditLine('2026-11-14 MEMORY_AUDIT items=0\n', 7, now), 'MEMORY_AUDIT_DUE 7d last=2026-11-14 → node scripts/memory-audit.mjs --run');
  assert.equal(memoryAuditLine('2026-11-01 MEMORY_AUDIT items=0\n2026-11-15 MEMORY_AUDIT items=0\n', 7, now), null);
  assert.equal(declaredDays('- **Memory audit.** `Memory audit days: 7`，Probe …'), 7);
  assert.equal(declaredDays('# 沒有宣告'), null);
  assert.equal(declaredDays('Memory audit days: 0'), null);
});

test('GitLab tracker：until #<n> 以 glab issue view <n> -F json 查，closed 算結案、opened 不算', t => {
  const { root, write, run } = fixture(t, { tracker: 'Issues 用 `glab issue` 管理。\n' });
  const bin = join(root, '..', 'bin');
  writeFileSync(join(bin, 'glab'), `#!/usr/bin/env node
const [cmd, sub, n, flag, format] = process.argv.slice(2);
if (cmd !== 'issue' || sub !== 'view' || flag !== '-F' || format !== 'json') process.exit(1);
console.log(JSON.stringify({ state: n === '5' ? 'closed' : 'opened' }));
`);
  chmodSync(join(bin, 'glab'), 0o755);
  write('MEMORY.md', '- [A](a.md) — until #5\n- [B](b.md) — until #6\n');
  write('a.md', 'x\n');
  write('b.md', 'x\n');
  assert.equal(run().stdout, 'UNTIL_CLOSED line=1 #5\nMEMORY_AUDIT items=1 index_over=0 long=0 orphan=0 broken=0 until_closed=1 dated_stale=0\n');
});
