import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { hookCommands, loadCases, permissionDecision, runCase } from './hook-acceptance.mjs';

const SCRIPT = new URL('./hook-acceptance.mjs', import.meta.url).pathname;
const cli = (cwd, args, env = {}) => {
  const base = { ...process.env, ...env };
  if (!('CLAUDE_PROJECT_DIR' in env)) delete base.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: base });
};

function temp(t) {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-acceptance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 擋 `| tail` 的 PreToolUse hook（spay2 retro 8eaa8b41#2 的形狀：只在 Claude 的 Bash 工具生效，`!` 與終端機都測不到）。
const GATE = "let s = ''; process.stdin.on('data', d => { s += d; }).on('end', () => { const c = JSON.parse(s).tool_input.command ?? ''; if (/\\| *tail/.test(c)) { console.error('gate 接 tail 會吃掉 exit code'); process.exit(2); } });\n";
// 擋寫入 <main>/AGENTS.md 的 hook：比對 stdin 的 file_path 是否等於 $CLAUDE_PROJECT_DIR 指向的主 checkout 下的檔。
const MAIN_GUARD = "let s = ''; process.stdin.on('data', d => { s += d; }).on('end', () => { const p = JSON.parse(s).tool_input.file_path ?? ''; if (p === process.argv[2] + '/AGENTS.md') { console.error('主 checkout'); process.exit(2); } });\n";

function project(t, { gate = true } = {}) {
  const dir = temp(t);
  mkdirSync(join(dir, '.claude'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/gate.mjs'), gate ? GATE : 'process.exit(0);\n');
  writeFileSync(join(dir, 'scripts/main-guard.mjs'), MAIN_GUARD);
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/gate.mjs"' }] },
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/scripts/main-guard.mjs" "${dir}"` }] },
  ] } }));
  writeFileSync(join(dir, 'scripts/hook-acceptance-cases.json'), JSON.stringify([
    { event: 'PreToolUse', tool: 'Bash', input: { command: 'bash bin/check 2>&1 | tail -15' }, expected: 2, label: 'gate 接 tail' },
    { event: 'PreToolUse', tool: 'Bash', input: { command: 'git status --short' }, expected: 0, label: '一般指令放行' },
    { event: 'PreToolUse', tool: 'Edit', input: { file_path: '<main>/AGENTS.md' }, expected: 2, label: '主 checkout 不可 Edit' },
  ], null, 2));
  return dir;
}

test('CLI：照 settings 的 matcher 跑每個案例，全過印 PASS 行與 HOOK_ACCEPTANCE PASS <n>、exit 0', t => {
  const dir = project(t);
  const result = cli(dir, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, [
    'PASS PreToolUse Bash expected=2 actual=2 gate 接 tail',
    'PASS PreToolUse Bash expected=0 actual=0 一般指令放行',
    'PASS PreToolUse Edit expected=2 actual=2 主 checkout 不可 Edit',
    'HOOK_ACCEPTANCE PASS 3',
    '',
  ].join('\n'));
});

test('settings 掛的 hook 少了擋下的判斷：該案例 FAIL、exit 1', t => {
  const dir = project(t, { gate: false });
  const result = cli(dir, []);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL PreToolUse Bash expected=2 actual=0 gate 接 tail$/m);
  assert.match(result.stdout, /^HOOK_ACCEPTANCE FAIL 1\/3$/m);
});

test('FAIL 行下一行縮排附擋下那支 hook 的 stderr 末行', t => {
  const dir = project(t);
  writeFileSync(join(dir, 'cases.json'), JSON.stringify([{ event: 'PreToolUse', tool: 'Bash', input: { command: 'x | tail' }, expected: 0, label: '預期放行' }]));
  const result = cli(dir, ['--cases', join(dir, 'cases.json')]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'FAIL PreToolUse Bash expected=0 actual=2 預期放行\n  gate 接 tail 會吃掉 exit code\nHOOK_ACCEPTANCE FAIL 1/1\n');
});

test('hook 指令裡的 $CLAUDE_PROJECT_DIR 指向 --project-dir：指向只有放行 stub 的目錄時擋下的案例 FAIL', t => {
  const dir = project(t);
  const stub = project(t, { gate: false });
  const result = cli(dir, ['--settings', join(dir, '.claude/settings.json'), '--project-dir', stub, '--cases', join(dir, 'scripts/hook-acceptance-cases.json')]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL PreToolUse Bash expected=2 actual=0 gate 接 tail$/m);
});

