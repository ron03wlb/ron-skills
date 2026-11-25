// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { PUSH_SCRIPTS, TRACKER_SCRIPTS, allowRule, permissionProblems, scriptFile } from './check-coordinator-permissions.mjs';

const SCRIPT = fileURLToPath(new URL('./check-coordinator-permissions.mjs', import.meta.url));
const allow = names => ({ permissions: { allow: names.map(allowRule) } });

// 暫存 repo：.claude/settings.json 與 scripts/ 下的腳本（預設清單裡的都有），在 repo 根跑 CLI。
function run(t, settings, flags = [], scripts = [...TRACKER_SCRIPTS, ...PUSH_SCRIPTS]) {
  const dir = mkdtempSync(join(realTmpdir(), 'coordinator-permissions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.claude'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  for (const name of scripts) writeFileSync(join(dir, 'scripts', scriptFile(name)), '');
  return spawnSync('node', [SCRIPT, ...flags], { cwd: dir, encoding: 'utf8' });
}

test('清單：tracker 寫入是 gh-tracker；push 放行是 land、pilot-close 與 pilot-land 的 push 子指令', () => {
  assert.deepEqual(TRACKER_SCRIPTS, ['gh-tracker.mjs']);
  assert.deepEqual(PUSH_SCRIPTS, ['land.mjs', 'pilot-close.mjs', 'pilot-land.mjs push']);
  assert.equal(allowRule('land.mjs'), 'Bash(node scripts/land.mjs:*)');
  assert.equal(allowRule('pilot-land.mjs push'), 'Bash(node scripts/pilot-land.mjs push:*)');
  assert.equal(scriptFile('pilot-land.mjs push'), 'pilot-land.mjs');
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

test('push 答是（--push）：每條都要，缺的列出來', t => {
  const settings = allow(['gh-tracker.mjs']);
  assert.deepEqual(permissionProblems(settings, { push: true }), { missing: ['land.mjs', 'pilot-close.mjs', 'pilot-land.mjs push'], extra: [], absent: [] });
  const result = run(t, settings, ['--push']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^land\.mjs：Bash\(node scripts\/land\.mjs:\*\)$/m);
  assert.match(result.stderr, /^pilot-close\.mjs：Bash\(node scripts\/pilot-close\.mjs:\*\)$/m);
  assert.match(result.stderr, /^pilot-land\.mjs push：Bash\(node scripts\/pilot-land\.mjs push:\*\)$/m);
  assert.doesNotMatch(result.stderr, /gh-tracker/);
  assert.equal(run(t, allow(['gh-tracker.mjs', ...PUSH_SCRIPTS]), ['--push']).status, 0);
});

// #395 G26：Push gate 入口只放行 push 子指令，stage、sync-main 不放行；沒有 pilot（scripts/ 沒有 pilot-land.mjs）的 repo 不要求。
test('pilot-land.mjs push：scripts/ 有 pilot-land.mjs 才要求；萬用字元規則不算', t => {
  const base = ['gh-tracker.mjs', 'land.mjs', 'pilot-close.mjs'];
  const noPilot = name => name !== 'pilot-land.mjs';
  assert.deepEqual(permissionProblems(allow(base), { push: true, exists: noPilot }), { missing: [], extra: [], absent: [] });
  assert.equal(run(t, allow(base), ['--push'], base).status, 0);
  const wildcard = { permissions: { allow: [...base.map(allowRule), 'Bash(node scripts/pilot-land.mjs:*)'] } };
  assert.deepEqual(permissionProblems(wildcard, { push: true }).missing, ['pilot-land.mjs push']);
  const absent = run(t, allow([...base, 'pilot-land.mjs push']), ['--push'], base);
  assert.equal(absent.status, 1, absent.stdout);
  assert.match(absent.stderr, /^pilot-land\.mjs push：Bash\(node scripts\/pilot-land\.mjs push:\*\)$/m);
});

test('push 答否：有 pilot-land.mjs push 的放行規則也 exit 1', () => {
  assert.deepEqual(permissionProblems(allow(['gh-tracker.mjs', 'pilot-land.mjs push'])).extra, ['pilot-land.mjs push']);
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
  assert.deepEqual(permissionProblems(settings, { push: true }).missing, ['land.mjs', 'pilot-close.mjs', 'pilot-land.mjs push']);
  assert.deepEqual(permissionProblems({}).missing, ['gh-tracker.mjs']);
});

test('不認得的旗標：exit 2', t => {
  assert.equal(run(t, allow(['gh-tracker.mjs']), ['--yes']).status, 2);
});

// review #244：pilot-close.mjs 在 #245 之前不是正本，放行一個不存在的路徑等於預先放行之後放在那裡的任何腳本。
test('放行的腳本在 scripts/ 不存在：exit 1，列出來', t => {
  const settings = allow(['gh-tracker.mjs', ...PUSH_SCRIPTS]);
  assert.deepEqual(permissionProblems(settings, { push: true, exists: name => name !== 'pilot-close.mjs' }).absent, ['pilot-close.mjs']);
  const result = run(t, settings, ['--push'], ['gh-tracker.mjs', 'land.mjs', 'pilot-land.mjs push']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /不存在/);
  assert.match(result.stderr, /^pilot-close\.mjs：Bash\(node scripts\/pilot-close\.mjs:\*\)$/m);
  assert.equal(run(t, allow(['gh-tracker.mjs']), [], []).status, 1);
});
