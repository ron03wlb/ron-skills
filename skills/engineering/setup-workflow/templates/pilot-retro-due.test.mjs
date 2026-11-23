// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AGE_HOURS, DEFAULT_COUNT, declaredRoster, declaredThreshold, retroDue, rosterItems, trackerItems } from './pilot-retro-due.mjs';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-retro-due.mjs', import.meta.url));
const NOW = Date.parse('2026-11-23T12:00:00Z');
const HOUR = 3_600_000;
const DEFAULTS = { count: DEFAULT_COUNT, ageHours: DEFAULT_AGE_HOURS };
const aged = (...hours) => hours.map(h => ({ createdAt: NOW - h * HOUR }));

// CoS item 41：未收集的 retro 達 5 則或最舊一則滿 8 小時就收集；land 中、已有收集者在跑時不開第二個。
test('觸發邊界：0 則、4 則不觸發；5 則觸發；1 則滿 8h 觸發、未滿不觸發', () => {
  assert.equal(retroDue({ items: [], threshold: DEFAULTS, now: NOW }).state, 'IDLE');
  assert.equal(retroDue({ items: aged(1, 1, 1, 1), threshold: DEFAULTS, now: NOW }).state, 'IDLE');
  assert.equal(retroDue({ items: aged(1, 1, 1, 1, 1), threshold: DEFAULTS, now: NOW }).state, 'DUE');
  assert.equal(retroDue({ items: aged(8), threshold: DEFAULTS, now: NOW }).state, 'DUE');
  assert.equal(retroDue({ items: aged(7.9), threshold: DEFAULTS, now: NOW }).state, 'IDLE');
  assert.equal(retroDue({ items: [{ createdAt: null }], threshold: DEFAULTS, now: NOW }).state, 'IDLE', '沒有時間的項目只計數');
});

test('land 中（staged batch）到期也只等；已有收集者時 RUNNING；staged 優先', () => {
  assert.deepEqual(retroDue({ items: aged(1, 1, 1, 1, 1), threshold: DEFAULTS, now: NOW, staged: '1123a' }).state, 'WAIT');
  assert.equal(retroDue({ items: aged(9), threshold: DEFAULTS, now: NOW, running: 'term_x' }).state, 'RUNNING');
  assert.equal(retroDue({ items: aged(9), threshold: DEFAULTS, now: NOW, staged: '1123a', running: 'term_x' }).state, 'WAIT');
  assert.equal(retroDue({ items: aged(1), threshold: DEFAULTS, now: NOW, staged: '1123a' }).state, 'IDLE', '沒到期時不論 land');
});

test('宣告行：沒宣告用預設 5／8h；count=3 age=2h；格式錯是 null', () => {
  assert.deepEqual(declaredThreshold('沒有宣告'), { count: 5, ageHours: 8 });
  assert.deepEqual(declaredThreshold('- **Retro trigger.** `Retro trigger: count=3 age=2h`，其他'), { count: 3, ageHours: 2 });
  assert.equal(declaredThreshold('Retro trigger: count=0 age=8h'), null);
  assert.equal(declaredThreshold('Retro trigger: 5 8h'), null);
});

test('Declared roster：Roster due 的行才算，年齡取 ISO 時刻或檔案 mtime', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'retro-due-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a1b2c3d4.md');
  writeFileSync(file, '# retro');
  utimesSync(file, (NOW - 9 * HOUR) / 1000, (NOW - 9 * HOUR) / 1000);
  assert.deepEqual(declaredRoster('- Roster command: `node scripts/retro-collect.mjs --status`. Roster due: `DONE`.'), { command: 'node scripts/retro-collect.mjs --status', due: ['DONE'] });
  assert.equal(declaredRoster('- Roster command: `x`.').due, null);
  assert.equal(declaredRoster('沒有名單'), null);
  const items = rosterItems([
    `DONE a1b2c3d4 term_1 ${file}`, 'DONE e5f6a7b8 term_2 2026-11-23T10:00:00Z', 'PENDING 11112222 term_3 -', 'SUMMARY done=2',
  ].join('\n'), ['DONE'], dir);
  assert.deepEqual(items.map(item => [item.id, (NOW - item.createdAt) / HOUR]), [['a1b2c3d4', 9], ['e5f6a7b8', 2]]);
});

