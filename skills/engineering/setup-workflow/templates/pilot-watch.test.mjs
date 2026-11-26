// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./pilot-watch.mjs', import.meta.url).pathname;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const SHA = 'b'.repeat(40);

// 假 Orca：`screens` 是 handle → 依序回的畫面（`{ status, tail }`，或 `{ raw }` 原樣印出、不經 JSON.stringify）；讀完最後一個之後一直回最後一個。
// 不在表裡的 handle 回 terminal_handle_stale。每次呼叫記進 orca.log。
// `terminal wait`（tui-idle）不推進畫面、不記進 orca.log，記進 wait.log；waitMs[handle] 毫秒後回 satisfied（沒給時立刻回）。
function fixture(t, screens = {}, waitMs = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-watch-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const arg = k => process.argv[process.argv.indexOf(k) + 1];
${orcaReplySource()}
if (process.argv[3] === 'wait') {
  fs.appendFileSync(${JSON.stringify(join(temp, 'wait.log'))}, process.argv.slice(2).join(' ') + '\\n');
  setTimeout(() => reply('wait', { wait: { satisfied: true } }), ${JSON.stringify(waitMs)}[arg('--terminal')] ?? 0);
  return;
}
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const screens = ${JSON.stringify(screens)};
const handle = arg('--terminal');
const list = screens[handle];
if (!list) { fail('terminal_handle_stale'); process.exit(1); }
const counter = ${JSON.stringify(join(temp, 'count-'))} + handle;
const i = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
// 不帶 --screen 的讀取（累積輸出，#537）不推進畫面順序：有 scrollback 時回它，沒有時同目前畫面。
const scroll = !process.argv.includes('--screen');
if (!scroll) fs.writeFileSync(counter, String(i + 1));
const { scrollback, ...screen } = list[Math.min(scroll ? Math.max(i - 1, 0) : i, list.length - 1)];
if (scroll && scrollback) reply('read', { terminal: { ...screen, tail: scrollback } });
else if (screen.raw !== undefined) process.stdout.write(screen.raw);
else reply('read', { terminal: screen });
`);
  chmodSync(cli, 0o755);
  const pilot = join(temp, 'checkout', '.scratch/pilot');
  mkdirSync(pilot, { recursive: true });
  const batch = (key, members, extra = '') => writeFileSync(join(pilot, `batch-${key}.md`), `# batch ${key}
current: dispatched 2026-11-21T09:00:00+08:00
integration: pilot/integration @ 1234567

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
${members.map(m => `| ${m.n} | issue/${m.n}-x | ${m.worktree ?? `/w/issue-${m.n}`} | ${m.handle} | 2026-11-21T09:00:00+08:00 | 90m | ${m.state ?? 'running'} | |`).join('\n')}
${extra}`);
  const run = (args, extraEnv = { ORCA_CLI_COMMAND: cli }) =>
    spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, cwd: temp, timeout: 20000 });
  const reads = handle => readFileSync(log, 'utf8').split('\n').filter(line => line.includes(`--terminal ${handle} `)).length;
  const waits = () => (existsSync(join(temp, 'wait.log')) ? readFileSync(join(temp, 'wait.log'), 'utf8') : '');
  return { temp, pilot, batch, run, reads, cli, waits };
}

const fast = ['--interval', '0.01'];

// #325：自寫的 `^(DONE|STOP) [0-9]+` 漏抓兩格縮排的結果行，後面又接著 Claude Code 的提示列，漏掉 STOP 約 1 小時。
test('結果行有兩格縮排、後面接 TUI 提示列：抓得到', t => {
  const { run } = fixture(t, { term_a: [
    { status: 'running', tail: ['● 跑測試中'] },
    { status: 'running', tail: ['● 報告', `  DONE 355 ${SHA}`, '', '╭──────────╮', '│ ❯        │', '╰──────────╯', '  ⏵⏵ auto mode on (shift+tab to cycle)'] },
  ] });
  const result = run(['term_a', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT - term_a DONE 355 ${SHA}\n`);
});

