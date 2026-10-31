import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const path = new URL('../skills/engineering/issue-queue/SKILL.md', import.meta.url);
const skill = existsSync(path) ? readFileSync(path, 'utf8') : '';
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const paragraph = marker => skill.split('\n\n').find(block => block.includes(marker)) ?? '';

// #105（#102 底線 ③）：人看池子的入口。手動跑或 `/loop /issue-queue` 定時跑，所以不能 disable-model-invocation，
// description 要限定只在人輸入時觸發（check-loop-invocable 的規則）。
test('issue-queue 是 /loop 可呼叫的 skill，description 限定觸發時機', () => {
  assert.ok(skill, 'skills/engineering/issue-queue/SKILL.md 不存在');
  assert.match(skill, /^---\nname: issue-queue\n/);
  assert.doesNotMatch(skill, /^disable-model-invocation:\s*true/m);
  assert.match(skill.split('\n---\n')[0], /description: .*only when the user runs `?\/issue-queue`? or `?\/loop \/issue-queue`?/);
});

// 分桶只讀 issue-pool.mjs，和 pilot、--pool 同一份；沒有這支就交給 /setup-workflow，不自己拼查詢。
test('分桶讀 scripts/issue-pool.mjs，沒有時停下指向 /setup-workflow', () => {
  assert.match(skill, /node scripts\/issue-pool\.mjs/);
  assert.match(skill, /\/setup-workflow/);
});

// R4-Q4：最上面一行「進行中 N／上限 M」，M 是 adapter 的 worker cap，沒寫顯示「不限」。
test('報告第一行是「進行中 N／上限 M」，上限讀 adapter 的 worker cap、沒寫顯示「不限」', () => {
  assert.match(skill, /`進行中 <N>／上限 <M>`/);
  assert.match(skill, /worker cap/);
  assert.match(skill, /`不限`/);
});

// R3-Q4：stale 桶列認領者與最後一次留言，釋放或保留由人決定，agent 不自己搶回。
test('stale 桶列出認領者與最後一次留言，由人決定，agent 不搶回', () => {
  const stale = paragraph('**Stale.**');
  assert.ok(stale, '沒有 Stale 步驟');
  assert.match(stale, /認領：/);
  assert.match(stale, /last comment/i);
  assert.match(stale, /never (re)?claim/i);
});

// R1-Q7、R2-Q4：細化照 /triage 的規則、不改 Matt 的 /triage；人確認後才改 ready-for-agent／ready-for-human；pilot 的自動細化不變。
test('逐張細化照 /triage 規則，人確認後才改 ready 狀態，pilot 自動細化不變', () => {
  const refine = paragraph('**Refine.**');
  assert.ok(refine, '沒有 Refine 步驟');
  assert.match(refine, /`triage`/);
  assert.match(refine, /AGENT-BRIEF\.md/);
  assert.match(refine, /`ready-for-agent`/);
  assert.match(refine, /`ready-for-human`/);
  assert.match(refine, /confirm/i);
  assert.match(skill, /pilot's own refinement/i);
});

// R2-Q5：五條母單提示，只提示不擋流程，adapter 可關閉；第 3 條沿用 #94 的 proseDeps；之後逐張母單請人判斷。
test('母單提示有五條、只提示不擋、adapter 可關閉，之後逐張母單請人判斷', () => {
  const hints = paragraph('**Parent hints.**');
  assert.ok(hints, '沒有 Parent hints 步驟');
  assert.match(hints, /every child is closed/i);
  assert.match(hints, /triage (state )?label/i);
  assert.match(hints, /`blocked_by`/);
  assert.match(hints, /proseDeps/);
  assert.match(hints, /`## 驗收`/);
  assert.match(hints, /decision number/i);
  assert.match(hints, /range/i);
  assert.match(hints, /never block/i);
  assert.match(hints, /`Parent hints: off`/);
  assert.match(paragraph('**Review parents.**'), /one parent at a time/i);
});

test('第 3 條提示引用的 proseDeps 在 pilot-probe 正本裡存在', async () => {
  const { proseDeps } = await import('../skills/engineering/setup-workflow/templates/pilot-probe.mjs');
  assert.deepEqual(proseDeps('依賴 ①（#103）；提示第 3 條沿用 #94 的實作。'), [103]);
});

// 新 session 實跑 /issue-queue 時，`node -e` 匯入 pilot-probe.mjs 會拋錯：它載入的 orca-session-send.mjs 在頂層讀
// `process.argv[1]`，`-e` 底下沒有這個值。所以要從暫存的 .mjs 檔匯入。
test('第 3 條提示從暫存腳本檔匯入 proseDeps，不用 node -e', () => {
  const hints = paragraph('**Parent hints.**');
  assert.doesNotMatch(hints, /node[^`]*\s-e\s/);
  assert.match(hints, /prose-deps\.mjs/);
});

test('README 有 issue-queue 一段', () => {
  assert.match(readme, /^## issue-queue\n\n`\/issue-queue`/m);
});