test('tracker：內文有 From: retro-collect 的不算；GitHub 與 GitLab 欄位都認得', () => {
  const items = trackerItems([
    { number: 1, createdAt: '2026-11-23T00:00:00Z', body: 'Orca: term_a\n1. x' },
    { number: 2, createdAt: '2026-11-23T01:00:00Z', body: 'Orca: term_b\nFrom: retro-collect\n1. y' },
    { iid: 3, created_at: '2026-11-23T02:00:00Z', description: 'Chat: s' },
  ]);
  assert.deepEqual(items.map(item => item.id), ['#1', '#3']);
});

/** 暫存 checkout：adapter（Pilot 段 → pilot.md → retro.md 兩層）、假 gh（回 issues）、選用的 batch checkpoint。 */
function fixture(t, { orca = false, trigger = '- **Retro trigger.** `Retro trigger: count=5 age=8h`', collect = '- **Retro collect.** 見主 checkout。', issues = [], batch } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'retro-due-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo');
  mkdirSync(join(root, 'docs/agents'), { recursive: true });
  writeFileSync(join(root, 'docs/agents/issue-run.md'), '# Adapter\n\n## Pilot\n\n見 [pilot.md](pilot.md)。\n\n## Other\n');
  writeFileSync(join(root, 'docs/agents/pilot.md'), `# Pilot\n\n- **Retro.** 見 [retro.md](retro.md)。\n`);
  writeFileSync(join(root, 'docs/agents/retro.md'), `# Retro\n\n${collect}\n${trigger}\n`);
  writeFileSync(join(root, 'docs/agents/issue-tracker.md'), 'Issues 用 `gh issue` 管理。\n');
  if (batch) {
    mkdirSync(join(root, '.scratch/pilot'), { recursive: true });
    writeFileSync(join(root, '.scratch/pilot/batch-1123a.md'), `# batch 1123a\ncurrent: ${batch}\n`);
  }
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(issues))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  // 假 Orca：create 開 term_new；list 只在 tab 檔存在時列出它，標題取 tab 檔（收集者分頁的實際標題）。
  const log = join(temp, 'orca.log');
  const tab = join(temp, 'tab');
  writeFileSync(join(bin, 'orca'), `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (b === 'create') reply('create', { terminal: { handle: 'term_new' } });
else if (b === 'wait') reply('wait', { wait: { satisfied: true } });
else if (b === 'send') { fs.writeFileSync(${JSON.stringify(log)} + '.sent', arg('--text')); reply('send', { send: { accepted: true } }); }
else if (b === 'read') reply('read', { terminal: { tail: [fs.existsSync(${JSON.stringify(log)} + '.sent') ? fs.readFileSync(${JSON.stringify(log)} + '.sent', 'utf8') : '❯'] } });
else if (b === 'list' && fs.existsSync(${JSON.stringify(tab)})) reply('list-visual', { terminals: [{ handle: 'term_new' }], visualLayouts: [{ root: { second: { tabs: [{ title: fs.readFileSync(${JSON.stringify(tab)}, 'utf8'), panes: { first: { handle: 'term_new' } } }] } } }] });
else if (b === 'list') reply('list-visual', { terminals: [], visualLayouts: [] });
`);
  chmodSync(join(bin, 'orca'), 0o755);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, root, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...FAST, PATH: `${bin}:${process.env.PATH}`, RETRO_DUE_NOW: new Date(NOW).toISOString(),
      ORCA_CLI_COMMAND: orca ? join(bin, 'orca') : '', ORCA_TERMINAL_HANDLE: '', TAB_STATE_DIR: join(temp, 'titles') },
  });
  return { root, run, log, tab };
}
const issue = (number, hours, body = '1. x') => ({ number, createdAt: new Date(NOW - hours * HOUR).toISOString(), body });

