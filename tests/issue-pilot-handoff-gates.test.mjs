import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 交接到期時，本 session 開的 product-decision gate 不再用阻塞的 AskUserQuestion 問：
// 照常交接、交接訊息第一行列出 gate，由下一任依 Notify 處理（#340，investing#423 停約 6.5 小時）。
const skill = readFileSync(new URL('../skills/engineering/issue-pilot/SKILL.md', import.meta.url), 'utf8');
const section = heading => {
  const start = skill.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `缺少 ## ${heading}`);
  const end = skill.indexOf('\n## ', start + 1);
  return skill.slice(start, end < 0 ? undefined : end);
};
const step7 = skill.split('\n').find(line => line.startsWith('7. **Report and sleep.**'));

test('第 7 步：有可做的事時不發阻塞提問，交接也不例外', () => {
  assert.ok(step7, '缺少第 7 步');
  assert.match(step7, /Ask with `AskUserQuestion` only on a tick with nothing actionable/);
  assert.match(step7, /never on a tick where a \[Handoff\]\(#handoff\) is due/);
});

test('Handoff：product-decision gate 不延後交接、不在交接的 tick 阻塞提問', () => {
  const handoff = section('Handoff');
  assert.doesNotMatch(handoff, /ask it with `AskUserQuestion` in that tick even while work is in flight/);
  assert.doesNotMatch(handoff, /or a product-decision gate this session opened\) still awaiting/);
  assert.match(handoff, /Hand off as usual over a product-decision gate this session opened: it never defers the handoff/);
  // 照順序讀：不阻塞提問的句子要排在交接指令（第 3 步）之前
  assert.ok(handoff.indexOf('never defers the handoff') < handoff.indexOf("3. Run the adapter's handoff command"));
});

test('Handoff：交接訊息第一行列出未回覆的 gate，回答由下一任寫進 gates.md', () => {
  const handoff = section('Handoff');
  assert.ok(handoff.includes('`OPEN_GATES <G…> → <new coordinator tab>`'), '缺少交接訊息第一行的格式');
  assert.match(handoff, /first line of the handoff message \(what you tell the human in step 3\)/);
  assert.match(handoff, /resolves each in `gates\.md`/);
  assert.match(handoff, /never relayed from this retired session/);
  // 第 3 步告訴人交接結果時，也要把這一行放在最前面
  assert.match(handoff, /after the `OPEN_GATES` line when a gate is still unanswered/);
});
