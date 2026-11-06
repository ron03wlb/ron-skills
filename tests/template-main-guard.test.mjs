// retro spay2 e9234021#1：範本的 main guard 寫成 `import.meta.url === pathToFileURL(process.argv[1]).href` 時，
// 被 `node --input-type=module -e` 或 `node --eval` 載入（argv[1] 是 undefined）就丟 ERR_INVALID_ARG_TYPE，import 它的腳本跟著壞
// （spay2 的 followups.mjs → worktree-overlap.mjs，batch-merge.test exit 1）。guard 要先判斷 `process.argv[1] &&`。
// 這裡對每支用 pathToFileURL／realpathSync 包 argv[1] 當 guard 的正本實際 import 一次，exit 0 才算過；改了舊寫法的新範本也會被抓到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('../skills/engineering/setup-workflow/templates/', import.meta.url);
const guarded = readdirSync(dir).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  .filter(name => /(pathToFileURL|realpathSync)\((realpathSync\()?process\.argv\[1\]/.test(readFileSync(new URL(name, dir), 'utf8')));

test('有 argv[1] main guard 的正本至少找到一支（樣式沒改名）', () => {
  assert.ok(guarded.includes('worktree-overlap.mjs'), guarded.join(' '));
});

for (const name of guarded) {
  test(`${name}：argv[1] 為 undefined 時 import 不丟例外、不執行 main`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL(name, dir).href)});`],
      { cwd: fileURLToPath(dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    assert.equal(result.status, 0, `${name} exit ${result.status}：${result.stderr}`);
  });
}
