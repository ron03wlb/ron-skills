// overlay 測試的共用前置：把上游 skill 複製到暫存目錄，套上 overlays/<name>.patch，回傳套用後的 SKILL.md（#462-3）。
// 上游位置與 git apply 沿用 scripts/sync-skills.mjs（它也清掉 GIT_DIR 等變數：pre-commit hook 匯出後 git apply 會套到本 repo，#25）。
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyPatch, upstreamSkill } from '../../scripts/sync-skills.mjs';
import { realTmpdir } from './real-tmpdir.mjs';

const root = new URL('../..', import.meta.url).pathname;

/** 上游 skill 目錄：matt-skills.txt／pstack-skills.txt 裡啟用的那一份。 */
export const upstreamDir = name => {
  const found = upstreamSkill(name, root);
  assert.ok(found, `清單沒有啟用 ${name}`);
  return found.dir;
};

/** 套用 overlays/<name>.patch 後的 SKILL.md 內容；暫存目錄在測試結束時刪除。 */
export function applyOverlay(t, name, upstream = upstreamDir(name)) {
  const dir = mkdtempSync(join(realTmpdir(), `${name}-overlay-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(upstream, dir, { recursive: true });
  const applied = applyPatch(join(root, 'overlays', `${name}.patch`), dir, ['ignore', 'pipe', 'pipe']);
  assert.equal(applied.status, 0, applied.stderr);
  return readFileSync(join(dir, 'SKILL.md'), 'utf8');
}
