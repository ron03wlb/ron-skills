// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { repoFixture, run, source } from './test/repo-fixture.mjs';
import { recordFix } from './orca-session-split.mjs';

const script = join(source, 'orca-session-split.mjs');

// 記錄呼叫的假 Orca CLI（回應由 test/fake-orca.mjs 的真實樣本長出）。
function fixture(t, { self, sendRejected = false, swallow = 0, waitError = false, createFails = false } = {}) {
  const { temp, repo } = repoFixture(t);
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
const sentFile = ${JSON.stringify(log)} + '.sent'; const sent = () => fs.existsSync(sentFile) ? fs.readFileSync(sentFile, 'utf8').trim().split('\\n') : [];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (b === 'split') reply('split', { split: { handle: 'term_split' } });
else if (b === 'rename') reply('rename', { rename: { handle: process.argv[4] } });
else if (b === 'create') ${createFails ? `fail('runtime_unavailable')` : `reply('create', { terminal: { handle: 'term_new' } })`};
else if (b === 'wait') ${waitError ? `fail('runtime_unavailable')` : `reply('wait', { wait: { satisfied: true } })`};
else if (b === 'send') { fs.appendFileSync(sentFile, arg('--text') + '\\n'); reply('send', { send: { accepted: ${!sendRejected} } }); }
else if (b === 'read') reply('read', { terminal: { tail: sent().length > ${swallow} ? [sent().pop()] : ['❯'] } });
`);
  chmodSync(cli, 0o755);
  const titles = join(temp, 'titles');
  const ledger = join(temp, 'pilot-workers.tsv');
  const open = (args, extra = {}) => run(repo, ['node', script, ...args], { env: { ORCA_CLI_COMMAND: cli, ...FAST, ORCA_TERMINAL_HANDLE: self ?? '', TAB_STATE_DIR: titles, PILOT_WORKERS_LEDGER: ledger, PILOT_MACHINE_WORKER_CAP: '2', ...extra } });
  const recorded = handle => readFileSync(join(titles, handle), 'utf8');
  return { repo, log, open, recorded, titles, ledger };
}

// split 出來的 pane 和呼叫者同一個分頁：分頁標題歸呼叫者，不改名也不記標題（#378）。
test('在 Orca pane 內：split 在呼叫者旁邊、不改分頁標題、送出 prompt 且不帶 --wait-submit', t => {
  const { log, open, titles } = fixture(t, { self: 'term_self' });
  const result = open(['--title', '#12 交付', '--prompt', '/issue-run 12']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'OPENED term_split');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /terminal split --terminal term_self --direction vertical --command claude/);
  assert.match(calls, /terminal send --terminal term_split --text \/issue-run 12 --enter --json\n/);
  assert.doesNotMatch(calls, /terminal create|terminal rename|--wait-submit/);
  assert.equal(existsSync(join(titles, 'term_split')), false);
});

test('不在 Orca pane 內：在主 checkout 新開 terminal', t => {
  const { repo, log, open } = fixture(t);
  assert.equal(open(['--title', 'x', '--prompt', 'y']).stdout.trim(), 'OPENED term_new');
  assert.match(readFileSync(log, 'utf8'), new RegExp(`terminal create --worktree path:${repo} --title 處理中｜x --command claude`));
});

test('--tab：即使在 pane 內也在主 checkout 新開分頁，不 split', t => {
  const { repo, log, open } = fixture(t, { self: 'term_self' });
  assert.equal(open(['--title', 'x', '--prompt', 'y', '--tab']).stdout.trim(), 'OPENED term_new');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, new RegExp(`terminal create --worktree path:${repo} --title 處理中｜x --command claude`));
  assert.doesNotMatch(calls, /terminal split/);
});

test('--worktree：在指定 worktree 新開分頁，不 split；stdout 只有 OPENED 一行', t => {
  const { log, open } = fixture(t, { self: 'term_self' });
  assert.equal(open(['--title', 'fix-x', '--prompt', 'y', '--worktree', '/w/fix-x']).stdout, 'OPENED term_new\n');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /terminal create --worktree path:\/w\/fix-x --title 處理中｜fix-x --command claude/);
  assert.doesNotMatch(calls, /terminal split/);
});

test('送出被吞（accepted 但畫面沒出現 prompt）：讀畫面確認後重送一次', t => {
  const { log, open } = fixture(t, { self: 'term_self', swallow: 1 });
  const result = open(['--title', 'x', '--prompt', '/loop /issue-pilot']);
  assert.equal(result.stdout.trim(), 'OPENED term_split');
  assert.equal(readFileSync(log, 'utf8').match(/terminal send/g).length, 2);
});

test('第三次（延後）重送送達即成功；三次都被吞才 STOP send，exit 4', t => {
  const late = fixture(t, { self: 'term_self', swallow: 2 });
  assert.equal(late.open(['--title', 'x', '--prompt', '/loop /issue-pilot']).status, 0);
  const { open } = fixture(t, { self: 'term_self', swallow: 3 });
  const result = open(['--title', 'x', '--prompt', '/loop /issue-pilot']);
  assert.equal(result.status, 4);
  assert.equal(result.stdout.trim(), 'STOP send term_split');
});

test('send 被拒：STOP send，exit 4', t => {
  const { open } = fixture(t, { self: 'term_self', sendRejected: true });
  const result = open(['--title', 'x', '--prompt', 'y']);
  assert.equal(result.status, 4);
  assert.equal(result.stdout.trim(), 'STOP send term_split');
});

test('--worktree 而 STOP：只印 STOP', t => {
  const { open } = fixture(t, { sendRejected: true });
  const result = open(['--title', 'x', '--prompt', 'y', '--worktree', '/w/fix-x']);
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP send term_new\n');
});

// 開好分頁之後 Orca 出錯：呼叫者（如 pilot-handoff）要拿到 handle 才關得掉這個分頁，所以回 STOP 而不是丟出例外。
test('開好分頁後 Orca 出錯：STOP orca <錯誤碼>，exit 4；openSession 的 STOP 帶 handle', async t => {
  const { repo, log, open } = fixture(t, { waitError: true });
  const result = open(['--title', 'x', '--prompt', 'y']);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, 'STOP orca runtime_unavailable\n');
  const cli = join(log, '../orca');
  const { openSession } = await import(script);
  assert.deepEqual(await openSession({ cli }, { title: 'x', prompt: 'y', main: repo, newTab: true }), { stop: 'orca runtime_unavailable', handle: 'term_new' });
  const sent = await openSession({ cli }, { title: 'x', prompt: 'y', main: repo, newTab: true, createSignal: AbortSignal.abort('gone') });
  assert.match(sent.stop, /^create /);
  assert.equal(sent.handle, undefined);
});

test('用法錯誤 exit 2', t => {
  const { open } = fixture(t);
  assert.equal(open(['--title', 'x']).status, 2);
});

// CoS item 41：openSession 的 `model` 只給 pilot-handoff 開後繼 coordinator 用；命令列不讀 adapter，不合法的值也不拼進 --command。
test('claudeCommand：合法 model 帶 --model，沒給或含其他字元時裸 claude', async () => {
  const { claudeCommand } = await import(script);
  assert.equal(claudeCommand('claude-sonnet-5-5'), 'claude --model claude-sonnet-5-5');
  assert.equal(claudeCommand(undefined), 'claude');
  assert.equal(claudeCommand('x; rm -rf ~'), 'claude');
  assert.equal(claudeCommand('$(id)'), 'claude');
});

test('命令列開 session 不吃 adapter 的 Coordinator model 宣告：仍是裸 claude', t => {
  const { repo, log, open } = fixture(t);
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  writeFileSync(join(repo, 'docs/agents/issue-run.md'), '# adapter\n\n## Pilot\n\nCoordinator model: claude-sonnet-5-5\n');
  assert.equal(open(['--title', 'x', '--prompt', 'y', '--tab']).stdout.trim(), 'OPENED term_new');
  assert.match(readFileSync(log, 'utf8'), / --command claude --json$/m);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /--model/);
});

// #622：fix unit／retro 收集者的分頁算進全機帳本。
test('--capacity 上限已滿：STOP capacity、exit 4、沒呼叫 Orca 開分頁、帳本不變', t => {
  const { log, open, ledger } = fixture(t);
  const rows = `spay2\t2\t${new Date().toISOString()}\n`;
  writeFileSync(ledger, rows);
  const result = open(['--title', 'fix', '--prompt', 'y', '--tab', '--capacity', 'ron-skills', '--kind', 'fix']);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout.trim(), 'STOP capacity 3/2 spay2=2 +1');
  assert.equal(readFileSync(log, 'utf8'), '');
  assert.equal(readFileSync(ledger, 'utf8'), rows);
});

test('--capacity 沒滿：開分頁並在帳本記一筆 session 列', t => {
  const { open, ledger } = fixture(t);
  writeFileSync(ledger, `spay2\t1\t${new Date().toISOString()}\n`);
  const result = open(['--title', 'fix', '--prompt', 'y', '--tab', '--capacity', 'ron-skills', '--kind', 'fix']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'OPENED term_new');
  assert.match(readFileSync(ledger, 'utf8'), /^session\tron-skills\tfix\tterm_new\t\d{4}-/m);
});

test('--capacity 開分頁那一步就失敗（沒有 handle）：刪掉預留、不記帳', t => {
  const { open, ledger } = fixture(t, { createFails: true });
  assert.equal(open(['--title', 'fix', '--prompt', 'y', '--tab', '--capacity', 'ron-skills', '--kind', 'fix']).status, 4);
  assert.equal(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '', '');
});

test('--capacity 與 --kind 要一起給，kind 只能 fix|retro：否則 exit 2', t => {
  const { open, log } = fixture(t);
  for (const extra of [['--capacity', 'ron-skills'], ['--kind', 'fix'], ['--capacity'], ['--kind'], ['--capacity', '--kind', 'fix'], ['--capacity', 'ron-skills', '--kind', 'worker'], ['--capacity', 'session', '--kind', 'fix']]) {
    assert.equal(open(['--title', 'x', '--prompt', 'y', ...extra]).status, 2, extra.join(' '));
  }
  assert.equal(readFileSync(log, 'utf8'), '');
});

test('openCountedSession 兩個同時開、只剩一個名額：只開一個，另一個 STOP capacity', async t => {
  const { ledger, repo } = fixture(t);
  const { openCountedSession } = await import(script);
  const cli = join(repo, '..', 'orca');
  process.env.TAB_STATE_DIR = join(repo, '..', 'titles');
  t.after(() => { delete process.env.TAB_STATE_DIR; });
  const open = () => openCountedSession({ cli }, { title: 'fix', prompt: 'y', main: repo, newTab: true }, { repo: 'ron-skills', kind: 'fix', file: ledger, cap: 1 });
  const results = await Promise.all([open(), open()]);
  assert.equal(results.filter(result => result.handle && !result.stop).length, 1, JSON.stringify(results));
  assert.match(results.find(result => result.stop).stop, /^capacity 2\/1 ron-skills:fix=1 \+1$/);
  assert.match(readFileSync(ledger, 'utf8'), /^session\tron-skills\tfix\tterm_new\t/m);
});

// #622 review 2：送出後確認失敗（STOP 帶 handle）時分頁還開著，預留列換成它的 handle，由 Probe 在 terminal 結束時清掉。
test('--capacity 分頁開好但送出失敗：帳本記那個分頁的 handle，不釋出名額', t => {
  const { open, ledger } = fixture(t, { sendRejected: true });
  const result = open(['--title', 'fix', '--prompt', 'y', '--tab', '--capacity', 'ron-skills', '--kind', 'fix']);
  assert.equal(result.stdout.trim(), 'STOP send term_new');
  assert.match(readFileSync(ledger, 'utf8'), /^session\tron-skills\tfix\tterm_new\t/m);
});

test('recordFix：補記指令先 close 預留列再 open 真的 handle', () => {
  assert.equal(recordFix({ repo: 'ron-skills', kind: 'fix', handle: 'term_x', pending: 'pending:1.a' }),
    'node scripts/pilot-capacity.mjs close pending:1.a && node scripts/pilot-capacity.mjs open ron-skills fix term_x');
});
