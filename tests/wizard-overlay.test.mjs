import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverlay } from './helpers/apply-overlay.mjs';

// #375：精靈在 bash 裡跑 `zsh -ic` 讀變數，被 SIGTTIN 暫停（#330 第 6 項）。
test('wizard overlay 的第 3 步要精靈直接讀 export 行與秘密存放處，不開互動式 shell', t => {
  const skill = applyOverlay(t, 'wizard');
  const step3 = skill.split('### 3. Author the wizard')[1]?.split('\n### ')[0];
  assert.ok(step3, 'SKILL.md 沒有第 3 步');
  const paragraphs = step3.split('\n\n').filter(text => /never start an interactive shell/.test(text));
  assert.equal(paragraphs.length, 1, '第 3 步要恰好一段寫「never start an interactive shell」');
  const [paragraph] = paragraphs;
  assert.match(paragraph, /zsh -i/);
  assert.match(paragraph, /bash -i/);
  assert.match(paragraph, /`export VAR=…` line/);
  assert.match(paragraph, /`ask` or `ask_secret` for it/, '找不到值時沒有退回 ask／ask_secret');
  assert.match(paragraph, /~\/\.zshrc/);
  assert.match(paragraph, /never start an interactive shell/);
  assert.match(paragraph, /\$\{VAR:-\}/, '沒有先用繼承的環境變數');
  assert.match(paragraph, /never `source` or `eval`/, '讀 export 行不能 source／eval，否則又執行 rc 檔');
  assert.match(paragraph, /security find-generic-password/);
  assert.match(paragraph, /secret-tool lookup/);
  assert.match(paragraph, /`VAR=value cmd` prefix, never as a command-line argument/);
  // 寫 stage 之前就要讀到這條限制：排在「Hold the bar」之前。
  assert.ok(step3.indexOf(paragraph) < step3.indexOf('Hold the bar'), '限制段落排在 Hold the bar 之後');
});