test('<main> 換成主 checkout：從 linked worktree 跑時指向主 checkout，不是 worktree', t => {
  const main = temp(t);
  const git = (...args) => { const r = spawnSync('git', ['-C', main, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const tree = join(temp(t), 'wt');
  git('worktree', 'add', '-q', tree);
  const cases = join(tree, 'cases.json');
  writeFileSync(cases, JSON.stringify([{ event: 'PreToolUse', tool: 'Edit', input: { file_path: '<main>/AGENTS.md' }, expected: 2, label: 'x' }]));
  assert.deepEqual(loadCases(cases, main)[0].input, { file_path: `${main}/AGENTS.md` });
  mkdirSync(join(tree, '.claude'));
  writeFileSync(join(tree, 'main-guard.mjs'), MAIN_GUARD);
  writeFileSync(join(tree, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/main-guard.mjs" "${main}"` }] }] } }));
  const result = cli(tree, ['--cases', cases]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('案例的 env 併入 hook 的環境變數：依環境啟用的 hook（例如只在 zsh 擋）在任何機器上結果都相同', t => {
  const dir = temp(t);
  writeFileSync(join(dir, 'zsh-only.mjs'), "process.exit(process.env.SHELL === '/bin/zsh' ? 2 : 0);\n");
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${join(dir, 'zsh-only.mjs')}"` }] }] } };
  const item = { event: 'PreToolUse', tool: 'Bash', input: { command: 'echo ===' } };
  assert.equal(runCase(settings, dir, { ...item, env: { SHELL: '/bin/zsh' } }).exit, 2);
  assert.equal(runCase(settings, dir, { ...item, env: { SHELL: '/bin/bash' } }).exit, 0);
  const file = join(dir, 'c.json');
  writeFileSync(file, JSON.stringify([{ ...item, expected: 2, label: 'x', env: { SHELL: 1 } }]));
  assert.throws(() => loadCases(file, dir), /env/);
});

test('不帶 tool 的事件（UserPromptSubmit、Stop）：stdin 欄位併入 stdin JSON 頂層，<project> 換成 project dir；輸出行的工具欄印 -', t => {
  const dir = temp(t);
  mkdirSync(join(dir, '.claude'));
  // 讀頂層 prompt 的 hook（UserPromptSubmit）與讀 transcript_path 的 hook（Stop）
  writeFileSync(join(dir, 'prompt.mjs'), "let s = ''; process.stdin.on('data', d => { s += d; }).on('end', () => process.exit(JSON.parse(s).prompt === 'stop' ? 2 : 0));\n");
  writeFileSync(join(dir, 'stop.mjs'), "import { readFileSync } from 'node:fs';\nlet s = ''; process.stdin.on('data', d => { s += d; }).on('end', () => process.exit(readFileSync(JSON.parse(s).transcript_path, 'utf8').includes('english') ? 2 : 0));\n");
  writeFileSync(join(dir, 'transcript.jsonl'), 'english\n');
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/prompt.mjs"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/stop.mjs"' }] }],
  } }));
  const cases = join(dir, 'cases.json');
  writeFileSync(cases, JSON.stringify([
    { event: 'UserPromptSubmit', stdin: { prompt: 'stop' }, expected: 2, label: 'prompt 擋下' },
    { event: 'UserPromptSubmit', stdin: { prompt: 'go' }, expected: 0, label: 'prompt 放行' },
    { event: 'Stop', stdin: { transcript_path: '<project>/transcript.jsonl', stop_hook_active: false }, expected: 2, label: 'transcript 擋下' },
  ]));
  const result = cli(dir, ['--project-dir', dir, '--cases', cases]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'PASS UserPromptSubmit - expected=2 actual=2 prompt 擋下\nPASS UserPromptSubmit - expected=0 actual=0 prompt 放行\nPASS Stop - expected=2 actual=2 transcript 擋下\nHOOK_ACCEPTANCE PASS 3\n');
  assert.deepEqual(loadCases(cases, '/m', dir)[2].stdin, { transcript_path: `${dir}/transcript.jsonl`, stop_hook_active: false });
});

test('loadCases：不是陣列、缺欄位、expected 不是整數都丟錯；<main> 只換字串值', t => {
  const dir = temp(t);
  const write = value => { const file = join(dir, 'c.json'); writeFileSync(file, JSON.stringify(value)); return file; };
  assert.throws(() => loadCases(write({}), dir), /陣列/);
  assert.throws(() => loadCases(write([{ event: 'PreToolUse', tool: 'Bash', input: {}, label: 'x' }]), dir), /expected/);
  assert.throws(() => loadCases(write([{ event: 'PreToolUse', input: {}, expected: 0, label: 'x' }]), dir), /input 要和 tool 一起給/);
  assert.throws(() => loadCases(write([{ event: 'Stop', stdin: 'x', expected: 0, label: 'x' }]), dir), /stdin/);
  const [item] = loadCases(write([{ event: 'PreToolUse', tool: 'Read', input: { file_path: '<main>/a', limit: 3 }, expected: 0, label: 'x' }]), '/m');
  assert.deepEqual(item.input, { file_path: '/m/a', limit: 3 });
});

test('用法錯誤、讀不到 settings 或案例檔：exit 2', t => {
  const dir = project(t);
  assert.equal(cli(dir, ['--bogus', 'x']).status, 2);
  assert.equal(cli(dir, ['--settings']).status, 2);
  assert.equal(cli(dir, ['--settings', join(dir, 'nope.json')]).status, 2);
  const missing = cli(dir, ['--cases', join(dir, 'nope.json')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /nope\.json/);
});

test('hookCommands：matcher 整串比對；沒有 matcher 與 * 都命中', () => {
  const settings = { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] },
    { matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'b' }] },
    { matcher: '*', hooks: [{ type: 'command', command: 'c' }] },
    { hooks: [{ type: 'command', command: 'd' }, { type: 'prompt', prompt: 'x' }] },
  ] } };
  assert.deepEqual(hookCommands(settings, 'PreToolUse', 'Bash'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(hookCommands(settings, 'PreToolUse', 'Edit'), ['b', 'c', 'd']);
  assert.deepEqual(hookCommands(settings, 'PreToolUse', 'BashOutput'), ['c', 'd']);
  assert.deepEqual(hookCommands(settings, 'Stop', 'Bash'), []);
});

// spay2 retro tooling-584：以 exit 0 + stdout `hookSpecificOutput.permissionDecision: "deny"` 拒絕的 hook，只核 exit code 會判成放行
const jsonHook = (dir, name, decision, exit = 0) => {
  const file = join(dir, `${name}.mjs`);
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `${decision}（stub）` } };
  writeFileSync(file, `process.stdout.write(${JSON.stringify(`${JSON.stringify(output)}\n`)});\nprocess.exit(${exit});\n`);
  return { matcher: 'Read', hooks: [{ type: 'command', command: `node "${file}"` }] };
};
const READ_CASE = { event: 'PreToolUse', tool: 'Read', input: { file_path: 'docs/a.md' } };

