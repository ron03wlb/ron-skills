// setup-workflow 測試共用：不受外層 GIT_* 與全域 git 設定影響的 env、git 與寫檔 helper。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
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
