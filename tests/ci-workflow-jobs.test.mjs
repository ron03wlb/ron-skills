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

const all = jobs(workflow);
const byRunner = runner => Object.values(all).find(block => new RegExp(`^ {4}runs-on: ${runner}$`, 'm').test(block));
const steps = block => block.slice(block.indexOf('    steps:\n'));

test('ubuntu job 沒有 if，每種觸發都跑', () => {
  const ubuntu = byRunner('ubuntu-latest');
  assert.ok(ubuntu, 'checks.yml 沒有 ubuntu-latest job');
  assert.doesNotMatch(ubuntu, /^ {4}if:/m);
});

test('macOS job 只在 pull_request、schedule、workflow_dispatch 跑，push 不跑', () => {
  const macos = byRunner('macos-latest');
  assert.ok(macos, 'checks.yml 沒有 macos-latest job');
  assert.match(macos, /^ {4}if: github\.event_name != 'push'$/m);
  for (const event of ['push', 'pull_request', 'schedule', 'workflow_dispatch']) {
    assert.match(workflow, new RegExp(`^  ${event}:`, 'm'), `on: 少了 ${event}，if 的排除就不等於只跑另外三種`);
  }
  const on = workflow.match(/^on:\n((?: .*\n|\n)*)/m)[1];
  assert.doesNotMatch(on, /^ {2}(?!push|pull_request|schedule|workflow_dispatch)[\w-]+:/m, 'on: 多了別的觸發，macOS 也會跟著跑');
});

test('macOS job 的 steps（含 node-version）與 ubuntu job 相同', () => {
  const ubuntu = byRunner('ubuntu-latest');
  const macos = byRunner('macos-latest');
  assert.ok(ubuntu && macos);
  assert.equal(steps(macos), steps(ubuntu));
  assert.match(steps(macos), /node-version: /);
});
