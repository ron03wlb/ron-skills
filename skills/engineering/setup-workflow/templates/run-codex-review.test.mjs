import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { source, run, git } from './test/repo-fixture.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

// 假 codex：記錄 argv／stdin（每次的 -m 另附加到 FAKE_ARGV.models），-m 屬於 FAKE_CAPACITY 時印容量不足並 exit 1；否則輸出 FAKE_LOG，依 FAKE_WRITES 寫檔（相對路徑落在 -C worktree），必要時寫 -o 報告，以 FAKE_EXIT 結束。
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify({ argv, stdin: fs.readFileSync(0, 'utf8') }));
const model = argv[argv.indexOf('-m') + 1]; fs.appendFileSync(process.env.FAKE_ARGV + '.models', model + '\\n');
if ((process.env.FAKE_CAPACITY || '').split(',').includes(model)) {
  process.stdout.write('ERROR: Selected model is at capacity. Please try a different model.\\n'); process.exit(1);
}
process.stdout.write(process.env.FAKE_LOG);
for (const [file, content] of JSON.parse(process.env.FAKE_WRITES || '[]')) fs.writeFileSync(path.resolve(argv[argv.indexOf('-C') + 1], file), content);
if (process.env.FAKE_REPORT) fs.writeFileSync(argv[argv.indexOf('-o') + 1], process.env.FAKE_REPORT);
process.exit(Number(process.env.FAKE_EXIT || 0));
`;
const header = (model = 'gpt-6-astra', effort = 'high') =>
  `OpenAI Codex v0.162.1\n--------\nworkdir: /w\nmodel: ${model}\nprovider: openai\nsandbox: read-only\nreasoning effort: ${effort}\nsession id: 01a1\n--------\nuser\nUse the code-review skill.\n`;
const SPAWN_LINE = '2026-10-10T15:01:29.959668Z ERROR codex_core::tools::router: error=collab spawn failed: Fatal error: failed to load model context\n';

// worktree fixture：已提交檔、review 前已存在的未提交修改，與 review 前以 `git add -N` 標記的新檔；out dir 位於被忽略的 .scratch。
function worktree(temp) {
  const repo = join(temp, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(repo, '.gitignore'), '.scratch/\n'); writeFileSync(join(repo, 'tracked.md'), 'base\n'); writeFileSync(join(repo, 'dirty.md'), 'base\n');
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  writeFileSync(join(repo, 'dirty.md'), 'edited before review\n');
  writeFileSync(join(repo, 'intent.md'), 'new file\n'); git(repo, 'add', '-N', 'intent.md');
  return repo;
}

function review(t, { log = header(), report = '**Standards**\n**Spec**\n', exit = 0, staleReport = false, rulings, writes = [], outDir = '.scratch/issue-run-1', baseline, checkpoint, capacity = '' } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'codex-review-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bin = join(temp, 'codex'); writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  const repo = worktree(temp); const out = join(repo, outDir); const argvFile = join(temp, 'argv.json');
  if (staleReport) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'review.md'), 'stale'); }
  // checkpoint：.scratch/issue-run-1/state.md 宣告 integration: main；stale 時分支先合入一個 main 的新 commit，而 baseline 仍指舊 HEAD。
  // stacked*：task 疊在 blocker 候選（task 上的 b1、b2，不在 main）上，checkpoint baseline: 記 b2；stacked 傳 b2，stacked-old 傳舊候選 b1。
  // stale-recorded：checkpoint baseline: 記整合分支上的舊祖先（非 stacked），傳入值與之相等但不是 merge-base。
  let recorded = 'x';
  if (checkpoint) {
    // 夾具的未提交修改先收進 stash（intent-to-add 先取消），分支操作完再放回並重新 add -N。
    git(repo, 'reset', '-q'); git(repo, 'stash', '-u', '-q');
    git(repo, 'switch', '-qc', 'task');
    if (checkpoint.startsWith('stacked')) for (const name of ['b1', 'b2']) {
      writeFileSync(join(repo, `${name}.md`), `${name}\n`); git(repo, 'add', `${name}.md`);
      git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', name);
    }
    git(repo, 'switch', '-q', 'main');
    writeFileSync(join(repo, 'upstream.md'), 'upstream\n'); git(repo, 'add', 'upstream.md');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'upstream');
    git(repo, 'switch', '-q', 'task');
    if (checkpoint === 'stale' || checkpoint === 'stale-recorded') { git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '-q', '--no-ff', '-m', 'sync', 'main'); baseline = git(repo, 'rev-parse', 'main~1'); }
    else if (checkpoint.startsWith('stacked')) baseline = git(repo, 'rev-parse', checkpoint === 'stacked' ? 'HEAD' : 'HEAD~1');
    else baseline = git(repo, 'merge-base', 'HEAD', 'main');
    if (checkpoint === 'stale-recorded') recorded = baseline;
    if (checkpoint.startsWith('stacked')) recorded = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'stash', 'pop', '-q'); git(repo, 'add', '-N', 'intent.md');
    mkdirSync(join(repo, '.scratch/issue-run-1'), { recursive: true });
    writeFileSync(join(repo, '.scratch/issue-run-1/state.md'), `# issue-run-1\nbaseline: ${recorded}   worktree: x   endpoint: commit\nintegration: main\n`);
  }
  const extra = [];
  if (rulings !== undefined) {
    extra.push(join(temp, 'rulings.md'));
    if (rulings !== null) writeFileSync(extra[0], rulings);
  }
  const fixedPoint = baseline ?? git(repo, 'rev-parse', '--short', 'HEAD');
  const result = run(temp, [process.execPath, join(source, 'run-codex-review.mjs'), fixedPoint, 'spec.md', repo, out, ...extra],
    { env: { CODEX_BIN: bin, FAKE_ARGV: argvFile, FAKE_LOG: log, FAKE_REPORT: report, FAKE_EXIT: String(exit), FAKE_WRITES: JSON.stringify(writes), FAKE_CAPACITY: capacity } });
  const models = existsSync(`${argvFile}.models`) ? readFileSync(`${argvFile}.models`, 'utf8').trim().split('\n') : [];
  return { result, repo, temp, out, models, call: existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf8')) : null };
}
const error = (result) => { assert.equal(result.status, 1); return JSON.parse(result.stderr.trim()).error; };

