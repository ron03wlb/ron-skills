import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-sources.mjs', import.meta.url));
const checkout = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-sources-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs/agents'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), 'rules\n');
  writeFileSync(join(dir, 'docs/agents/pilot.md'), 'pilot v1\n');
  return dir;
};
const run = (dir, ...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8' });
const SOURCES = ['AGENTS.md', 'docs/agents/pilot.md'];
const sha = text => createHash('sha256').update(text).digest('hex');

test('沒有記錄：每個來源都印 SOURCE_CHANGED，不寫記錄', t => {
  const dir = checkout(t);
  const result = run(dir, ...SOURCES);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_CHANGED AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\n');
  assert.throws(() => readFileSync(join(dir, '.scratch/pilot/sources')));
});

test('--record 先回報變動再寫記錄（每行 `<sha256>   <path>`），印 RECORDED <n>；之後沒有變動就只印 RECORDED', t => {
  const dir = checkout(t);
  const first = run(dir, '--record', ...SOURCES);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'SOURCE_CHANGED AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\nRECORDED 2\n');
  assert.equal(readFileSync(join(dir, '.scratch/pilot/sources'), 'utf8'), `${sha('rules\n')}   AGENTS.md\n${sha('pilot v1\n')}   docs/agents/pilot.md\n`);
  assert.equal(run(dir, ...SOURCES).stdout, '');
  assert.equal(run(dir, '--record', ...SOURCES).stdout, 'RECORDED 2\n');
});

test('改過的來源印 SOURCE_CHANGED；不存在的來源印 SOURCE_MISSING，不中止', t => {
  const dir = checkout(t);
  run(dir, '--record', ...SOURCES);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), 'pilot v2\n');
  rmSync(join(dir, 'AGENTS.md'));
  const result = run(dir, ...SOURCES, 'skills/x/SKILL.md');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_MISSING AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\nSOURCE_MISSING skills/x/SKILL.md\n');
});

test('來源從 checkout 解析，與呼叫者的 cwd 無關；也接受絕對路徑', t => {
  const dir = checkout(t);
  const result = spawnSync('node', [SCRIPT, dir, '--record', 'AGENTS.md', join(dir, 'docs/agents/pilot.md')], { encoding: 'utf8', cwd: realTmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_CHANGED AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\nRECORDED 2\n');
});

test('checkout 裡以 .. 開頭的檔名仍記成相對路徑', t => {
  const dir = checkout(t);
  writeFileSync(join(dir, '..notes.md'), 'x\n');
  assert.equal(run(dir, '--record', join(dir, '..notes.md')).stdout, 'SOURCE_CHANGED ..notes.md\nRECORDED 1\n');
});

test('經由 symlink 路徑執行仍會跑（macOS 的 /tmp 是 /private/tmp 的 symlink）', t => {
  const dir = checkout(t);
  const link = join(dir, 'link.mjs');
  symlinkSync(SCRIPT, link);
  const result = spawnSync('node', [link, dir, 'AGENTS.md'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_CHANGED AGENTS.md\n');
});

test('沒給來源：exit 2', t => {
  assert.equal(run(checkout(t)).status, 2);
  assert.equal(run(checkout(t), '--record').status, 2);
});
