import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../skills/engineering/retro-collect/SKILL.md', import.meta.url), 'utf8');

// #106：舊版依 Orca 分頁點名退役 coordinator 的本機 retro 檔，只有 L3 用得到，別台機器也看不到。
// 改成收集 tracker 上所有開著的 `retro-candidates` Issue，合入後關掉這些 Issue，不再碰分頁。
// 太複雜的候選另開 `retro` Issue 交給 pilot（使用者 2026-10-31 的範圍補充）。
test('retro-collect 收集開著的 retro-candidates Issue，合入後關掉它們，不依賴 Orca 分頁', () => {
  assert.match(skill, /open Issues labelled `retro-candidates`/);
  assert.match(skill, /blocked → #<n>/, '太複雜的候選要另開 retro Issue 並在計畫標 blocked → #<n>');
  assert.doesNotMatch(skill, /retired coordinator|\btabs?\b|PENDING|CLOSE_GONE|session8/i, '不能再依 Orca 分頁或退役 session 點名');
  assert.match(skill, /docs\/agents\/issue-run\.md/);
  assert.match(skill, /\*\*Retro collect\*\*/, '專案事實讀 adapter 的 Retro collect 條目');
  const close = skill.split('\n\n').find(paragraph => paragraph.includes('**Close.**'));
  assert.ok(close, '沒有 Close 步驟');
  assert.match(close, /close/i);
  assert.match(close, /comment/i);
});
