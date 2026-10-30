import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/check-pilot-lines.mjs', import.meta.url).pathname;

// 重現真實歷史：issue-pilot 引用 Pilot **Sessions** line，ADAPTER.md 的 Pilot 段只列了 Hold flag。
function fixture(t, adapterLines) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-lines-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(script, join(repo, 'scripts/check-pilot-lines.mjs'));
  mkdirSync(join(repo, 'skills/engineering/issue-pilot'), { recursive: true });
  mkdirSync(join(repo, 'skills/engineering/issue-run'), { recursive: true });
  writeFileSync(join(repo, 'skills/engineering/issue-pilot/SKILL.md'), "---\nname: issue-pilot\n---\n\nRegister this session per the adapter's Pilot **Sessions** line.\n");
  writeFileSync(join(repo, 'skills/engineering/issue-run/ADAPTER.md'), `# t\n\n## Pilot\n\n${adapterLines.map(l => `- **${l}.** x\n`).join('')}\n## Permissions\n\n- **Sessions.** 別段的同名不算\n`);
  writeFileSync(join(repo, 'README.md'), '# x\n');
  return spawnSync('node', [join(repo, 'scripts/check-pilot-lines.mjs')], { encoding: 'utf8' });
}

test('skill 引用的 Pilot 行未列在 ADAPTER.md Pilot 段：報 PILOT_LINE_UNDOCUMENTED、exit 1', t => {
  const result = fixture(t, ['Hold flag']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^PILOT_LINE_UNDOCUMENTED Sessions（skills\/engineering\/issue-pilot\/SKILL\.md）/);
});

test('引用的 Pilot 行已列在 Pilot 段：通過', t => {
  const result = fixture(t, ['Hold flag', 'Sessions']);
  assert.equal(result.status, 0, result.stdout);
});
