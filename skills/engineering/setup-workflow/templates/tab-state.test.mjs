import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { forgetTitleRecord, recordTitle, recordedTitle, sameTopic, stripState, withState } from './tab-state.mjs';

const script = fileURLToPath(new URL('./tab-state.mjs', import.meta.url));
const SELF = 'term_self';

// 記錄呼叫的假 Orca CLI：`terminal list` 回本分頁（title 是 Claude 的自動標題；`tabTitle` 是 --include-visual-layouts 回的實際分頁標題）。
// `failing` 為真時每個呼叫都回錯。標題記錄放在 fixture 的 TAB_STATE_DIR，不碰家目錄。
// `tabTitle` 有值時 rename 會改掉回報的分頁標題；`stuck` 為真時 rename 回 ok、回報的標題不變（2026-11-02 coordinator 回報改名成功，分頁實際沒變）。
// `lagReads` 是改名後還回舊標題的讀取次數。
function fixture(t, { autoTitle = 'Claude 自動標題', failing = false, tabTitle, slow = '', stuck = false, lagReads = 0, firstRenameFails = false, slowRenames = 0, renameLands = false } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'tab-state-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const dir = join(temp, 'titles');
  const live = join(temp, 'live-title');
  const pending = join(temp, 'pending-title');
  const lag = join(temp, 'lag-reads');
  if (tabTitle !== undefined) writeFileSync(live, tabTitle);
  writeFileSync(lag, String(lagReads));
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (b === ${JSON.stringify(slow)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
if (b === 'rename' && fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('terminal rename').length - 1 <= ${slowRenames}) {
  if (${renameLands}) fs.writeFileSync(${JSON.stringify(live)}, arg('--title'));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
}
if (${failing}) fail('runtime_unavailable');
else if (${firstRenameFails} && b === 'rename' && fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('terminal rename').length === 2) fail('runtime_unavailable');
else if (b === 'list' && fs.existsSync(${JSON.stringify(live)}) && process.argv.includes('--include-visual-layouts')) {
  const left = Number(fs.readFileSync(${JSON.stringify(lag)}, 'utf8'));
  if (fs.existsSync(${JSON.stringify(pending)})) {
    if (left > 0) fs.writeFileSync(${JSON.stringify(lag)}, String(left - 1));
    else fs.renameSync(${JSON.stringify(pending)}, ${JSON.stringify(live)});
  }
  reply('list-visual', { visualLayouts: [{ root: { second: { tabs: [{ title: fs.readFileSync(${JSON.stringify(live)}, 'utf8'), panes: { second: { handle: ${JSON.stringify(SELF)} } } }] } } }] });
}
else if (b === 'list') reply('list', { terminals: [{ handle: 'term_other', title: '別人' }, { handle: ${JSON.stringify(SELF)}, title: ${JSON.stringify(autoTitle)} }], totalCount: 2 });
else if (b === 'rename') {
  if (!${stuck} && fs.existsSync(${JSON.stringify(live)})) fs.writeFileSync(${JSON.stringify(pending)}, arg('--title'));
  reply('rename', { rename: { handle: arg('--terminal'), title: arg('--title') } });
}
`);
  chmodSync(cli, 0o755);
  const record = title => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, SELF), title); };
  const recorded = () => existsSync(join(dir, SELF)) ? readFileSync(join(dir, SELF), 'utf8') : null;
  const run = (args, extra = {}) => spawnSync('node', [script, ...args], {
    encoding: 'utf8', env: { ...process.env, ORCA_CLI_COMMAND: cli, ORCA_TERMINAL_HANDLE: SELF, TAB_STATE_DIR: dir, ...extra },
  });
  return { log, record, recorded, run, calls: () => readFileSync(log, 'utf8') };
}

test('換狀態前綴：以 Orca 實際分頁標題為準，不用過期的記錄', t => {
  const { record, recorded, run } = fixture(t, { tabTitle: '處理中｜新主題' });
  record('處理中｜舊主題');
  assert.equal(run(['待 Retro']).status, 0);
  assert.equal(recorded(), '待 Retro｜新主題');
});

test('換狀態前綴：只換最前面的狀態，其他文字不動，並記下新標題', t => {
  const { record, recorded, run, calls } = fixture(t);
  record('處理中｜#21 雙池採集｜實作｜補 TPEx 舊版格式');
  const result = run(['待 Retro']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls(), /^terminal rename --terminal term_self --title 待 Retro｜#21 雙池採集｜實作｜補 TPEx 舊版格式 --json$/m);
  assert.equal(recorded(), '待 Retro｜#21 雙池採集｜實作｜補 TPEx 舊版格式');
});

test('沒有前綴就補上：沒有記錄時以 Orca 的自動標題為目前標題', t => {
  const { recorded, run, calls } = fixture(t, { autoTitle: 'Issue-run 126 batch 126-128' });
  const result = run(['處理中']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 處理中｜Issue-run 126 batch 126-128');
  assert.match(calls(), /^terminal rename --terminal term_self --title 處理中｜Issue-run 126 batch 126-128 --json$/m);
  assert.equal(recorded(), '處理中｜Issue-run 126 batch 126-128');
});

// #141：/clear 後的新 session 跑 `tab-state 處理中`，帶出同一個 handle 上一個 session 的主題。
test('--topic：一次設定前綴與主題，不沿用記錄裡上一個 session 的主題', t => {
  const { record, recorded, run, calls } = fixture(t);
  record('處理中｜[維運] 整理 worktree');
  const result = run(['處理中', '--topic', '[維運] retro 收集']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 處理中｜[維運] retro 收集');
  assert.equal(calls(), 'terminal rename --terminal term_self --title 處理中｜[維運] retro 收集 --json\nterminal list --include-visual-layouts --json\n', '不讀目前標題，只有改名後讀回');
  assert.equal(recorded(), '處理中｜[維運] retro 收集');
});

test('--topic 沒有值或是空字串：exit 2，不呼叫 Orca', t => {
  const { run, calls } = fixture(t);
  for (const args of [['處理中', '--topic'], ['處理中', '--topic', ''], ['處理中', '--topic', ' ']]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
  assert.equal(calls(), '');
});

// retro spay2 92fa93fe#7：Orca 回 ok 但分頁標題沒變，只看回傳就回報了沒發生的事。
test('改名回 ok 但讀回的標題不符：不印 TAB_STATE，印 TAB_STATE_MISMATCH 並 exit 1', t => {
  const { run } = fixture(t, { tabTitle: 'Loop issue-pilot command', stuck: true });
  const result = run(['處理中', '--topic', '[維運] 主題'], { TAB_STATE_VERIFY_RETRY_MS: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'TAB_STATE_MISMATCH 處理中｜[維運] 主題 actual=Loop issue-pilot command');
});

test('改名後讀回的標題相符：照常印 TAB_STATE、exit 0', t => {
  const { run } = fixture(t, { tabTitle: '舊標題' });
  const result = run(['處理中', '--topic', '主題']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 處理中｜主題');
  assert.equal(result.stderr, '');
});

test('改名後要過一下才讀得到新標題：重讀到相符就算成功', t => {
  const { run } = fixture(t, { tabTitle: '舊標題', lagReads: 1 });
  const result = run(['處理中', '--topic', '主題'], { TAB_STATE_VERIFY_RETRY_MS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 處理中｜主題');
});

test('讀不到分頁（舊版 Orca、連不上）不算不符：照常印 TAB_STATE、exit 0', t => {
  const { run } = fixture(t);
  const result = run(['處理中', '--topic', '主題']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 處理中｜主題');
  assert.equal(result.stderr, '');
});

test('改名後讀回太慢：不算不符，照常印 TAB_STATE、exit 0', t => {
  const { run } = fixture(t, { slow: 'list' });
  const result = run(['處理中', '--topic', '主題'], { TAB_STATE_LIST_BUDGET_MS: '300', TAB_STATE_BUDGET_MS: '20000' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 處理中｜主題');
});

test('沒有 ORCA_TERMINAL_HANDLE：exit 0 不輸出、不改記錄', t => {
  const { recorded, run } = fixture(t);
  const result = run(['待關閉'], { ORCA_TERMINAL_HANDLE: '' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, '');
  assert.equal(recorded(), null);
});

// #295：`tab-state 處理中 --topic …` 只有 exit 0、沒有 TAB_STATE 行，分不出成功或失敗。
test('Orca 呼叫失敗：exit 0、stdout 空、stderr 印 TAB_STATE_FAILED 與原因，不改記錄', t => {
  const { recorded, run } = fixture(t, { failing: true });
  const result = run(['待關閉']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'TAB_STATE_FAILED 待關閉 runtime_unavailable');
  assert.equal(recorded(), null);
});

// 1102b：d6651f99 跑 `tab-state 待關閉` 只有 exit 0、沒有 TAB_STATE，分頁實際已改名但記錄還是待 Retro，#297 的分頁沒被關。
test('第一次改名失敗：再送一次，成功就印 TAB_STATE 並寫記錄', t => {
  const { record, recorded, run, calls } = fixture(t, { firstRenameFails: true });
  record('待 Retro｜x');
  const result = run(['待關閉']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 待關閉｜x');
  assert.equal(result.stderr, '');
  assert.equal(recorded(), '待關閉｜x');
  assert.equal(calls().split('terminal rename').length - 1, 2);
});

test('--title：有實際分頁標題時不用過期的記錄，查不到才用記錄；沒給 handle 是用法錯誤', t => {
  const live = fixture(t, { tabTitle: '待關閉｜x' });
  live.record('待 Retro｜x');
  assert.equal(live.run(['--title', SELF], { ORCA_TERMINAL_HANDLE: '' }).stdout.trim(), '待關閉｜x');
  const stale = fixture(t, { failing: true });
  stale.record('待關閉｜y');
  assert.equal(stale.run(['--title', SELF]).stdout.trim(), '待關閉｜y');
  assert.equal(stale.run(['--title']).status, 2);
});

test('改名逾時：stderr 講明逾時、改名可能已送達，不改記錄', t => {
  const { recorded, run } = fixture(t, { slow: 'rename' });
  const result = run(['待關閉', '--topic', 'x'], { TAB_STATE_BUDGET_MS: '300' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^TAB_STATE_FAILED 待關閉 逾時（300 ms），改名可能已送達$/m);
  assert.equal(recorded(), null);
});

// retro spay2 b1549391#4：逾時後由腳本自己讀回，不交給 agent 判斷。
const BUDGET = { TAB_STATE_BUDGET_MS: '2000', TAB_STATE_VERIFY_RETRY_MS: '1' };

test('改名逾時後讀回沒生效：再送一次，成功就印 TAB_STATE 並寫記錄', t => {
  const { recorded, run, calls } = fixture(t, { tabTitle: '舊標題', slowRenames: 2 });
  const result = run(['處理中', '--topic', 'x'], BUDGET);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^TAB_STATE 處理中｜x$/m);
  assert.equal(recorded(), '處理中｜x');
  assert.equal(calls().split('terminal rename').length - 1, 3);
});

test('改名逾時後讀回已生效：不再送，印 TAB_STATE 並寫記錄', t => {
  const { recorded, run, calls } = fixture(t, { tabTitle: '舊標題', slowRenames: 2, renameLands: true });
  const result = run(['處理中', '--topic', 'x'], BUDGET);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^TAB_STATE 處理中｜x$/m);
  assert.equal(recorded(), '處理中｜x');
  assert.equal(calls().split('terminal rename').length - 1, 2);
});

test('只換前綴、改名逾時後讀回已帶該前綴：算生效，記下實際標題', t => {
  const { recorded, run } = fixture(t, { tabTitle: '舊標題', slowRenames: 2, renameLands: true });
  const result = run(['處理中'], BUDGET);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^TAB_STATE 處理中｜舊標題$/m);
  assert.equal(recorded(), '處理中｜舊標題');
});

test('改名逾時、讀回沒生效、再送仍逾時：印 TAB_STATE_FAILED，共送三次', t => {
  const { recorded, run, calls } = fixture(t, { tabTitle: '舊標題', slow: 'rename' });
  const result = run(['處理中', '--topic', 'x'], BUDGET);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^TAB_STATE_FAILED 處理中 逾時（2000 ms），改名可能已送達$/m);
  assert.equal(recorded(), null);
  assert.equal(calls().split('terminal rename').length - 1, 3);
});

// #295：terminal list --include-visual-layouts 花 12.8 秒，超過共用的 10 秒，改名連帶被中止。
test('讀目前標題太慢：改用記錄的標題，改名照常完成', t => {
  const { record, recorded, run } = fixture(t, { slow: 'list' });
  record('處理中｜主題');
  const result = run(['待關閉'], { TAB_STATE_LIST_BUDGET_MS: '300', TAB_STATE_BUDGET_MS: '20000' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TAB_STATE 待關閉｜主題');
  assert.equal(recorded(), '待關閉｜主題');
});

test('狀態不合法：exit 2，不呼叫 Orca', t => {
  const { run, calls } = fixture(t);
  for (const args of [[], ['完成'], ['待', 'retro']]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
  assert.equal(calls(), '');
});

test('withState、stripState：只認三種狀態加全形｜的前綴', () => {
  assert.equal(withState('待 Retro｜#126 分頁狀態｜已合入 PR #130', '待關閉'), '待關閉｜#126 分頁狀態｜已合入 PR #130');
  assert.equal(withState('#126 分頁狀態｜實作', '處理中'), '處理中｜#126 分頁狀態｜實作');
  assert.equal(stripState('完成｜#126'), '完成｜#126');
  assert.equal(stripState('處理中|#126'), '處理中|#126');
});

test('sameTopic：去掉狀態前綴與 [類別] 後比對', () => {
  assert.equal(sameTopic('處理中｜[維運] issue-pilot coordinator', 'issue-pilot coordinator'), true);
  assert.equal(sameTopic('待 Retro｜[維運] issue-pilot coordinator', '[維運] issue-pilot coordinator'), true);
  assert.equal(sameTopic('處理中｜#126 分頁狀態', 'issue-pilot coordinator'), false);
  assert.equal(sameTopic(null, ''), false);
});

// 真實情形：followups 395。spay2 的 retro-collect 複製了目錄與檔名規則來刪紀錄，這裡改了就靜默刪不到。
test('forgetTitleRecord：刪掉 recordTitle 寫的紀錄（含要轉換檔名的 handle），沒有紀錄時不丟錯', t => {
  const temp = mkdtempSync(join(realTmpdir(), 'tab-state-'));
  const saved = process.env.TAB_STATE_DIR;
  process.env.TAB_STATE_DIR = join(temp, 'titles');
  t.after(() => {
    if (saved === undefined) delete process.env.TAB_STATE_DIR; else process.env.TAB_STATE_DIR = saved;
    rmSync(temp, { recursive: true, force: true });
  });
  for (const handle of ['term_a', 'term:a/b c']) {
    assert.equal(recordTitle(handle, '待關閉｜x'), true);
    assert.equal(recordedTitle(handle), '待關閉｜x');
    forgetTitleRecord(handle);
    assert.equal(recordedTitle(handle), null);
    forgetTitleRecord(handle);
  }
  forgetTitleRecord(undefined);
});
