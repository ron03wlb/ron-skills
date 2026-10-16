import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/check-loop-invocable.mjs', import.meta.url).pathname;

function fixture(t, flag) {
  const temp = mkdtempSync(join(tmpdir(), 'loop-invocable-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(script, join(repo, 'scripts/check-loop-invocable.mjs'));
  mkdirSync(join(repo, 'skills/eng/pilot'), { recursive: true });
  writeFileSync(join(repo, 'skills/eng/pilot/SKILL.md'), `---\nname: pilot\n${flag ? 'disable-model-invocation: true\n' : ''}---\n\nStart with \`/loop /pilot\`.\n`);
  writeFileSync(join(repo, 'README.md'), '# x\n');
  return spawnSync('node', [join(repo, 'scripts/check-loop-invocable.mjs')], { encoding: 'utf8', env: { ...process.env, MATT_SKILLS: join(temp, 'none'), PSTACK_SKILLS: join(temp, 'none') } });
}

test('被 /loop 驅動的 user-invoked skill：報 LOOP_USER_INVOKED、exit 1', t => {
  const result = fixture(t, true);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^LOOP_USER_INVOKED pilot（skills\/eng\/pilot\/SKILL\.md）/);
});

test('被 /loop 驅動的 model-invoked skill：通過', t => {
  const result = fixture(t, false);
  assert.equal(result.status, 0, result.stdout);
});
