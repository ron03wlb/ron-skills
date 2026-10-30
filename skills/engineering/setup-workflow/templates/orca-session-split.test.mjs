import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { repoFixture, run, source } from './test/repo-fixture.mjs';

const script = join(source, 'orca-session-split.mjs');

// 記錄呼叫的假 Orca CLI（回應由 test/fake-orca.mjs 的真實樣本長出）。
function fixture(t, { self, sendRejected = false, swallow = 0, waitError = false } = {}) {
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
else if (b === 'create') reply('create', { terminal: { handle: 'term_new' } });
else if (b === 'wait') ${waitError ? `fail('runtime_unavailable')` : `reply('wait', { wait: { satisfied: true } })`};
else if (b === 'send') { fs.appendFileSync(sentFile, arg('--text') + '\\n'); reply('send', { send: { accepted: ${!sendRejected} } }); }
else if (b === 'read') reply('read', { terminal: { tail: sent().length > ${swallow} ? [sent().pop()] : ['❯'] } });
`);
  chmodSync(cli, 0o755);
  const open = args => run(repo, ['node', script, ...args], { env: { ORCA_CLI_COMMAND: cli, ...FAST, ORCA_TERMINAL_HANDLE: self ?? '' } });
  return { repo, log, open };
}

test('在 Orca pane 內：split 在呼叫者旁邊、命名、送出 prompt 且不帶 --wait-submit', t => {
  const { log, open } = fixture(t, { self: 'term_self' });
  const result = open(['--title', '#12 交付', '--prompt', '/issue-run 12']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'OPENED term_split');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /terminal split --terminal term_self --direction vertical --command claude/);
  assert.match(calls, /terminal rename --terminal term_split --title #12 交付/);
  assert.match(calls, /terminal send --terminal term_split --text \/issue-run 12 --enter --json\n/);
  assert.doesNotMatch(calls, /terminal create|--wait-submit/);
});

test('不在 Orca pane 內：在主 checkout 新開 terminal', t => {
  const { repo, log, open } = fixture(t);
  assert.equal(open(['--title', 'x', '--prompt', 'y']).stdout.trim(), 'OPENED term_new');
  assert.match(readFileSync(log, 'utf8'), new RegExp(`terminal create --worktree path:${repo} --title x --command claude`));
});

test('--tab：即使在 pane 內也在主 checkout 新開分頁，不 split', t => {
  const { repo, log, open } = fixture(t, { self: 'term_self' });
  assert.equal(open(['--title', 'x', '--prompt', 'y', '--tab']).stdout.trim(), 'OPENED term_new');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, new RegExp(`terminal create --worktree path:${repo} --title x --command claude`));
  assert.doesNotMatch(calls, /terminal split/);
});

test('--worktree：在指定 worktree 新開分頁，不 split；stdout 只有 OPENED 一行', t => {
  const { log, open } = fixture(t, { self: 'term_self' });
  assert.equal(open(['--title', 'fix-x', '--prompt', 'y', '--worktree', '/w/fix-x']).stdout, 'OPENED term_new\n');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /terminal create --worktree path:\/w\/fix-x --title fix-x --command claude/);
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
