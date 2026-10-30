import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAST, orcaReplySource } from './helpers/fake-orca.mjs';

const script = new URL('../scripts/orca-session-send.mjs', import.meta.url).pathname;

// 記錄呼叫的假 Orca CLI（回應由 helpers/fake-orca.mjs 的真實樣本長出）；`swallow` 次送出不出現在畫面上，`busy` 次 wait 不成立。
function fixture(t, { busy = 0, sendRejected = false, swallow = 0, stale = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'orca-session-send-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
const sentFile = ${JSON.stringify(log)} + '.sent'; const sent = () => fs.existsSync(sentFile) ? fs.readFileSync(sentFile, 'utf8').trim().split('\\n') : [];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (${stale}) { fail('terminal_handle_stale'); process.exit(1); }
if (b === 'wait') reply('wait', { wait: { satisfied: (fs.readFileSync(${JSON.stringify(log)}, 'utf8').match(/terminal wait/g) || []).length > ${busy} } });
else if (b === 'send') { fs.appendFileSync(sentFile, arg('--text') + '\\n'); reply('send', { send: { accepted: ${!sendRejected} } }); }
else if (b === 'read') reply('read', { terminal: { tail: ['● 先前的報告', sent().length > ${swallow} ? '> ' + sent().pop() : '❯'] } });
`);
  chmodSync(cli, 0o755);
  const send = args => spawnSync('node', [script, ...args], { cwd: temp, encoding: 'utf8', env: { ...process.env, ORCA_CLI_COMMAND: cli, ...FAST } });
  return { log, send };
}

const PROMPT = '/issue-run 22 --worker /home/ron/code/ron-skills/.scratch/pilot/batch-20-22.md';

test('等 TUI 閒置、送出並讀畫面確認：SENT <handle>，不開新 terminal、不帶 --wait-submit', t => {
  const { log, send } = fixture(t);
  const result = send(['--terminal', 'term_w', '--prompt', PROMPT]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'SENT term_w');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /^terminal wait --terminal term_w --for tui-idle /m);
  assert.ok(calls.includes(`terminal send --terminal term_w --text ${PROMPT} --enter --json\n`), calls);
  assert.match(calls, /terminal read --terminal term_w/);
  assert.doesNotMatch(calls, /terminal (create|split|close)|--wait-submit/);
});

test('第一輪仍忙碌時再等一輪；兩輪都忙碌 STOP tui-timeout，不送出', t => {
  assert.equal(fixture(t, { busy: 1 }).send(['--terminal', 'term_w', '--prompt', PROMPT]).stdout.trim(), 'SENT term_w');
  const { log, send } = fixture(t, { busy: 2 });
  const result = send(['--terminal', 'term_w', '--prompt', PROMPT]);
  assert.equal(result.status, 4);
  assert.equal(result.stdout.trim(), 'STOP tui-timeout term_w');
  assert.doesNotMatch(readFileSync(log, 'utf8'), /terminal send/);
});

// 真實發生過的錯：裸 `terminal send` 回 accepted、文字卻沒提交，重送又黏成兩份（adapter Dispatch 第 3 步）。
test('送出被吞：讀畫面確認後重送；三次都被吞 STOP send', t => {
  const late = fixture(t, { swallow: 1 });
  assert.equal(late.send(['--terminal', 'term_w', '--prompt', PROMPT]).stdout.trim(), 'SENT term_w');
  assert.equal(readFileSync(late.log, 'utf8').match(/terminal send/g).length, 2);
  const result = fixture(t, { swallow: 3 }).send(['--terminal', 'term_w', '--prompt', PROMPT]);
  assert.equal(result.status, 4);
  assert.equal(result.stdout.trim(), 'STOP send term_w');
});

test('send 被拒：STOP send；handle 失效：STOP orca <錯誤碼>', t => {
  assert.equal(fixture(t, { sendRejected: true }).send(['--terminal', 'term_w', '--prompt', PROMPT]).stdout.trim(), 'STOP send term_w');
  const stale = fixture(t, { stale: true }).send(['--terminal', 'term_gone', '--prompt', PROMPT]);
  assert.equal(stale.status, 4);
  assert.equal(stale.stdout.trim(), 'STOP orca terminal_handle_stale');
});

test('用法錯誤 exit 2', t => {
  const { send } = fixture(t);
  assert.equal(send(['--terminal', 'term_w']).status, 2);
  assert.equal(send(['--prompt', PROMPT]).status, 2);
  assert.equal(send(['--terminal', 'term_w', '--prompt', PROMPT, '--tab']).status, 2);
});
