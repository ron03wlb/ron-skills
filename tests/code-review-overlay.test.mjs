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

// #569：Spec sub-agent 把 spay2 adapter 的 `[Drift check]` 報成壞連結 P2，那是 adapter-line.mjs 解析的條目名稱（spay2 retro 9580d1e4#1）。
// 只在 repo 有 scripts/adapter-line.mjs 時加進 brief。
test('code-review overlay：repo 有 adapter-line.mjs 時，兩份 brief 說明 docs/agents 的裸 [Entry] 是條目名稱、不報壞連結；沒有該檔不加', t => {
  const paragraphs = applyOverlay(t, 'code-review').split('\n\n');
  const text = paragraphs.find(p => p.startsWith('**Adapter entries.**'));
  assert.ok(text, 'overlay 沒有 Adapter entries 段落');
  assert.match(text, /When the repo has `scripts\/adapter-line\.mjs`, add to both briefs/);
  assert.match(text, /`docs\/agents\/\*\*`/);
  assert.match(text, /bare `\[Entry\]` not followed by `\(` or `:` is an adapter entry name/);
  assert.match(text, /the repo's checks cover it/);
  assert.match(text, /do not report it as a broken link/);
  assert.match(text, /Without `scripts\/adapter-line\.mjs`, leave this sentence out/);
});

// spay2 retro c3b3a383#2：Spec sub-agent 以自寫的合成輸出推出 P2「父 suite 被列為失敗」，真實 Node v24.21 輸出不會出現。
test('code-review overlay：Spec brief 要求解析工具輸出的 finding 以本機真實輸出重現，合成樣本標猜測且不高於 P3', t => {
  const text = applyOverlay(t, 'code-review').split('\n\n').find(p => p.startsWith('**Parsed tool output.**'));
  assert.ok(text, 'overlay 沒有 Parsed tool output 段落');
  assert.match(text, /Add to the Spec brief/);
  assert.match(text, /real output on this machine: paste the command and its output/);
  assert.match(text, /marked as a guess and rated no higher than P3/);
});
