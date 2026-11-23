import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOverlay, upstreamDir } from './helpers/apply-overlay.mjs';

const root = new URL('..', import.meta.url).pathname;
const upstream = upstreamDir('poteto-mode');

// #342：上游 SKILL.md 要每個子代理 kickoff 第一行讀 worker.md，它的規則和 issue-run 的 review、本機 candidate、pr skill 衝突。
test('poteto-mode overlay 的 Local harness 寫明 kickoff 不帶 worker.md', t => {
  const skill = applyOverlay(t, 'poteto-mode');
  const harness = skill.split('## Local harness')[1]?.split('\n## ')[0];
  assert.ok(harness, 'overlay 沒有 Local harness 段');
  const line = harness.split('\n').find(text => text.includes('worker.md'));
  assert.ok(line, 'Local harness 沒有提到 worker.md');
  assert.match(line, /\/issue-run/);
  assert.match(line, /kickoff/);
  assert.match(line, /\b(no|not|never|without)\b/i);
});

// #342：pstack 0.15.44 刪了 playbooks/orchestrate.md，引用它的文件會叫 agent 去讀不存在的檔。
test('repo 文件引用的 poteto-mode playbook 都在上游存在', () => {
  const files = ['skills/engineering/issue-pilot/SKILL.md', 'README.md', 'docs/workflow/09-skills.md'];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [, name] of text.matchAll(/playbooks\/([a-z0-9-]+)\.md/g)) {
      assert.ok(existsSync(join(upstream, 'playbooks', `${name}.md`)), `${file} 引用不存在的 playbooks/${name}.md`);
    }
    if (!existsSync(join(upstream, 'playbooks/orchestrate.md'))) {
      for (const line of text.split('\n').filter(candidate => /Orchestrate/.test(candidate))) {
        assert.match(line, /removed|已刪/, `${file} 仍把 Orchestrate 當成現有 playbook：${line.slice(0, 120)}`);
      }
    }
  }
});
