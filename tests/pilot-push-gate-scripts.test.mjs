import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #239：Push gate 在主 checkout 跑 `main` 上的 `pilot-pr-body.mjs`，batch 193 改了它認得的 regression 行，舊版印 `STOP regression 193`。
// #275：原本的解法是 adapter 一律寫 `node <stage worktree>/scripts/…`，每任 coordinator 都得手算路徑。改成主 checkout 的入口自己轉到 stage worktree 的版本
// （行為測試在 setup-workflow 正本的 pilot-pr-body.test.mjs），所以 adapter 要寫主 checkout 的入口，不再要人算路徑。
const FILES = ['docs/agents/pilot.md', 'docs/agents/pilot-after-merge.md', 'docs/agents/pilot-exceptions.md', 'docs/agents/pilot-conflict.md', 'skills/engineering/issue-run/PILOT-TEMPLATE.md'];
// `<stage worktree>` 中間有空格，`\S*` 比對不到，要另外列。
const COMMAND = /node (<stage worktree>\/\S*|\S*)(pilot-pr-body\.mjs|pilot-land\.mjs sync-main)/g;

/** 要 coordinator 自己算路徑的 Push gate 腳本指令。 */
export function handComputedCommands(text) {
  return [...text.matchAll(COMMAND)].filter(m => m[1] !== 'scripts/').map(m => m[0]);
}

test('Push gate 的 pilot-pr-body 與 sync-main 指令都寫主 checkout 的入口', () => {
  for (const file of FILES) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(handComputedCommands(text), [], file);
  }
});

test('#275 的手算寫法被抓到', () => {
  assert.deepEqual(handComputedCommands('`node <stage worktree>/scripts/pilot-pr-body.mjs <主 checkout>`；`node $ST/scripts/pilot-land.mjs sync-main`'),
    ['node <stage worktree>/scripts/pilot-pr-body.mjs', 'node $ST/scripts/pilot-land.mjs sync-main']);
  assert.deepEqual(handComputedCommands('`node scripts/pilot-pr-body.mjs <主 checkout> --out x`'), []);
});

test('主 checkout 的兩支副本都會轉交，否則上面的寫法會跑到 main 上的舊版（#239）', () => {
  for (const name of ['pilot-pr-body', 'pilot-land']) {
    assert.match(readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8'), /runInStageWorktree\(import\.meta\.url/, name);
  }
});