test('JSON permissionDecision deny（exit 0）：算擋下，actual=2', t => {
  const dir = temp(t);
  const settings = { hooks: { PreToolUse: [jsonHook(dir, 'allow-plain', 'allow'), jsonHook(dir, 'deny', 'deny')] } };
  const { exit, results } = runCase(settings, dir, READ_CASE);
  assert.equal(exit, 2, JSON.stringify(results));
  assert.deepEqual(results.map(result => [result.status, result.decision, result.blocked]), [[0, 'allow', false], [0, 'deny', true]]);
});

test('JSON permissionDecision ask／allow 不算擋下；exit 非 0 時不解析 stdout JSON', t => {
  const dir = temp(t);
  assert.equal(runCase({ hooks: { PreToolUse: [jsonHook(dir, 'ask', 'ask')] } }, dir, READ_CASE).exit, 0);
  assert.equal(runCase({ hooks: { PreToolUse: [jsonHook(dir, 'allow', 'allow')] } }, dir, READ_CASE).exit, 0);
  assert.equal(runCase({ hooks: { PreToolUse: [jsonHook(dir, 'deny-exit1', 'deny', 1)] } }, dir, READ_CASE).exit, 1);
});

test('permissionDecision：非 JSON、缺欄位回 null', () => {
  assert.equal(permissionDecision(''), null);
  assert.equal(permissionDecision('not json'), null);
  assert.equal(permissionDecision('{"continue":true}'), null);
  assert.equal(permissionDecision('{"hookSpecificOutput":{"permissionDecision":"deny"}}'), 'deny');
});
