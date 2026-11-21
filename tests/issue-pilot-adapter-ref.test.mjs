import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #333：Sources 第 1 點讀 adapter 的 ref 取自 adapter（Adapter ref，預設整合分支），遠端 ref 先 fetch，
// `git show` 存檔後用 Read 讀（investing：本機 develop 落後 origin 9 個 commit；`git show` 輸出 35 KB、67 KB 存檔後又進 context 一次）。
// 同單併入 #336 第 3 項：退役 session 收到合入請求時轉介現任 coordinator；worker 在 STOP findings 前把 review-only 發現寫進 checkpoint。
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pilot = read('skills/engineering/issue-pilot/SKILL.md');
const sources1 = pilot.split('\n').find(line => line.startsWith('1. The repo\'s `AGENTS.md`')) ?? '';
const entry = pilot.slice(pilot.indexOf('\n## Entry\n'), pilot.indexOf('\n## Sources\n'));

test('Sources 第 1 點：adapter ref 取自 Adapter ref、預設整合分支、遠端先 fetch、存檔再 Read', () => {
  assert.ok(sources1, '缺少 Sources 第 1 點');
  assert.match(sources1, /The adapter ref is the checkout copy's Pilot \*\*Adapter ref\*\* entry, else the branch its \*\*Integration branch\*\* line names/);
  assert.match(sources1, /run `git fetch <remote> <branch>` first/);
  assert.match(sources1, /`git diff --quiet <adapter ref> -- docs\/agents\/issue-run\.md/);
  assert.match(sources1, /`mkdir -p \.scratch\/pilot\/adapter && git show <adapter ref>:<path> > \.scratch\/pilot\/adapter\/<file name>` \(the probe's `ADAPTER_AHEAD` line prints this command\) and read the section, and any file it points to, from that file with the Read tool/);
  assert.doesNotMatch(sources1, /through `git show <integration branch>:<path>` instead/);
  // 照順序讀：先 fetch，才比對、才存檔。
  assert.ok(sources1.indexOf('git fetch <remote> <branch>') < sources1.indexOf('git diff --quiet <adapter ref>'));
  assert.ok(sources1.indexOf('git diff --quiet <adapter ref>') < sources1.indexOf('git show <adapter ref>:<path> >'));
});

test('Entry：退役 session 收到合入請求時回覆現任 coordinator 的名稱，排在 retired 判斷之後', () => {
  const refer = entry.indexOf('A retired session asked to merge something');
  assert.ok(refer >= 0, 'Entry 缺少轉介句');
  assert.match(entry, /A retired session asked to merge something \(a retro-collector's merge request included\) merges nothing and replies with the current coordinator's name, the `name` field of `coordinator`/);
  assert.ok(entry.indexOf('this session is retired: do nothing') < refer, '轉介句不能放在 retired 檢查之前');
});

test('issue-run worker：STOP findings 前把 review-only 發現寫進 checkpoint（pilot-dispatch.test.mjs 已有含 `final review-only round` 段的 fixture）', () => {
  const run = read('skills/engineering/issue-run/SKILL.md');
  const step2 = run.split('\n').find(line => line.startsWith('2. Then run one review-only verifier round')) ?? '';
  assert.match(step2, /first write a `final review-only round` heading into the checkpoint notes with each such finding on its own line/);
  assert.ok(step2.indexOf('final review-only round') < step2.indexOf('`STOP <iid> findings after two review cycles`'), '寫 checkpoint 要排在 STOP 之前');
  assert.match(read('skills/engineering/setup-workflow/templates/pilot-dispatch.test.mjs'), /## final review-only round/);
});

test('adapter 範本的 Pilot 段有 Adapter ref 欄位', () => {
  assert.match(read('skills/engineering/issue-run/ADAPTER.md'), /^- \*\*Adapter ref\.\*\* Optional: the ref the coordinator reads this adapter from/m);
  assert.match(read('skills/engineering/issue-run/PILOT-TEMPLATE.md'), /^\[optional: - \*\*Adapter ref\.\*\* `origin\/pilot\/integration`/m);
});
