import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { missingIsolation, spawnsGit } from './check-test-git-isolation.mjs';

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
  assert.equal(missingIsolation("spawnSync('git', []);\n"), false, '沒用 child_process 的檔不算');
});
