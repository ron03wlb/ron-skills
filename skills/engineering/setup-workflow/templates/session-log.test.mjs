// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./session-log.mjs', import.meta.url).pathname;

const session = 'abcd1234-0000-4000-8000-000000000000';
// 長指令結尾是 tab-state 待關閉：19a75ed3 第 135 行就是被 cut -c1-300 截掉這段而誤判（#403）。
const longCommand = `${'echo 很長的一段；'.repeat(40)}node scripts/tab-state.mjs 待關閉`;
const longOutput = `${'輸出'.repeat(300)}END`;
const blocking = '語言檢查：這次工具呼叫前有 1 段使用者可見文字以英文為主。';
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const lines = [
  { type: 'user', message: { role: 'user', content: '開始' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, toolUse('toolu_A', 'Bash', { command: longCommand })] } },
  { type: 'attachment', attachment: { type: 'hook_success', hookName: 'PostToolUse:Bash', toolUseID: 'toolu_A', stdout: 'x'.repeat(2000) } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: longOutput }] } },
  { type: 'api-request-blob', message: { role: 'assistant', content: [toolUse('toolu_A', 'Bash', { command: longCommand })] } },
  { type: 'assistant', message: { role: 'assistant', content: [toolUse('toolu_A', 'Bash', { command: longCommand })] } },
  { type: 'attachment', uuid: 'u7', attachment: { type: 'hook_blocking_error', hookName: 'PostToolUse:Bash', toolUseID: 'toolu_A', blockingError: { blockingError: blocking, command: 'node hook.mjs' } } },
  { type: 'assistant', message: { role: 'assistant', content: [toolUse('toolu_B', 'Read', { file_path: '/x.md' })] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', is_error: true, content: [{ type: 'text', text: '找不到檔案' }] }] } },
  { type: 'api-request', params: { model: 'm' } },
  { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: '重送的結果' }] } },
  { type: 'attachment', uuid: 'u12', attachment: { type: 'hook_blocking_error', hookName: 'Stop', blockingError: { blockingError: '請改名分頁', command: 'node tab.mjs' } } },
  { type: 'attachment', uuid: 'u12', attachment: { type: 'hook_blocking_error', hookName: 'Stop', blockingError: { blockingError: '請改名分頁', command: 'node tab.mjs' } } },
];
const q = value => JSON.stringify(value);
const full = [
  `2 Bash ${q({ command: longCommand })}`,
  `4 result ${q(longOutput)}`,
  `7 blockingError PostToolUse:Bash ${q(blocking)}`,
  `8 Read ${q({ file_path: '/x.md' })}`,
  `9 result(error) ${q('找不到檔案')}`,
  `12 blockingError Stop ${q('請改名分頁')}`,
];

function fixture(t) {
  const home = mkdtempSync(join(realTmpdir(), 'session-log-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'projects', '-repo-a');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session}.jsonl`);
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n{壞掉的行\n`);
  mkdirSync(join(home, 'projects', '-repo-b'), { recursive: true });
  writeFileSync(join(home, 'projects', '-repo-b', 'abcd9999-0000.jsonl'), '');
  const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  return { home, file, run };
}

test('依 session 前綴跨 projects 找 jsonl：每個 tool call 一次、不截斷、略過 api-request 與 hook_success、印 blockingError', t => {
  const { file, run } = fixture(t);
  const result = run('abcd1234');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [`# ${file}`, ...full, ''].join('\n'));
  assert.ok(result.stdout.includes('node scripts/tab-state.mjs 待關閉'));
  assert.ok(!result.stdout.includes('重送的結果'));
  assert.ok(!result.stdout.includes('xxxx'));
});

test('--lines 依 tool call 所在行篩選，結果與 blockingError 跟著它；--grep 篩整組；直接給 jsonl 路徑也可以', t => {
  const { file, run } = fixture(t);
  assert.equal(run('abcd1234', '--lines', '8-12').stdout, [`# ${file}`, ...full.slice(3), ''].join('\n'));
  assert.equal(run(file, '--grep', '語言檢查').stdout, [`# ${file}`, ...full.slice(0, 3), ''].join('\n'));
  const none = run('abcd1234', '--grep', '不存在的字');
  assert.equal(none.status, 1);
  assert.equal(none.stdout, `# ${file}\n`);
});

test('只有帶 --max 才截斷，截斷處標出原長度', t => {
  const { file, run } = fixture(t);
  const result = run('abcd1234', '--lines', '8-9', '--max', '5');
  assert.equal(result.status, 0, result.stderr);
  const read = q({ file_path: '/x.md' });
  const err = q('找不到檔案');
  assert.equal(result.stdout, [
    `# ${file}`,
    `8 Read ${read.slice(0, 5)}…(原長 ${read.length} 字)`,
    `9 result(error) ${err.slice(0, 5)}…(原長 ${err.length} 字)`,
    '',
  ].join('\n'));
});

test('找不到、前綴不唯一、用法錯誤都 exit 2', t => {
  const { run } = fixture(t);
  const missing = run('ffff');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^SESSION_NOT_FOUND ffff/);
  const ambiguous = run('abcd');
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /^SESSION_AMBIGUOUS abcd /);
  assert.equal(run().status, 2);
  assert.equal(run('abcd1234', '--lines', 'x').status, 2);
  assert.equal(run('abcd1234', '--max', '0').status, 2);
  assert.equal(run('abcd1234', '--grep', '(').status, 2);
});
