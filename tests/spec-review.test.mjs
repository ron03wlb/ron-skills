import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname;
const matt = join(process.env.MATT_SKILLS ?? join(homedir(), 'code/skills'), 'skills');
// pre-commit hook 會匯出 GIT_DIR，git apply 繼承後會套到本 repo（#25）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const skill = readFileSync(join(root, 'skills/engineering/spec-review/SKILL.md'), 'utf8');

const patched = (t, rel, name) => {
  const dir = mkdtempSync(join(realTmpdir(), `${name}-overlay-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(matt, rel), dir, { recursive: true });
  const applied = spawnSync('git', ['apply', join(root, 'overlays', `${name}.patch`)], { cwd: dir, encoding: 'utf8', env });
  assert.equal(applied.status, 0, applied.stderr);
  return readFileSync(join(dir, 'SKILL.md'), 'utf8');
};

// 事項 #55：spec 定稿前的新人審查。
test('to-spec overlay 在發布前跑 spec-review', t => {
  const step3 = patched(t, 'engineering/to-spec', 'to-spec').split('\n3. ')[1]?.split('\n')[0];
  assert.ok(step3, 'to-spec 沒有第 3 步');
  assert.ok(step3.indexOf('`spec-review`') >= 0 && step3.indexOf('`spec-review`') < step3.indexOf('publish it'), 'spec-review 不在發布之前');
});

test('grilling overlay 在 to-spec 以外寫出 spec 時跑 spec-review', t => {
  assert.match(patched(t, 'productivity/grilling', 'grilling'), /writing a spec outside `to-spec`.*`spec-review`/);
});

test('spec-review 只派一個 sonnet 審查者，讀 adapter 的 Not defects 段', () => {
  assert.equal(skill.match(/`model: sonnet`/g)?.length, 1);
  assert.match(skill, /^## Spec review\n\nNot defects:\n- /m, '缺 adapter 段落格式範例');
  assert.match(skill, /grep -rn -A 20 '\^## Spec review' docs\/agents\//);
  assert.match(skill, /one level deep/);
  assert.match(skill, /80k tokens/);
  for (const category of ['unclear', 'contradiction', 'undecided']) assert.match(skill, new RegExp(`\\*\\*${category}\\*\\*`));
  assert.match(skill, /F<n> \| L<start>-<end> § <section heading> \| <unclear\|contradiction\|undecided>/);
  assert.match(skill, /Fix: .*Ask: /);
});

test('spec-review 排除無人值守流程，且註明 EGM 出處與授權', () => {
  const description = skill.match(/^description: "(.*)"$/m)?.[1] ?? '';
  assert.match(description, /never inside issue-run, issue-pilot, or another unattended run/);
  assert.match(skill, /google\/elephant-goldfish-model/);
  assert.match(skill, /Apache License 2\.0/);
  for (const rel of ['skills/engineering/issue-run/SKILL.md', 'skills/engineering/issue-pilot/SKILL.md']) {
    assert.doesNotMatch(readFileSync(join(root, rel), 'utf8'), /spec-review/, `${rel} 不該呼叫 spec-review`);
  }
});

// spay2 retro 1124c 5cc58424#2：只改測試的規格，正式碼直接讀時鐘／隨機數的子案例做不到，要明示排除。
test('spec-review 對只改測試的規格逐條核對子案例可行性', () => {
  const step4 = skill.split('## 4. Resolve every finding')[1]?.split('\n## 5.')[0] ?? '';
  assert.match(step4, /\*\*Test-only spec\.\*\*.*clock, a random source.*exclude that sub-case/);
  assert.ok(step4.indexOf('**Test-only spec.**') < step4.indexOf('Done when'), '可行性核對要排在 Done when 之前');
});
