// setup-workflow 測試共用：不受外層 GIT_*、Claude session 與全域 git 設定影響的 env、git 與寫檔 helper。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// pilot-land.mjs、land.mjs 經 heavy-slot.mjs 跑檢查：鎖檔目錄換成本行程的暫存目錄，env 取值之前就要設好。
import '../../skills/engineering/setup-workflow/templates/test/isolate-heavy-slot-env.mjs';

// CLAUDE_CODE_SESSION_ID 等：在 Claude Code 裡跑測試時 pilot-probe 會讀到這個 session 的 transcript，
// context 超過門檻就多印 HANDOFF_DUE（#663）；要測 context 的測試自己用 PILOT_TRANSCRIPT 指到 fixture。
const SESSION_KEYS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'PILOT_TRANSCRIPT'];

export const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !SESSION_KEYS.includes(key))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};

export function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** 依 { 相對路徑: 內容 } 寫檔；內容為 undefined 的略過。 */
export function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
