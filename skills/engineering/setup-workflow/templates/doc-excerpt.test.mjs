// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./doc-excerpt.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8' });

test('長單行只印比對處前後，帶檔名與行號；同一行不相鄰的兩處以 … 串在同一行；沒相符 exit 1；用法錯誤 exit 2', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'excerpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.md');
  writeFileSync(file, `短行\n${'前'.repeat(100)}BEHIND_MAIN${'後'.repeat(100)}BEHIND_MAIN${'尾'.repeat(5)}\n`);

  const result = run('BEHIND_MAIN', file, '--width', '3');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${file}:2: …前前前BEHIND_MAIN後後後…後後後BEHIND_MAIN尾尾尾…\n`);
  assert.equal(run('短行', file).stdout, `${file}:1: 短行…\n`.replace('…', ''));
  assert.equal(run('NOPE', file).status, 1);
  assert.equal(run('x').status, 2);
  assert.equal(run('(', file).status, 2);
  assert.equal(run('x', join(dir, 'none.md')).status, 2);
});

test('同一行多處相符、前後文重疊或相鄰時併成一段，不重複印（#528）', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'excerpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.md');
  // 仿 **Probe lines.**：一行裡 PARKED、UNBLOCKED 靠得很近、命中多次，遠處再一次
  writeFileSync(file, `- **Probe lines.** \`PARKED <n>\` 與 \`UNBLOCKED <n>\`：PARKED 先看${'中'.repeat(40)}UNBLOCKED 尾\n`);
  const result = run('PARKED|UNBLOCKED', file, '--width', '8');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${file}:1: …nes.** \`PARKED <n>\` 與 \`UNBLOCKED <n>\`：PARKED 先看${'中'.repeat(5)}…${'中'.repeat(8)}UNBLOCKED 尾\n`);
  // 相鄰（前一段的結尾正好是下一段的開頭）也併成一段
  writeFileSync(file, 'xxabyyyyabzz\n');
  assert.equal(run('ab', file, '--width', '2').stdout, `${file}:1: xxabyyyyabzz\n`);
});