// #323：resume 之後畫面上還留著舊的 STOP，watcher 一啟動就退出，等於沒在看。
test('啟動時畫面已有舊 STOP 130：不算，之後出現新 DONE 才退出', t => {
  const old = '  STOP 130 findings after two review cycles';
  const { batch, run, reads } = fixture(t, { term_130: [
    { status: 'running', tail: [old, '❯'] },
    { status: 'running', tail: [old, '● 重跑中', '❯'] },
    { status: 'running', tail: [old, '● 重跑中', '❯'] },
    { status: 'running', tail: [old, '● 重跑中', `DONE 130 ${SHA}`, '❯'] },
  ] });
  batch('130', [{ n: 130, handle: 'term_130' }], `resumed: #130 2026-11-21T10:00:00+08:00 ${old.trim()}\n`);
  const result = run(['--batch', '130', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 130 term_130 DONE 130 ${SHA}\n`);
  assert.equal(reads('term_130'), 4);
});

// #406（investing#469 第 2 項）：pilot-batch resume 之後、watcher 啟動之前 worker 已印 DONE，畫面基準把它吞掉，watcher 一直不通知。
// batch 成員改照 Probe 的 WORKER：只略過 `resumed:` 記下的那一行，啟動時已在畫面上的新結果行照報。
test('batch 成員在 resume 後、watcher 啟動前已印 DONE：第一輪就回報，只略過 resumed 記下的舊結果行', t => {
  const old = 'STOP 430 decision 舊的取捨';
  const { batch, run, reads } = fixture(t, { term_430: [{ status: 'running', tail: [old, '● 照答案做', `  DONE 430 ${SHA}`, '❯'] }] });
  batch('430', [{ n: 430, handle: 'term_430' }], `resumed: #430 2026-11-21T18:20:00+08:00 ${old}\n`);
  const result = run(['--batch', '430', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 430 term_430 DONE 430 ${SHA}\n`);
  assert.equal(reads('term_430'), 1);
});

// #537：watcher 啟動前 DONE 已捲出畫面；畫面不是工作中時往回讀累積輸出。
test('batch 成員的結果行已捲出畫面：往回讀累積輸出回報 RESULT（#537）', t => {
  const { batch, run } = fixture(t, { term_526: [{ status: 'running', tail: ['  報告最後一行', '❯'], scrollback: [`DONE 526 ${SHA}`, '  報告最後一行', '❯'] }] });
  batch('526', [{ n: 526, handle: 'term_526' }]);
  const result = run(['--batch', '526', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 526 term_526 DONE 526 ${SHA}\n`);
});

// #643 第 1 項（batch-395）：resume 後 worker 在背景等 pre-commit、畫面閒置，watcher 往回讀累積輸出（#537），那裡的舊 STOP 尾巴黏著 Orca 側欄，
// 與 resumed 行字串不同，watcher 一啟動就印 RESULT 結束。比對前去掉 `│` 之後的側欄：舊 STOP 不報，之後的新結果照報。
test('累積輸出裡的舊 STOP 帶側欄尾巴、resumed 行記的是去掉側欄的那一行：不當新結果，等到新的 DONE 才結束（#643）', t => {
  const old = 'STOP 395 permission settings.json 缺 pilot-land.mjs push 規則';
  const idle = ['● commit 在背景跑 pre-commit 檢查', '❯'];
  const scrollback = [`  ${old} │…s/pilot-after-merge.md[ ask ]`, '  報告', ...idle];
  const { batch, run, reads } = fixture(t, { term_395: [
    { status: 'running', tail: idle, scrollback },
    { status: 'running', tail: idle, scrollback },
    { status: 'running', tail: [`DONE 395 ${SHA}`, '❯'] },
  ] });
  batch('395', [{ n: 395, handle: 'term_395' }], `resumed: #395 2026-11-25T12:07:35+08:00 ${old}\n`);
  const result = run(['--batch', '395', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 395 term_395 DONE 395 ${SHA}\n`);
  // 三次 --screen 讀取加兩次累積輸出：前兩輪沒有結束。
  assert.ok(reads('term_395') >= 5, String(reads('term_395')));
});

test('batch 成員沒有 resumed 行、啟動時畫面已有自己的結果行：第一輪就回報（與 Probe 的 WORKER 同一判斷）', t => {
  const { batch, run } = fixture(t, { term_436: [{ status: 'running', tail: [`DONE 436 ${SHA}`, '❯'] }] });
  batch('436', [{ n: 436, handle: 'term_436' }]);
  const result = run(['--batch', '436', '--checkout', 'checkout', ...fast]);
  assert.equal(result.stdout, `RESULT 436 term_436 DONE 436 ${SHA}\n`);
});

test('啟動時畫面已有舊 STOP，之後出現不同的新 STOP 也退出', t => {
  const { run } = fixture(t, { term_130: [
    { status: 'running', tail: ['STOP 130 old cause'] },
    { status: 'running', tail: ['STOP 130 old cause', 'STOP 130 decision 新的取捨'] },
  ] });
  const result = run(['term_130', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT - term_130 STOP 130 decision 新的取捨\n');
});

// investing 舊版帶多個 --batch 時只看最後一批、exit 0（已發生三次）。
test('--batch A --batch B：兩批都監看，結果行標出是哪一批', t => {
  const { batch, run, reads } = fixture(t, {
    term_1: [{ status: 'running', tail: ['● 跑測試中'] }],
    term_2: [{ status: 'running', tail: ['❯'] }, { status: 'running', tail: ['STOP 2 prerequisite missing'] }],
    term_3: [{ status: 'running', tail: ['❯'] }],
  });
  batch('A', [{ n: 1, handle: 'term_1' }, { n: 9, handle: 'term_9', state: 'done' }]);
  batch('B', [{ n: 2, handle: 'term_2' }, { n: 3, handle: 'term_3' }]);
  const result = run(['--batch', 'A', '--batch', 'B', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT B term_2 STOP 2 prerequisite missing\n');
  assert.ok(reads('term_1') >= 2, '第一批的成員也要讀');
  assert.equal(reads('term_9'), 0, '不是 running 的成員不讀');
});

test('batch 成員只認自己號碼的結果行', t => {
  const { batch, run } = fixture(t, { term_4: [
    { status: 'running', tail: ['❯'] },
    { status: 'running', tail: ['  STOP 77 別張單的結果（引用）', '❯'] },
    { status: 'running', tail: ['  STOP 77 別張單的結果（引用）', 'DONE 4 abcdef1'] },
  ] });
  batch('4', [{ n: 4, handle: 'term_4' }]);
  const result = run(['--batch', '4', '--checkout', 'checkout', ...fast]);
  assert.equal(result.stdout, 'RESULT 4 term_4 DONE 4 abcdef1\n');
});

// #590：pilot-dispatch --unit 派出的非 Issue fix unit，batch-req-<n>.md 的唯一成員列 Issue 欄是 `-`（pilot-land／pilot-close 的請求分支列），
// worker 回報 `DONE req-<n> <sha>`；以前 watch 只看號碼列，這種 unit 完成了也不通知。
test('請求 unit（batch-req-<n>.md 的 - 列）：認得 DONE req-<n> <sha>，別的 req 號碼與 Issue 號碼都不算', t => {
  const { pilot, run } = fixture(t, { term_u: [
    { status: 'running', tail: ['● 修 CI 中'] },
    { status: 'running', tail: ['  DONE req-1 abcdef1', 'DONE 12 abcdef1', '❯'] },
    { status: 'running', tail: ['● 報告', `  DONE req-12 ${SHA}`, '❯'] },
  ] });
  writeFileSync(join(pilot, 'batch-req-12.md'), `# batch req-12
current: dispatched 2026-11-26T09:00:00+08:00
integration: pilot/integration @ 1234567

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
| - | retro/fix-ci | /w/req-12 | term_u | 2026-11-26T09:00:00+08:00 | 90m | running | |
`);
  const result = run(['--batch', 'req-12', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT req-12 term_u DONE req-12 ${SHA}\n`);
  assert.equal(readFileSync(join(pilot, 'results/term_u'), 'utf8').split(' ').slice(1).join(' '), `DONE req-12 ${SHA}\n`);
});

// #590 review：`postland:` 行的讀取端（pilot-land 的 POSTLAND_PENDING）只認 Issue 號碼，unit 的 POSTLAND 記成 `postland: #req-12 …` 也讀不到，重跑還重複記。
test('請求 unit 的 DONE 前有 POSTLAND：照樣 RESULT，checkpoint 不記 postland 行', t => {
  const { pilot, run } = fixture(t, { term_u: [{ status: 'running', tail: ['  POSTLAND req-12 node scripts/x.mjs', `  DONE req-12 ${SHA}`, '❯'] }] });
  const text = `# batch req-12
current: dispatched 2026-11-26T09:00:00+08:00
integration: pilot/integration @ 1234567

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
| - | retro/fix-ci | /w/req-12 | term_u | 2026-11-26T09:00:00+08:00 | 90m | running | |
`;
  writeFileSync(join(pilot, 'batch-req-12.md'), text);
  const result = run(['--batch', 'req-12', '--checkout', 'checkout', ...fast]);
  assert.equal(result.stdout, `RESULT req-12 term_u DONE req-12 ${SHA}\n`);
  assert.equal(readFileSync(join(pilot, 'batch-req-12.md'), 'utf8'), text);
});

test('直接給 handle：unit 的 DONE req-<n> <sha> 也算結果', t => {
  const { run } = fixture(t, { term_u: [{ status: 'running', tail: ['❯'] }, { status: 'running', tail: [`DONE req-12 ${SHA}`, '❯'] }] });
  const result = run(['term_u', ...fast]);
  assert.equal(result.stdout, `RESULT - term_u DONE req-12 ${SHA}\n`);
});

test('直接給 checkpoint 檔：照檔名標出 batch', t => {
  const { batch, pilot, run } = fixture(t, { term_5: [{ status: 'running', tail: [] }, { status: 'running', tail: ['DONE 5 abcdef1'] }] });
  batch('5-6', [{ n: 5, handle: 'term_5' }]);
  const result = run([join(pilot, 'batch-5-6.md'), ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT 5-6 term_5 DONE 5 abcdef1\n');
});

test('terminal 已結束卻沒有新結果行：印 EXITED 並退出', t => {
  const { run } = fixture(t, { term_x: [{ status: 'running', tail: ['STOP 8 old'] }, { status: 'exited', tail: ['STOP 8 old'] }] });
  const result = run(['term_x', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'EXITED - term_x\n');
});

// #466 第 2 項（investing#445）：worker 分頁已結束，`--batch 445` 只印 EXITED；它的 checkpoint 已寫 `State: done, candidate <sha>`、SHA 等於 worktree HEAD。
test('batch 成員 terminal 已結束、checkpoint 最後的 State 是 done 且 SHA 等於 worktree HEAD：印 RESULT … DONE <n> <sha> from-state', t => {
  const { temp, batch, run } = fixture(t, { term_445: [{ status: 'exited', tail: [] }], term_446: [{ status: 'exited', tail: [] }] });
  const worktree = join(temp, 'wt');
  const git = (...args) => spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8', env });
  spawnSync('git', ['init', '-q', worktree], { env });
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'c');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  for (const [n, sha] of [[445, head], [446, SHA]]) {
    mkdirSync(join(temp, `notes/issue-${n}`), { recursive: true });
    writeFileSync(join(temp, `notes/issue-${n}/state.md`), `State: done, candidate ${sha}\n`);
  }
  batch('445-446', [{ n: 445, handle: 'term_445', worktree }, { n: 446, handle: 'term_446', worktree }]);
  const result = run(['--batch', '445-446', '--checkout', 'checkout', '--worker-state', join(temp, 'notes/issue-<n>/state.md'), ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 445-446 term_445 DONE 445 ${head} from-state\nEXITED 445-446 term_446\n`);
});

// #204：tail 含反斜線（Windows 路徑、ANSI 殘留）時 Orca 的 JSON 有不成立的跳脫，zsh echo 加 jq 報 Invalid escape。
test('screen JSON 帶不成立的反斜線跳脫：照樣讀出結果行', t => {
  const raw = String.raw`{"ok":true,"result":{"terminal":{"handle":"term_w","status":"running","tail":["C:\Users\ron\x","DONE 6 abcdef1"]}}}` + '\n';
  const { run } = fixture(t, { term_w: [{ status: 'running', tail: [] }, { raw }] });
  const result = run(['term_w', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT - term_w DONE 6 abcdef1\n');
});

test('讀不到 terminal：印 READ_FAILED 並在下一輪重試', t => {
  const { run } = fixture(t, { term_ok: [{ status: 'running', tail: [] }, { status: 'running', tail: ['DONE 1 abcdef1'] }] });
  const result = run(['term_gone', 'term_ok', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^READ_FAILED - term_gone terminal_handle_stale$/m);
  assert.match(result.stdout, /^RESULT - term_ok DONE 1 abcdef1$/m);
});

test('--batch 沒有 running 成員：印 NO_RUNNING，什麼都沒得看時 exit 0；checkpoint 讀不到時 BATCH_FAILED exit 1', t => {
  const { batch, run } = fixture(t, {});
  batch('7', [{ n: 7, handle: 'term_7', state: 'done' }]);
  const none = run(['--batch', '7', '--checkout', 'checkout']);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, 'NO_RUNNING 7\n');
  const missing = run(['--batch', 'nope', '--checkout', 'checkout']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^BATCH_FAILED nope /m);
});

test('--tail <handle> --lines <n>：印畫面最後 n 行', t => {
  const { run } = fixture(t, { term_9: [{ status: 'running', tail: ['a', 'b', 'c', 'DONE 9 abc'] }] });
  const two = run(['--tail', 'term_9', '--lines', '2']);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(two.stdout, 'c\nDONE 9 abc\n');
  assert.equal(run(['--tail', 'term_9']).stdout, 'a\nb\nc\nDONE 9 abc\n');
});

test('用法錯誤 exit 2', t => {
  const { run, cli } = fixture(t, {});
  for (const args of [[], ['--batch'], ['--batch', 'a b'], ['--interval', '0', 'term_1'], ['--lines', '2', 'term_1'], ['--tail', 'term_1', 'term_2'], ['--tail', 'term_1', '--lines', '0'], ['--bogus']]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
  assert.equal(run(['term_1'], {}).status, 2, '沒有 ORCA_CLI_COMMAND');
  assert.ok(cli);
});

test('同一個 handle 既直接給又在 batch 裡：以 batch 成員為準（只認自己號碼、標出批次）', t => {
  const { batch, run } = fixture(t, { term_12: [
    { status: 'running', tail: ['❯'] },
    { status: 'running', tail: ['  DONE 99 abcdef1 （引用別張）'] },
    { status: 'running', tail: ['  DONE 99 abcdef1', `DONE 12 ${SHA}`] },
  ] });
  batch('5', [{ n: 12, handle: 'term_12' }]);
  const result = run(['term_12', '--batch', '5', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 5 term_12 DONE 12 ${SHA}\n`);
});

// investing 的 parseTerminal：tail 可能是一個字串，或元素裡帶換行；結果行裡的控制字元換成空白。
test('tail 是字串、或元素內含換行：攤平成行再判斷', t => {
  const { run } = fixture(t, { term_s: [
    { status: 'running', tail: ['● 跑測試中'] },
    { status: 'running', tail: ['● 報告\n  STOP 3 prerequisite\tmissing\n❯'] },
  ] });
  const result = run(['term_s', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT - term_s STOP 3 prerequisite missing\n');
});

// #413 第 1 項（investing#516 第 1 項、investing#533 第 2 項）：watch 印 `RESULT … DONE 437 <sha>`，之後畫面捲走結果行或 terminal 結束，
// 下一次 Probe 讀畫面只得到 RUNNING／STUCK exited，--apply 沒寫回，coordinator 只能手改。watch 讀到 batch 成員的結果行時記進
// `<checkpoint 目錄>/results/<handle>`（`<ISO 時間> <結果行>`），Probe 畫面上沒有結果行時改讀它。
test('batch 成員印 RESULT 時把結果行記進 results/<handle>；直接給的 handle 不記', t => {
  const { batch, pilot, run } = fixture(t, {
    term_436: [{ status: 'running', tail: [`DONE 436 ${SHA}`, '❯'] }],
    term_x: [{ status: 'running', tail: [] }, { status: 'running', tail: ['STOP 9 decision x'] }],
  });
  batch('436', [{ n: 436, handle: 'term_436' }]);
  const before = Date.now();
  const result = run(['--batch', '436', '--checkout', 'checkout', ...fast]);
  assert.equal(result.stdout, `RESULT 436 term_436 DONE 436 ${SHA}\n`);
  const [time, ...line] = readFileSync(join(pilot, 'results', 'term_436'), 'utf8').trim().split(' ');
  assert.equal(line.join(' '), `DONE 436 ${SHA}`);
  assert.ok(Date.parse(time) >= before - 1000, time);
  assert.equal(run(['term_x', ...fast]).stdout, 'RESULT - term_x STOP 9 decision x\n');
  assert.throws(() => readFileSync(join(pilot, 'results', 'term_x')), /ENOENT/);
});

// CoS item 67：worker 印 DONE 後要等到下一個 interval（預設 60 秒）watcher 才讀到；改成工作中的 worker 一閒置就叫醒 watcher。
const WORKING = ['✻ Running checks… (3m 2s · esc to interrupt)'];
test('上一輪畫面工作中：兩輪之間起 tui-idle 等待，worker 一閒置就讀畫面印 RESULT，不等 interval', t => {
  const { run, waits } = fixture(t, { term_67: [
    { status: 'running', tail: WORKING },
    { status: 'running', tail: ['● 報告', `DONE 67 ${SHA}`, '❯'] },
  ] }, { term_67: 300 });
  const started = Date.now();
  // interval 60 秒：只靠計時就會被 spawnSync 的 20 秒逾時殺掉。
  const result = run(['term_67', '--interval', '60']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT - term_67 DONE 67 ${SHA}\n`);
  assert.ok(Date.now() - started < 15000, `花了 ${Date.now() - started} 毫秒`);
  assert.match(waits(), /^terminal wait --terminal term_67 --for tui-idle --timeout-ms 60000 --json$/m);
});

test('上一輪畫面已閒置（等背景檢查）：不起 tui-idle 等待，照 interval 輪詢', t => {
  const { run, waits } = fixture(t, { term_68: [
    { status: 'running', tail: ['● 等背景的 bin/check', '❯'] },
    { status: 'running', tail: ['● 等背景的 bin/check', '❯'] },
    { status: 'running', tail: [`DONE 68 ${SHA}`, '❯'] },
  ] });
  const result = run(['term_68', '--interval', '0.05']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT - term_68 DONE 68 ${SHA}\n`);
  assert.equal(waits(), '', '閒置畫面起 tui-idle 等待會立刻成立而空轉');
});

test('wakeOnIdle：waitIdle 回 true 提早醒並中止其餘等待；回 false 或失敗不提早醒', async () => {
  const { wakeOnIdle } = await import('./pilot-watch.mjs');
  const aborted = [];
  const pending = (handle, signal) => new Promise(resolve => signal.addEventListener('abort', () => { aborted.push(handle); resolve(false); }));
  let slept = 0;
  const fakeSleep = (ms, _, { signal }) => new Promise((resolve, reject) => {
    slept = ms;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await wakeOnIdle(60000, ['a', 'b'], (handle, signal) => (handle === 'a' ? Promise.resolve(true) : pending(handle, signal)), fakeSleep);
  assert.equal(slept, 60000);
  assert.deepEqual(aborted, ['b'], '醒來時中止還在等的 tui-idle');

  // false 與失敗都不算：只有計時結束才醒。
  let ticks = 0;
  const shortSleep = () => new Promise(resolve => setTimeout(() => { ticks++; resolve(); }, 20));
  await wakeOnIdle(20, ['x', 'y'], handle => (handle === 'x' ? Promise.resolve(false) : Promise.reject(new Error('terminal_handle_stale'))), shortSleep);
  assert.equal(ticks, 1);
});

// #502（investing#609 第 1 項，investing#601）：候選落地後必須立刻跑一次的指令只寫在 worker 報告內文，coordinator 看不到，
// 落地到有人跑之前每次 sync 都 exit 3。worker 在 DONE 之前印 `POSTLAND <n> <command>`，watch 把它記進 batch checkpoint 的 `postland:` 行。
const POSTLAND = 'scripts/project-sync.py --setup-status-field --apply';
test('#601 的報告形狀（一行 POSTLAND 在 DONE 之前）：指令記進 checkpoint，RESULT 照舊', t => {
  const { batch, pilot, run } = fixture(t, { term_601: [{ status: 'running', tail: [
    '● ## Autonomous decisions', '  - [reversible] Status 改六欄', '', `  POSTLAND 601 ${POSTLAND}`, `  DONE 601 ${SHA}`, '', '❯'] }] });
  batch('601', [{ n: 601, handle: 'term_601' }]);
  const result = run(['--batch', '601', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 601 term_601 DONE 601 ${SHA}\n`);
  assert.match(readFileSync(join(pilot, 'batch-601.md'), 'utf8'), new RegExp(`\\npostland: #601 ${POSTLAND.replace(/[.*]/g, '\\$&')}\\n$`));
});

test('多行 POSTLAND 都記下，順序同畫面；同一個 <n> 重跑 watch 不重複記；resume 前的舊 POSTLAND 與別的號碼不記', t => {
  const old = `DONE 602 ${'a'.repeat(40)}`;
  const { batch, pilot, run } = fixture(t, { term_602: [{ status: 'running', tail: [
    'POSTLAND 602 echo old', old, '● 重做', 'POSTLAND 602 make sync', '│ POSTLAND 602 node scripts/x.mjs --apply │', 'POSTLAND 9 echo other', 'POSTLAND 602 make sync', `DONE 602 ${SHA}`, '❯'] }] });
  batch('602', [{ n: 602, handle: 'term_602' }], `resumed: #602 2026-11-21T10:00:00+08:00 ${old}\n`);
  const args = ['--batch', '602', '--checkout', 'checkout', ...fast];
  assert.equal(run(args).stdout, `RESULT 602 term_602 DONE 602 ${SHA}\n`);
  assert.equal(run(args).stdout, `RESULT 602 term_602 DONE 602 ${SHA}\n`);
  const lines = readFileSync(join(pilot, 'batch-602.md'), 'utf8').split('\n').filter(line => line.startsWith('postland:'));
  assert.deepEqual(lines, ['postland: #602 node scripts/x.mjs --apply', 'postland: #602 make sync']);
});

test('結果是 STOP 時不記 POSTLAND；沒有 POSTLAND 時 checkpoint 一個字都不改', t => {
  const { batch, pilot, run } = fixture(t, {
    term_603: [{ status: 'running', tail: ['POSTLAND 603 make sync', 'STOP 603 decision x'] }],
    term_604: [{ status: 'running', tail: [`DONE 604 ${SHA}`] }],
  });
  batch('603', [{ n: 603, handle: 'term_603' }, { n: 604, handle: 'term_604' }]);
  const before = readFileSync(join(pilot, 'batch-603.md'), 'utf8');
  assert.equal(run(['--batch', '603', '--checkout', 'checkout', ...fast]).stdout, `RESULT 603 term_603 STOP 603 decision x\nRESULT 603 term_604 DONE 604 ${SHA}\n`);
  assert.equal(readFileSync(join(pilot, 'batch-603.md'), 'utf8'), before);
});

test('from-state 的 DONE：已結束畫面上的 POSTLAND 也記下（EXITED 的不記）', t => {
  const { temp, batch, pilot, run } = fixture(t, {
    term_605: [{ status: 'exited', tail: ['POSTLAND 605 make sync', '● 結束'] }],
    term_606: [{ status: 'exited', tail: ['POSTLAND 606 make sync'] }],
  });
  const worktree = join(temp, 'wt');
  const git = (...args) => spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8', env });
  spawnSync('git', ['init', '-q', worktree], { env });
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'c');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  mkdirSync(join(temp, 'notes/issue-605'), { recursive: true });
  writeFileSync(join(temp, 'notes/issue-605/state.md'), `State: done, candidate ${head}\n`);
  batch('605', [{ n: 605, handle: 'term_605', worktree }, { n: 606, handle: 'term_606', worktree }]);
  const result = run(['--batch', '605', '--checkout', 'checkout', '--worker-state', join(temp, 'notes/issue-<n>/state.md'), ...fast]);
  assert.equal(result.stdout, `RESULT 605 term_605 DONE 605 ${head} from-state\nEXITED 605 term_606\n`);
  const lines = readFileSync(join(pilot, 'batch-605.md'), 'utf8').split('\n').filter(line => line.startsWith('postland:'));
  assert.deepEqual(lines, ['postland: #605 make sync']);
});

// #502 × #537：DONE 已捲出畫面、從累積輸出讀到時，它之前的 POSTLAND 也只在累積輸出裡，要從同一份讀。
test('結果行從累積輸出讀到（#537）時，累積輸出裡 DONE 之前的 POSTLAND 也記下', t => {
  const { batch, pilot, run } = fixture(t, { term_607: [{ status: 'running', tail: ['  報告最後一行', '❯'],
    scrollback: [`POSTLAND 607 ${POSTLAND}`, `DONE 607 ${SHA}`, '  報告最後一行', '❯'] }] });
  batch('607', [{ n: 607, handle: 'term_607' }]);
  const result = run(['--batch', '607', '--checkout', 'checkout', ...fast]);
  assert.equal(result.stdout, `RESULT 607 term_607 DONE 607 ${SHA}\n`);
  const lines = readFileSync(join(pilot, 'batch-607.md'), 'utf8').split('\n').filter(line => line.startsWith('postland:'));
  assert.deepEqual(lines, [`postland: #607 ${POSTLAND}`]);
});

// #573：WSL 重開後 batch 只重派 #501，#502 的舊 terminal 已結束（成員列仍是 running）；舊版第一輪就印 EXITED #502 而結束，watcher 等於沒在看 #501。
test('batch 成員 A 活著、成員 B 的舊 terminal 一開始就已結束：不因 B 結束，等 A 的結果（#573）', t => {
  const { batch, run } = fixture(t, {
    term_501: [{ status: 'running', tail: ['● 工作中'] }, { status: 'running', tail: [`DONE 501 ${SHA}`] }],
    term_502: [{ status: 'exited', tail: [] }],
  });
  batch('501-502', [{ n: 501, handle: 'term_501' }, { n: 502, handle: 'term_502' }]);
  const result = run(['--batch', '501-502', '--checkout', 'checkout', ...fast]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `RESULT 501-502 term_501 DONE 501 ${SHA}\n`);
});

test('batch 成員 A 活著時結束（不是一開始就已結束）：照樣印 EXITED（#573）', t => {
  const { batch, run } = fixture(t, {
    term_501: [{ status: 'running', tail: ['● 工作中'] }, { status: 'exited', tail: [] }],
    term_502: [{ status: 'exited', tail: [] }],
  });
  batch('501-502', [{ n: 501, handle: 'term_501' }, { n: 502, handle: 'term_502' }]);
  const result = run(['--batch', '501-502', '--checkout', 'checkout', ...fast]);
  assert.equal(result.stdout, 'EXITED 501-502 term_501\n');
});
