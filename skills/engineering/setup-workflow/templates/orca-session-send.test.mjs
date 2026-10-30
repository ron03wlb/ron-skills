import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./orca-session-send.mjs', import.meta.url).pathname;

// 記錄呼叫的假 Orca CLI（回應由 test/fake-orca.mjs 的真實樣本長出）；`swallow` 次送出不出現在畫面上，`busy` 次 wait 不成立；
// `draft` 為第一次送出前 composer 已有的文字（undefined 沿用樣本值、null 回應不帶 `draft` 欄位，如 composer 為空的真實輸出），
// 送出 Enter 後連同送出的文字一起出現在畫面上。
// `stuck` 次送出的文字進了輸入框卻沒提交：畫面最後一行是輸入框裡的 prompt，draft 也還是它。
function fixture(t, { busy = 0, sendRejected = false, swallow = 0, stale = false, draft, stuck = 0 } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'orca-session-send-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
const sentFile = ${JSON.stringify(log)} + '.sent'; const sent = () => fs.existsSync(sentFile) ? fs.readFileSync(sentFile, 'utf8').split('\\n').slice(0, -1) : [];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (${stale}) { fail('terminal_handle_stale'); process.exit(1); }
if (b === 'wait') reply('wait', { wait: { satisfied: (fs.readFileSync(${JSON.stringify(log)}, 'utf8').match(/terminal wait/g) || []).length > ${busy} } });
else if (b === 'send') { fs.appendFileSync(sentFile, arg('--text') + '\\n'); reply('send', { send: { accepted: ${!sendRejected} } }); }
else if (b === 'read' && sent().length && sent().length <= ${stuck}) reply('read', { terminal: { tail: ['● 先前的報告', '> ' + sent()[0]], draft: sent()[0] } });
else if (b === 'read') {
  const draft = ${JSON.stringify(draft ?? '')};
  const typed = sent().length ? draft + (sent().filter(Boolean).pop() ?? '') : '';
  const terminal = { tail: ['● 先前的報告', sent().length > ${swallow} ? '> ' + typed : '❯'] };
  if (${draft === null}) {
    const result = mergeSample(ORCA_SAMPLES.read, { terminal }, 'read');
    delete result.terminal.draft;
    console.log(JSON.stringify({ ok: true, result }));
  } else reply('read', { terminal: ${draft === undefined} ? terminal : { ...terminal, draft: sent().length ? '' : draft } });
}
`);
  chmodSync(cli, 0o755);
  const send = args => spawnSync('node', [script, ...args], { cwd: temp, encoding: 'utf8', env: { ...process.env, ORCA_CLI_COMMAND: cli, ...FAST } });
  return { log, send };
}

const PROMPT = '/issue-run 22 --worker /repo/.scratch/batch-20-22.md';

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

// 真實發生過的錯：裸 `terminal send` 回 accepted、文字卻沒提交，重送又黏成兩份。
test('送出被吞：讀畫面確認後重送；三次都被吞 STOP send', t => {
  const late = fixture(t, { swallow: 1 });
  assert.equal(late.send(['--terminal', 'term_w', '--prompt', PROMPT]).stdout.trim(), 'SENT term_w');
  assert.equal(readFileSync(late.log, 'utf8').match(/terminal send/g).length, 2);
  const result = fixture(t, { swallow: 3 }).send(['--terminal', 'term_w', '--prompt', PROMPT]);
  assert.equal(result.status, 4);
  assert.equal(result.stdout.trim(), 'STOP send term_w');
});

// 真實發生過的錯：先前裸 `terminal send` 留下未提交的同一段 prompt，第一次就送整段，worker 收到黏成兩份。
test('送出前 composer 已有同一段 prompt：第一次只補 Enter，不黏成兩份；stderr 印 DRAFT_SUBMIT <handle>', t => {
  const { log, send } = fixture(t, { draft: PROMPT });
  const result = send(['--terminal', 'term_w', '--prompt', PROMPT]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'SENT term_w');
  const sends = readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('terminal send '));
  assert.deepEqual(sends, ['terminal send --terminal term_w --text  --enter --json']);
  assert.match(result.stderr, /^DRAFT_SUBMIT term_w$/m);
  assert.doesNotMatch(result.stderr, /batch-20-22/);
});

test('draft 為空、缺省或與 prompt 無關：送整段 prompt，不印 DRAFT_SUBMIT', t => {
  for (const draft of ['', null, undefined]) {
    const { log, send } = fixture(t, { draft });
    const result = send(['--terminal', 'term_w', '--prompt', PROMPT]);
    assert.equal(result.stdout.trim(), 'SENT term_w');
    assert.ok(readFileSync(log, 'utf8').includes(`terminal send --terminal term_w --text ${PROMPT} --enter --json\n`));
    assert.doesNotMatch(result.stderr, /DRAFT_SUBMIT/);
  }
});

// 曾發生的失敗模式：文字停在輸入框沒提交。畫面上輸入框那一行含 prompt，不能當成已送達。
test('文字進了輸入框卻沒提交：不算送達，只補 Enter 一次後才 SENT', t => {
  const { log, send } = fixture(t, { stuck: 1 });
  const result = send(['--terminal', 'term_w', '--prompt', PROMPT]);
  assert.equal(result.stdout.trim(), 'SENT term_w');
  const sends = readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('terminal send '));
  assert.deepEqual(sends, [`terminal send --terminal term_w --text ${PROMPT} --enter --json`, 'terminal send --terminal term_w --text  --enter --json']);
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
