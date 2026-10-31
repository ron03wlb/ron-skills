import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { COORDINATOR_SCRIPTS, missingAllows } from '../scripts/check-coordinator-permissions.mjs';

const script = new URL('../scripts/check-coordinator-permissions.mjs', import.meta.url).pathname;
const allow = names => ({ permissions: { allow: names.map(name => `Bash(node scripts/${name}:*)`) } });

// 暫存 settings 檔後跑 CLI。
function run(t, settings) {
  const dir = mkdtempSync(join(realTmpdir(), 'coordinator-permissions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(settings));
  return spawnSync('node', [script, file], { encoding: 'utf8' });
}

test('清單至少有 land.mjs、pilot-close.mjs、gh-tracker.mjs', () => {
  for (const name of ['land.mjs', 'pilot-close.mjs', 'gh-tracker.mjs']) assert.ok(COORDINATOR_SCRIPTS.includes(name), name);
});

test('#131 之前的設定（只放行 gh-tracker）：exit 1，列出 land.mjs 與 pilot-close.mjs', t => {
  const settings = allow(['gh-tracker.mjs']);
  assert.deepEqual(missingAllows(settings), ['land.mjs', 'pilot-close.mjs']);
  const result = run(t, settings);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^land\.mjs：Bash\(node scripts\/land\.mjs:\*\)$/m);
  assert.match(result.stderr, /^pilot-close\.mjs：Bash\(node scripts\/pilot-close\.mjs:\*\)$/m);
  assert.doesNotMatch(result.stderr, /gh-tracker/);
});

test('三條齊全：exit 0', t => {
  const settings = allow(['gh-tracker.mjs', 'land.mjs', 'pilot-close.mjs']);
  assert.deepEqual(missingAllows(settings), []);
  assert.equal(run(t, settings).status, 0);
});

test('規則寫成別的形式（少了 :*、放在 ask）不算放行', () => {
  const settings = { permissions: {
    allow: ['Bash(node scripts/gh-tracker.mjs:*)', 'Bash(node scripts/land.mjs)'],
    ask: ['Bash(node scripts/pilot-close.mjs:*)'],
  } };
  assert.deepEqual(missingAllows(settings), ['land.mjs', 'pilot-close.mjs']);
  assert.deepEqual(missingAllows({}), [...COORDINATOR_SCRIPTS]);
});

test('repo 自己的 .claude/settings.json 通過', () => {
  const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  assert.deepEqual(missingAllows(settings), []);
});

test('pilot.md 的 Permissions 條目列出 allow 的每條規則，且只列這些', () => {
  const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  const pilot = readFileSync(new URL('../docs/agents/pilot.md', import.meta.url), 'utf8');
  const entry = pilot.split('\n').find(line => line.startsWith('- **Permissions.**'));
  assert.ok(entry, 'pilot.md 沒有 Permissions 條目');
  const listed = [...entry.matchAll(/`(Bash\([^`]*\))`/g)].map(m => m[1]).sort();
  assert.deepEqual(listed, [...settings.permissions.allow].sort());
});
