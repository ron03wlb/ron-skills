import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./pilot-dispatch.mjs', import.meta.url).pathname;
const SESSION = 'sess-me';
const MINE = `認領：${hostname()}／${SESSION}`;
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
// `claims[<n>]` 是那張 Issue 原有的留言（排在 comments.json 之前）；沒給時是一則這個 session（SESSION）的認領留言。
function fixture(t, { modes = {}, waitHangs = false, guard, claims = {} } = {}) {
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
  // 開著的分頁 `[{ handle, worktreePath }]`：create 加一筆、close 移除，list 依 --worktree 過濾。
  const terminals = join(temp, 'terminals.json');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2); const [a, b] = args; const arg = k => args[args.indexOf(k) + 1];
let stdin = 0; try { stdin = fs.readFileSync(0).length; } catch {}
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
fs.appendFileSync(${JSON.stringify(log)} + '.stdin', stdin + '\\n');
${orcaReplySource()}
const modes = ${JSON.stringify(modes)};
const terminals = ${JSON.stringify(terminals)};
if (a === 'worktree' && b === 'create') {
  const n = arg('--issue'); const mode = modes[n] ?? 'ok'; const path = ${JSON.stringify(root)} + '/' + arg('--name');
  if (mode !== 'fail') execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'add', '-q', '-b', arg('--branch'), path, arg('--base-branch')], { stdio: 'ignore' });
  if (mode === 'bare') execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'config', 'core.bare', 'true']);
  if (mode === 'ok' || mode === 'bare') console.log(JSON.stringify({ ok: true, result: { worktree: { path } } }));
  else fail(mode === 'late' ? 'request_timeout' : 'invalid_argument');
}
else if (b === 'create') {
  // 同一個 Issue 第二個分頁起加上序號（term_46、term_46_2），關掉的 handle 不重用，--fresh 才分得出新舊分頁。
  const terms = fs.existsSync(terminals) ? JSON.parse(fs.readFileSync(terminals, 'utf8')) : [];
  const base = 'term_' + arg('--title').replace(/^.*#/, '');
  const count = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter(line => line.startsWith('terminal create ') && line.includes('#' + base.slice(5) + ' ')).length;
  const handle = count > 1 ? base + '_' + count : base;
  fs.writeFileSync(terminals, JSON.stringify([...terms, { handle, worktreePath: arg('--worktree').replace(/^path:/, '') }]));
  reply('create', { terminal: { handle } });
}
else if (b === 'list') {
  const terms = (fs.existsSync(terminals) ? JSON.parse(fs.readFileSync(terminals, 'utf8')) : []).filter(t => 'path:' + t.worktreePath === arg('--worktree'));
  reply('list', { terminals: terms, totalCount: terms.length });
}
else if (b === 'close') {
  const terms = JSON.parse(fs.readFileSync(terminals, 'utf8'));
  fs.writeFileSync(terminals, JSON.stringify(terms.filter(t => t.handle !== arg('--terminal'))));
  reply('close', { close: { handle: arg('--terminal') } });
}
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
  // 假 gh：留言存在 comments.json，`issue view --json comments` 讀（前面接上 claims）、`issue comment --body` 加一則，每次呼叫記進 gh.log。
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  const comments = join(temp, 'comments.json');
  writeFileSync(comments, '[]');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2); const arg = k => args[args.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(join(temp, 'gh.log'))}, args.join(' ') + '\\n');
