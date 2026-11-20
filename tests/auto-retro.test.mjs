import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const paragraph = (text, marker) => text.split('\n\n').find(p => p.includes(marker));

// #327：coordinator 交接後、worker DONE 後都等 Operator 到各分頁打 /retro（investing session cf6ac0fd：26 個分頁停在待 Retro），
// retro-candidates 累積了也要 Operator 打 /retro-collect。改成 skill 自己以 Skill tool 跑，retro-collect 由 coordinator 依 adapter 的 Retro trigger 開。
test('retro-collect 可由 Skill tool 呼叫，description 限定觸發時機', () => {
  const frontmatter = read('skills/engineering/retro-collect/SKILL.md').split('\n---\n')[0];
  assert.doesNotMatch(frontmatter, /disable-model-invocation/);
  assert.match(frontmatter, /Use only when the user runs \/retro-collect, or when an issue-pilot coordinator starts it through the adapter's \*\*Retro trigger\*\* entry; never on your own initiative/);
});

test('worker 在寫 DONE 報告之前以 Skill tool 跑 retro（只在有 Retro collect 條目時），報告仍以 DONE 收尾；STOP 不跑', () => {
  const worker = paragraph(read('skills/engineering/issue-run/SKILL.md'), '--worker <checkpoint>` runs one Issue');
  const retro = worker.indexOf('run `retro` with the Skill tool');
  assert.ok(retro > 0, 'worker 段沒有跑 retro');
  assert.match(worker, /when the adapter has a \*\*Retro collect\*\* entry, run `retro`/);
  assert.ok(worker.indexOf('Before writing a `DONE` report') < retro, '跑 retro 要排在寫 DONE 報告之前');
  assert.ok(retro < worker.indexOf('still ending with the `DONE` line'), 'retro 之後的報告仍以 DONE 收尾');
  assert.match(worker, /A `STOP` waits on the human, so it runs no retro/);
});

test('coordinator 在 HANDED_OFF、停 loop 之後跑 retro；不再要求人打 /retro', () => {
  const skill = read('skills/engineering/issue-pilot/SKILL.md');
  const handoff = skill.split('\n').find(line => line.startsWith("3. Run the adapter's handoff command."));
  const [handed, loop, retro] = ['On `HANDED_OFF`', 'stop the loop', 'run `retro` with the Skill tool'].map(s => handoff.indexOf(s));
  assert.ok(handed >= 0 && handed < loop && loop < retro, `順序應為 HANDED_OFF → 停 loop → retro：${handoff}`);
  assert.match(handoff, /has a \*\*Retro collect\*\* entry, run `retro`/);
  assert.doesNotMatch(skill, /user-typed only/);
  assert.doesNotMatch(skill, /never ask a session to call it through the Skill tool/);
});

test('Reconcile 依 Retro trigger 開 /retro-collect：≥3 張、或 POOL_EMPTY 時 ≥1 張，沒有在跑的；不算收集者自己的單', () => {
  const reconcile = paragraph(read('skills/engineering/issue-pilot/SKILL.md'), '1. **Reconcile.**');
  const trigger = reconcile.slice(reconcile.indexOf('**Retro trigger**'));
  assert.match(trigger, /at least 3, or at least 1 while the probe prints `POOL_EMPTY`/);
  assert.match(trigger, /no tab already runs `\/retro-collect`/);
  assert.match(trigger, /`From: retro-collect` line/);
  assert.match(trigger, /With no such entry, skip it/);
  // skill 引用的 Pilot 條目要寫在 ADAPTER.md 的 Pilot 段（check-pilot-lines）；範本預設沒有。
  assert.match(read('skills/engineering/issue-run/ADAPTER.md'), /^- \*\*Retro trigger\.\*\* Optional:/m);
  assert.match(read('skills/engineering/issue-run/PILOT-TEMPLATE.md'), /^- \*\*Retro trigger\.\*\* None/m);
});
