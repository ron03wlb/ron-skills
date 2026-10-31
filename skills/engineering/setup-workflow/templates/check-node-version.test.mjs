import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./check-node-version.mjs', import.meta.url).pathname;
const local = process.versions.node;
const major = Number(local.split('.')[0]);

// PR #43：本機 Node 24 跑 bin/check 全過，CI 釘 22.19.0 卻紅，合入後 main 才紅。
function fixture(t, files) {
  const dir = mkdtempSync(join(realTmpdir(), 'node-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return spawnSync('node', [script, dir], { encoding: 'utf8' });
}

// 與 ../scripts/ci.mjs 寫出的兩種 CI 檔同形。
const workflow = version => `jobs:\n  checks:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '${version}'\n`;
const gitlab = version => `checks:\n  image: node:${version}\n  script:\n    - bin/check\n`;
const gh = name => `.github/workflows/${name}`;

test('所有 workflow 同版且主版本等於本機：exit 0', t => {
  const result = fixture(t, { [gh('checks.yml')]: workflow(local), [gh('site.yml')]: workflow(local) });
  assert.equal(result.status, 0, result.stdout);
});

test('PR #43 的情況：CI 主版本與本機不同，exit 1', t => {
  const result = fixture(t, { [gh('checks.yml')]: workflow(`${major - 2}.19.0`) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`^NODE_VERSION CI 是 ${major - 2}\\.19\\.0，本機是 ${local.replaceAll('.', '\\.')}$`, 'm'));
});

test('兩個 workflow 版本不同：exit 1', t => {
  const result = fixture(t, { [gh('a.yml')]: workflow(local), [gh('b.yml')]: workflow(`${major}.0.0`) });
  if (local === `${major}.0.0`) return;
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^NODE_VERSION \.github\/workflows\/b\.yml 是 /m);
});

test('找不到 node-version：exit 1', t => {
  const result = fixture(t, { [gh('checks.yml')]: 'jobs: {}\n' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /沒有任何 node-version/);
});

// ci.mjs 在 GitLab code host 寫 .gitlab-ci.yml，版本釘在 `image: node:<版本>`（#247：版本來源與 ci.mjs 一致）。
test('GitLab：.gitlab-ci.yml 的 image node 版本與本機同主版本 exit 0，不同 exit 1', t => {
  assert.equal(fixture(t, { '.gitlab-ci.yml': gitlab(local) }).status, 0);
  const result = fixture(t, { '.gitlab-ci.yml': gitlab(`${major - 2}.19.0`) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`^NODE_VERSION CI 是 ${major - 2}\\.19\\.0，本機是 `, 'm'));
});

test('註解裡的 node-version 不算釘版本', t => {
  const result = fixture(t, { [gh('checks.yml')]: `# node-version: '${major - 2}.0.0' 舊版\n${workflow(local)}` });
  assert.equal(result.status, 0, result.stdout);
});
