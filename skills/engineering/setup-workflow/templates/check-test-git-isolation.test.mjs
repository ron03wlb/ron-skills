// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { missingIsolation, missingOrcaIsolation, spawnsGit, usesOrca } from './check-test-git-isolation.mjs';

const script = new URL('./check-test-git-isolation.mjs', import.meta.url).pathname;

// #291 修的真實形狀：land.test.mjs 用 spawnSync('git', …) 建 fixture，沒 import 隔離模組。
const UNISOLATED = "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['-C', repo, 'init']);\n";

function dir(t, files) {
  const root = mkdtempSync(join(realTmpdir(), 'isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
// #524 的真實形狀：pilot-batch.test.mjs 以 `...process.env` 跑讀 ORCA_CLI_COMMAND 的 pilot-batch.mjs，沒清掉 session 繼承的值，move 呼叫了真的 Orca。
const ORCA_TEST = "import { spawnSync } from 'node:child_process';\nconst run = (...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });\n";
const ORCA_SCRIPT = 'const cli = process.env.ORCA_CLI_COMMAND;\n';

const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8' });

test('會 spawn git 卻沒 import 隔離模組：exit 1 並列出檔案', t => {
  const root = dir(t, { 'land.test.mjs': UNISOLATED, 'sub/ok.test.mjs': `import './test/isolate-git-env.mjs';\n${UNISOLATED}` });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /land\.test\.mjs/);
  assert.doesNotMatch(result.stderr, /ok\.test\.mjs/);
});

test('有 import 隔離模組（或 repo-fixture）、不 spawn git、非 .test.mjs：通過', t => {
  const root = dir(t, {
    'a.test.mjs': `import { x } from '../test/repo-fixture.mjs';\n${UNISOLATED}`,
    'b.test.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync('node', ['x']);\n",
    'c.mjs': UNISOLATED,
  });
  assert.equal(run(root).status, 0);
});

test('沒帶目錄或目錄不存在：exit 2，不當掉', t => {
  assert.equal(run().status, 2);
  const missing = run(join(dir(t, {}), 'no/such/dir'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /目錄不存在/);
});

test('字串與註解裡的 git 呼叫不算，argv 陣列與 template 指令稿裡的算', () => {
  assert.equal(spawnsGit("const s = \"execFileSync('git', [])\"; // spawnSync('git')\n"), false);
  assert.equal(spawnsGit("run(repo, ['git', 'status']);\n"), true);
  assert.equal(spawnsGit("write(`execFileSync('git', ['x'])`);\n"), true);
  assert.equal(spawnsGit('const fx = `python3 - <<\'E\'\\ndef git(path, *a): subprocess.run(["git", "-C", path, *a], check=True)\\nE`;\n'), false, 'template 內他語言指令稿的 ["git", …] 不算 spawn（#412）');
  assert.equal(spawnsGit("spawnSync('git', ['-C', p]);\nconst fx = `echo ${x}`;\n"), true, '真正的 spawn 仍抓得到');
  assert.equal(spawnsGit("const fx = `${run(['git', 'status'])}`;\n"), true, '${…} 內的程式碼仍要看');
  assert.equal(missingIsolation("spawnSync('git', []);\n"), false, '沒用 child_process 的檔不算');
});

test('#524：spawn 讀 ORCA_CLI_COMMAND 的被測腳本卻沒 import Orca 隔離模組：exit 1 並列出檔案', t => {
  const root = dir(t, {
    'pilot-batch.test.mjs': ORCA_TEST, 'pilot-batch.mjs': ORCA_SCRIPT,
    'a/pilot-batch.test.mjs': `import './test/isolate-orca-env.mjs';\n${ORCA_TEST}`, 'a/pilot-batch.mjs': ORCA_SCRIPT,
    'b/pilot-batch.test.mjs': `import './test/isolate-git-env.mjs';\n${ORCA_TEST}`, 'b/pilot-batch.mjs': ORCA_SCRIPT,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /isolate-orca-env\.mjs/);
  assert.deepEqual(result.stderr.split('\n').filter(line => line.endsWith('.test.mjs')), [join(root, 'pilot-batch.test.mjs')]);
});

test('Orca 隔離：測試自己的程式碼用到 Orca 變數或假 Orca 也要；字串、註解、沒 spawn 的不算', () => {
  assert.equal(missingOrcaIsolation(ORCA_TEST, ORCA_SCRIPT), true);
  assert.equal(missingOrcaIsolation(ORCA_TEST), false, '被測腳本與測試都沒用到 Orca 變數');
  assert.equal(missingOrcaIsolation(`${ORCA_TEST}const fake = \`\${orcaReplySource()}\`;\n`), true, 'template 的 ${…} 內的假 Orca 算');
  assert.equal(missingOrcaIsolation(`${ORCA_TEST}run({ ORCA_TERMINAL_HANDLE: 'term_x' });\n`), true);
  assert.equal(missingOrcaIsolation(ORCA_TEST, '// 需要 ORCA_CLI_COMMAND\nconst s = "ORCA_CLI_COMMAND";\n'), false, '被測腳本只在註解與字串提到');
  assert.equal(missingOrcaIsolation("const s = 'ORCA_CLI_COMMAND';\n", ORCA_SCRIPT), false, '沒用 child_process 的檔不算');
  assert.equal(usesOrca('process.env.ORCA_CLI_COMMAND'), true);
});
