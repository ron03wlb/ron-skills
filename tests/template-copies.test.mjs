// scripts/ 裡從 setup-workflow 正本複製來的副本（清單在 docs/agents/workflow-templates.json）必須與正本逐位元組相同、
// 與清單記錄的 sha256 一致：要改就改正本，commit 後用 setup-workflow 的 copy-templates.mjs 複製過來。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pilotFiles } from '../scripts/pilot-probe.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const { copies } = JSON.parse(read('docs/agents/workflow-templates.json'));

for (const [path, entry] of Object.entries(copies)) {
  test(`${path} 與 setup-workflow 正本相同，hash 與清單一致`, () => {
    assert.ok(read(path).equals(read(entry.template)),
      `${path} 與正本不同：改 ${entry.template}，commit 後執行 node skills/engineering/setup-workflow/scripts/copy-templates.mjs . --no-tests <名稱>`);
    assert.equal(createHash('sha256').update(read(path)).digest('hex'), entry.sha256, `${path} 與清單記錄的 sha256 不同`);
    assert.match(entry.commit, /^[0-9a-f]{40}$/);
  });
}

// L3 必接：主 checkout 的未提交改動與新檔會讓 pilot 的 Probe 停止合併（#30）；Bash 的 sed -i、重導向也會寫檔（#47）。
test('.claude/settings.json 以 PreToolUse（Edit|Write|Bash）接上主 checkout 防護', () => {
  assert.ok(copies['scripts/claude-hook-main-checkout.mjs'], '清單沒有 scripts/claude-hook-main-checkout.mjs');
  const { hooks } = JSON.parse(read('.claude/settings.json'));
  const wired = hooks.PreToolUse.some(({ matcher, hooks: list }) => /\bEdit\b/.test(matcher) && /\bWrite\b/.test(matcher) && /\bBash\b/.test(matcher)
    && list.some(({ command }) => command.includes('scripts/claude-hook-main-checkout.mjs')));
  assert.ok(wired, '.claude/settings.json 的 PreToolUse 沒有以 Edit|Write|Bash 呼叫 scripts/claude-hook-main-checkout.mjs');
});

// pilot-handoff 是合併兩邊後的正本（#57）：本 repo 的 Handoff 跑的是副本，連同它開 session 用的 orca-session-split。
test('scripts/pilot-handoff.mjs 與它 import 的 orca-session-send、orca-session-split 都登記為副本', () => {
  for (const path of ['scripts/pilot-handoff.mjs', 'scripts/orca-session-send.mjs', 'scripts/orca-session-split.mjs']) assert.ok(copies[path], `清單沒有 ${path}`);
});

// pilot 存檔的寫入者由副本負責，adapter 的 Pilot 段不再要求手寫（#56；gates.md 的 pilot-gate，#134；batch 成員搬移的 pilot-batch，#163）。
test('清單涵蓋寫 pilot 存檔的 7 個副本與它們的共用 lib', () => {
  for (const name of ['pilot-register', 'pilot-decision', 'pilot-request', 'pilot-hold', 'pilot-sources', 'pilot-gate', 'pilot-batch', 'lib/pilot-store']) {
    assert.ok(copies[`scripts/${name}.mjs`], `清單沒有 scripts/${name}.mjs`);
  }
});

// Probe 與 Dispatch 改用正本（#58）：adapter 的呼叫方式不變；正本不寫死本 repo 的路徑與名稱，
// ADAPTER_AHEAD 要比的 pilot.md 由 adapter 的 Pilot 段連結推出。
test('pilot-probe、pilot-dispatch 登記為副本，正本與測試 grep 不到本 repo 專屬的路徑或名稱', () => {
  for (const name of ['pilot-probe', 'pilot-dispatch']) {
    assert.ok(copies[`scripts/${name}.mjs`], `清單沒有 scripts/${name}.mjs`);
    for (const file of [`${name}.mjs`, `${name}.test.mjs`]) {
      const text = read(`skills/engineering/setup-workflow/templates/${file}`).toString();
      for (const word of ['ron-skills', 'ron03wlb', 'spay2', 'docs/agents/pilot.md', '/Users/', '/home/', '/root/']) {
        assert.ok(!text.includes(word), `${file} 含有 ${word}`);
      }
    }
  }
});

test('本 repo adapter 的 Pilot 段連到 pilot.md，Probe 會把它當 adapter 比對', () => {
  assert.deepEqual(pilotFiles(read('docs/agents/issue-run.md').toString()), ['docs/agents/pilot.md']);
});

// 分頁狀態（#126）：LANDED、HANDED_OFF 在 Bash 輸出，worker 的 DONE 與前綴檢查在 Stop。
test('.claude/settings.json 以 PostToolUse（Bash）與 Stop 接上分頁狀態 hook', () => {
  for (const path of ['scripts/tab-state.mjs', 'scripts/claude-hook-tab-state.mjs']) assert.ok(copies[path], `清單沒有 ${path}`);
  const { hooks } = JSON.parse(read('.claude/settings.json'));
  const calls = list => list.some(({ command }) => command.includes('scripts/claude-hook-tab-state.mjs'));
  assert.ok(hooks.PostToolUse.some(({ matcher, hooks: list }) => /\bBash\b|^\*$/.test(matcher) && calls(list)), 'PostToolUse 沒有對 Bash 呼叫 scripts/claude-hook-tab-state.mjs');
  assert.ok(hooks.Stop.some(({ hooks: list }) => calls(list)), 'Stop 沒有呼叫 scripts/claude-hook-tab-state.mjs');
});
