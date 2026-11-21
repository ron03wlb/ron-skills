import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { BRIEF_FIELDS, briefRejectLine, missingFields, skeleton } from './brief-check.mjs';

const SCRIPT = fileURLToPath(new URL('./brief-check.mjs', import.meta.url));
const HERE = dirname(SCRIPT);
const cli = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: HERE });
const tempDir = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'brief-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const FULL = ['# #7 brief', '',
  '目標：修好 #7 的回歸失敗', '範圍：本 card worktree /w（分支 issue/7-fix）', '驗收：失敗的 testcase 全綠', '驗證：`bin/check`',
  'TIMEBOX：90 分鐘；超過時最後一行 `STOP 7 timebox <進度>`', '', '請做：', '1. …', '',
  '禁止：不 push、不 merge', 'Standing orders：/repo/.scratch/pilot/preferences.md', '回報：最後一行 `DONE 7 <sha>`', ''].join('\n');

test('missingFields：八個欄位以行首標籤辨識，缺的依序列出（spay2 #649，ron-skills #346）', () => {
  assert.deepEqual(BRIEF_FIELDS.map(([name]) => name), ['goal', 'scope', 'acceptance', 'verify', 'timebox', 'forbidden', 'report', 'standing-orders']);
  assert.deepEqual(missingFields(FULL), []);
  assert.deepEqual(missingFields(FULL.replace(/^TIMEBOX.*\n/m, '')), ['timebox']);
  assert.deepEqual(missingFields(FULL.replace(/^Standing orders.*\n/m, '').replace(/^目標.*\n/m, '')), ['goal', 'standing-orders']);
  assert.deepEqual(missingFields(FULL.replace('TIMEBOX：90 分鐘', 'TIMEBOX：盡快')), ['timebox'], 'TIMEBOX 要有分鐘數');
  assert.deepEqual(missingFields(FULL.replace('/repo/.scratch/pilot/preferences.md', '見 coordinator')), ['standing-orders'], 'standing orders 要指向 preferences.md');
  assert.deepEqual(missingFields(FULL.replace(/^範圍：.*$/m, '範圍： ')), ['scope'], '標籤後要有內容');
  assert.deepEqual(missingFields(FULL.replace('目標：', '目標:')), [], '半形冒號也算');
});

test('briefRejectLine：一行含 batch key、iid、brief 路徑、原因分類與缺項，不含 brief 全文', () => {
  assert.equal(briefRejectLine({ batch: 'batch-7', iid: '7', file: '/w/.scratch/pilot/briefs/fix-7.md', missing: ['timebox', 'standing-orders'] }),
    'BRIEF_REJECTED batch-7 #7 /w/.scratch/pilot/briefs/fix-7.md class=missing-fields missing=timebox,standing-orders');
});

test('CLI：完整 brief 印 BRIEF_OK exit 0；缺欄位印 BRIEF_REJECTED exit 1；用法錯誤或讀不到檔 exit 2', t => {
  const dir = tempDir(t);
  const ok = join(dir, 'ok.md'); writeFileSync(ok, FULL);
  const bad = join(dir, 'bad.md'); writeFileSync(bad, FULL.replace(/^TIMEBOX.*\n/m, ''));
  assert.deepEqual([cli(ok).status, cli(ok).stdout], [0, `BRIEF_OK ${ok}\n`]);
  const rejected = cli(bad, '--batch', 'batch-7', '--iid', '7');
  assert.deepEqual([rejected.status, rejected.stdout], [1, `BRIEF_REJECTED batch-7 #7 ${bad} class=missing-fields missing=timebox\n`]);
  assert.equal(cli(bad).stdout, `BRIEF_REJECTED ? #? ${bad} class=missing-fields missing=timebox\n`);
  assert.equal(cli().status, 2);
  assert.equal(cli(bad, '--batch').status, 2, '旗標缺值');
  assert.equal(cli(bad, '--nope', 'x').status, 2, '不認得的旗標');
  assert.equal(cli(join(dir, 'none.md')).status, 2);
});

// spay2 retro b20cba58#1：照 pstack 範本寫英文 `## Goal` 標題的 brief，八欄全缺。
const GOAL_HEADINGS = ['# dispatch race', '', '## Goal', '修派工等待的競態', '', '## Scope', 'scripts/x.mjs', '',
  '## Acceptance', '測試穩定通過', '', '## Verify', 'bin/check', '', '## Timebox', '60 分鐘', '',
  '## Forbidden', '不 push', '', '## Standing orders', '/repo/.scratch/pilot/preferences.md', '', '## Report', 'DONE <sha>', ''].join('\n');

test('--skeleton：印能通過檢查的標籤骨架，Standing orders 預填主 checkout 的 preferences.md；`## Goal` 標題版 exit 1，骨架填值後 exit 0', t => {
  const dir = tempDir(t);
  const headings = join(dir, 'headings.md'); writeFileSync(headings, GOAL_HEADINGS);
  assert.deepEqual([cli(headings).status, cli(headings).stdout],
    [1, `BRIEF_REJECTED ? #? ${headings} class=missing-fields missing=goal,scope,acceptance,verify,timebox,forbidden,report,standing-orders\n`]);
  const out = cli('--skeleton');
  assert.equal(out.status, 0, out.stderr);
  const main = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: HERE, encoding: 'utf8' }).stdout.split('\n')[0].replace(/^worktree /, '');
  assert.equal(out.stdout, skeleton(main));
  assert.ok(out.stdout.split('\n').includes(`Standing orders：${join(main, '.scratch/pilot/preferences.md')}`), out.stdout);
  assert.match(out.stdout, /^驗證：.*grep -E '\^ℹ \(pass\|fail\)'/m, 'node 24 的 --test 摘要是 `ℹ pass <n>`');
  assert.deepEqual(missingFields(out.stdout), []);
  const filled = join(dir, 'filled.md');
  writeFileSync(filled, out.stdout.replace('<一句話：要達成的結果>', '修派工等待的競態').replace('<worktree 絕對路徑、分支；可改的檔案>', '/w（分支 x）；scripts/x.mjs')
    .replace('<可觀察的完成條件；新行為要有 fixture>', '測試穩定通過').replace('<指令>', 'bin/check').replace('<最後一行的格式>', 'DONE <sha>'));
  assert.deepEqual([cli(filled).status, cli(filled).stdout], [0, `BRIEF_OK ${filled}\n`]);
  assert.equal(cli('--skeleton', 'x').status, 2, '--skeleton 不帶其他參數');
});

test('--skeleton 在 git repo 外：Standing orders 用 cwd', t => {
  const dir = tempDir(t);
  const out = spawnSync('node', [SCRIPT, '--skeleton'], { encoding: 'utf8', cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(missingFields(out.stdout), []);
  assert.match(out.stdout, /^Standing orders：.*\.scratch\/pilot\/preferences\.md$/m);
});