const comments = JSON.parse(fs.readFileSync(${JSON.stringify(comments)}, 'utf8'));
const claims = ${JSON.stringify(claims)}[args[2]] ?? [${JSON.stringify(MINE)}];
if (args[0] === 'issue' && args[1] === 'view') console.log(JSON.stringify({ comments: [...claims, ...comments.filter(c => c.issue === args[2]).map(({ body }) => body)].map(body => ({ body })) }));
else if (args[0] === 'issue' && args[1] === 'comment') fs.writeFileSync(${JSON.stringify(comments)}, JSON.stringify([...comments, { issue: args[2], body: arg('--body') }]));
else { console.error('gh：沒有替身 ' + args.join(' ')); process.exit(1); }
`);
  chmodSync(join(bin, 'gh'), 0o755);
  let dispatchScript = script;
  if (guard !== undefined) {
    const scripts = join(temp, 'scripts');
    mkdirSync(join(scripts, 'lib'), { recursive: true });
    for (const name of ['pilot-dispatch.mjs', 'issue-pool.mjs', 'lib/hosts.mjs', 'orca-session-send.mjs', 'orca-worktree-create.mjs', 'tab-state.mjs']) copyFileSync(new URL(`./${name}`, import.meta.url), join(scripts, name));
    writeFileSync(join(scripts, 'pilot-unbare.sh'), guard);
    chmodSync(join(scripts, 'pilot-unbare.sh'), 0o755);
    dispatchScript = join(scripts, 'pilot-dispatch.mjs');
  }
  const dispatch = (args, extra = {}) => spawnSync('node', [dispatchScript, ...args], {
    cwd: repo, encoding: 'utf8', input: 'leftover-line\nanother-line\n', timeout: 60000,
    env: { ...env, PATH: `${bin}:${env.PATH}`, CLAUDE_CODE_SESSION_ID: SESSION, ORCA_CLI_COMMAND: cli, ORCA_BIN: '', ...FAST, TAB_STATE_DIR: join(root, 'titles'), ...extra },
  });
  const checkpoint = key => readFileSync(join(repo, `.scratch/pilot/batch-${key}.md`), 'utf8');
  const calls = () => readFileSync(log, 'utf8');
  const sent = () => (existsSync(`${log}.sent`) ? readFileSync(`${log}.sent`, 'utf8') : '');
  const open = () => (existsSync(terminals) ? JSON.parse(readFileSync(terminals, 'utf8')) : []);
  const posted = () => JSON.parse(readFileSync(comments, 'utf8'));
  const ghCalls = () => (existsSync(join(temp, 'gh.log')) ? readFileSync(join(temp, 'gh.log'), 'utf8') : '');
  const comment = (issue, body) => writeFileSync(comments, JSON.stringify([...posted(), { issue, body }]));
  return { temp, repo, root, log, cli, dispatch, checkpoint, calls, sent, open, posted, ghCalls, comment };
}

const lines = result => result.stdout.trim().split('\n');

// 派工前讀 Issue 最近一則認領留言（格式同 issue-pool.mjs claim），不是這個 session 的就不派（#165）。
test('最近一則認領是別的 session：STOP not-claimed，不開 worktree、不開分頁，成員記 stop；自己認領的照常派出', t => {
  const { repo, dispatch, calls, checkpoint } = fixture(t, { claims: { 133: [MINE, '認領：other-box／their-session'] } });
  const result = dispatch(['23-133', '23:pilot-probe', '133:pilot-dispatch']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['DISPATCHED 23 term_23', 'STOP 133 not-claimed']);
  assert.doesNotMatch(calls(), /^worktree create .*--issue 133 /m);
  assert.doesNotMatch(calls(), /^terminal create .* --title 處理中｜#133 /m);
  assert.equal(existsSync(join(repo, '..', 'workspaces', 'issue-133')), false);
  assert.match(checkpoint('23-133'), /^\| 133 \| issue\/133-pilot-dispatch \|  \|  \| [^|]+ \| 90m \| stop \| \|$/m);
});

test('沒有認領留言、或認領只是引用在別的文字裡：STOP not-claimed', t => {
  const { dispatch, calls } = fixture(t, { claims: { 133: [], 134: [`前任寫的：\n${MINE}`] } });
  const result = dispatch(['133-134', '133:a', '134:b']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP 133 not-claimed', 'STOP 134 not-claimed']);
  assert.doesNotMatch(calls(), /^worktree create /m);
});

// claim 以前任 coordinator 的 session 接手（`CLAIMED <n> takeover <session>`）時，留言寫的是前任的 session，照樣算這個 session 的。
test('認領是 claim 接手的本機前任 coordinator：照常派出', t => {
  const { repo, dispatch } = fixture(t, { claims: { 133: [`認領：${hostname()}／old-coord`] } });
  mkdirSync(join(repo, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(repo, '.scratch/pilot/sessions.md'), '2026-10-31T09:00:00+08:00   session old-coord   pid 4242   coord-1\n'
    + '2026-10-31T10:00:00+08:00   handoff from-session old-coord → terminal term_1   reason 合入 2 批\n'
    + `2026-10-31T10:00:05+08:00   session ${SESSION}   pid 4343   coord-2\n`);
  const result = dispatch(['133', '133:pilot-dispatch']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['DISPATCHED 133 term_133']);
});

test('create 回 ok:false 但 worktree 已建好：以目錄與 git worktree list 為準，照樣派出', t => {
  const { repo, root, dispatch, calls, sent } = fixture(t, { modes: { 46: 'late' } });
  const result = dispatch(['46', '46:pilot-dispatch']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result).pop(), 'DISPATCHED 46 term_46');
  assert.match(calls(), /^worktree create --name issue-46 --base-branch pilot\/integration --branch issue\/46-pilot-dispatch --issue 46 --json$/m);
  assert.match(calls(), new RegExp(`^terminal create --worktree path:${root}/issue-46 --title 處理中｜#46 --command claude --json$`, 'm'));
  assert.equal(sent().trim(), `/issue-run 46 --worker ${repo}/.scratch/pilot/batch-46.md`);
  // Orca 讀不回 create 設的標題：worker 的 tab-state 要靠這份記錄（scripts/tab-state.mjs）。
  assert.equal(readFileSync(join(root, 'titles/term_46'), 'utf8'), '處理中｜#46');
});

