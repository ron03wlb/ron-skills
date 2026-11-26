import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// #593：#395 的 coordinator 對閒置分頁（空 `❯`、footer `← 1 agent`）連跑三次 resume 都印 `STOP <n> tui-timeout`，才開 gate。
// 就緒由 Orca 的 `tui-idle` 判斷、本 repo 不重判；Resume 條目要寫明連續兩次 tui-timeout 之後改走 `--fresh`，遇未提交改動照 `DIRTY_BACKUP` 處理。
const root = new URL('..', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('adapter-line 讀得到的 Resume 條目寫明連續 tui-timeout 的下一步', () => {
  const entry = execFileSync('node', ['scripts/adapter-line.mjs', 'Resume'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(line => line.startsWith('- **Resume.**') && !line.includes('見 [pilot-round.md]')).join('\n');
  for (const needle of ['連續兩次', 'SCREEN_TAIL', 'tui-idle', '← 1 agent', 'pilot-dispatch.mjs <key> --fresh', 'DIRTY_BACKUP', '#593'])
    assert.ok(entry.includes(needle), `Resume 條目缺 ${needle}`);
});

test('pilot-batch 與 orca-session-send 正本的 tui-timeout 說明記下就緒由 Orca 判斷（#593）', () => {
  for (const name of ['pilot-batch.mjs', 'orca-session-send.mjs']) {
    const head = read(`skills/engineering/setup-workflow/templates/${name}`).split('\n').filter(line => line.startsWith('//')).join('\n');
    assert.match(head, /tui-idle[^\n]*本 repo 不重判[^\n]*#593/, name);
  }
});
