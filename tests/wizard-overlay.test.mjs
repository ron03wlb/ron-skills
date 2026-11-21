import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname;
const patch = join(root, 'overlays/wizard.patch');
const upstream = join(process.env.MATT_SKILLS ?? join(homedir(), 'code/skills'), 'skills/engineering/wizard');
// pre-commit hook 會匯出 GIT_DIR，git apply 繼承後會套到本 repo（#25）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// #375：精靈在 bash 裡跑 `zsh -ic` 讀變數，被 SIGTTIN 暫停（#330 第 6 項）。
test('wizard overlay 的第 3 步要精靈直接讀 export 行與秘密存放處，不開互動式 shell', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'wizard-overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(upstream, dir, { recursive: true });
  const applied = spawnSync('git', ['apply', patch], { cwd: dir, encoding: 'utf8', env });
  assert.equal(applied.status, 0, applied.stderr);

  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const step3 = skill.split('### 3. Author the wizard')[1]?.split('\n### ')[0];
  assert.ok(step3, 'SKILL.md 沒有第 3 步');
  const paragraph = step3.split('\n\n').find(text => /zsh -i/.test(text));
  assert.ok(paragraph, '第 3 步沒有提到 zsh -i');
  assert.match(paragraph, /bash -i/);
  assert.match(paragraph, /`export`/);
  assert.match(paragraph, /~\/\.zshrc/);
  assert.match(paragraph, /security find-generic-password/);
  assert.match(paragraph, /environment variable/i);
  assert.match(paragraph, /\b(never|not|don't)\b/i);
});
