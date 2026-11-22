// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./adapter-line.mjs', import.meta.url).pathname;

// 假 repo：預算表列核心與拆出檔，條目、pointer、標題節都有
function fixture(t) {
  const root = mkdtempSync(join(realTmpdir(), 'adapter-line-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'docs/agents'), { recursive: true });
  writeFileSync(join(root, 'scripts/adapter-size-budget.json'), JSON.stringify({
    'docs/agents/issue-run.md': 14000,
    'docs/agents/pilot.md': 14000,
    'docs/agents/pilot-round.md': 58000,
    'docs/agents/missing.md': 58000,
  }));
  writeFileSync(join(root, 'docs/agents/issue-run.md'), [
    '# adapter', '', '## Checks', '', '只有一條：`bin/check`。', '', '- **Sub.** 子條目', '', '## Review', '', 'Skill `code-review`。', '',
  ].join('\n'));
  writeFileSync(join(root, 'docs/agents/pilot.md'), [
    '# Pilot', '',
    '- **Probe.** 見 [pilot-round.md](pilot-round.md)：Reconcile 時讀。', '',
    '- **Refine dispatch.** 細化', '',
    '- **Refine body rules.** 本文', '',
    '- **Defaults for `preferences.md`.** worker 最多 4 個',
    '  縮排的子行併入條目', '',
    '- **Watch.** 背景跑',
  ].join('\n'));
  writeFileSync(join(root, 'docs/agents/pilot-round.md'), ['# 每輪', '', '- **Probe.** 在主 checkout 跑 `node scripts/pilot-probe.mjs`。', '', '- **Watch dog.** 同名前綴在另一檔', '', '- **Defaults for `preferences.md`.** 本文', ''].join('\n'));
  writeFileSync(join(root, 'docs/agents/other.md'), '- **Other.** 不在預算表，不讀\n');
  return root;
}
const run = (root, ...args) => spawnSync('node', [script, '--root', root, ...args], { encoding: 'utf8' });

test('條目名印整條（含縮排子行），每條前一行 `== <檔>:<行>`；核心的 pointer 與拆出檔的本文都印', t => {
  const root = fixture(t);
  const probe = run(root, 'Probe');
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, [
    '== docs/agents/pilot.md:3', '- **Probe.** 見 [pilot-round.md](pilot-round.md)：Reconcile 時讀。',
    '== docs/agents/pilot-round.md:3', '- **Probe.** 在主 checkout 跑 `node scripts/pilot-probe.mjs`。', '',
  ].join('\n'));
  const defaults = run(root, 'Defaults for `preferences.md`', 'Watch');
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(defaults.stdout, [
    '== docs/agents/pilot.md:9', '- **Defaults for `preferences.md`.** worker 最多 4 個', '  縮排的子行併入條目',
    '== docs/agents/pilot-round.md:7', '- **Defaults for `preferences.md`.** 本文',
    '== docs/agents/pilot.md:12', '- **Watch.** 背景跑', '',
  ].join('\n'));
});

test('沒有同名條目時印同名 Markdown 標題整節，到下一個同級標題前', t => {
  const root = fixture(t);
  const result = run(root, 'Checks');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ['== docs/agents/issue-run.md:3', '## Checks', '', '只有一條：`bin/check`。', '', '- **Sub.** 子條目', ''].join('\n'));
});

test('唯一前綴印該條目並註明實際名稱；多條前綴與找不到時 exit 1、stderr 列候選，其他條目照印', t => {
  const root = fixture(t);
  const prefix = run(root, 'Defaults for');
  assert.equal(prefix.status, 0, prefix.stderr);
  // 核心 pointer 與拆出檔本文同名，算一種名稱，兩條都印
  assert.match(prefix.stdout, /^ADAPTER_LINE_PREFIX Defaults for → Defaults for `preferences\.md`\n== docs\/agents\/pilot\.md:9\n[\s\S]*== docs\/agents\/pilot-round\.md:7\n- \*\*Defaults for `preferences\.md`\.\*\* 本文\n$/);
  const watch = run(root, 'Watch');
  assert.equal(watch.status, 0, '完全相符優先，不看前綴');
  assert.doesNotMatch(watch.stdout, /Watch dog/);
  assert.equal(run(root, 'Prob').status, 1, '字首後接英數字不算前綴');
  const many = run(root, 'Refine', 'Watch');
  assert.equal(many.status, 1);
  assert.equal(many.stderr, 'ADAPTER_LINE_NOT_FOUND Refine\n  candidate docs/agents/pilot.md:5 Refine dispatch\n  candidate docs/agents/pilot.md:7 Refine body rules\n');
  assert.match(many.stdout, /^== docs\/agents\/pilot\.md:12\n- \*\*Watch\.\*\* 背景跑\n$/);
  const none = run(root, 'Other');
  assert.equal(none.status, 1, '不在預算表的檔不查');
  assert.equal(none.stderr, 'ADAPTER_LINE_NOT_FOUND Other\n');
});

test('--list 每條印 `<檔> <名稱>`；用法錯誤或沒有預算表 exit 2', t => {
  const root = fixture(t);
  const list = run(root, '--list');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.split('\n')[0], 'docs/agents/issue-run.md Sub');
  assert.ok(list.stdout.includes('docs/agents/pilot-round.md Probe\n'));
  assert.equal(run(root).status, 2);
  rmSync(join(root, 'scripts/adapter-size-budget.json'));
  const missing = run(root, 'Probe');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /adapter-size-budget\.json/);
});
