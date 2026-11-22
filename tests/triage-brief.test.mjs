import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const entry = (text, name) => {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.startsWith(`- **${name}.**`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
};

// #381（investing#379 第 5 項）：coordinator 派 triage 子代理時每次手寫 30–40 行 prompt，主 checkout、ADAPTER_AHEAD 的 stage 版指令、
// macOS 沒有 timeout、主 checkout 寫入防護這些 repo 專屬事實常漏。改成 adapter 的 **Triage brief** 條目提供範本，SKILL 的 Pick 指向它（不做 pilot-brief.mjs）。
test('issue-pilot SKILL 的 Pick：子代理細化 needs-triage 時從 adapter 的 Triage brief 條目起頭', () => {
  const pick = read('skills/engineering/issue-pilot/SKILL.md').split('\n').find(line => line.startsWith('4. **Pick.**'));
  assert.match(pick, /refine any `needs-triage` member per the adapter before dispatching it; when a subagent does the refining, start its prompt from the adapter's Pilot \*\*Triage brief\*\* entry when it has one/);
});

test('pilot adapter 骨架：ADAPTER.md 的 Pilot 條目清單有 Triage brief，PILOT-ROUND-TEMPLATE 有整條範本，placeholder 都在 PILOT-TEMPLATE 註解說明', () => {
  assert.match(entry(read('skills/engineering/issue-run/ADAPTER.md'), 'Triage brief'), /^- \*\*Triage brief\.\*\* Optional: /);
  const brief = entry(read('skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md'), 'Triage brief');
  assert.ok(brief, 'PILOT-ROUND-TEMPLATE 缺 Triage brief 整條');
  for (const placeholder of ['{{timeout cmd}}', '{{tracker write}}', '{{triage traps}}', '<main checkout>', '<adapter checkout>', '<stage worktree>', 'ADAPTER_AHEAD', 'SCRIPT_AHEAD']) {
    assert.ok(brief.includes(placeholder), `Triage brief 範本缺 ${placeholder}`);
  }
  const comment = read('skills/engineering/issue-run/PILOT-TEMPLATE.md').split('-->')[0];
  for (const name of ['timeout cmd', 'tracker write', 'triage traps']) assert.match(comment, new RegExp(`\\{\\{${name}\\}\\}\\s+\\S`), `PILOT-TEMPLATE 註解沒說明 {{${name}}}`);
});

test('ron-skills 自己的 adapter 填好 Triage brief：pilot-round.md 有整條且沒有 {{placeholder}}，pilot.md 留 pointer', () => {
  const brief = entry(read('docs/agents/pilot-round.md'), 'Triage brief');
  assert.ok(brief, 'pilot-round.md 缺 Triage brief');
  assert.doesNotMatch(brief, /\{\{/);
  for (const fact of ['<主 checkout>', 'ADAPTER_AHEAD', 'node scripts/gh-tracker.mjs', 'timeout: 600000', 'claude-hook-main-checkout.mjs', '--json']) {
    assert.ok(brief.includes(fact), `Triage brief 缺 ${fact}`);
  }
  assert.match(read('docs/agents/pilot.md'), /^- \*\*Triage brief\.\*\* 見 \[pilot-round\.md\]\(pilot-round\.md\)/m);
});
