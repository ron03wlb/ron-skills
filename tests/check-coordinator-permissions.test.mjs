import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { permissionProblems } from '../scripts/check-coordinator-permissions.mjs';

// scripts/check-coordinator-permissions.mjs 是 setup-workflow 正本的副本（#244），通用行為由正本的測試測；這裡只測本 repo 的設定：
// 本 repo 讓 coordinator 自己 push、合併、關單（setup-workflow L3 的 push 那一題答是，#131），所以 bin/check 帶 --push。
const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));

test('bin/check 以 --push 檢查（本 repo 的 push 答是）', () => {
  const check = readFileSync(new URL('../bin/check', import.meta.url), 'utf8');
  assert.match(check, /^node scripts\/check-coordinator-permissions\.mjs --push$/m);
});

test('repo 自己的 .claude/settings.json 在 --push 下通過', () => {
  assert.deepEqual(permissionProblems(settings, { push: true }), { missing: [], extra: [] });
});

test('pilot-exceptions.md 的 Permissions 條目列出 allow 的每條規則，且只列這些', () => {
  const pilot = readFileSync(new URL('../docs/agents/pilot-exceptions.md', import.meta.url), 'utf8');
  const entry = pilot.split('\n').find(line => line.startsWith('- **Permissions.**'));
  assert.ok(entry, 'pilot-exceptions.md 沒有 Permissions 條目（#166 從 pilot.md 移過去）');
  const listed = [...entry.matchAll(/`(Bash\([^`]*\))`/g)].map(m => m[1]).sort();
  assert.deepEqual(listed, [...settings.permissions.allow].sort());
});
