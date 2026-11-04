import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./doc-excerpt.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8' });

test('長單行只印比對處前後，每處一行，帶檔名與行號；沒相符 exit 1；用法錯誤 exit 2', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'excerpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.md');
  writeFileSync(file, `短行\n${'前'.repeat(100)}BEHIND_MAIN${'後'.repeat(100)}BEHIND_MAIN${'尾'.repeat(5)}\n`);

  const result = run('BEHIND_MAIN', file, '--width', '3');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${file}:2: …前前前BEHIND_MAIN後後後…\n${file}:2: …後後後BEHIND_MAIN尾尾尾…\n`);
  assert.equal(run('短行', file).stdout, `${file}:1: 短行…\n`.replace('…', ''));
  assert.equal(run('NOPE', file).status, 1);
  assert.equal(run('x').status, 2);
  assert.equal(run('(', file).status, 2);
  assert.equal(run('x', join(dir, 'none.md')).status, 2);
});
