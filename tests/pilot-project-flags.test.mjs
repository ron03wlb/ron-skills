import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #245：pilot-land、pilot-close 改成 setup-workflow 正本的副本後，ron-skills 的專案值改由參數給。少了旗標時指令照樣跑完：
// pilot-land 改跑 `bin/check`（沒有 --upstream，看不到 overlay 漂移）、條目衝突與流程站戳記都變成 STOP conflict；pilot-close 沒有 --repo 就 exit 2。
// 所以 adapter 裡每一條這兩支的指令都要帶上 ron-skills 的值。
const FILES = ['docs/agents/pilot.md', 'docs/agents/pilot-after-merge.md', 'docs/agents/pilot-exceptions.md', 'docs/agents/pilot-conflict.md'];
const LAND_FLAGS = "--check-command 'bin/check --upstream' --resolver scripts/pilot-resolve.mjs";
const CLOSE_FLAGS = '--repo ron03wlb/ron-skills';

/** 文字裡反引號包住、以 `node ` 開頭的 pilot-land／pilot-close 指令，缺了 ron-skills 旗標的那些。 */
export function missingFlags(text) {
  return [...text.matchAll(/`(node [^`]*?pilot-(land|close)\.mjs[^`]*)`/g)]
    .filter(([, command, name]) => !command.includes(name === 'land' ? LAND_FLAGS : CLOSE_FLAGS))
    .map(([, command]) => command);
}

test('adapter 的 pilot-land、pilot-close 指令都帶 ron-skills 的專案值', () => {
  let seen = 0;
  for (const file of FILES) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    seen += [...text.matchAll(/`node [^`]*?pilot-(land|close)\.mjs/g)].length;
    assert.deepEqual(missingFlags(text), [], file);
  }
  // Stage、sync-main、請求分支與 Close 都有指令：零命中表示 regex 沒認得寫法。
  assert.ok(seen >= 4, `只找到 ${seen} 條指令`);
});

test('缺旗標的寫法被抓到', () => {
  assert.deepEqual(missingFlags('跑 `node scripts/pilot-land.mjs <key>`，再 `node scripts/pilot-close.mjs <key> <pr> <merge sha>`'),
    ['node scripts/pilot-land.mjs <key>', 'node scripts/pilot-close.mjs <key> <pr> <merge sha>']);
  assert.deepEqual(missingFlags(`\`node <stage worktree>/scripts/pilot-land.mjs sync-main ${LAND_FLAGS}\`、\`node scripts/pilot-close.mjs 1 2 abc ${CLOSE_FLAGS}\``), []);
});