// 記錄只是輔助：寫不進去（TAB_STATE_DIR 是檔案）時照樣派出，不能變成沒有 handle 的 STOP、留下關不掉的分頁。
test('標題記錄寫不進去：照樣派出', t => {
  const { root, dispatch } = fixture(t);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'not-a-dir'), '');
  const result = dispatch(['46', '46:pilot-dispatch'], { TAB_STATE_DIR: join(root, 'not-a-dir') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result).pop(), 'DISPATCHED 46 term_46');
});

test('create 失敗而且沒有目錄：STOP create，不開分頁；其他成員照樣派出', t => {
  const { dispatch, calls } = fixture(t, { modes: { 46: 'fail' } });
  const result = dispatch(['23-46', '46:pilot-dispatch', '23:pilot-probe']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP 46 create orca worktree create：invalid_argument', 'DISPATCHED 23 term_23']);
  assert.doesNotMatch(calls(), /terminal create .* --title 處理中｜#46 /);
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
// 預算要夠 #23 走完 worktree create、Bare guard、terminal create，在永遠不回的 wait 用完：1500 ms 在 7、8 個 worker 同時跑時
// 會在 create 或 terminal 階段就用完（handle 空白，或多出分頁提示），整批 bin/check 不穩定（#156、#157、#160）。
test('總預算用完：進行中與還沒派的成員都 STOP timeout，照樣寫進 checkpoint', t => {
  const { dispatch, checkpoint } = fixture(t, { waitHangs: true });
  const begin = Date.now();
  const result = dispatch(['23-46', '23:pilot-probe', '46:pilot-dispatch'], { PILOT_DISPATCH_BUDGET_MS: '8000', SESSION_TUI_WAIT_MS: '60000' });
  assert.ok(Date.now() - begin < 30000, `${Date.now() - begin} ms`);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  // 負載高時 23 可能已開了分頁才逾時，STOP 會多帶「請確認有沒有留下標題 … 的分頁」（#139：land.test 搬進同一組並行後出現）。
  const [first, ...rest] = lines(result);
  assert.match(first, /^STOP 23 timeout(（請確認有沒有留下標題 .+ 的分頁）)?$/);
  assert.deepEqual(rest, ['STOP 46 timeout']);
  assert.match(checkpoint('23-46'), /^\| 23 \| .* \| term_23 \| .* \| stop \| \|$/m);
  assert.match(checkpoint('23-46'), /^\| 46 \| .* \| stop \| \|$/m);
});

// 重跑 terminal 或送出 STOP 的成員：worktree 已在，再呼叫 create 會讓 Orca 去重出 `issue-<n>-2`（orca-worktree-create.mjs 的註解）。
test('重跑時 worktree 已存在：不再呼叫 worktree create，直接開分頁派出', t => {
  const { dispatch, calls } = fixture(t);
  assert.equal(dispatch(['46', '46:pilot-dispatch']).status, 0);
  const result = dispatch(['46', '46:pilot-dispatch']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result).pop(), 'DISPATCHED 46 term_46_2');
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

// --fresh（#124）：Stage 的同一條目衝突之後，把成員重派成 fresh worker。
// 起點重現 batch 77-124 前的情況：batch 23-46 兩個成員都 done，46 在 Stage 跟整合分支衝突；46 的 worktree 除了 worker 分頁，
// 還有一個 checkpoint 沒記到的分頁；整合分支在派工之後前進了一個 commit；worker 留下自己的 checkpoint 目錄。
function conflicted(t) {
  const fx = fixture(t);
  // 照 issue-run 的 adapter，.scratch/ 不 commit。
  writeFileSync(join(fx.repo, '.gitignore'), '.scratch/\n');
  git(fx.repo, 'add', '.gitignore');
  git(fx.repo, 'commit', '-qm', 'ignore scratch');
  git(fx.repo, 'branch', '-f', 'pilot/integration', 'main');
  assert.equal(fx.dispatch(['23-46', '23:pilot-probe', '46:pilot-dispatch']).status, 0);
  const tree = join(fx.root, 'issue-46');
  writeFileSync(join(tree, 'work.txt'), 'worker\n');
  git(tree, 'add', '.');
  git(tree, 'commit', '-qm', 'worker');
  mkdirSync(join(tree, '.scratch/issue-run-46'), { recursive: true });
  writeFileSync(join(tree, '.scratch/issue-run-46/state.md'), 'old checkpoint\n');
  const extra = spawnSync(fx.cli, ['terminal', 'create', '--worktree', `path:${tree}`, '--title', 'shell #46', '--json'], { encoding: 'utf8' });
  assert.equal(extra.status, 0, extra.stderr);
  const file = join(fx.repo, '.scratch/pilot/batch-23-46.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/ running \| \|$/gm, ' done | abc1234 |'));
  git(fx.repo, 'commit', '-q', '--allow-empty', '-m', 'integration moved');
  git(fx.repo, 'branch', '-f', 'pilot/integration', 'main');
  const note = join(fx.temp, 'note.md');
  writeFileSync(note, '重派：與 pilot/integration 的 Stage 條目衝突，從新 base 整併。\n');
  const head = git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch');
  return { ...fx, tree, note, head, file };
}

const fresh = (fx, ...extra) => fx.dispatch(['23-46', '--fresh', '46:pilot-dispatch', '--note', fx.note, ...extra]);

test('--fresh：-prior 留住原分支，新分支從目前的整合分支開出，worktree 裡的分頁都關掉、拆成自己的 batch 再派出', t => {
  const fx = conflicted(t);
  const result = fresh(fx);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['DISPATCHED 46 term_46_3', `PRIOR 46 issue/46-pilot-dispatch-prior ${fx.head}`]);
  assert.equal(git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch-prior'), fx.head);
  assert.equal(git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch'), git(fx.repo, 'rev-parse', 'pilot/integration'));
  assert.equal(git(fx.tree, 'branch', '--show-current'), 'issue/46-pilot-dispatch');
  // 每個舊分頁都關掉（含 checkpoint 沒記到的那個），只剩新派的 worker。
  assert.match(fx.calls(), /^terminal close --terminal term_46 --json$/m);
  assert.match(fx.calls(), /^terminal close --terminal term_46_2 --json$/m);
  assert.deepEqual(fx.open().filter(t => t.worktreePath === fx.tree).map(t => t.handle), ['term_46_3']);
  // 舊 checkpoint 改名，fresh worker 才不會讀到。
  assert.equal(readFileSync(join(fx.tree, '.scratch/issue-run-46-prior/state.md'), 'utf8'), 'old checkpoint\n');
  assert.equal(existsSync(join(fx.tree, '.scratch/issue-run-46')), false);
  // 原 batch 的那一列標成 moved，自己的 batch 是表頭加一列。
  assert.match(fx.checkpoint('23-46'), /^\| 46 \| issue\/46-pilot-dispatch \| .* \| moved batch-46 \| abc1234 \|$/m);
  assert.match(fx.checkpoint('23-46'), /^\| 23 \| .* \| done \| abc1234 \|$/m);
  const sha = git(fx.repo, 'rev-parse', '--short', 'pilot/integration');
  assert.match(fx.checkpoint('46'), new RegExp([
    '^# batch 46',
    `current: dispatched ${ISO}`,
    `integration: pilot/integration @ ${sha}`,
    '',
    '\\| Issue \\| branch \\| worktree \\| handle \\| started \\| stuck-after \\| state \\| candidate \\|',
    '\\|---\\|---\\|---\\|---\\|---\\|---\\|---\\|---\\|',
    `\\| 46 \\| issue/46-pilot-dispatch \\| ${fx.tree} \\| term_46_3 \\| ${ISO} \\| 90m \\| running \\| \\|`,
    '$',
  ].join('\n')));
  assert.equal(fx.sent().trim().split('\n').pop(), `/issue-run 46 --worker ${fx.repo}/.scratch/pilot/batch-46.md`);
  assert.deepEqual(fx.posted(), [{ issue: '46', body: `重派：與 pilot/integration 的 Stage 條目衝突，從新 base 整併。\n\nprior: issue/46-pilot-dispatch-prior @ ${fx.head}` }]);
});

test('--fresh：工作樹有未提交改動時 STOP dirty，分支、worktree、分頁、checkpoint 與 Issue 都不動', t => {
  const fx = conflicted(t);
  writeFileSync(join(fx.tree, 'stray.txt'), 'uncommitted\n');
  const before = fx.checkpoint('23-46');
  const result = fresh(fx);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP dirty 46']);
  assert.equal(git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch'), fx.head);
  assert.equal(git(fx.repo, 'branch', '--list', '*-prior*'), '');
  assert.equal(git(fx.tree, 'branch', '--show-current'), 'issue/46-pilot-dispatch');
  assert.ok(existsSync(join(fx.tree, 'stray.txt')));
  assert.ok(existsSync(join(fx.tree, '.scratch/issue-run-46/state.md')));
  assert.doesNotMatch(fx.calls(), /^terminal close /m);
  assert.equal(fx.checkpoint('23-46'), before);
  assert.equal(existsSync(join(fx.repo, '.scratch/pilot/batch-46.md')), false);
  assert.doesNotMatch(fx.ghCalls(), /^issue comment /m);
});

test('--fresh：重派過的 Issue 再衝突時 STOP refresh-twice、什麼都不動；--again 另存成 -prior2', t => {
  const fx = conflicted(t);
  assert.equal(fresh(fx).status, 0);
  writeFileSync(join(fx.tree, 'work.txt'), 'fresh worker\n');
  git(fx.tree, 'add', '.');
  git(fx.tree, 'commit', '-qm', 'fresh worker');
  const second = git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch');
  const closes = fx.calls().match(/^terminal close /gm).length;
  const result = fresh(fx);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP refresh-twice 46']);
  assert.equal(git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch'), second);
  assert.equal(git(fx.repo, 'branch', '--list', '*-prior2'), '');
  assert.equal(fx.calls().match(/^terminal close /gm).length, closes);
  assert.equal(fx.posted().length, 1);
  // gate 選了「再重派一次」：
  const again = fresh(fx, '--again');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(lines(again).pop(), `PRIOR 46 issue/46-pilot-dispatch-prior2 ${second}`);
  assert.equal(git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch-prior'), fx.head);
  assert.equal(git(fx.repo, 'rev-parse', 'issue/46-pilot-dispatch'), git(fx.repo, 'rev-parse', 'pilot/integration'));
  assert.equal(fx.posted().length, 2);
});

// 每一步都能從中斷處重跑：已改名、已開新分支、已留言、已拆 batch 的都略過，不再另存一份 prior，也不重複留言。
test('--fresh：中斷在改名之後時重跑接著做；派出之前中斷的重跑不重複留言、不另存 prior', t => {
  const fx = conflicted(t);
  git(fx.tree, 'branch', '-m', 'issue/46-pilot-dispatch', 'issue/46-pilot-dispatch-prior');
  const result = fresh(fx);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result).pop(), `PRIOR 46 issue/46-pilot-dispatch-prior ${fx.head}`);
  assert.equal(git(fx.tree, 'branch', '--show-current'), 'issue/46-pilot-dispatch');
  // 中斷在送出 worker 指令之前：分頁沒開成，batch-46 那列是 stop。
  const file = join(fx.repo, '.scratch/pilot/batch-46.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/ running \| \|$/m, ' stop | |'));
  const rerun = fresh(fx);
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(lines(rerun).pop(), `PRIOR 46 issue/46-pilot-dispatch-prior ${fx.head}`);
  assert.equal(git(fx.repo, 'branch', '--list', '*-prior2'), '');
  assert.equal(fx.posted().length, 1);
  assert.equal(fx.checkpoint('46').split('\n').filter(line => /^\| \d+ \|/.test(line)).length, 1);
  assert.deepEqual(fx.open().filter(t => t.worktreePath === fx.tree).length, 1);
});

// fresh worker 已經在跑、還沒 commit：同一行再跑一次不能把它的分頁關掉重派（例如 handoff 後下一任 coordinator 重跑）。
test('--fresh：已派出的 fresh worker 還在跑時 STOP running，不關分頁', t => {
  const fx = conflicted(t);
  assert.equal(fresh(fx).status, 0);
  const closes = fx.calls().match(/^terminal close /gm).length;
  const result = fresh(fx);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP 46 running term_46_3']);
  assert.equal(fx.calls().match(/^terminal close /gm).length, closes);
  assert.deepEqual(fx.open().filter(t => t.worktreePath === fx.tree).map(t => t.handle), ['term_46_3']);
});

test('--fresh：最近一則認領是別的 session 時 STOP not-claimed，分支、分頁、checkpoint 與 Issue 都不動', t => {
  const fx = conflicted(t);
  fx.comment('46', '認領：other-box／their-session');
  const before = fx.checkpoint('23-46');
  const result = fresh(fx);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP 46 not-claimed']);
  assert.equal(git(fx.repo, 'branch', '--list', '*-prior*'), '');
  assert.doesNotMatch(fx.calls(), /^terminal close /m);
  assert.equal(fx.checkpoint('23-46'), before);
  assert.equal(existsSync(join(fx.repo, '.scratch/pilot/batch-46.md')), false);
  assert.doesNotMatch(fx.ghCalls(), /^issue comment /m);
});

test('--fresh 的參數錯誤時 exit 2，不動任何東西', t => {
  const fx = conflicted(t);
  for (const args of [['23-46', '--fresh', '46:pilot-dispatch'], ['23-46', '--fresh', '46:pilot-dispatch', '--note', join(fx.temp, 'missing.md')],
    ['23-46', '23:pilot-probe', '--fresh', '46:pilot-dispatch', '--note', fx.note], ['23-46', '46:pilot-dispatch', '--note', fx.note], ['23-46', '46:pilot-dispatch', '--again']]) {
    const result = fx.dispatch(args);
    assert.equal(result.status, 2, `${args.join(' ')}：${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /^用法：/);
  }
  assert.equal(git(fx.repo, 'branch', '--list', '*-prior*'), '');
});
