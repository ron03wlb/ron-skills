import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #239：Push gate 在主 checkout 跑 `main` 上的 `pilot-pr-body.mjs`，batch 193 改了它認得的 regression 行，舊版印 `STOP regression 193`。
// pilot adapter 裡這兩支腳本的指令一律寫成 `node <stage worktree>/scripts/…`。
const FILES = ['docs/agents/pilot.md', 'docs/agents/pilot-after-merge.md', 'docs/agents/pilot-exceptions.md', 'docs/agents/pilot-conflict.md'];
const COMMAND = /node (\S*)(pilot-pr-body\.mjs|pilot-land\.mjs sync-main)/g;

/** 沒有寫成 `<stage worktree>/scripts/` 的 Push gate 腳本指令。 */
export function mainCheckoutCommands(text) {
  return [...text.matchAll(COMMAND)].filter(m => m[1] !== '<stage worktree>/scripts/').map(m => m[0]);
}

test('Push gate 的 pilot-pr-body 與 sync-main 指令都跑 stage worktree 的腳本', () => {
  for (const file of FILES) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(mainCheckoutCommands(text), [], file);
  }
});

test('#239 的原寫法被抓到', () => {
  assert.deepEqual(mainCheckoutCommands('1. 跑 `node scripts/pilot-pr-body.mjs <主 checkout> --out x`；`STOP behind-main` 跑 `node scripts/pilot-land.mjs sync-main`'),
    ['node scripts/pilot-pr-body.mjs', 'node scripts/pilot-land.mjs sync-main']);
  assert.deepEqual(mainCheckoutCommands('`node <stage worktree>/scripts/pilot-pr-body.mjs <主 checkout>`'), []);
});