test('CLI：沒有 Retro trigger 條目印 RETRO_OFF', t => {
  const { run } = fixture(t, { trigger: '' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RETRO_OFF no-trigger-entry\n');
});

test('CLI：4 則（第 5 則是收集者自己的）RETRO_IDLE；5 則 RETRO_DUE 附 --start 指令', t => {
  const four = fixture(t, { issues: [issue(1, 1), issue(2, 1), issue(3, 1), issue(4, 1), issue(5, 1, 'From: retro-collect')] }).run();
  assert.equal(four.stdout, 'RETRO_IDLE 4 oldest=1.0h threshold count=5 age=8h\n', four.stderr);
  const { root, run } = fixture(t, { issues: [1, 2, 3, 4, 5].map(n => issue(n, 2)) });
  const five = run();
  assert.equal(five.status, 0, five.stderr);
  assert.equal(five.stdout, `RETRO_DUE 5 oldest=2.0h → node scripts/pilot-retro-due.mjs ${root} --start\n`);
});

test('CLI：1 則滿 8h 觸發；land 中（staged batch）印 RETRO_WAIT', t => {
  assert.match(fixture(t, { issues: [issue(7, 8.5)] }).run().stdout, /^RETRO_DUE 1 oldest=8\.5h → /);
  const waiting = fixture(t, { issues: [issue(7, 8.5)], batch: 'staged abc1234 onto def5678' }).run();
  assert.equal(waiting.stdout, 'RETRO_WAIT staged 1123a 1 oldest=8.5h\n');
  assert.match(fixture(t, { issues: [issue(7, 8.5)], batch: 'merged abc1234' }).run().stdout, /^RETRO_DUE /, 'merged 已過 stage 到合入的區段');
});

test('CLI：自訂門檻；宣告格式錯、Roster 沒有 Roster due 時 RETRO_FAILED exit 1', t => {
  assert.match(fixture(t, { trigger: '- **Retro trigger.** `Retro trigger: count=2 age=24h`', issues: [issue(1, 1), issue(2, 1)] }).run().stdout, /^RETRO_DUE 2 /);
  const bad = fixture(t, { trigger: '- **Retro trigger.** `Retro trigger: count=five`' }).run();
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^RETRO_FAILED bad-declaration/);
  const roster = fixture(t, { collect: '- **Retro collect.** x\n  - Roster command: `echo DONE a 2026-11-23T00:00:00Z`.' }).run();
  assert.equal(roster.status, 1);
  assert.equal(roster.stdout, 'RETRO_FAILED roster-due-missing\n');
});

test('CLI：Declared roster 在 checkout 跑 Roster command，只算 Roster due 的行', t => {
  const command = "printf 'DONE a1 t1 2026-11-23T03:00:00Z\\nPENDING b2 t2 -\\nTOOLING 12 x\\nSUMMARY done=1\\n'";
  const { run } = fixture(t, { collect: `- **Retro collect.** x\n  - Roster command: \`${command}\`. Roster due: \`DONE\`.` });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^RETRO_DUE 1 oldest=9\.0h → /);
});

test('CLI --start：到期時新開分頁送 /retro-collect、記下收集者；它還在處理中時 RETRO_RUNNING，換成待關閉後再到期', t => {
  const { root, run, log, tab } = fixture(t, { orca: true, issues: [issue(1, 9)] });
  const started = run('--start');
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, 'RETRO_STARTED term_new\n');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, new RegExp(`terminal create --worktree path:${root} --title 處理中｜retro-collect --command claude`));
  assert.match(calls, /terminal send --terminal term_new --text \/retro-collect --enter/);
  assert.equal(readFileSync(join(root, '.scratch/retro/collector'), 'utf8'), `${new Date(NOW).toISOString()} term_new\n`);
  writeFileSync(tab, '處理中｜retro-collect');
  assert.equal(run().stdout, 'RETRO_RUNNING term_new 1 oldest=9.0h\n');
  writeFileSync(tab, '待關閉｜retro-collect');
  assert.match(run().stdout, /^RETRO_DUE 1 /);
});

test('CLI --start：沒到期時照印那一行、不開分頁', t => {
  const { root, run, log } = fixture(t, { orca: true, issues: [issue(1, 1)] });
  assert.match(run('--start').stdout, /^RETRO_IDLE 1 /);
  assert.equal(existsSync(log), false);
  assert.equal(existsSync(join(root, '.scratch/retro/collector')), false);
});
