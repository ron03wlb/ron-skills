import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/check-node-version.mjs', import.meta.url).pathname;
const local = process.versions.node;
const major = Number(local.split('.')[0]);

// PR #43：本機 Node 24 跑 bin/check 全過，CI 釘 22.19.0 卻紅，合入後 main 才紅。
function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'node-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return spawnSync('node', [script, dir], { encoding: 'utf8' });
}

const workflow = version => `jobs:\n  checks:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '${version}'\n`;

test('所有 workflow 同版且主版本等於本機：exit 0', t => {
  const result = fixture(t, { 'checks.yml': workflow(local), 'site.yml': workflow(local) });
  assert.equal(result.status, 0, result.stdout);
});

test('PR #43 的情況：CI 主版本與本機不同，exit 1', t => {
  const result = fixture(t, { 'checks.yml': workflow(`${major - 2}.19.0`) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`^NODE_VERSION CI 是 ${major - 2}\\.19\\.0，本機是 ${local.replaceAll('.', '\\.')}$`, 'm'));
});

test('兩個 workflow 版本不同：exit 1', t => {
  const result = fixture(t, { 'a.yml': workflow(local), 'b.yml': workflow(`${major}.0.0`) });
  if (local === `${major}.0.0`) return;
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^NODE_VERSION b\.yml 是 /m);
});

test('找不到 node-version：exit 1', t => {
  const result = fixture(t, { 'checks.yml': 'jobs: {}\n' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /沒有任何 node-version/);
});
