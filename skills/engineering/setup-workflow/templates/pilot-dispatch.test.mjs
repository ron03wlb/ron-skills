import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./pilot-dispatch.mjs', import.meta.url).pathname;
// pre-commit hook 匯出 GIT_DIR 等變數；繼承下去，腳本的 git 會指回本 repo 而不是 fixture。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// 主 checkout（有 pilot/integration）與記錄呼叫的假 Orca CLI。`worktree create` 依 `modes[<n>]`：
//   ok      建好 worktree、回 ok:true；
//   late    建好 worktree，卻回 ok:false（2026-10-30 實際發生：worktree 已建好、create 回 "ok": false）；
//   fail    回 ok:false、不建 worktree；
//   bare    同 ok，另把主 checkout 設成 bare（Orca 從 WSL 建 worktree 的副作用）。
// `guard` 是專案自備 Bare guard（pilot-unbare.sh）的內容：有給時把 dispatch 與它的相依複製到暫存的 scripts/，guard 放在旁邊。
// 每次呼叫都把 stdin 讀光並記下讀到幾個位元組：Orca CLI 會吃掉 stdin，`while read` 迴圈因此只派到第一個成員。
// `waitHangs` 為真時 `terminal wait` 永遠不回。
function fixture(t, { modes = {}, waitHangs = false, guard } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-dispatch-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'branch', 'pilot/integration');
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const root = join(temp, 'workspaces');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2); const [a, b] = args; const arg = k => args[args.indexOf(k) + 1];
let stdin = 0; try { stdin = fs.readFileSync(0).length; } catch {}
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
fs.appendFileSync(${JSON.stringify(log)} + '.stdin', stdin + '\\n');
${orcaReplySource()}
const modes = ${JSON.stringify(modes)};
if (a === 'worktree' && b === 'create') {
  const n = arg('--issue'); const mode = modes[n] ?? 'ok'; const path = ${JSON.stringify(root)} + '/' + arg('--name');
  if (mode !== 'fail') execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'add', '-q', '-b', arg('--branch'), path, arg('--base-branch')], { stdio: 'ignore' });
  if (mode === 'bare') execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'config', 'core.bare', 'true']);
  if (mode === 'ok' || mode === 'bare') console.log(JSON.stringify({ ok: true, result: { worktree: { path } } }));
  else fail(mode === 'late' ? 'request_timeout' : 'invalid_argument');
}
else if (b === 'create') reply('create', { terminal: { handle: 'term_' + arg('--title').slice(1) } });
else if (b === 'wait' && ${waitHangs}) setInterval(() => {}, 1000);
else if (b === 'wait') reply('wait', { wait: { satisfied: true } });
else if (b === 'send') { fs.appendFileSync(${JSON.stringify(log)} + '.sent', arg('--text') + '\\n'); reply('send', { send: { accepted: true } }); }
else if (b === 'read') {
  const sent = ${JSON.stringify(log)} + '.sent';
  reply('read', { terminal: { tail: [fs.existsSync(sent) ? fs.readFileSync(sent, 'utf8').trim().split('\\n').pop() : '❯'], draft: '' } });
}
else fail('unknown');
`);
  chmodSync(cli, 0o755);
  let dispatchScript = script;
  if (guard !== undefined) {
    const scripts = join(temp, 'scripts');
    mkdirSync(scripts);
    for (const name of ['pilot-dispatch.mjs', 'orca-session-send.mjs', 'orca-worktree-create.mjs']) copyFileSync(new URL(`./${name}`, import.meta.url), join(scripts, name));
    writeFileSync(join(scripts, 'pilot-unbare.sh'), guard);
    chmodSync(join(scripts, 'pilot-unbare.sh'), 0o755);
    dispatchScript = join(scripts, 'pilot-dispatch.mjs');
  }
  const dispatch = (args, extra = {}) => spawnSync('node', [dispatchScript, ...args], {
    cwd: repo, encoding: 'utf8', input: 'leftover-line\nanother-line\n', timeout: 60000,
    env: { ...env, ORCA_CLI_COMMAND: cli, ORCA_BIN: '', ...FAST, ...extra },
  });
  const checkpoint = key => readFileSync(join(repo, `.scratch/pilot/batch-${key}.md`), 'utf8');
  const calls = () => readFileSync(log, 'utf8');
  const sent = () => (existsSync(`${log}.sent`) ? readFileSync(`${log}.sent`, 'utf8') : '');
  return { repo, root, log, dispatch, checkpoint, calls, sent };
}

const lines = result => result.stdout.trim().split('\n');

test('create 回 ok:false 但 worktree 已建好：以目錄與 git worktree list 為準，照樣派出', t => {
  const { repo, root, dispatch, calls, sent } = fixture(t, { modes: { 46: 'late' } });
  const result = dispatch(['46', '46:pilot-dispatch']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result).pop(), 'DISPATCHED 46 term_46');
  assert.match(calls(), /^worktree create --name issue-46 --base-branch pilot\/integration --branch issue\/46-pilot-dispatch --issue 46 --json$/m);
  assert.match(calls(), new RegExp(`^terminal create --worktree path:${root}/issue-46 --title #46 --command claude --json$`, 'm'));
  assert.equal(sent().trim(), `/issue-run 46 --worker ${repo}/.scratch/pilot/batch-46.md`);
});

