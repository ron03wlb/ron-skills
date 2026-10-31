import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = fileURLToPath(new URL('./claude-hook-tab-state.mjs', import.meta.url));
const SELF = 'term_self';
const SHA = '4b14f45a922942987473d3a1b9358740c2409777';

// 專案目錄（放 docs/agents/tab-state.json）、記錄呼叫的假 Orca CLI 與 TAB_STATE_DIR。
// `terminal list` 回本分頁，title 是 Claude 的自動標題；`failing` 為真時每個 Orca 呼叫都回錯。
function fixture(t, { autoTitle = 'Claude 自動標題', failing = false, config } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'claude-hook-tab-state-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const project = join(temp, 'project');
  mkdirSync(join(project, 'docs/agents'), { recursive: true });
  if (config) writeFileSync(join(project, 'docs/agents/tab-state.json'), JSON.stringify(config));
  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const dir = join(temp, 'titles');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (${failing}) fail('runtime_unavailable');
else if (b === 'list') reply('list', { terminals: [{ handle: ${JSON.stringify(SELF)}, title: ${JSON.stringify(autoTitle)} }], totalCount: 1 });
else if (b === 'rename') reply('rename', { rename: { handle: arg('--terminal'), title: arg('--title') } });
`);
  chmodSync(cli, 0o755);
  const transcript = join(temp, 'transcript.jsonl');
  const record = (title, handle = SELF) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, handle), title); };
  const recorded = (handle = SELF) => existsSync(join(dir, handle)) ? readFileSync(join(dir, handle), 'utf8') : null;
  const hook = (input, extra = {}) => spawnSync('node', [script], {
    input: typeof input === 'string' ? input : JSON.stringify({ cwd: project, transcript_path: transcript, ...input }), encoding: 'utf8',
    env: { ...process.env, ORCA_CLI_COMMAND: cli, ORCA_TERMINAL_HANDLE: SELF, TAB_STATE_DIR: dir, CLAUDE_PROJECT_DIR: project, ...extra },
  });
  const say = text => writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: '/issue-run 126 --worker x' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  return { record, recorded, hook, say, calls: () => readFileSync(log, 'utf8') };
}

const bash = (command, stdout) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });

test('Bash 輸出 LANDED：分頁轉成待 Retro，其他文字不動', t => {
  const { record, recorded, hook, calls } = fixture(t);
  record('處理中｜#21 雙池採集｜收尾｜land');
  const result = hook(bash('node scripts/land.mjs issue/21-pool --title x --body-file b.md', `PUSHED\nPR 130\nLANDED 130 ${SHA}\n`));
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls(), /^terminal rename --terminal term_self --title 待 Retro｜#21 雙池採集｜收尾｜land --json$/m);
  assert.equal(recorded(), '待 Retro｜#21 雙池採集｜收尾｜land');
});

test('pilot-handoff 印 HANDED_OFF：舊 coordinator 分頁轉成待 Retro', t => {
  const { record, recorded, hook } = fixture(t);
  record('處理中｜[維運] issue-pilot coordinator');
  assert.equal(hook(bash('node scripts/pilot-handoff.mjs --session s --pid 1 --reason x', 'HANDED_OFF term_new\n')).status, 0);
  assert.equal(recorded(), '待 Retro｜[維運] issue-pilot coordinator');
});

test('其他 Bash 輸出、其他工具：不呼叫 Orca', t => {
  const { record, hook, calls } = fixture(t);
  record('處理中｜#21 雙池採集｜實作｜測試');
  for (const input of [
    bash('node scripts/land.mjs x', 'STOP ci-failed\n'),
    bash('echo', 'see LANDED 130 abc1234 above\n'),
    { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: `LANDED 130 ${SHA}` },
  ]) assert.equal(hook(input).status, 0);
  assert.equal(calls(), '');
});

test('Stop：worker 最後一段文字是 DONE 結果行就轉成待 Retro，之後不再要求改名', t => {
  const { record, recorded, hook, say } = fixture(t);
  record('處理中｜#126 分頁狀態｜收尾｜候選');
  say(`摘要……\n\nDONE 126 ${SHA}`);
  const result = hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(recorded(), '待 Retro｜#126 分頁狀態｜收尾｜候選');
});

test('Stop：標題沒有合法前綴就 exit 2 要求改名；stop_hook_active 為 true 時放行；有前綴時不輸出', t => {
  const { record, hook, say, calls } = fixture(t, { autoTitle: 'Issue-run 126 batch 126-128' });
  say('還在跑測試。');
  const denied = hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /Issue-run 126 batch 126-128/);
  assert.match(denied.stderr, /tab-state\.mjs/);
  assert.equal(hook({ hook_event_name: 'Stop', stop_hook_active: true }).status, 0);
  for (const title of ['完成｜#126', '處理中|#126']) {
    record(title);
    assert.equal(hook({ hook_event_name: 'Stop', stop_hook_active: false }).status, 2, title);
  }
  record('處理中｜#126 分頁狀態｜實作｜hook');
  const allowed = hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout + allowed.stderr, '');
  assert.doesNotMatch(calls(), /rename/);
});

test('沒有 ORCA_TERMINAL_HANDLE、Orca 呼叫失敗、輸入不合法：exit 0 不輸出', t => {
  const quiet = fixture(t);
  quiet.say('還在跑測試。');
  const failing = fixture(t, { failing: true });
  failing.say('還在跑測試。');
  for (const [{ hook }, input, extra] of [
    [quiet, { hook_event_name: 'Stop', stop_hook_active: false }, { ORCA_TERMINAL_HANDLE: '' }],
    [quiet, bash('node scripts/land.mjs x', `LANDED 130 ${SHA}`), { ORCA_TERMINAL_HANDLE: '' }],
    [failing, { hook_event_name: 'Stop', stop_hook_active: false }, {}],
    [failing, bash('node scripts/land.mjs x', `LANDED 130 ${SHA}`), {}],
    [quiet, 'not json', {}],
  ]) {
    const result = hook(input, extra);
    assert.equal(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout + result.stderr, '', JSON.stringify(input));
  }
  assert.equal(quiet.calls(), '');
});

test('PostToolUse：記下改本分頁標題的 orca terminal rename，別的分頁與要展開的標題不記', t => {
  const { recorded, hook } = fixture(t);
  const cases = [
    ['orca terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "處理中｜#21 雙池採集｜實作｜補 TPEx 舊版格式"', '處理中｜#21 雙池採集｜實作｜補 TPEx 舊版格式'],
    [`"$ORCA_CLI_COMMAND" terminal rename --terminal ${SELF} --title '待 Retro｜#21 雙池採集｜已合入 PR #130' --json >/dev/null 2>&1`, '待 Retro｜#21 雙池採集｜已合入 PR #130'],
    ['orca terminal rename --terminal term_other --title "處理中｜別人"', '待 Retro｜#21 雙池採集｜已合入 PR #130'],
    ['orca terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "處理中｜$TOPIC"', '待 Retro｜#21 雙池採集｜已合入 PR #130'],
  ];
  for (const [command, expected] of cases) {
    assert.equal(hook(bash(command, '')).status, 0, command);
    assert.equal(recorded(), expected, command);
  }
  assert.equal(recorded('term_other'), null);
});

test('docs/agents/tab-state.json：同名覆寫、null 停用、新增觸發條件', t => {
  const { record, recorded, hook } = fixture(t, { config: { triggers: {
    landed: null,
    'pilot-handoff': { event: 'PostToolUse', match: '^HANDED_OFF ', state: '待關閉' },
    deployed: { event: 'PostToolUse', match: '^DEPLOYED ', state: '待 Retro' },
  } } });
  record('處理中｜#21 雙池採集｜收尾｜land');
  hook(bash('node scripts/land.mjs x', `LANDED 130 ${SHA}`));
  assert.equal(recorded(), '處理中｜#21 雙池採集｜收尾｜land');
  hook(bash('deploy', 'DEPLOYED prod'));
  assert.equal(recorded(), '待 Retro｜#21 雙池採集｜收尾｜land');
  hook(bash('node scripts/pilot-handoff.mjs', 'HANDED_OFF term_new'));
  assert.equal(recorded(), '待關閉｜#21 雙池採集｜收尾｜land');
});
