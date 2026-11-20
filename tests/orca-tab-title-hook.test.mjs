// hooks/orca-tab-title.test.sh 納入 bin/check（#374）：測試腳本自建兩個 Orca issue worktree 的 fixture，
// 沒有 Orca、沒有真實 worktree 的環境（CI）也要實際跑完每個情境，不能 SKIP。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../hooks/orca-tab-title.test.sh', import.meta.url));

test('orca-tab-title hook 回歸測試在沒有 Orca worktree 的環境實際執行並全數通過', t => {
  // HOME 換成空目錄：模擬 CI（沒有 ~/code/spay2 與任何 Orca worktree），也不碰使用者的 ~/.cache。
  const home = mkdtempSync(join(realTmpdir(), 'orca-tab-title-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  delete env.ORCA_TERMINAL_HANDLE;
  delete env.ORCA_CLI_COMMAND;
  const r = spawnSync('sh', [script], { encoding: 'utf8', env, timeout: 300_000 });
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /SKIP/, out);
  assert.doesNotMatch(out, /^FAIL /m, out);
  assert.equal(r.status, 0, out);
  assert.ok((out.match(/^PASS /gm) || []).length >= 20, out);
});
