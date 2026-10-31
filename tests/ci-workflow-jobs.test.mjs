import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #87：macOS runner 在 private repo 以 10 倍計費，所以 macOS job 只在 PR、每週與手動觸發時跑，push 照舊只跑 ubuntu。
const workflow = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');

// 依 `jobs:` 底下兩格縮排的 key 切出每個 job 的文字。
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const result = {};
  for (const [, name, block] of body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)*)/gm)) result[name] = block;
  return result;
}

const all = Object.values(jobs(workflow));
const byRunner = runner => {
  const found = all.filter(block => new RegExp(`^ {4}runs-on: ${runner}$`, 'm').test(block));
  assert.equal(found.length, 1, `checks.yml 要剛好一個 ${runner} job`);
  return found[0];
};
// 兩個 job 只該差在 if 與 runs-on。
const shared = block => block.replace(/^ {4}(?:if|runs-on):.*\n/gm, '');

test('ubuntu job 沒有 if，每種觸發都跑', () => {
  assert.doesNotMatch(byRunner('ubuntu-latest'), /^ {4}if:/m);
});

test('macOS job 只在 pull_request、schedule、workflow_dispatch 跑：以正向清單寫，on: 新增觸發也不會跟著跑', () => {
  const [, condition] = byRunner('macos-latest').match(/^ {4}if: (.*)$/m) ?? [];
  assert.equal(condition, `contains(fromJSON('["pull_request", "schedule", "workflow_dispatch"]'), github.event_name)`);
});

test('macOS job 除了 if 與 runs-on，內容（steps、node-version）與 ubuntu job 相同', () => {
  const ubuntu = shared(byRunner('ubuntu-latest'));
  assert.match(ubuntu, /^ {4}steps:\n/m);
  assert.equal(shared(byRunner('macos-latest')), ubuntu);
});
