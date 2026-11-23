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

// CoS item 41：舊規則（≥3 張、POOL_EMPTY 時 ≥1 張）只寫在 Reconcile 的 prose，沒有 script，ron-skills 的 adapter 也沒有條目，從沒觸發過。
// 改成 Project hooks 之後（安全點）跑 pilot-retro-due.mjs，門檻 count／age 由 adapter 宣告，兩套不並存。
test('Project hooks 之後依 Retro trigger 跑 pilot-retro-due；Reconcile 不再有 ≥3 規則；不以 Skill tool 叫 retro-collect', () => {
  const skill = read('skills/engineering/issue-pilot/SKILL.md');
  assert.doesNotMatch(paragraph(skill, '1. **Reconcile.**').split('\n')[0], /Retro trigger/);
  assert.doesNotMatch(skill, /at least 3, or at least 1 while the probe prints `POOL_EMPTY`/);
  const hooks = skill.split('\n').find(line => line.startsWith('3. **Project hooks.**'));
  const trigger = hooks.slice(hooks.indexOf('**Retro trigger**'));
  assert.ok(hooks.indexOf('**Retro trigger**') > hooks.indexOf('Project tick hooks'), 'Retro trigger 要排在 Project tick hooks 之後');
  for (const token of ['RETRO_DUE', 'RETRO_WAIT', 'RETRO_RUNNING', 'RETRO_IDLE', 'RETRO_OFF', 'RETRO_FAILED', 'RETRO_START_FAILED', 'RETRO_STARTED']) assert.match(trigger, new RegExp(`\`${token}`));
  assert.match(trigger, /`From: retro-collect` line/);
  assert.match(trigger, /default 5/);
  assert.match(trigger, /default 8 hours/);
  assert.match(trigger, /Never invoke `retro-collect` with the Skill tool here/);
  assert.match(trigger, /With no such entry, skip it\.$/);
  // skill 引用的 Pilot 條目要寫在 ADAPTER.md 的 Pilot 段（check-pilot-lines）；範本預設沒有。
  const adapter = read('skills/engineering/issue-run/ADAPTER.md');
  assert.match(adapter, /^- \*\*Retro trigger\.\*\* Optional:.*`Retro trigger: count=<n> age=<h>h`.*`count=5 age=8h`/m);
  assert.match(adapter, /`Roster due: <TOKEN>\[,<TOKEN>…\]`/);
  assert.match(read('skills/engineering/issue-run/PILOT-TEMPLATE.md'), /^- \*\*Retro trigger\.\*\* None/m);
  // ron-skills 自己啟用：pilot.md 指向 pilot-retro-collect.md 的同名條目，宣告預設門檻。
  assert.match(read('docs/agents/pilot.md'), /^- \*\*Retro trigger\.\*\* 見 \[pilot-retro-collect\.md\]/m);
  assert.match(read('docs/agents/pilot-retro-collect.md'), /^- \*\*Retro trigger\.\*\* `Retro trigger: count=5 age=8h`.*node scripts\/pilot-retro-due\.mjs/m);
});

test('retro-collect 把給 owner 否決的段落寫到 Retro collect checkout 的 .scratch/retro/reports/<YYYY-MM-DD>-<key>.md', () => {
  const close = read('skills/engineering/retro-collect/SKILL.md').split('\n').find(line => line.startsWith('5. **Close.**'));
  assert.match(close, /`\.scratch\/retro\/reports\/<YYYY-MM-DD>-<key>\.md` in the checkout the \*\*Retro collect\*\* entry names/);
  assert.match(close, /`blocked → #<n>`\) and the Issue or roster item it came from, then every `retro` Issue opened/);
  assert.match(read('skills/engineering/issue-run/ADAPTER.md'), /`\.scratch\/retro\/reports\/<YYYY-MM-DD>-<key>\.md` in the checkout this entry names/);
});
