// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./check-adapter-size.mjs', import.meta.url).pathname;
const run = root => spawnSync('node', [script, '--root', root], { encoding: 'utf8' });

function fixture(t, budget) {
  const root = mkdtempSync(join(realTmpdir(), 'adapter-size-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'docs/agents'), { recursive: true });
  if (budget) writeFileSync(join(root, 'scripts/adapter-size-budget.json'), JSON.stringify(budget));
  return root;
}

test('都在預算內：每檔一行用量與餘裕，清單上不存在的檔略過，exit 0', t => {
  const root = fixture(t, { 'docs/agents/issue-run.md': 10, 'docs/agents/pilot.md': 10, 'docs/agents/pilot-round.md': 58000 });
  writeFileSync(join(root, 'docs/agents/issue-run.md'), '1234567890');
  writeFileSync(join(root, 'docs/agents/pilot-round.md'), '中');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'docs/agents/issue-run.md 10／10，餘裕 0 bytes\ndocs/agents/pilot-round.md 3／58000，餘裕 57997 bytes\nadapter 檔大小預算檢查通過。\n');
});

test('超過預算：stderr 每檔一行 ADAPTER_SIZE_OVER 加拆檔提示，exit 1', t => {
  const root = fixture(t, { 'docs/agents/issue-run.md': 5, 'docs/agents/pilot.md': 14000 });
  writeFileSync(join(root, 'docs/agents/issue-run.md'), '123456');
  writeFileSync(join(root, 'docs/agents/pilot.md'), 'ok');
  const result = run(root);
  assert.equal(result.status, 1);
  const [first, hint] = result.stderr.split('\n');
  assert.equal(first, 'ADAPTER_SIZE_OVER docs/agents/issue-run.md 6 > 5');
  assert.match(hint, /adapter-line\.mjs/);
});

test('沒有預算表 exit 2；範本附的預算表把兩個必讀核心各訂 14000 bytes、PILOT-ROUND-TEMPLATE 的拆出檔 58000', t => {
  const root = fixture(t);
  assert.equal(run(root).status, 2);
  assert.equal(spawnSync('node', [script, '--root'], { encoding: 'utf8' }).status, 2, '--root 沒給值是用法錯誤');
  const seed = JSON.parse(readFileSync(new URL('./adapter-size-budget.json', import.meta.url), 'utf8'));
  assert.deepEqual(seed, { 'docs/agents/issue-run.md': 14000, 'docs/agents/pilot.md': 14000, 'docs/agents/pilot-round.md': 58000 });
});
