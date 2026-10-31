import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { PUSH_SCRIPTS, TRACKER_SCRIPTS, allowRule, permissionProblems } from './check-coordinator-permissions.mjs';

const SCRIPT = fileURLToPath(new URL('./check-coordinator-permissions.mjs', import.meta.url));
const allow = names => ({ permissions: { allow: names.map(allowRule) } });

// 暫存 repo：.claude/settings.json 與 scripts/ 下的腳本（預設三支都有），在 repo 根跑 CLI。
function run(t, settings, flags = [], scripts = [...TRACKER_SCRIPTS, ...PUSH_SCRIPTS]) {
  const dir = mkdtempSync(join(realTmpdir(), 'coordinator-permissions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.claude'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  for (const name of scripts) writeFileSync(join(dir, 'scripts', name), '');
  return spawnSync('node', [SCRIPT, ...flags], { cwd: dir, encoding: 'utf8' });
}

test('清單：tracker 寫入是 gh-tracker；push 放行是 land 與 pilot-close', () => {
  assert.deepEqual(TRACKER_SCRIPTS, ['gh-tracker.mjs']);
  assert.deepEqual(PUSH_SCRIPTS, ['land.mjs', 'pilot-close.mjs']);
  assert.equal(allowRule('land.mjs'), 'Bash(node scripts/land.mjs:*)');
});

test('push 答否（預設）：只要 gh-tracker；有 land 或 pilot-close 的放行規則反而 exit 1', t => {
  assert.deepEqual(permissionProblems(allow(['gh-tracker.mjs'])), { missing: [], extra: [], absent: [] });
  assert.equal(run(t, allow(['gh-tracker.mjs'])).status, 0);
  const settings = allow(['gh-tracker.mjs', 'land.mjs']);
  assert.deepEqual(permissionProblems(settings), { missing: [], extra: ['land.mjs'], absent: [] });
  const result = run(t, settings);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--push/);
  assert.match(result.stderr, /^land\.mjs：Bash\(node scripts\/land\.mjs:\*\)$/m);
});

test('push 答是（--push）：三條都要，缺的列出來', t => {
  const settings = allow(['gh-tracker.mjs']);
  assert.deepEqual(permissionProblems(settings, { push: true }), { missing: ['land.mjs', 'pilot-close.mjs'], extra: [], absent: [] });
  const result = run(t, settings, ['--push']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^land\.mjs：Bash\(node scripts\/land\.mjs:\*\)$/m);
  assert.match(result.stderr, /^pilot-close\.mjs：Bash\(node scripts\/pilot-close\.mjs:\*\)$/m);
  assert.doesNotMatch(result.stderr, /gh-tracker/);
  assert.equal(run(t, allow(['gh-tracker.mjs', 'land.mjs', 'pilot-close.mjs']), ['--push']).status, 0);
});

test('沒有 gh-tracker 的放行規則：兩種答案都 exit 1', t => {
  assert.equal(run(t, {}).status, 1);
  assert.equal(run(t, allow(['land.mjs', 'pilot-close.mjs']), ['--push']).status, 1);
});

test('規則寫成別的形式（少了 :*、放在 ask）不算放行', () => {
  const settings = { permissions: {
    allow: ['Bash(node scripts/gh-tracker.mjs:*)', 'Bash(node scripts/land.mjs)'],
    ask: ['Bash(node scripts/pilot-close.mjs:*)'],
  } };
  assert.deepEqual(permissionProblems(settings, { push: true }).missing, ['land.mjs', 'pilot-close.mjs']);
  assert.deepEqual(permissionProblems({}).missing, ['gh-tracker.mjs']);
});

test('不認得的旗標：exit 2', t => {
  assert.equal(run(t, allow(['gh-tracker.mjs']), ['--yes']).status, 2);
});

// review #244：pilot-close.mjs 在 #245 之前不是正本，放行一個不存在的路徑等於預先放行之後放在那裡的任何腳本。
test('放行的腳本在 scripts/ 不存在：exit 1，列出來', t => {
  const settings = allow(['gh-tracker.mjs', 'land.mjs', 'pilot-close.mjs']);
  assert.deepEqual(permissionProblems(settings, { push: true, exists: name => name !== 'pilot-close.mjs' }).absent, ['pilot-close.mjs']);
  const result = run(t, settings, ['--push'], ['gh-tracker.mjs', 'land.mjs']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /不存在/);
  assert.match(result.stderr, /^pilot-close\.mjs：Bash\(node scripts\/pilot-close\.mjs:\*\)$/m);
  assert.equal(run(t, allow(['gh-tracker.mjs']), [], []).status, 1);
});
