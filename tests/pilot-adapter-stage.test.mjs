import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// coordinator 照 adapter Pilot 段逐行執行；這裡驗的是它讀到的那幾行。
const adapter = readFileSync(new URL('../docs/agents/issue-run.md', import.meta.url), 'utf8');
const pilot = adapter.match(/^## Pilot\n([\s\S]*?)(?=^## |(?![\s\S]))/m)[1];
const line = name => pilot.match(new RegExp(`^- \\*\\*${name}\\.\\*\\*.*$`, 'm'))?.[0] ?? '';
const stageWorktree = '/home/ron/orca/workspaces/ron-skills/pilot-stage';

// 重現真實歷史：stage #15 時主 checkout 切到 pilot/stage-<key>，工作樹帶出該分支的 .claude/settings.json，
// 在主 checkout 跑的 session 都載入了它的 hook，切回 main 後每次 Stop 都報找不到腳本（#21）。
// 根因是主 checkout 的工作樹被換掉，所以只鎖 checkout／switch；merge、branch 不會換工作樹。
test('Stage、Regression、Integrate、Integration branch 寫明在 stage worktree，且不在主 checkout checkout／switch', () => {
  for (const name of ['Stage', 'Regression', 'Integrate', 'Integration branch']) {
    const text = line(name);
    assert.ok(text.includes(stageWorktree), `**${name}.** 要寫明在 stage worktree 執行`);
    for (const [hit, target] of text.matchAll(/git (?:-C (\S+) )?(?:checkout|switch)\b/g)) {
      assert.equal(target, stageWorktree, `${name}：${hit} 不在 stage worktree`);
    }
  }
});

// 主 checkout 不在 main 的偵測在 pilot-probe.mjs 裡（tests/pilot-probe.test.mjs 驗 NOT_MAIN）；這裡驗 Probe 跑它並處理 NOT_MAIN。
test('Probe 在主 checkout 跑 pilot-probe.mjs，並處理 NOT_MAIN', () => {
  assert.match(line('Probe'), /node scripts\/pilot-probe\.mjs \/home\/ron\/code\/ron-skills/);
  assert.match(line('Probe'), /`NOT_MAIN <分支>` 回報人，不 stage、不 merge/);
});