test('create 失敗而且沒有目錄：STOP create，不開分頁；其他成員照樣派出', t => {
  const { dispatch, calls } = fixture(t, { modes: { 46: 'fail' } });
  const result = dispatch(['23-46', '46:pilot-dispatch', '23:pilot-probe']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP 46 create orca worktree create：invalid_argument', 'DISPATCHED 23 term_23']);
  assert.doesNotMatch(calls(), /terminal create .* --title #46 /);
});

// 重現 2026-10-30：在 `while read` 迴圈裡呼叫 orca-ide，它把 stdin 讀光，迴圈只派到第一個成員。
test('Orca CLI 會把 stdin 讀光：第二個成員仍然派出，每個子行程讀到的 stdin 都是空的', t => {
  const { log, dispatch } = fixture(t);
  const result = dispatch(['23-46', '23:pilot-probe', '46:pilot-dispatch']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['DISPATCHED 23 term_23', 'DISPATCHED 46 term_46']);
  assert.deepEqual([...new Set(readFileSync(`${log}.stdin`, 'utf8').trim().split('\n'))], ['0']);
});

// 專案的 guard 通常還會在 decisions.md 記一列；這裡的替身只還原、印出收到的時機。
test('create 把主 checkout 設成 bare：先跑 Bare guard（時機 dispatch #<n>）、轉印它的輸出，照樣派出', t => {
  const { repo, dispatch } = fixture(t, { modes: { 46: 'bare' }, guard: '#!/bin/sh\ngit -C "$1" config core.bare false\necho "UNBARE $1 $2"\n' });
  const result = dispatch(['46', '46:pilot-dispatch']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), [`UNBARE ${repo} dispatch #46`, 'DISPATCHED 46 term_46']);
  assert.equal(git(repo, 'rev-parse', '--is-bare-repository'), 'false');
});

test('Bare guard 失敗：STOP unbare，不開分頁', t => {
  const { dispatch, calls } = fixture(t, { guard: '#!/bin/sh\necho 壞了 >&2\nexit 3\n' });
  const result = dispatch(['46', '46:pilot-dispatch']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP 46 unbare 壞了']);
  assert.doesNotMatch(calls(), /^terminal create /m);
});

const ISO = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d';

// state 只能是 PILOT-STORE.md 的 running／done／stop：pilot-probe.mjs 只把 `stop` 算成結束，寫成別的字 batch 就永遠不會 STAGEABLE。
test('batch checkpoint：寫表頭（current dispatched、pilot/integration 的 SHA）與每個成員一行，STOP 的成員記 stop', t => {
  const { repo, root, dispatch, checkpoint } = fixture(t, { modes: { 46: 'fail' } });
  const result = dispatch(['23-46', '23:pilot-probe', '46:pilot-dispatch']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  const sha = git(repo, 'rev-parse', '--short', 'pilot/integration');
  assert.match(checkpoint('23-46'), new RegExp([
    '^# batch 23-46',
    `current: dispatched ${ISO}`,
    `integration: pilot/integration @ ${sha}`,
    '',
    '\\| Issue \\| branch \\| worktree \\| handle \\| started \\| stuck-after \\| state \\| candidate \\|',
    '\\|---\\|---\\|---\\|---\\|---\\|---\\|---\\|---\\|',
    `\\| 23 \\| issue/23-pilot-probe \\| ${root}/issue-23 \\| term_23 \\| ${ISO} \\| 90m \\| running \\| \\|`,
    `\\| 46 \\| issue/46-pilot-dispatch \\|  \\|  \\| ${ISO} \\| 90m \\| stop \\| \\|`,
    '$',
  ].join('\n')));
});

test('重跑同一個 batch：已有的成員行就地換掉，其他列不動', t => {
  const { root, dispatch, checkpoint } = fixture(t, { modes: { 46: 'fail' } });
  dispatch(['23-46', '23:pilot-probe', '46:pilot-dispatch']);
  const result = dispatch(['23-46', '46:pilot-dispatch']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  const rows = checkpoint('23-46').split('\n').filter(line => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, 2);
  assert.match(rows[0], new RegExp(`^\\| 23 \\| issue/23-pilot-probe \\| ${root}/issue-23 \\| term_23 `));
  assert.match(rows[1], /^\| 46 \| .* \| stop \| \|$/);
});

// Bash 工具最多等 600 秒，被殺就來不及寫 checkpoint：預算到了中止進行中的步驟，剩下的成員都 STOP timeout。
test('總預算用完：進行中與還沒派的成員都 STOP timeout，照樣寫進 checkpoint', t => {
  const { dispatch, checkpoint } = fixture(t, { waitHangs: true });
  const begin = Date.now();
  const result = dispatch(['23-46', '23:pilot-probe', '46:pilot-dispatch'], { PILOT_DISPATCH_BUDGET_MS: '1500', SESSION_TUI_WAIT_MS: '60000' });
  assert.ok(Date.now() - begin < 20000, `${Date.now() - begin} ms`);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP 23 timeout', 'STOP 46 timeout']);
  assert.match(checkpoint('23-46'), /^\| 23 \| .* \| term_23 \| .* \| stop \| \|$/m);
  assert.match(checkpoint('23-46'), /^\| 46 \| .* \| stop \| \|$/m);
});

// 重跑 terminal 或送出 STOP 的成員：worktree 已在，再呼叫 create 會讓 Orca 去重出 `issue-<n>-2`（orca-worktree-create.mjs 的註解）。
test('重跑時 worktree 已存在：不再呼叫 worktree create，直接開分頁派出', t => {
  const { dispatch, calls } = fixture(t);
  assert.equal(dispatch(['46', '46:pilot-dispatch']).status, 0);
  const result = dispatch(['46', '46:pilot-dispatch']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result).pop(), 'DISPATCHED 46 term_46');
  assert.equal(calls().match(/^worktree create /gm).length, 1);
});

// 整合分支與 stuck-after 是專案的值：由參數傳入，預設 pilot/integration 與 90m。
test('--integration 換掉 worktree 的 base 與表頭的整合分支，--stuck-after 換掉成員行的 stuck-after', t => {
  const { repo, dispatch, calls, checkpoint } = fixture(t);
  git(repo, 'branch', 'feature-int');
  const result = dispatch(['46', '46:pilot-dispatch', '--integration', 'feature-int', '--stuck-after', '45m']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(calls(), /^worktree create --name issue-46 --base-branch feature-int --branch issue\/46-pilot-dispatch --issue 46 --json$/m);
  assert.match(checkpoint('46'), new RegExp(`^integration: feature-int @ ${git(repo, 'rev-parse', '--short', 'feature-int')}$`, 'm'));
  assert.match(checkpoint('46'), /^\| 46 \| .* \| 45m \| running \| \|$/m);
});

test('參數錯誤時 exit 2，不派工', t => {
  const { dispatch, calls } = fixture(t);
  for (const args of [['46', '46:x', '--integration'], ['46', '46:x', '--stuck-after', '2h'], ['46', '46:x', '--bogus', 'y'], ['46', '46:x', '--integration', 'a', '--integration', 'b'], ['46', '46:x', '--integration', '--stuck-after']]) {
    const result = dispatch(args);
    assert.equal(result.status, 2, `${args.join(' ')}：${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /^用法：/);
  }
  assert.equal(calls(), '');
});

// 參數化之後才碰得到：打錯的整合分支會寫出 `integration: <分支> @ `（沒有 SHA）的表頭，重跑也不會改寫。
test('整合分支不存在時 exit 2，不寫 checkpoint、不派工', t => {
  const { repo, dispatch, calls } = fixture(t);
  const result = dispatch(['46', '46:pilot-dispatch', '--integration', 'pilot/integ']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /pilot\/integ/);
  assert.equal(existsSync(join(repo, '.scratch/pilot/batch-46.md')), false);
  assert.equal(calls(), '');
});
