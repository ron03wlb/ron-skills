import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { leadingSpaceBang } from './claude-hook-bang-space.mjs';

const HOOK = fileURLToPath(new URL('./claude-hook-bang-space.mjs', import.meta.url));
const hook = input => spawnSync('node', [HOOK], { input, encoding: 'utf8' });
const submit = prompt => hook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));

// spay2 retro b10f5dc4#5：使用者訊息原文開頭多一個空格，被當一般訊息送給模型，指令沒有執行，使用者以為已跑過。
const REAL = ' ! node /tmp/claude-1001/-home-ron-code-spay2/b10f5dc4-a84e-41b4-ac5b-5cf4a9ff3640/scratchpad/verify-728.mjs';

test('前導空白的 ! 指令（真實案例）：exit 0，additionalContext 提示去掉開頭空白重送，不擋下訊息', () => {
  const result = submit(REAL);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /BANG_LEADING_SPACE/);
  assert.match(out.hookSpecificOutput.additionalContext, /去掉開頭空白/);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('! node /tmp/claude-1001/'), '提示帶出去掉空白後的指令');
  assert.equal(out.decision, undefined, '不擋下訊息');
});

test('Issue #346 驗收：" ! ls" 提示，"! ls" 不提示', () => {
  assert.match(hook('{"prompt":" ! ls"}').stdout, /BANG_LEADING_SPACE/);
  assert.equal(hook('{"prompt":"! ls"}').stdout, '');
});

test('其他前導空白（tab、全形空白、換行）也提示；多行訊息只帶第一行', () => {
  for (const prompt of ['\t! ls', '　! ls', '\n!ls']) {
    const result = submit(prompt);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /BANG_LEADING_SPACE/, JSON.stringify(prompt));
  }
  const multi = JSON.parse(submit(' ! ls\n第二行').stdout).hookSpecificOutput.additionalContext;
  assert.ok(multi.includes('（! ls）') && !multi.includes('第二行'), multi);
});

test('負例：無前導空白的 !、中間有 !、只有空白與 !、一般訊息不輸出', () => {
  for (const prompt of ['! ls', '請看 ! 這個', '  !', ' ', '修好 #728', '']) {
    const result = submit(prompt);
    assert.equal(result.status, 0, JSON.stringify(prompt));
    assert.equal(result.stdout, '', JSON.stringify(prompt));
  }
  assert.equal(leadingSpaceBang(' ! ls  '), '! ls');
  assert.equal(leadingSpaceBang(42), null);
});

test('stdin 不是 JSON、prompt 不是字串時 exit 0 無輸出', () => {
  for (const input of ['not json', '', JSON.stringify({ prompt: 42 }), JSON.stringify(null)]) {
    const result = hook(input);
    assert.equal(result.status, 0, input);
    assert.equal(result.stdout, '', input);
  }
});
