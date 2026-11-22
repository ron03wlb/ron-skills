// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-request.mjs', import.meta.url));
const REQUESTS = [
  '# Requests',
  '2026-10-30T20:00:00+08:00   優先做 #27   source demo-0a',
  '2026-10-30T20:05:00+08:00  hold 到 #30 合入  source demo-0b',
  '2026-10-30T20:10:00+08:00   不要 applied 2 次   source demo-0c   applied 2026-10-30T20:11:00+08:00',
  '2026-10-30T20:20:00+08:00   declined 的 source 也算內文   source demo-0d',
  '',
].join('\n');
const checkout = (t, text = REQUESTS) => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-request-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(dir, '.scratch/pilot/requests.md'), text);
  return dir;
};
const run = (dir, ...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8' });
const lines = dir => readFileSync(join(dir, '.scratch/pilot/requests.md'), 'utf8').split('\n');

test('list：每個還開著的 request 印 REQUEST <行號>   <原文>；兩個空白的舊格式、內文提到 applied／declined／source 都照樣算開著', t => {
  const result = run(checkout(t), 'list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'REQUEST 2   2026-10-30T20:00:00+08:00   優先做 #27   source demo-0a',
    'REQUEST 3   2026-10-30T20:05:00+08:00  hold 到 #30 合入  source demo-0b',
    'REQUEST 5   2026-10-30T20:20:00+08:00   declined 的 source 也算內文   source demo-0d',
    '',
  ].join('\n'));
});

test('沒有 requests.md：list 不輸出、exit 0', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-request-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, 'list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('apply <行號>：在同一行附加 `   applied <time>`（可帶 note），之後 list 不再列出', t => {
  const dir = checkout(t);
  const result = run(dir, 'apply', '2', '--note', '已排進 batch 27');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'APPLIED 2\n');
  assert.match(lines(dir)[1], /^2026-10-30T20:00:00\+08:00   優先做 #27   source demo-0a   applied \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d   已排進 batch 27$/);
  assert.ok(!run(dir, 'list').stdout.includes('REQUEST 2 '));
  assert.equal(lines(dir).length, REQUESTS.split('\n').length);
});

test('decline <行號> --reason：附加 `   declined <reason>`', t => {
  const dir = checkout(t);
  const result = run(dir, 'decline', '5', '--reason', '已經有 hold');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'DECLINED 5\n');
  assert.equal(lines(dir)[4], '2026-10-30T20:20:00+08:00   declined 的 source 也算內文   source demo-0d   declined 已經有 hold');
});

// 沒有 source 欄的行 reader 一律當成開著；只附加標記關不掉，所以先補上 `source unknown`。
test('沒有 source 欄的行：apply 先補 `   source unknown` 再標記，之後 list 不再列出', t => {
  const dir = checkout(t, '2026-10-30T20:00:00+08:00   重跑 probe\n');
  const result = run(dir, 'apply', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(lines(dir)[0], /^2026-10-30T20:00:00\+08:00   重跑 probe   source unknown   applied \S+$/);
  assert.equal(run(dir, 'list').stdout, '');
});

test('行號不是開著的 request：印 NOT_OPEN <行號>、exit 1、不改檔', t => {
  const dir = checkout(t);
  for (const line of ['1', '4', '6', '99']) {
    const result = run(dir, 'apply', line);
    assert.equal(result.status, 1, line);
    assert.equal(result.stdout, `NOT_OPEN ${line}\n`);
  }
  assert.equal(lines(dir).join('\n'), REQUESTS);
});

test('用法錯誤：exit 2（decline 沒給 reason、reason 含三個空白、行號不是數字）', t => {
  const dir = checkout(t);
  assert.equal(run(dir, 'decline', '2').status, 2);
  assert.equal(run(dir, 'decline', '2', '--reason', 'a   b').status, 2);
  assert.equal(run(dir, 'apply', 'x').status, 2);
  // 標記之後再出現 ` source ` 會讓 reader 只看它後面的字，那一行又變回開著。
  assert.equal(run(dir, 'decline', '2', '--reason', '另一個 source 已處理').status, 2);
  assert.equal(run(dir, 'apply', '2', '--note', 'source x').status, 2);
  assert.equal(lines(dir).join('\n'), REQUESTS);
  assert.equal(run(dir, 'bogus').status, 2);
});

// investing#472 第 2 項：非 pilot session 交 request 要翻 PILOT-STORE 才找得到行格式，手寫容易寫錯分欄。
test('add <內文> --source <session>：附加 `<time>   <內文>   source <session>`，印 ADDED <行號>，之後 list 列出', t => {
  const dir = checkout(t);
  const result = run(dir, 'add', '請合入 issue/52-x（#52）', '--source', 'demo-0e');
  assert.equal(result.status, 0, result.stderr);
  const n = REQUESTS.split('\n').length;
  assert.equal(result.stdout, `ADDED ${n}\n`);
  assert.match(lines(dir)[n - 1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d   請合入 issue\/52-x（#52）   source demo-0e$/);
  assert.equal(lines(dir).at(-1), '');
  assert.match(run(dir, 'list').stdout, new RegExp(`^REQUEST ${n}   .*source demo-0e$`, 'm'));
});

test('add：沒有 requests.md 時建立它；檔尾沒有換行時先補上', t => {
  const fresh = mkdtempSync(join(realTmpdir(), 'pilot-request-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  assert.equal(run(fresh, 'add', '暫停到 #30', '--source', 's1').stdout, 'ADDED 1\n');
  assert.match(lines(fresh)[0], /   暫停到 #30   source s1$/);
  const dir = checkout(t, '# Requests');
  assert.equal(run(dir, 'add', '優先做 #31', '--source', 's2').stdout, 'ADDED 2\n');
  assert.equal(lines(dir)[0], '# Requests');
});

test('add 用法錯誤：exit 2、不改檔（沒有 --source、內文含 source 字樣或三個空白、source 含 applied／declined）', t => {
  for (const args of [
    ['add', '優先做 #27'],
    ['add', '優先做 #27', '--source'],
    ['add', '改 source 再說', '--source', 's1'],
    ['add', 'a   b', '--source', 's1'],
    ['add', '優先做 #27', '--source', 'applied x'],
    ['add', '#27 開頭像標題', '--source', 's1'],
    ['add', '優先做 #27', '--source', 's1', '--note', 'x'],
  ]) {
    const dir = checkout(t);
    const result = run(dir, ...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(lines(dir).join('\n'), REQUESTS, args.join(' '));
  }
});
