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
  const roster = skill.split('\n\n').find(paragraph => paragraph.includes('**Roster.**'));
  assert.doesNotMatch(skill, /retired coordinator|PENDING|CLOSE_GONE|session8/i, '不能再依退役 session 點名');
  assert.doesNotMatch(roster, /\btabs?\b|orca/i, '點名只看 tracker，不依 Orca 分頁');
  assert.match(skill, /docs\/agents\/issue-run\.md/);
  assert.match(skill, /\*\*Retro collect\*\*/, '專案事實讀 adapter 的 Retro collect 條目');
  const close = skill.split('\n\n').find(paragraph => paragraph.includes('**Close.**'));
  assert.ok(close, '沒有 Close 步驟');
  assert.match(close, /close/i);
  assert.match(close, /comment/i);
});

// #156：收完要關的來源分頁得自己比對 session 與分頁。收集單開頭記 `Orca: <handle>`，Close 只關標題還是待關閉的那些：
// 處理中的分頁代表那個 session 還在工作。
test('retro-collect 的 Close 依收集單的 Orca handle 關掉待關閉的來源分頁，其他狀態不動', () => {
  const close = skill.split('\n\n').find(paragraph => paragraph.includes('**Close.**'));
  assert.match(close, /`Orca: <handle>`/);
  assert.match(close, /`待關閉｜`/);
  assert.match(close, /orca terminal close --terminal <handle> --tab/);
  assert.match(close, /leave any other state alone/);
});
