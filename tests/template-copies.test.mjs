// scripts/ 裡從 setup-workflow 正本複製來的副本（清單在 docs/agents/workflow-templates.json）必須與正本逐位元組相同、
// 與清單記錄的 sha256 一致：要改就改正本，commit 後用 setup-workflow 的 copy-templates.mjs 複製過來。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const { copies } = JSON.parse(read('docs/agents/workflow-templates.json'));

for (const [path, entry] of Object.entries(copies)) {
  test(`${path} 與 setup-workflow 正本相同，hash 與清單一致`, () => {
    assert.ok(read(path).equals(read(entry.template)),
      `${path} 與正本不同：改 ${entry.template}，commit 後執行 node skills/engineering/setup-workflow/scripts/copy-templates.mjs . --no-tests <名稱>`);
    assert.equal(createHash('sha256').update(read(path)).digest('hex'), entry.sha256, `${path} 與清單記錄的 sha256 不同`);
    assert.match(entry.commit, /^[0-9a-f]{40}$/);
  });
}

// L3 必接：主 checkout 的未提交改動與新檔會讓 pilot 的 Probe 停止合併（#30）。
test('.claude/settings.json 以 PreToolUse（Edit|Write）接上主 checkout 防護', () => {
  assert.ok(copies['scripts/claude-hook-main-checkout.mjs'], '清單沒有 scripts/claude-hook-main-checkout.mjs');
  const { hooks } = JSON.parse(read('.claude/settings.json'));
  const wired = hooks.PreToolUse.some(({ matcher, hooks: list }) => /\bEdit\b/.test(matcher) && /\bWrite\b/.test(matcher)
    && list.some(({ command }) => command.includes('scripts/claude-hook-main-checkout.mjs')));
  assert.ok(wired, '.claude/settings.json 的 PreToolUse 沒有以 Edit|Write 呼叫 scripts/claude-hook-main-checkout.mjs');
});
