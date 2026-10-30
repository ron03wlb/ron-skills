import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { FAST, orcaReplySource } from './helpers/fake-orca.mjs';

const script = new URL('../scripts/pilot-handoff.mjs', import.meta.url).pathname;
const SESSION = '00000000-0000-0000-0000-000000000001';
// pre-commit hook 匯出 GIT_DIR 等變數；繼承下去，腳本的 `git worktree list` 會指回本 repo 而不是 fixture。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// 主 checkout 的 coordinator 檔（pid 42），以及記錄呼叫的假 Orca CLI（回應由 helpers/fake-orca.mjs 的真實樣本長出）。
// `takeover` 為真時，假 Orca 收到送出就像新 session 跑了 /issue-pilot 的 Entry：把自己的 `pid ` 行寫進 coordinator 檔。
// `waitHangs` 為真時 `terminal wait` 永遠不回；`createDelayMs` 讓 `terminal create` 晚回（分頁已開、handle 還沒回來）。
function fixture(t, { createError = false, tuiUnsatisfied = 0, sendRejected = false, takeover = true, waitHangs = false, createDelayMs = 0 } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'pilot-handoff-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-q', repo], { env }).status, 0);
  const pilot = join(repo, '.scratch/pilot');
  mkdirSync(pilot, { recursive: true });
  const coordinator = join(pilot, 'coordinator');
  const original = 'pid 42   loop yes   since 2026-10-30T14:13:54+08:00   name ron-skills-ab\n';
  writeFileSync(coordinator, original);
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (b === 'create') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${createDelayMs});
if (b === 'create') ${createError ? `fail('create_failed')` : `reply('create', { terminal: { handle: 'term_pilot' } })`};
else if (b === 'wait' && ${waitHangs}) setInterval(() => {}, 1000);
else if (b === 'wait') reply('wait', { wait: { satisfied: (fs.readFileSync(${JSON.stringify(log)}, 'utf8').match(/terminal wait/g) || []).length > ${tuiUnsatisfied} } });
else if (b === 'send') {
  fs.appendFileSync(${JSON.stringify(log)} + '.sent', arg('--text') + '\\n');
  fs.writeFileSync(${JSON.stringify(log)} + '.coordinator', fs.readFileSync(${JSON.stringify(coordinator)}, 'utf8'));
  if (${takeover && !sendRejected}) fs.writeFileSync(${JSON.stringify(coordinator)}, 'pid 99   loop yes   since 2026-10-30T15:00:00+08:00   name ron-skills-ac\\n');
  reply('send', { send: { accepted: ${!sendRejected} } });
}
else if (b === 'close') reply('close', { close: { handle: arg('--terminal') } });
else if (b === 'read') {
  const sent = ${JSON.stringify(log)} + '.sent';
  reply('read', { terminal: { tail: [fs.existsSync(sent) ? fs.readFileSync(sent, 'utf8').trim().split('\\n').pop() : '❯'], draft: '' } });
}
`);
  chmodSync(cli, 0o755);
  const args = pid => [script, '--session', SESSION, '--pid', pid, '--reason', '已合入 2 批'];
  const options = extra => ({ cwd: repo, encoding: 'utf8', env: { ...env, ORCA_CLI_COMMAND: cli, ...FAST, PILOT_HANDOFF_WAIT_MS: '300', PILOT_HANDOFF_POLL_MS: '10', ...extra } });
  const handoff = (pid = '42', extra = {}) => spawnSync('node', args(pid), { ...options(extra), timeout: 20000 });
  // 背景執行，給要在中途送訊號的測試用。
  const start = (extra = {}) => spawn('node', args('42'), options(extra));
  return { repo, coordinator, original, log, handoff, start };
}

// 真實發生過的錯：coordinator 已換人（pid 不是呼叫者）時舊 session 照樣交接，會把新 coordinator 的 pid 行蓋掉。
test('呼叫者不是 coordinator：STOP not-coordinator，不改 coordinator 檔、不呼叫 Orca', t => {
  const { coordinator, original, log, handoff } = fixture(t);
  const result = handoff('7');
  assert.equal(result.status, 4);
  assert.match(result.stdout.trim().split('\n').pop(), /^STOP not-coordinator /);
  assert.equal(readFileSync(coordinator, 'utf8'), original);
  assert.equal(readFileSync(log, 'utf8'), '');
});

test('交接：改寫為 handoff 行、在主 checkout 開分頁並送出 /loop /issue-pilot，等新 session 寫入 pid 行才 HANDED_OFF', t => {
  const { repo, coordinator, log, handoff } = fixture(t);
  const result = handoff();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'HANDED_OFF term_pilot');
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.startsWith(`terminal create --worktree path:${repo} --title issue-pilot coordinator --command claude --json\n`), calls);
  assert.match(calls, /^terminal wait --terminal term_pilot --for tui-idle /m);
  assert.match(calls, /^terminal send --terminal term_pilot --text \/loop \/issue-pilot --enter --json$/m);
  assert.doesNotMatch(calls, /terminal split/);
  assert.match(readFileSync(coordinator, 'utf8'), /^pid 99 /);
});

test('coordinator 檔有多行：STOP not-coordinator 仍是單獨的最後一行', t => {
  const { coordinator, handoff } = fixture(t);
  writeFileSync(coordinator, 'pid 7   loop yes\nname other\n');
  const lines = handoff().stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^STOP not-coordinator pid 7   loop yes \/ name other$/);
});

test('沒有 coordinator 檔：STOP not-coordinator，不建檔、不呼叫 Orca', t => {
  const { coordinator, log, handoff } = fixture(t);
  rmSync(coordinator);
  const result = handoff();
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout.trim(), /^STOP not-coordinator/);
  assert.equal(existsSync(coordinator), false);
  assert.equal(readFileSync(log, 'utf8'), '');
});

test('送出時 coordinator 檔已是 handoff 行（不含 pid 欄），新 session 才會視為無人占用', t => {
  const { log, handoff } = fixture(t);
  assert.equal(handoff().status, 0);
  const seen = readFileSync(log + '.coordinator', 'utf8');
  assert.match(seen, new RegExp(`^handoff   from-session ${SESSION}   from-pid 42   at \\S+   reason 已合入 2 批\\n$`));
});

for (const [name, options, cause, opened] of [
  ['create 失敗', { createError: true }, /^STOP create create_failed$/, false],
  ['兩輪 TUI 都未就緒', { tuiUnsatisfied: 2 }, /^STOP tui-timeout term_pilot$/, true],
  ['send 被拒', { sendRejected: true }, /^STOP send term_pilot$/, true],
  ['新 session 沒寫入 pid 行', { takeover: false }, /^STOP pid-timeout term_pilot$/, true],
]) {
  // 開出來的分頁不關，`/loop /issue-pilot` 之後仍可能接手，與照常繼續的舊 coordinator 同時活著。
  test(`${name}：STOP、還原 coordinator 檔${opened ? '、關掉新開的分頁' : ''}`, t => {
    const { coordinator, original, log, handoff } = fixture(t, options);
    const result = handoff();
    assert.equal(result.status, 4);
    assert.match(result.stdout.trim(), cause);
    assert.equal(readFileSync(coordinator, 'utf8'), original);
    assert.equal(/^terminal close --terminal term_pilot --json$/m.test(readFileSync(log, 'utf8')), opened);
  });
}

// 真實發生過的錯：腳本一路同步等到底，最壞約 15 分鐘，超過 Bash 工具 600 秒上限；被殺時 coordinator 停在 handoff 行，不還原也不印 STOP。
test('總時間超過上限（新 session 一直沒寫 pid 行）：STOP timeout、還原 coordinator 檔、關掉新開的分頁', t => {
  const { coordinator, original, log, handoff } = fixture(t, { takeover: false });
  const result = handoff('42', { PILOT_HANDOFF_WAIT_MS: '600000', PILOT_HANDOFF_BUDGET_MS: '1500' });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), 'STOP timeout');
  assert.equal(readFileSync(coordinator, 'utf8'), original);
  assert.match(readFileSync(log, 'utf8'), /^terminal close --terminal term_pilot --json$/m);
});

test('等 TUI 時 Orca 卡住：預算到了殺掉它、STOP timeout、還原並關掉分頁', t => {
  const { coordinator, original, log, handoff } = fixture(t, { waitHangs: true });
  const result = handoff('42', { SESSION_TUI_WAIT_MS: '120000', PILOT_HANDOFF_BUDGET_MS: '1500' });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), 'STOP timeout');
  assert.equal(readFileSync(coordinator, 'utf8'), original);
  assert.match(readFileSync(log, 'utf8'), /^terminal close --terminal term_pilot --json$/m);
});

// 中止若殺掉進行中的 create，Orca 可能已開好分頁卻沒回 handle，分頁就關不掉、一直跑著 claude。
test('預算在 terminal create 進行中用完：等 create 回來再關掉分頁、STOP timeout', t => {
  const { coordinator, original, log, handoff } = fixture(t, { createDelayMs: 1000 });
  const result = handoff('42', { PILOT_HANDOFF_BUDGET_MS: '300' });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), 'STOP timeout');
  assert.equal(readFileSync(coordinator, 'utf8'), original);
  assert.match(readFileSync(log, 'utf8'), /^terminal close --terminal term_pilot --json$/m);
});

for (const name of ['SIGTERM', 'SIGINT']) {
  test(`等新 session 時收到 ${name}：STOP signal ${name}、還原 coordinator 檔、關掉新開的分頁`, async t => {
    const { coordinator, original, log, start } = fixture(t, { takeover: false });
    const child = start({ PILOT_HANDOFF_WAIT_MS: '600000' });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const deadline = Date.now() + 10000;
    while (!existsSync(log + '.sent')) {
      assert.ok(Date.now() < deadline, '10 秒內沒有送出');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    child.kill(name);
    const [status] = await once(child, 'exit');
    assert.equal(status, 4);
    assert.equal(stdout.trim().split('\n').pop(), `STOP signal ${name}`);
    assert.equal(readFileSync(coordinator, 'utf8'), original);
    assert.match(readFileSync(log, 'utf8'), /^terminal close --terminal term_pilot --json$/m);
  });
}

test('用法錯誤 exit 2', t => {
  const { repo } = fixture(t);
  const run = args => spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, ORCA_CLI_COMMAND: 'x' } });
  assert.equal(run(['--session', SESSION]).status, 2);
  assert.equal(run(['--session', SESSION, '--pid', 'abc', '--reason', 'x']).status, 2);
});
