import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-decision.mjs', import.meta.url));
const HEADER = '| time | decision | reason | evidence | result |\n|---|---|---|---|---|\n';
const checkout = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-decision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  return dir;
};
const run = (dir, ...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8' });
const file = dir => join(dir, '.scratch/pilot/decisions.md');
const add = (dir, extra = []) => run(dir, '--time', '2026-10-31T06:00:00+08:00', '--decision', '派出 batch 56', '--reason', 'pool 最小', '--evidence', '.scratch/pilot/batch-56.md', '--result', 'ok', ...extra);

test('沒有檔案：建出 # Decisions 標題與表頭，附加一列，印 DECISION <time>', t => {
  const dir = checkout(t);
  const result = add(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'DECISION 2026-10-31T06:00:00+08:00\n');
  assert.equal(readFileSync(file(dir), 'utf8'), `# Decisions\n\n${HEADER}| 2026-10-31T06:00:00+08:00 | 派出 batch 56 | pool 最小 | .scratch/pilot/batch-56.md | ok |\n`);
});

test('既有檔案只附加一列；檔尾沒有換行時先補', t => {
  const dir = checkout(t);
  writeFileSync(file(dir), `# Decisions\n\n${HEADER}| a | b | c | d | e |`);
  assert.equal(add(dir).status, 0);
  assert.equal(readFileSync(file(dir), 'utf8'), `# Decisions\n\n${HEADER}| a | b | c | d | e |\n| 2026-10-31T06:00:00+08:00 | 派出 batch 56 | pool 最小 | .scratch/pilot/batch-56.md | ok |\n`);
});

test('沒給 --time 用現在時間（帶時差）', t => {
  const dir = checkout(t);
  const result = run(dir, '--decision', 'd', '--reason', 'r', '--evidence', 'e', '--result', 'ok');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^DECISION \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d\n$/);
});

test('欄位含 | 或換行、缺欄位：exit 2，不寫檔', t => {
  const dir = checkout(t);
  assert.equal(add(dir, ['--reason', 'a | b']).status, 2);
  assert.equal(add(dir, ['--result', 'a\nb']).status, 2);
  assert.equal(run(dir, '--decision', 'd').status, 2);
  assert.equal(add(dir, ['--time', 'yesterday']).status, 2);
  assert.throws(() => readFileSync(file(dir)));
});

// pilot-unbare.sh 在檔案不存在時只附加列，表格前就沒有標題與表頭；空行也會把表格切成兩段。
test('--repair 補上標題與表頭、移除表格中間的空行與重複表頭，印 REPAIRED', t => {
  const dir = checkout(t);
  writeFileSync(file(dir), `| a | 還原 core.bare | b | c | d |\n\n${HEADER}| e | f | g | h | i |\n`);
  const result = run(dir, '--repair');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'REPAIRED\n');
  assert.equal(readFileSync(file(dir), 'utf8'), `# Decisions\n\n${HEADER}| a | 還原 core.bare | b | c | d |\n| e | f | g | h | i |\n`);
  assert.equal(run(dir, '--repair').stdout, 'OK\n');
});

test('--repair 認得手寫的 `| --- |` 分隔列與多空白的表頭，換成標準表頭', t => {
  const dir = checkout(t);
  writeFileSync(file(dir), '# Decisions\n\n|  time | decision | reason | evidence | result |\n| --- | --- | --- | --- | --- |\n| a | b | c | d | e |\n');
  assert.equal(run(dir, '--repair').stdout, 'REPAIRED\n');
  assert.equal(readFileSync(file(dir), 'utf8'), `# Decisions\n\n${HEADER}| a | b | c | d | e |\n`);
});

test('--repair 遇到不是表格列或欄數不對的行：印 MALFORMED <行號> <行>、exit 1、不改檔', t => {
  const dir = checkout(t);
  const text = `# Decisions\n\n${HEADER}| a | b | c | d | e |\n隨手寫的備註\n| x | y |\n`;
  writeFileSync(file(dir), text);
  const result = run(dir, '--repair');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'MALFORMED 6 隨手寫的備註\nMALFORMED 7 | x | y |\n');
  assert.equal(readFileSync(file(dir), 'utf8'), text);
});
