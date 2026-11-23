import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverlay } from './helpers/apply-overlay.mjs';

// #531-1：Standards sub-agent 只讀 diff 就斷言呼叫端的資料形狀，回報不成立的 P2（session 9909542c）。
// 「Tool evidence」只約束搜尋與指令；對 diff 外程式行為的斷言要引用讀到的那一行。
test('code-review overlay：兩份 brief 都要求 P2 以上的 finding 引用 path:line 與該行內容，diff 外的行為先讀到那一行', t => {
  const paragraphs = applyOverlay(t, 'code-review').split('\n\n');
  const tool = paragraphs.findIndex(text => text.startsWith('**Tool evidence.**'));
  const line = paragraphs.findIndex(text => text.startsWith('**Line evidence.**'));
  assert.ok(tool >= 0, 'overlay 沒有 Tool evidence 段落');
  assert.equal(line, tool + 1, 'Line evidence 要緊接在 Tool evidence 之後');
  const text = paragraphs[line];
  assert.match(text, /Add to both briefs/);
  assert.match(text, /P2 or above/);
  assert.match(text, /`path:line` plus that line's text/);
  assert.match(text, /outside the diff[^"]*read that line/);
});
