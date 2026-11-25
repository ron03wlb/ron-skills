// check-adapter-size.mjs（setup-workflow 正本）：--headroom 輸出、`#after:` 本文條目的計算、超預算照原本方式報錯（#647）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = new URL('../skills/engineering/setup-workflow/templates/check-adapter-size.mjs', import.meta.url).pathname;

/** 暫存 root：files 是 { 路徑: 內容 }，table 寫成預算表。 */
function fixture(files, table) {
  const root = mkdtempSync(join(realTmpdir(), 'adapter-size-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  writeFileSync(join(root, 'scripts/adapter-size-budget.json'), JSON.stringify(table));
  return root;
}
const run = (root, ...args) => spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });

test('--headroom 每份受預算管的檔印一行 HEADROOM <檔> <剩餘> <目前>/<上限>，exit 0，不印通過行', () => {
  const root = fixture({ 'a.md': 'x'.repeat(30), 'b.md': 'y'.repeat(10) }, { 'a.md': 100, 'b.md': 50, 'gone.md': 10 });
  const result = run(root, '--headroom');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'HEADROOM a.md 70 30/100\nHEADROOM b.md 40 10/50\n');
});

test('`<路徑>#after:<標記>` 只算第一個標記之後的位元組（以 bytes 計），標記找不到時整檔都算', () => {
  const root = fixture({ 't.md': '註解-->本文 abc-->後面', 'u.md': 'abcde' }, { 't.md#after:-->': 100, 'u.md#after:-->': 100 });
  const [t, u] = run(root, '--headroom').stdout.trim().split('\n');
  assert.equal(t, `HEADROOM t.md#after:--> ${100 - Buffer.byteLength('本文 abc-->後面')} ${Buffer.byteLength('本文 abc-->後面')}/100`);
  assert.equal(u, 'HEADROOM u.md#after:--> 95 5/100');
});

test('超預算：--headroom 仍 exit 0 且剩餘為負；不帶 --headroom 照原本 ADAPTER_SIZE_OVER、exit 1', () => {
  const root = fixture({ 't.md': '-->' + 'z'.repeat(20) }, { 't.md#after:-->': 15 });
  const headroom = run(root, '--headroom');
  assert.equal(headroom.status, 0);
  assert.equal(headroom.stdout, 'HEADROOM t.md#after:--> -5 20/15\n');
  const check = run(root);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /^ADAPTER_SIZE_OVER t\.md#after:--> 20 > 15$/m);
});

test('沒超預算：舊格式的路徑鍵照舊印 `<檔> <bytes>／<預算>，餘裕 <n> bytes` 與通過行', () => {
  const root = fixture({ 'a.md': 'x'.repeat(5) }, { 'a.md': 2000 });
  const result = run(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^a\.md 5／2000，餘裕 1995 bytes$/m);
  assert.match(result.stdout, /adapter 檔大小預算檢查通過。/);
});
