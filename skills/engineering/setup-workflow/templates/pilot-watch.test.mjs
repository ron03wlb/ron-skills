import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./pilot-watch.mjs', import.meta.url).pathname;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const SHA = 'b'.repeat(40);

// 假 Orca：`screens` 是 handle → 依序回的畫面（`{ status, tail }`，或 `{ raw }` 原樣印出、不經 JSON.stringify）；讀完最後一個之後一直回最後一個。
// 不在表裡的 handle 回 terminal_handle_stale。每次呼叫記進 orca.log。
function fixture(t, screens = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-watch-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
const screens = ${JSON.stringify(screens)};
const handle = arg('--terminal');
const list = screens[handle];
if (!list) { fail('terminal_handle_stale'); process.exit(1); }
const counter = ${JSON.stringify(join(temp, 'count-'))} + handle;
const i = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(i + 1));
const screen = list[Math.min(i, list.length - 1)];
if (screen.raw !== undefined) process.stdout.write(screen.raw);
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
${members.map(m => `| ${m.n} | issue/${m.n}-x | /w/issue-${m.n} | ${m.handle} | 2026-11-21T09:00:00+08:00 | 90m | ${m.state ?? 'running'} | |`).join('\n')}
${extra}`);
  const run = (args, extraEnv = { ORCA_CLI_COMMAND: cli }) =>
    spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, cwd: temp, timeout: 20000 });
  const reads = handle => readFileSync(log, 'utf8').split('\n').filter(line => line.includes(`--terminal ${handle} `)).length;
  return { temp, pilot, batch, run, reads, cli };
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
