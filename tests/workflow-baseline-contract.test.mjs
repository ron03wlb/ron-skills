// #107（#102 底線 ⑤，R2-Q6、R3-Q1）：正本只保證三條底線，其他都是 adapter 可以覆寫或關閉的預設值；
// setup 以 L1 為底，L1 一定帶 issue-pool.mjs，讓 /issue-queue 與 /issue-run --pool 在 L1 就能用。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('setup-workflow 的 Templates 表把 issue-pool.mjs 放在 L1、不分 tracker 一定複製', () => {
  const skill = read('skills/engineering/setup-workflow/SKILL.md');
  const row = skill.split('\n').find(line => line.startsWith('| `issue-pool.mjs`'));
  assert.ok(row, 'Templates 表沒有 issue-pool.mjs 這一列');
  assert.match(row.split(' | ')[1], /^L1, always/);
});

const section = (doc, heading) => doc.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

test('ADAPTER.md 骨架寫明 --pool 的池子、認領時限與沒有 Pilot 段時的 worker cap', () => {
  const adapter = read('skills/engineering/issue-run/ADAPTER.md');
  const pool = section(adapter, 'Pool');
  assert.ok(pool, 'ADAPTER.md 沒有 ## Pool 段');
  assert.match(pool, /\/issue-run --pool/);
  assert.match(pool, /scripts\/issue-pool\.mjs/);
  assert.match(pool, /Claim timeout/);
  assert.match(pool, /--stale-hours <h>/);
  assert.match(pool, /24 hours/);
  assert.match(pool, /`Categories: <label>,\.\.\.`/);
  assert.match(section(adapter, 'Issue queue'), /no Pilot section[^.]*`不限`/);
});

test('/issue-queue 把 adapter Pool 段的認領時限傳給 issue-pool.mjs', () => {
  const queue = read('skills/engineering/issue-queue/SKILL.md');
  assert.match(queue, /--stale-hours <h>` when the adapter's Pool section sets `Claim timeout: <h> hours`/);
  assert.match(queue, /--categories <label>,\.\.\.` when it sets `Categories: <label>,\.\.\.`/);
});

test('docs/workflow README 寫明三條底線是正本唯一的契約，其餘是 adapter 可覆寫或關閉的預設值', () => {
  const contract = section(read('docs/workflow/README.md'), '三條底線');
  assert.ok(contract, 'README 沒有 ## 三條底線 段');
  for (const line of ['/loop /issue-run --pool', '/retro-collect', 'issue-pool.mjs claim']) assert.ok(contract.includes(line), `契約沒寫到 ${line}`);
  // 手動 /issue-run <n> 跑的是 adapter 的 Claim 指令（預設沒有），契約要照實寫出前提（#107 review）。
  assert.match(contract, /Claim 段/);
  assert.match(contract, /Retro collect 條目時/);
  for (const knob of ['git 流程', '整合分支', '母單提示', '桶名', '認領時限', 'worker cap']) assert.ok(contract.includes(knob), `預設值清單缺 ${knob}`);
});

test('/research 的結論先開 Issue 進 queue；升級等級重跑 /setup-workflow，一次一級', () => {
  const readme = read('docs/workflow/README.md');
  const paragraph = readme.split('\n\n').find(block => block.includes('/research')) ?? '';
  assert.match(paragraph, /Issue/);
  assert.match(paragraph, /\/issue-queue/);
  assert.match(paragraph, /\/setup-workflow/);
  assert.match(paragraph, /一次(只|最多)升一級/);
});

test('03 L1 checklist 有 /issue-queue 與 /issue-run --pool 兩步', () => {
  const headings = read('docs/workflow/03-level1.md').split('\n').filter(line => line.startsWith('### '));
  assert.ok(headings.some(h => h.includes('/issue-queue')), 'checklist 沒有 /issue-queue');
  assert.ok(headings.some(h => h.includes('/issue-run --pool')), 'checklist 沒有 /issue-run --pool');
});

// fresh 重派 #107：只審輪剩下的 findings，要照腳本與 skill 的實際行為寫。
test('Pool 段的認領窗口照 issue-pool.mjs claim：5 分鐘只用於還沒指派的認領留言', () => {
  const pool = section(read('skills/engineering/issue-run/ADAPTER.md'), 'Pool');
  assert.match(pool, /assigned Issue[^.]*any age/);
  assert.match(pool, /unassigned[^.]*5 minutes/);
  assert.match(pool, /latest claim comment is not from an assignee always blocks/);
  assert.match(pool, /taken over in two cases only: a pilot coordinator that succeeded a handed-off coordinator/);
});

test('三條底線照實寫範圍：停下的單只不卡無關的單、Retro collect 在 Pilot 段、worker cap 沒有通用預設', () => {
  const contract = section(read('docs/workflow/README.md'), '三條底線');
  assert.match(contract, /不卡住與它無關的單/);
  assert.match(contract, /Pilot 段的 Retro collect 條目/);
  const cap = contract.split('\n').find(line => line.startsWith('| worker cap'));
  assert.ok(cap, '預設值表沒有 worker cap 列');
  assert.match(cap, /沒有通用預設/);
  assert.match(cap, /\/issue-queue/);
});
