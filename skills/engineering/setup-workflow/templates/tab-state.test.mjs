import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { sameTopic, stripState, withState } from './tab-state.mjs';

const script = fileURLToPath(new URL('./tab-state.mjs', import.meta.url));
const SELF = 'term_self';

// 記錄呼叫的假 Orca CLI：`terminal list` 回本分頁（標題是 Claude 的自動標題，`rename` 設的標題 Orca 讀不回）。
// `failing` 為真時每個呼叫都回錯。標題記錄放在 fixture 的 TAB_STATE_DIR，不碰家目錄。
function fixture(t, { autoTitle = 'Claude 自動標題', failing = false } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'tab-state-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const dir = join(temp, 'titles');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (${failing}) fail('runtime_unavailable');
else if (b === 'list') reply('list', { terminals: [{ handle: 'term_other', title: '別人' }, { handle: ${JSON.stringify(SELF)}, title: ${JSON.stringify(autoTitle)} }], totalCount: 2 });
else if (b === 'rename') reply('rename', { rename: { handle: arg('--terminal'), title: arg('--title') } });
`);
  chmodSync(cli, 0o755);
  const record = title => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, SELF), title); };
  const recorded = () => existsSync(join(dir, SELF)) ? readFileSync(join(dir, SELF), 'utf8') : null;
  const run = (args, extra = {}) => spawnSync('node', [script, ...args], {
    encoding: 'utf8', env: { ...process.env, ORCA_CLI_COMMAND: cli, ORCA_TERMINAL_HANDLE: SELF, TAB_STATE_DIR: dir, ...extra },
  });
  return { log, record, recorded, run, calls: () => readFileSync(log, 'utf8') };
}

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

test('沒有 ORCA_TERMINAL_HANDLE、Orca 呼叫失敗：exit 0 不輸出、不改記錄', t => {
  for (const [options, extra] of [[{}, { ORCA_TERMINAL_HANDLE: '' }], [{ failing: true }, {}]]) {
    const { recorded, run } = fixture(t, options);
    const result = run(['待關閉'], extra);
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, '');
    assert.equal(recorded(), null);
  }
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
