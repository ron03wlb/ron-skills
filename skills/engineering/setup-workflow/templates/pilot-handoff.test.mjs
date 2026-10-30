import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./pilot-handoff.mjs', import.meta.url).pathname;
const SESSION = '00000000-0000-0000-0000-000000000001';
// pre-commit hook 匯出 GIT_DIR 等變數；繼承下去，腳本的 `git worktree list` 會指回本 repo 而不是 fixture。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// 主 checkout 的 coordinator 檔（pid 42），以及記錄呼叫的假 Orca CLI（回應由 test/fake-orca.mjs 的真實樣本長出）。
// `takeover` 為真時，假 Orca 收到送出就像新 session 跑了 /issue-pilot 的 Entry：把自己的 `pid ` 行寫進 coordinator 檔；
// `sendRejected` 時通常不寫，`lateTakeover` 為真時仍寫（Orca 回報拒收，prompt 其實已經送進去）。
// `waitHangs` 為真時 `terminal wait` 永遠不回；`createDelayMs` 讓 `terminal create` 晚回（分頁已開、handle 還沒回來）；
// `orphanLate` 為真時 `terminal list` 看不到 create 開的分頁（create 被殺時 Orca 還沒建好）。
// 主 checkout 另有既有 session（`--to` 的對象）：term_peer（標題 ron-skills-peer）、兩個標題都是 twin 的分頁；
// 別的 repo 也有一個標題 ron-skills-peer 的分頁，`--to` 不能選到它。`terminal list --worktree path:<p>` 只回那個 worktree 的分頁。
function fixture(t, { createError = false, tuiUnsatisfied = 0, sendRejected = false, takeover = true, lateTakeover = false, waitHangs = false, createDelayMs = 0, orphanLate = false } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-handoff-'));
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
  if (${takeover && (!sendRejected || lateTakeover)}) fs.writeFileSync(${JSON.stringify(coordinator)}, 'pid 99   loop yes   since 2026-10-30T15:00:00+08:00   name ron-skills-ac\\n');
  reply('send', { send: { accepted: ${!sendRejected} } });
}
else if (b === 'close') reply('close', { close: { handle: arg('--terminal') } });
else if (b === 'list') {
  // 主 checkout 原有現任 coordinator 的分頁（標題同名，還沒被 Claude 改名）；create 開出分頁後，另有一個人剛開、標題不同的分頁。
  const opened = ${!createError && !orphanLate} && /^terminal create /m.test(fs.readFileSync(${JSON.stringify(log)}, 'utf8'));
  const here = [['term_current', 'issue-pilot coordinator'], ['term_peer', 'ron-skills-peer'], ['term_twin1', 'twin'], ['term_twin2', 'twin'],
    ...(opened ? [['term_pilot', 'issue-pilot coordinator'], ['term_other', 'ron@Ron-NB: ~/code/ron-skills']] : [])];
  const all = [...here.map(([handle, title]) => ({ handle, title, worktreePath: ${JSON.stringify(repo)} })), { handle: 'term_far', title: 'ron-skills-peer', worktreePath: '/elsewhere/repo' }];
  const scope = process.argv.includes('--worktree') ? arg('--worktree').replace(/^path:/, '') : null;
  const terminals = all.filter(terminal => !scope || terminal.worktreePath === scope);
  reply('list', { terminals, totalCount: terminals.length });
}
else if (b === 'read') {
  const sent = ${JSON.stringify(log)} + '.sent';
  reply('read', { terminal: { tail: [fs.existsSync(sent) ? fs.readFileSync(sent, 'utf8').trim().split('\\n').pop() : '❯'], draft: '' } });
}
`);
  chmodSync(cli, 0o755);
  const args = (pid, more = []) => [script, '--session', SESSION, '--pid', pid, '--reason', '已合入 2 批', ...more];
  const options = extra => ({ cwd: repo, encoding: 'utf8', env: { ...env, ORCA_CLI_COMMAND: cli, ...FAST, PILOT_HANDOFF_WAIT_MS: '300', PILOT_HANDOFF_POLL_MS: '10', ORCA_TERMINAL_HANDLE: '', ...extra } });
  const handoff = (pid = '42', extra = {}, more = []) => spawnSync('node', args(pid, more), { ...options(extra), timeout: 30000 });
  // 背景執行，給要在中途送訊號的測試用。
  const start = (extra = {}) => spawn('node', args('42'), options(extra));
  return { repo, coordinator, original, sessions: join(pilot, 'sessions.md'), log, handoff, start };
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
  assert.ok(calls.startsWith(`terminal list --worktree path:${repo} --json\nterminal create --worktree path:${repo} --title issue-pilot coordinator --command claude --json\n`), calls);
  assert.match(calls, /^terminal wait --terminal term_pilot --for tui-idle /m);
  assert.match(calls, /^terminal send --terminal term_pilot --text \/loop \/issue-pilot --enter --json$/m);
  assert.doesNotMatch(calls, /terminal split/);
  assert.match(readFileSync(coordinator, 'utf8'), /^pid 99 /);
});

// spay2 版在 script 內附加 sessions.md；ron-skills 版要 coordinator 在 HANDED_OFF 之後手動附加，漏了 `/retro` 就找不到交接。
test('交接完成：在 sessions.md 附加 handoff 行（保留既有行），stderr 提醒停掉 watcher', t => {
  const { sessions, handoff } = fixture(t);
  const start = '2026-10-30T20:43:33+08:00   session 00000000-0000-0000-0000-000000000001   pid 42   ron-skills-ab\n';
  writeFileSync(sessions, start);
  const result = handoff();
  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(sessions, 'utf8').split('\n');
  assert.equal(lines[0] + '\n', start);
  assert.match(lines[1], new RegExp(`^\\S+   handoff from-session ${SESSION} → terminal term_pilot   reason 已合入 2 批$`));
  assert.equal(lines[2], '');
  assert.match(result.stderr, /watcher/);
});

test('STOP 時不附加 sessions.md：提早記 handoff 會讓 STOP 後的自己誤判退役', t => {
  const { sessions, handoff } = fixture(t, { sendRejected: true });
  assert.equal(handoff().status, 4);
  assert.equal(existsSync(sessions), false);
});

// held-merge 是可選的 hook：adapter 指定了「整合分支合併進行中」的檢查指令才跑（spay2 有，ron-skills 沒有）；沒帶 --held-check 時照常交接（見上面的交接測試）。
// 指令 exit 0 表示合併進行中、1 表示沒有，其他 exit code 無法判斷，一律不交接。
for (const [name, check, cause] of [
  ['回報合併中', 'echo batch-3 合併中; exit 0', /^STOP held-merge batch-3 合併中$/],
  ['無法判斷', 'exit 3', /^STOP held-check exit 3$/],
  ['被訊號殺掉', 'kill -TERM $$', /^STOP held-check signal SIGTERM$/],
]) {
  test(`--held-check ${name}：STOP，不改 coordinator 檔、不開分頁`, t => {
    const { coordinator, original, log, handoff } = fixture(t);
    const result = handoff('42', {}, ['--held-check', check]);
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stdout.trim().split('\n').pop(), cause);
    assert.equal(readFileSync(coordinator, 'utf8'), original);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /terminal create/);
  });
}

test('--held-check 回報沒有合併：照常 HANDED_OFF，指令在主 checkout 執行', t => {
  const { repo, handoff } = fixture(t);
  const result = handoff('42', {}, ['--held-check', 'pwd > held-cwd; exit 1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'HANDED_OFF term_pilot');
  assert.equal(readFileSync(join(repo, 'held-cwd'), 'utf8').trim(), repo);
});

// spay2 的 `--to <name|handle>`：交給已經開著的 session，不開新分頁；只找本 repo（任一 worktree）的分頁，handle 或標題完全相同才算。
for (const target of ['term_peer', 'ron-skills-peer']) {
  test(`--to ${target}：送 /loop /issue-pilot 給既有 session、不開新分頁，HANDED_OFF term_peer 並記進 sessions.md`, t => {
    const { coordinator, sessions, log, handoff } = fixture(t);
    const result = handoff('42', {}, ['--to', target]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'HANDED_OFF term_peer');
    const calls = readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /terminal (create|split|close) /);
    assert.match(calls, /^terminal send --terminal term_peer --text \/loop \/issue-pilot --enter --json$/m);
    assert.match(readFileSync(coordinator, 'utf8'), /^pid 99 /);
    assert.match(readFileSync(sessions, 'utf8'), /handoff from-session \S+ → terminal term_peer   reason /);
  });
}

for (const [name, to, extra, reason, cause] of [
  ['找不到', 'nobody', {}, 'to-not-found', /^STOP to-not-found nobody$/],
  ['標題對到兩個分頁', 'twin', {}, 'to-ambiguous', /^STOP to-ambiguous twin term_twin1 term_twin2$/],
  ['對象是自己的分頁', 'term_peer', { ORCA_TERMINAL_HANDLE: 'term_peer' }, 'to-self', /^STOP to-self term_peer$/],
  ['對象是 coordinator 檔裡自己的名字', 'ron-skills-ab', {}, 'to-self', /^STOP to-self ron-skills-ab$/],
]) {
  test(`--to ${name}：${reason}，不改 coordinator 檔、不送出`, t => {
    const { coordinator, original, log, handoff } = fixture(t);
    const result = handoff('42', extra, ['--to', to]);
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stdout.trim().split('\n').pop(), cause);
    assert.equal(readFileSync(coordinator, 'utf8'), original);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /terminal (create|send) /);
  });
}

// 既有 session 不是這次開的，失敗時不能關掉它。
test('--to 對象沒寫入 pid 行：STOP pid-timeout、還原 coordinator 檔、不關對象的分頁', t => {
  const { coordinator, original, log, handoff } = fixture(t, { takeover: false });
  const result = handoff('42', {}, ['--to', 'term_peer']);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), 'STOP pid-timeout term_peer');
  assert.equal(readFileSync(coordinator, 'utf8'), original);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /terminal close /);
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
  // 開出來的分頁要關：留著的話 `/loop /issue-pilot` 之後仍可能接手，與照常繼續的舊 coordinator 同時活著。
  test(`${name}：STOP、還原 coordinator 檔${opened ? '、關掉新開的分頁' : ''}`, t => {
    const { coordinator, original, log, handoff } = fixture(t, options);
    const result = handoff();
    assert.equal(result.status, 4);
    assert.match(result.stdout.trim(), cause);
    assert.equal(readFileSync(coordinator, 'utf8'), original);
    assert.equal(/^terminal close --terminal term_pilot --json$/m.test(readFileSync(log, 'utf8')), opened);
  });
}

// 新 session 已寫入自己的 pid 行之後才 STOP（Orca 回報拒收，prompt 其實已送進去）：還原會把新 coordinator 蓋掉，所以不還原。
test('STOP 時 coordinator 檔已是新 session 的 pid 行：不還原、不蓋掉它', t => {
  const { coordinator, handoff } = fixture(t, { sendRejected: true, lateTakeover: true });
  const result = handoff();
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout.trim(), /^STOP send term_pilot/);
  assert.match(readFileSync(coordinator, 'utf8'), /^pid 99 /);
});

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

// 真實發生過的錯：每步寫死 10 秒，WSL 上 `terminal create` 常超過 10 秒，handoff 第一步就 STOP create The operation was aborted。
test('terminal create 花 15 秒：預設上限內，照常 HANDED_OFF', t => {
  const { handoff } = fixture(t, { createDelayMs: 15000 });
  const result = handoff();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), 'HANDED_OFF term_pilot');
});

// #22 審查 P3：create 逾時被殺時 Orca 可能已開好分頁卻沒回 handle；從 `terminal list` 找回來關掉。
// 只關 create 之後才出現、標題相符的分頁：同名的既有分頁（現任 coordinator）和標題不同的新分頁都不碰，後者列在 STOP 原因裡。
test('terminal create 超過上限：STOP create、還原 coordinator 檔、關掉用標題找到的新分頁', t => {
  const { repo, coordinator, original, log, handoff } = fixture(t, { createDelayMs: 2000 });
  const result = handoff('42', { PILOT_HANDOFF_CREATE_MS: '300' });
  assert.equal(result.status, 4, result.stderr);
  const last = result.stdout.trim().split('\n').pop();
  assert.match(last, /^STOP create /);
  assert.match(last, /term_other/);
  assert.equal(readFileSync(coordinator, 'utf8'), original);
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.startsWith(`terminal list --worktree path:${repo} --json\nterminal create `), calls);
  assert.match(calls, /^terminal close --terminal term_pilot --json$/m);
  assert.doesNotMatch(calls, /^terminal close --terminal term_(current|other) /m);
});

// 審查 P2：create 被殺時 Orca 可能還在建分頁，list 看不到；什麼都沒關時 STOP 原因仍要提醒人去確認，分頁才不會無聲地留著。
test('terminal create 超過上限、list 還看不到分頁：STOP create 附上請人確認的提醒', t => {
  const { coordinator, original, log, handoff } = fixture(t, { createDelayMs: 2000, orphanLate: true });
  const result = handoff('42', { PILOT_HANDOFF_CREATE_MS: '300' });
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout.trim().split('\n').pop(), /^STOP create .*請確認有沒有留下標題 issue-pilot coordinator 或剛由 create 開出的分頁/);
  assert.equal(readFileSync(coordinator, 'utf8'), original);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /^terminal close /m);
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
  assert.equal(run(['--session', SESSION, '--pid', '42', '--reason', 'x', '--to']).status, 2);
  assert.equal(run(['--session', SESSION, '--pid', '42', '--reason', 'x', '--held-check']).status, 2);
});
