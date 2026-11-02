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

// #293：候選不在 tracker 的專案（spay2 G77）由條目宣告名單與結案，Roster、Plan、Close 三步都不能只會讀 Issue。
test('retro-collect：條目宣告名單時 Roster、Plan、Close 改用宣告，只宣告一部分就停', () => {
  const step = name => skill.split('\n\n').find(paragraph => paragraph.includes(`**${name}.**`));
  assert.match(step('Roster'), /`Roster command:`[^.]*instead of listing and claiming/);
  assert.match(step('Plan'), /declared roster/);
  assert.match(step('Close'), /`Close command:`[^.]*instead of/);
  const declared = step('Declared roster');
  assert.ok(declared, 'skill 沒有 Declared roster 段落');
  assert.match(declared, /`Roster command:`, `Collect command:`, and `Close command:`/);
  assert.match(declared, /stop and name/);
  assert.match(step('Roster'), /`Roster command:`[^.]*`\$ARGUMENTS`/, '宣告分支也要照 $ARGUMENTS 過濾');
  assert.match(step('Roster'), /nothing to read[^.]*report/, 'spay2 的 PENDING 沒有檔案：不能進計畫，也不能傳給結案指令');
  assert.match(step('Plan'), /Done when every candidate[^.]*roster item/);
  assert.match(declared, /`retro` Issue[^.]*still/, '太大的候選照樣開 retro Issue，要明寫');
  assert.match(declared, /no `retro-candidates` Issue/);
  assert.doesNotMatch(skill, /retro-collect\.mjs|--role|--mark/, 'skill 不寫死專案的腳本名');
});

test('retro-collect 宣告：ADAPTER 寫明三行與預設，ADR 0003 記下例外與代價', () => {
  const adapter = readFileSync(new URL('../skills/engineering/issue-run/ADAPTER.md', import.meta.url), 'utf8');
  const entry = adapter.split('\n').find(line => line.startsWith('- **Retro collect.**'));
  for (const name of ['Roster command:', 'Collect command:', 'Close command:']) assert.ok(entry.includes(`\`${name}\``), name);
  assert.match(entry, /`COLLECT <file>`/);
  assert.match(entry, /`NORMAL`/);
  assert.match(entry, /entry states[^.]*format/, '檔案格式由條目寫明');
  assert.match(entry, /placeholders/, '條目寫明結案指令的佔位符怎麼填');
  assert.match(entry, /Default: none; `\/retro-collect` stops and says so\./, '沒宣告的預設不變');
  const adr = readFileSync(new URL('../docs/adr/0003-tracker-shared-state.md', import.meta.url), 'utf8');
  assert.match(adr, /`Roster command:`/);
  assert.match(adr, /另一台機器看不到/);
  assert.match(adr, /預設仍是 tracker/);
});