test('主模型容量不足時改用 gpt-6.1-sol 重跑一次並以其比對 MODEL_MISMATCH；改名的失敗 log 不算 REVIEW_WROTE_REPO', t => {
  const { result, out, models } = review(t, { capacity: 'gpt-6-astra', log: header('gpt-6.1-sol'), outDir: 'reviews/r1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(models, ['gpt-6-astra', 'gpt-6.1-sol']);
  const json = JSON.parse(result.stdout.trim());
  assert.equal(json.model, 'gpt-6.1-sol'); assert.equal(json.fallbackFrom, 'gpt-6-astra');
  assert.match(readFileSync(join(out, 'codex.gpt-6-astra.log'), 'utf8'), /at capacity/);
  assert.equal(error(review(t, { capacity: 'gpt-6-astra' }).result), 'MODEL_MISMATCH');
  const both = review(t, { capacity: 'gpt-6-astra,gpt-6.1-sol' });
  assert.equal(error(both.result), 'CODEX_EXIT'); assert.equal(both.models.length, 2);
  const other = review(t, { exit: 3 });
  assert.equal(error(other.result), 'CODEX_EXIT'); assert.equal(other.models.length, 1);
});

test('以固定模型、effort、workspace-write（開放網路）與持久 session 呼叫 Codex，並回報 OK', t => {
  const { result, repo, out, call } = review(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(call.argv, ['exec', '-s', 'workspace-write', '--ignore-user-config', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high',
    '-c', 'sandbox_workspace_write.network_access=true', '-C', repo, '-o', join(out, 'review.md'), '-']);
  assert.match(call.stdin, new RegExp(`^Use the code-review skill\\. Fixed point: ${git(repo, 'rev-parse', 'HEAD')}\\. Spec: spec\\.md\\.`));
  assert.match(call.stdin, /You may run fixture tests that create temporary files, but write nothing to the repository\./);
  assert.match(call.stdin, /The controller has already run the verification suites; run only the focused tests that confirm or refute a suspected finding\./);
  assert.equal(JSON.parse(result.stdout).status, 'OK');
  assert.match(readFileSync(join(out, 'codex.log'), 'utf8'), /^OpenAI Codex/);
});
test('Codex 修改已追蹤檔、intent-to-add 檔或新增未追蹤檔判定 REVIEW_WROTE_REPO 並列出路徑', t => {
  const { result } = review(t, { writes: [['tracked.md', 'changed\n'], ['intent.md', 'changed\n'], ['added.md', 'x\n']] });
  assert.equal(result.status, 1);
  const detail = JSON.parse(result.stderr.trim());
  assert.equal(detail.error, 'REVIEW_WROTE_REPO');
  assert.deepEqual(detail.paths, ['added.md', 'intent.md', 'tracked.md']);
});
test('Codex 再次修改 review 前已修改的檔案也判定 REVIEW_WROTE_REPO', t => {
  const { result } = review(t, { writes: [['dirty.md', 'edited during review\n']] });
  assert.equal(error(result), 'REVIEW_WROTE_REPO');
  assert.deepEqual(JSON.parse(result.stderr.trim()).paths, ['dirty.md']);
});
test('Codex 只寫暫存目錄（含 worktree 內被忽略的 out dir）照常成功', t => {
  const temp = mkdtempSync(join(realTmpdir(), 'codex-fixture-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const { result } = review(t, { writes: [[join(temp, 'fixture.txt'), 'tmp\n'], ['.scratch/issue-run-1/extra.log', 'ignored\n']] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(temp, 'fixture.txt'), 'utf8'), 'tmp\n');
});
test('out dir 位於 worktree 內且未被忽略時，runner 自身的 review.md／codex.log 不判定 REVIEW_WROTE_REPO', t => {
  const { result, out } = review(t, { outDir: 'reviews/r1', staleReport: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(out, 'codex.log'), 'utf8'), /^OpenAI Codex/);
});
test('out dir 位於 worktree 內且未被忽略時，Codex 在該目錄或 repo 其他位置寫入其他檔案仍判定 REVIEW_WROTE_REPO', t => {
  const { result } = review(t, { outDir: 'reviews/r1', writes: [['reviews/r1/extra.log', 'x\n'], ['added.md', 'x\n']] });
  assert.equal(error(result), 'REVIEW_WROTE_REPO');
  assert.deepEqual(JSON.parse(result.stderr.trim()).paths, ['added.md', 'reviews/r1/extra.log']);
});
test('Codex 非零結束且改動 worktree 時優先判定 REVIEW_WROTE_REPO', t => {
  assert.equal(error(review(t, { exit: 2, writes: [['tracked.md', 'changed\n']] }).result), 'REVIEW_WROTE_REPO');
});
test('fixed point 在 worktree 解析不到 commit 時判定 BASELINE_INVALID，且不呼叫 Codex', t => {
  const { result, call } = review(t, { baseline: 'b055aa95b2' });
  assert.equal(error(result), 'BASELINE_INVALID'); assert.equal(call, null);
});
test('out dir 有 checkpoint 時，baseline 不是 HEAD 與 integration 的 merge-base即 BASELINE_STALE，且不呼叫 Codex；相等時照常', t => {
  const stale = review(t, { outDir: '.scratch/issue-run-1/r2', checkpoint: 'stale' });
  assert.equal(error(stale.result), 'BASELINE_STALE'); assert.equal(stale.call, null);
  assert.equal(JSON.parse(stale.result.stderr.trim()).mergeBase, git(stale.repo, 'rev-parse', 'main'));
  const fresh = review(t, { outDir: '.scratch/issue-run-1', checkpoint: 'fresh' });
  assert.equal(fresh.result.status, 0, fresh.result.stderr); assert.notEqual(fresh.call, null);
});
test('非 stacked：checkpoint baseline: 是整合分支祖先時，傳入值即使等於它，不是 merge-base 仍判 BASELINE_STALE', t => {
  const { result, call } = review(t, { outDir: '.scratch/issue-run-1/r2', checkpoint: 'stale-recorded' });
  assert.equal(error(result), 'BASELINE_STALE'); assert.equal(call, null);
});
test('stacked：傳入值等於 checkpoint baseline:（HEAD 的祖先、不在整合分支上）時不判 BASELINE_STALE，照常審查', t => {
  const { result, repo, call } = review(t, { outDir: '.scratch/issue-run-1/r2', checkpoint: 'stacked' });
  assert.equal(result.status, 0, result.stderr); assert.notEqual(call, null);
  assert.match(call.stdin, new RegExp(`Fixed point: ${git(repo, 'rev-parse', 'HEAD')}\\.`));
});
test('stacked：傳入值不等於 checkpoint baseline:（舊候選）時判 BASELINE_STALE，且不呼叫 Codex', t => {
  const { result, repo, call } = review(t, { outDir: '.scratch/issue-run-1/r2', checkpoint: 'stacked-old' });
  assert.equal(error(result), 'BASELINE_STALE'); assert.equal(call, null);
  assert.equal(JSON.parse(result.stderr.trim()).mergeBase, git(repo, 'rev-parse', 'HEAD'));
});
test('worktree 不是 git repository 時判定 SNAPSHOT_FAILED，且不呼叫 Codex', t => {
  const temp = mkdtempSync(join(realTmpdir(), 'codex-review-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const argvFile = join(temp, 'argv.json'); const bin = join(temp, 'codex'); writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  const result = run(temp, [process.execPath, join(source, 'run-codex-review.mjs'), 'abc123', 'spec.md', temp, join(temp, 'out')],
    { env: { CODEX_BIN: bin, FAKE_ARGV: argvFile, FAKE_LOG: header() } });
  assert.equal(error(result), 'SNAPSHOT_FAILED');
  assert.equal(existsSync(argvFile), false);
});
test('真實 spawn 失敗行判定 SPAWN_FAILED', t => {
  assert.equal(error(review(t, { log: header() + 'codex\n' + SPAWN_LINE }).result), 'SPAWN_FAILED');
});
test('diff 或檔案內容引用 spawn 失敗字句（非行首時間戳）不誤判', t => {
  const quoted = '+   `codex.log` contains `ERROR codex_core::tools::router: error=collab spawn failed`\n'
    + "   grep -qE '^[0-9TZ:.-]+ ERROR codex_core::tools::router: error=collab spawn failed' codex.log\n";
  assert.equal(review(t, { log: header() + quoted }).result.status, 0);
});
test('header 模型或 effort 不符判定 MODEL_MISMATCH；header 之後的冒充行不採計', t => {
  assert.equal(error(review(t, { log: header('gpt-6.1-sol', 'none') }).result), 'MODEL_MISMATCH');
  assert.equal(error(review(t, { log: header('gpt-6.1-sol', 'low') + 'model: gpt-6-astra\nreasoning effort: high\n' }).result), 'MODEL_MISMATCH');
  assert.equal(error(review(t, { log: 'no header at all\n' }).result), 'MODEL_MISMATCH');
});
test('Codex 非零結束判定 CODEX_EXIT', t => {
  assert.equal(error(review(t, { exit: 2 }).result), 'CODEX_EXIT');
});
test('未產出報告或空報告判定 NO_REPORT；舊報告先清除不採計', t => {
  assert.equal(error(review(t, { report: '' }).result), 'NO_REPORT');
  assert.equal(error(review(t, { report: '', staleReport: true }).result), 'NO_REPORT');
});
test('未給裁決檔時 prompt 不提已裁決項目', t => {
  const { result, call } = review(t);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(call.stdin, /Rulings/);
});
test('給裁決檔時 prompt 指向它，並限定只在 diff 改變前提時才重提', t => {
  const { result, call } = review(t, { rulings: '- sync 移除 pristine worktree：不修\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(call.stdin, /Rulings: \S*rulings\.md\./);
  assert.match(call.stdin, /re-raise a ruled finding only when this diff changes the premise of its ruling/);
});
test('裁決檔不存在或為空判定 RULINGS_MISSING，且不呼叫 Codex', t => {
  for (const rulings of [null, '']) {
    const { result, call } = review(t, { rulings });
    assert.equal(error(result), 'RULINGS_MISSING');
    assert.equal(call, null);
  }
});
test('缺參數判定 USAGE', t => {
  const result = run(source, [process.execPath, join(source, 'run-codex-review.mjs'), 'abc123']);
  assert.equal(error(result), 'USAGE');
});
