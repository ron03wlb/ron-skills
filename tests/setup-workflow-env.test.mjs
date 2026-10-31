import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env as baseEnv, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

// 環境站（detect.mjs --env）：平台以 DETECT_PLATFORM、DETECT_PROC_VERSION 注入，Node 版本以 DETECT_NODE_VERSION 注入，
// 其他工具以子行程的 PATH 控制（暫存 bin 目錄只放測試要的指令）。
const script = new URL('../skills/engineering/setup-workflow/scripts/detect.mjs', import.meta.url).pathname;
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

const CI = "jobs:\n  check:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '24.21.0'\n";

function tmp(t, prefix) {
  const dir = mkdtempSync(join(realTmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 只含 tools 的 PATH 目錄；git 連到真的 git，其他指令是印出版本的假腳本。 */
function bin(t, tools = { git: true }) {
  const dir = tmp(t, 'setup-workflow-env-bin-');
  for (const [name, version] of Object.entries(tools)) {
    if (!version) continue;
    if (name === 'git' && version === true) { symlinkSync(realGit, join(dir, 'git')); continue; }
    write(dir, { [name]: `#!/bin/sh\necho '${version}'\n` });
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** 跑環境站；opts：platform、procVersion（/proc/version 內容）、node、tools、orca、copy、files（目標 repo 的檔案）。 */
function station(t, { platform = 'darwin', procVersion, node = '24.21.0', tools, orca, copy = [], files = { '.github/workflows/ci.yml': CI } } = {}) {
  const root = tmp(t, 'setup-workflow-env-repo-');
  write(root, files);
  const env = { ...baseEnv, PATH: bin(t, tools), DETECT_PLATFORM: platform, DETECT_NODE_VERSION: node };
  delete env.ORCA_CLI_COMMAND;
  if (orca) env.ORCA_CLI_COMMAND = orca;
  if (procVersion !== undefined) {
    const proc = join(tmp(t, 'setup-workflow-env-proc-'), 'version');
    write(proc.replace(/\/version$/, ''), { version: procVersion });
    env.DETECT_PROC_VERSION = proc;
  }
  const copyArgs = copy.length ? ['--copy', ...copy] : [];
  const run = json => spawnSync(process.execPath, [script, root, '--env', ...copyArgs, ...(json ? ['--json'] : [])], { encoding: 'utf8', env });
  const json = run(true);
  const text = run(false);
  assert.equal(json.status, text.status, text.stderr);
  return { status: json.status, result: JSON.parse(json.stdout), lines: text.stdout.trim().split('\n'), stderr: text.stderr };
}

test('macOS：darwin 判為 macos，必要工具齊全時 exit 0、最後一行 ENV ok', t => {
  const { status, result, lines } = station(t, { orca: process.execPath, tools: { git: true, codex: 'codex-cli 0.50.0' } });
  assert.equal(status, 0);
  assert.equal(result.platform.value, 'macos');
  assert.equal(result.ok, true);
  assert.deepEqual(result.stops, []);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.required.node.met, true);
  assert.equal(result.required.node.required, '24.21.0');
  assert.equal(result.required.git.met, true);
  assert.equal(result.required.python.met, null);
  assert.equal(result.optional.orca.met, true);
  assert.equal(result.optional.codex.value, 'codex-cli 0.50.0');
  assert.match(lines[0], /^ENV platform macos /);
  assert.equal(lines.at(-1), 'ENV ok');
});

test('WSL：linux 且 proc version 含 microsoft 判為 wsl', t => {
  const { result } = station(t, { platform: 'linux', procVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2 (root@x) #1 SMP\n' });
  assert.equal(result.platform.value, 'wsl');
  assert.equal(result.ok, true);
});

test('一般 Linux：proc version 沒有 microsoft 判為 linux', t => {
  const { result } = station(t, { platform: 'linux', procVersion: 'Linux version 6.8.0-45-generic (buildd@lcy02) #45-Ubuntu SMP\n' });
  assert.equal(result.platform.value, 'linux');
  assert.equal(result.ok, true);
});

test('原生 Windows 是停點：exit 1、提示改用 WSL2', t => {
  const { status, result, lines } = station(t, { platform: 'win32' });
  assert.equal(status, 1);
  assert.equal(result.platform.value, 'win32');
  assert.equal(result.ok, false);
  assert.deepEqual(result.stops.map(stop => stop.name), ['platform']);
  assert.match(result.stops[0].fix, /WSL2/);
  assert.ok(lines.some(line => /^STOP platform /.test(line)), lines.join('\n'));
  assert.ok(lines.some(line => /^FIX platform .*WSL2/.test(line)), lines.join('\n'));
  assert.equal(lines.at(-1), 'ENV stop 1');
});

test('Node 主版本和 CI 鎖定的不同是停點，修正指令帶 CI 的版本', t => {
  const { status, result, lines } = station(t, { node: '22.19.0' });
  assert.equal(status, 1);
  assert.equal(result.required.node.met, false);
  assert.equal(result.required.node.value, '22.19.0');
  assert.deepEqual(result.stops.map(stop => stop.name), ['node']);
  assert.match(result.stops[0].fix, /24\.21\.0/);
  assert.equal(lines.at(-1), 'ENV stop 1');
});

test('CI 各 workflow 的 node-version 不一致是停點；沒有 CI 鎖定時不擋', t => {
  const split = station(t, { files: { '.github/workflows/a.yml': CI, '.github/workflows/b.yml': CI.replace('24.21.0', '22.19.0') } });
  assert.equal(split.status, 1);
  assert.deepEqual(split.result.stops.map(stop => stop.name), ['node']);
  const none = station(t, { files: { 'README.md': 'x\n' } });
  assert.equal(none.status, 0);
  assert.equal(none.result.required.node.met, true);
  assert.equal(none.result.required.node.required, null);
});

test('PATH 上沒有 git 是停點', t => {
  const { status, result } = station(t, { tools: {} });
  assert.equal(status, 1);
  assert.equal(result.required.git.met, false);
  assert.deepEqual(result.stops.map(stop => stop.name), ['git']);
});

test('要複製 pilot_git.py 但沒有 Python 是停點；有 python3 就通過，不複製 .py 時不檢查', t => {
  const missing = station(t, { copy: ['pilot_git.py', 'issue-pool.mjs'] });
  assert.equal(missing.status, 1);
  assert.equal(missing.result.required.python.met, false);
  assert.deepEqual(missing.result.stops.map(stop => stop.name), ['python']);
  assert.match(missing.result.stops[0].reason, /pilot_git\.py/);
  const present = station(t, { copy: ['pilot_git.py'], tools: { git: true, python3: 'Python 3.12.4' } });
  assert.equal(present.status, 0);
  assert.equal(present.result.required.python.value, 'Python 3.12.4');
  const skipped = station(t, { copy: ['issue-pool.mjs'] });
  assert.equal(skipped.result.required.python.met, null);
});

test('選用工具缺漏只記錄：沒有 Orca 時 L3 不可選、沒有 Codex 時 codex extension 不可選，仍 exit 0', t => {
  const { status, result, lines } = station(t);
  assert.equal(status, 0);
  assert.equal(result.optional.orca.met, false);
  assert.equal(result.optional.codex.met, false);
  assert.deepEqual(result.unavailable, ['L3', 'codex']);
  assert.ok(lines.some(line => /^OPTIONAL orca missing .*L3/.test(line)), lines.join('\n'));
  assert.equal(lines.at(-1), 'ENV ok');
});

test('ORCA_CLI_COMMAND 指向不存在的指令視為沒有 Orca', t => {
  const { result } = station(t, { orca: '/nonexistent/orca' });
  assert.equal(result.optional.orca.met, false);
  assert.deepEqual(result.unavailable, ['L3', 'codex']);
});
