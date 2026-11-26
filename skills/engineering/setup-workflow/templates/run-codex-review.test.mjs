// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { source, run, git } from './test/repo-fixture.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

// 假 codex：記錄 argv／stdin（每次的 -m 另附加到 FAKE_ARGV.models），-m 屬於 FAKE_CAPACITY 時印容量不足並 exit 1；否則輸出 FAKE_LOG，依 FAKE_WRITES 寫檔（相對路徑落在 -C worktree），必要時寫 -o 報告，以 FAKE_EXIT 結束。
// `login status`：FAKE_LOGIN 為 fail 時印 Not logged in 並 exit 1；其餘 exit 0，且不記 argv。FAKE_SLEEP_MS：review 呼叫先睡這麼久（測 timeout）。
// FAKE_CHECK_SPEC：像真 Codex 一樣以 -C worktree 解析 prompt 的 Spec 路徑，找不到時改寫 retro fc336d0c#1 的真實報告句。
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const argv = process.argv.slice(2);
if (argv[0] === 'login') {
  if (process.env.FAKE_LOGIN === 'fail') { process.stdout.write('Not logged in\\n'); process.exit(1); }
  process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0);
}
if (process.env.FAKE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP_MS));
const stdin = fs.readFileSync(0, 'utf8'); fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify({ argv, stdin }));
const model = argv[argv.indexOf('-m') + 1]; fs.appendFileSync(process.env.FAKE_ARGV + '.models', model + '\\n');
if ((process.env.FAKE_CAPACITY || '').split(',').includes(model)) {
  process.stdout.write('ERROR: Selected model is at capacity. Please try a different model.\\n'); process.exit(1);
}
process.stdout.write(process.env.FAKE_LOG);
for (const [file, content] of JSON.parse(process.env.FAKE_WRITES || '[]')) fs.writeFileSync(path.resolve(argv[argv.indexOf('-C') + 1], file), content);
let report = process.env.FAKE_REPORT;
const spec = /Spec: (\\S+)\\. /.exec(stdin)?.[1];
if (process.env.FAKE_CHECK_SPEC && !fs.existsSync(path.resolve(argv[argv.indexOf('-C') + 1], spec)))
  report = '## 規範審查（Standards）\\n\\n- 無\\n\\n## 需求審查（Spec）\\n\\n找不到 \`' + spec + '\`，因此未完成需求符合性審查，不能判定通過。\\n\\n**Standards：0 項；Spec：缺少來源。**';
if (report) fs.writeFileSync(argv[argv.indexOf('-o') + 1], report);
process.exit(Number(process.env.FAKE_EXIT || 0));
`;
const header = (model = 'gpt-6.2-sol', effort = 'medium') =>
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

function review(t, { log = header(), report = '**Standards**\n**Spec**\n', exit = 0, staleReport = false, rulings, writes = [], outDir = '.scratch/issue-run-1', baseline, checkpoint, capacity = '', spec = 'spec.md', specContent = '# spec\n', checkSpec = false, codexHome, login = '', sleepMs = '', timeoutMs = '', bin: binOverride, baselineArg, reviewLog, env = {}, force = false } = {}) {
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
  // spec 以 runner 的 cwd（temp，模擬主 checkout）為準寫入，不在 worktree 內；specContent 為 null 時不建立。
  if (specContent !== null) { mkdirSync(dirname(join(temp, spec)), { recursive: true }); writeFileSync(join(temp, spec), specContent); }
  const fixedPoint = baselineArg?.(repo) ?? baseline ?? git(repo, 'rev-parse', '--short', 'HEAD');
  // reviewLog：review 前已在主 checkout .scratch/review-log.jsonl 的紀錄（測等待規則）。
  if (reviewLog) { mkdirSync(join(repo, '.scratch'), { recursive: true }); writeFileSync(join(repo, '.scratch', 'review-log.jsonl'), reviewLog.map(entry => JSON.stringify(entry)).join('\n') + '\n'); }
  const result = run(temp, [process.execPath, join(source, 'run-codex-review.mjs'), ...(force ? ['--force-codex'] : []), fixedPoint, spec, repo, out, ...extra],
    { env: { CODEX_BIN: binOverride ?? bin, FAKE_LOGIN: login, FAKE_SLEEP_MS: String(sleepMs), CODEX_REVIEW_TIMEOUT_MS: String(timeoutMs), FAKE_ARGV: argvFile, FAKE_LOG: log, FAKE_REPORT: report, FAKE_EXIT: String(exit), FAKE_WRITES: JSON.stringify(writes), FAKE_CAPACITY: capacity, FAKE_CHECK_SPEC: checkSpec ? '1' : '', CODEX_HOME: codexHome ?? join(temp, 'codex-home'), ...env } });
  const models = existsSync(`${argvFile}.models`) ? readFileSync(`${argvFile}.models`, 'utf8').trim().split('\n') : [];
  return { result, repo, temp, out, models, call: existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf8')) : null };
}
const error = (result) => { assert.equal(result.status, 1); return JSON.parse(result.stderr.trim()).error; };

test('主模型容量不足時改用 gpt-6.2-astra 重跑一次並以其比對 MODEL_MISMATCH；改名的失敗 log 不算 REVIEW_WROTE_REPO', t => {
  const { result, out, models } = review(t, { capacity: 'gpt-6.2-sol', log: header('gpt-6.2-astra'), outDir: 'reviews/r1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(models, ['gpt-6.2-sol', 'gpt-6.2-astra']);
  const json = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(json.model, 'gpt-6.2-astra'); assert.equal(json.fallbackFrom, 'gpt-6.2-sol');
  assert.match(readFileSync(join(out, 'codex.gpt-6.2-sol.log'), 'utf8'), /at capacity/);
  assert.equal(error(review(t, { capacity: 'gpt-6.2-sol' }).result), 'MODEL_MISMATCH');
  const both = review(t, { capacity: 'gpt-6.2-sol,gpt-6.2-astra' });
  assert.equal(error(both.result), 'CODEX_EXIT'); assert.equal(both.models.length, 2);
  const other = review(t, { exit: 3 });
  assert.equal(error(other.result), 'CODEX_EXIT'); assert.equal(other.models.length, 1);
});

test('以固定模型、effort、workspace-write（開放網路）與持久 session 呼叫 Codex，並回報 OK', t => {
  const { result, repo, temp, out, call } = review(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(call.argv, ['exec', '-s', 'workspace-write', '--ignore-user-config', '-m', 'gpt-6.2-sol', '-c', 'model_reasoning_effort=medium',
    '-c', 'sandbox_workspace_write.network_access=true', '-C', repo, '-o', join(out, 'review.md'), '-']);
  assert.match(call.stdin, new RegExp(`^Use the code-review skill\\. Fixed point: ${git(repo, 'rev-parse', 'HEAD')}\\. Spec: ${join(temp, 'spec.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  assert.match(call.stdin, /You may run fixture tests that create temporary files, but write nothing to the repository\./);
  assert.match(call.stdin, /The controller has already run the verification suites; run only the focused tests that confirm or refute a suspected finding\./);
  const [line, json] = result.stdout.trim().split('\n');
  assert.equal(line, 'REVIEWER=codex model=gpt-6.2-sol');
  assert.equal(JSON.parse(json).status, 'OK'); assert.equal(JSON.parse(json).reviewer, 'codex');
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
// spay2 retro 5e2b0c21#2：deliver-sync-baseline 把 state.md 的 baseline: 改成新的 merge-base，同一命令裡的 review 仍收到寫死的舊值而 BASELINE_STALE。
// 這裡以 stale checkpoint 模擬 sync 之後：state.md 的 baseline: 已寫回 merge-base（main），傳 state:<path> 讀到它即照常審查。
const syncedState = repo => {
  const file = join(repo, '.scratch/issue-run-1/state.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^baseline: \S+/m, `baseline: ${git(repo, 'rev-parse', 'main')}`));
  return 'state:repo/.scratch/issue-run-1/state.md';
};
test('baseline 為 state:<path>（相對 runner cwd）時讀該檔 baseline: 行當 fixed point：sync 後串接不判 BASELINE_STALE', t => {
  const { result, repo, call } = review(t, { outDir: '.scratch/issue-run-1/r2', checkpoint: 'stale', baselineArg: syncedState });
  assert.equal(result.status, 0, result.stderr); assert.notEqual(call, null);
  assert.match(call.stdin, new RegExp(`Fixed point: ${git(repo, 'rev-parse', 'main')}\\.`));
});
test('state:<path> 讀不到檔或沒有 40 位 SHA 的 baseline: 行時判 BASELINE_STATE_UNREADABLE（附原因），且不呼叫 Codex', t => {
  const absent = review(t, { baselineArg: repo => `state:${join(repo, 'no-such-state.md')}` });
  assert.equal(error(absent.result), 'BASELINE_STATE_UNREADABLE'); assert.equal(absent.call, null);
  assert.equal(JSON.parse(absent.result.stderr.trim()).reason, 'ENOENT');
  // checkpoint fresh 的 state.md 寫的是 `baseline: x`：不是 SHA，不能當 fixed point
  const malformed = review(t, { outDir: '.scratch/issue-run-1', checkpoint: 'fresh', baselineArg: () => 'state:repo/.scratch/issue-run-1/state.md' });
  assert.equal(error(malformed.result), 'BASELINE_STATE_UNREADABLE'); assert.equal(malformed.call, null);
  assert.match(JSON.parse(malformed.result.stderr.trim()).reason, /baseline:/);
});
test('worktree 不是 git repository 時判定 SNAPSHOT_FAILED，且不呼叫 Codex', t => {
  const temp = mkdtempSync(join(realTmpdir(), 'codex-review-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const argvFile = join(temp, 'argv.json'); const bin = join(temp, 'codex'); writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  writeFileSync(join(temp, 'spec.md'), '# spec\n');
  const result = run(temp, [process.execPath, join(source, 'run-codex-review.mjs'), 'abc123', 'spec.md', temp, join(temp, 'out')],
    { env: { CODEX_BIN: bin, FAKE_ARGV: argvFile, FAKE_LOG: header(), CODEX_HOME: join(temp, 'codex-home') } });
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
  assert.equal(error(review(t, { log: header('gpt-6.2-astra', 'none') }).result), 'MODEL_MISMATCH');
  assert.equal(error(review(t, { log: header('gpt-6.2-astra', 'low') + 'model: gpt-6.2-sol\nreasoning effort: medium\n' }).result), 'MODEL_MISMATCH');
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
test('裁決檔不存在判定 RULINGS_MISSING，且不呼叫 Codex', t => {
  const { result, call } = review(t, { rulings: null });
  assert.equal(error(result), 'RULINGS_MISSING');
  assert.equal(call, null);
});
// 真實形狀：#797 傳了存在但為空的 rulings.md，舊碼回 RULINGS_MISSING，讀起來像檔案不存在。
test('裁決檔存在但為空判定 RULINGS_EMPTY（附路徑與下一步），且不呼叫 Codex', t => {
  const { result, call } = review(t, { rulings: '' });
  const detail = JSON.parse(result.stderr.trim());
  assert.equal(detail.error, 'RULINGS_EMPTY');
  assert.match(detail.rulings, /rulings\.md$/);
  assert.match(detail.next, /寫入已裁決項目.*刪除此檔/);
  assert.equal(call, null);
});
// 真實形狀：retro fc336d0c#1 在主 checkout 傳相對路徑 `.scratch/retro/plan-1106a.md`，Codex 以 worktree 解析找不到，舊碼仍回 OK、exit 0。
test('相對路徑 spec 以 runner cwd 解析成絕對路徑放進 prompt，Codex 在 worktree 也讀得到', t => {
  const { result, temp, call } = review(t, { spec: '.scratch/retro/plan-1106a.md', checkSpec: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(call.stdin.includes(`Spec: ${join(temp, '.scratch/retro/plan-1106a.md')}.`));
});
test('spec 不存在或為空判定 SPEC_MISSING（附絕對路徑），且不呼叫 Codex', t => {
  for (const specContent of [null, '']) {
    const { result, temp, call } = review(t, { spec: '.scratch/retro/plan-1106a.md', specContent });
    assert.equal(error(result), 'SPEC_MISSING');
    assert.equal(JSON.parse(result.stderr.trim()).spec, join(temp, '.scratch/retro/plan-1106a.md'));
    assert.equal(call, null);
  }
});
test('報告寫出未完成需求審查（retro fc336d0c#1 的真實句）判定 SPEC_NOT_REVIEWED；反引號或「」內的引用不算', t => {
  const real = '## 需求審查（Spec）\n\n找不到 `.scratch/retro/plan-1106a.md`，因此未完成需求符合性審查，不能判定通過。\n';
  assert.equal(error(review(t, { report: real }).result), 'SPEC_NOT_REVIEWED');
  assert.equal(error(review(t, { report: '**Standards：0 項；Spec：缺少來源。**\n' }).result), 'SPEC_NOT_REVIEWED');
  const quoted = '## 需求審查（Spec）\n\n- P3：review.md 寫出「未完成需求符合性審查」時判失敗，對應 `Spec：缺少來源`。\n';
  assert.equal(review(t, { report: quoted }).result.status, 0);
});
// review 1106b：舊碼只去掉反引號與「」，finding 用半形或全形雙引號引用時誤判 SPEC_NOT_REVIEWED
test('半形 "…" 與全形 “…” 內的引用不算 SPEC_NOT_REVIEWED；引號外的句子仍判定', t => {
  for (const report of ['## 需求審查（Spec）\n\n- P3 regex 對 "未完成需求符合性審查" 判定過寬\n', '## 需求審查（Spec）\n\n- P3 regex 對 “Spec：缺少來源” 判定過寬\n']) {
    assert.equal(review(t, { report }).result.status, 0, report);
  }
  assert.equal(error(review(t, { report: '- 見 "plan.md"：未完成需求符合性審查\n' }).result), 'SPEC_NOT_REVIEWED');
});
test('缺參數判定 USAGE', t => {
  const result = run(source, [process.execPath, join(source, 'run-codex-review.mjs'), 'abc123']);
  assert.equal(error(result), 'USAGE');
});

// 真實 log：retro spay2 86eda4c4#2（jsonl 710）。帳務問題重跑無用，原本只回 CODEX_EXIT，要讀 log 才知道。
const NO_CREDITS = 'ERROR: Your workspace is out of credits. Ask your workspace owner to refill in order to continue.\n';
test('額度用完：判定 CODEX_NO_CREDITS，附改用 code-review skill 的提示', t => {
  const { result } = review(t, { log: header() + NO_CREDITS + NO_CREDITS, exit: 1 });
  const json = JSON.parse(result.stderr.trim());
  assert.equal(json.error, 'CODEX_NO_CREDITS');
  assert.match(json.hint, /code-review/);
  assert.match(json.hint, /下一輪照樣先跑本 runner/);
  assert.doesNotMatch(json.hint, /補額度|不會補充/);
  assert.equal(json.quota, undefined);
  assert.equal(json.quotaKind, 'credits'); assert.equal(json.resetAtSource, 'estimated');
  assert.equal(result.stdout.trim(), `REVIEWER=claude reason=quota quotaKind=credits resetAt=${json.resetAt}`);
  assert.match(json.log, /codex\.log$/);
});

// 真實形狀：retro spay2 a903a2bb#2（2026-11-12 rollout：secondary used_percent 26、window 10080、resets_at 1795054725）；
// 2026-11-16 額度用完時的 rollout 則 secondary 為 null、rate_limit_reached_type 為 workspace_member_credits_depleted。
function rolloutHome(t, files) {
  const home = mkdtempSync(join(realTmpdir(), 'codex-quota-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  files.forEach(([name, limits, mtime], index) => {
    const dir = join(home, 'sessions', '2026', '11', String(12 + index)); mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    const records = (Array.isArray(limits) ? limits : [limits]).map(rate_limits => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits } }));
    writeFileSync(file, [JSON.stringify({ type: 'session_meta' }), ...records].join('\n') + '\n');
    utimesSync(file, mtime, mtime);
  });
  return home;
}
function quota(t, files) {
  const home = rolloutHome(t, files);
  return run(home, [process.execPath, join(source, 'run-codex-review.mjs'), '--quota'], { env: { CODEX_HOME: home } });
}
const WEEKLY = { primary: null, secondary: { used_percent: 26.0, window_minutes: 10080, resets_at: 1795054725 } };
const DEPLETED = { primary: null, secondary: null, rate_limit_reached_type: 'workspace_member_credits_depleted' };
// CoS item 124：舊版 reached 取最新 rollout、resets_at 往回取舊 rollout，拼出「12/1 重置」這種不存在的時間。兩者要來自同一份 rollout，否則印 ?（未知）。
test('--quota：新 rollout 的 reached 不配舊 rollout 的 resets_at，週額度欄位印 ?', t => {
  const result = quota(t, [['rollout-a.jsonl', WEEKLY, 1000], ['rollout-b.jsonl', DEPLETED, 2000]]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'CODEX_QUOTA used_percent=? window_minutes=? resets_at=? reached=workspace_member_credits_depleted');
  assert.doesNotMatch(result.stdout, /2026-11-19/);
});
test('--quota：同一份 rollout 先有週額度、後來 reached 時，兩者一起印', t => {
  assert.equal(quota(t, [['rollout-a.jsonl', [WEEKLY, DEPLETED], 1000]]).stdout.trim(),
    'CODEX_QUOTA used_percent=26 window_minutes=10080 resets_at=2026-11-19T02:18:45.000Z reached=workspace_member_credits_depleted');
});
test('--quota：只有週額度時 reached=none；沒有 rollout 時 CODEX_QUOTA_UNKNOWN', t => {
  assert.equal(quota(t, [['rollout-a.jsonl', WEEKLY, 1000]]).stdout.trim(), 'CODEX_QUOTA used_percent=26 window_minutes=10080 resets_at=2026-11-19T02:18:45.000Z reached=none');
  assert.equal(quota(t, []).stdout.trim(), 'CODEX_QUOTA_UNKNOWN');
});
test('額度字句只是被引用（非行首）或 Codex 成功結束：不判 CODEX_NO_CREDITS', t => {
  assert.equal(error(review(t, { log: header() + '+ ' + NO_CREDITS, exit: 2 }).result), 'CODEX_EXIT');
  assert.equal(review(t, { log: header() + NO_CREDITS }).result.status, 0);
});

// CoS item 124：舊預檢只讀本機 rollout，判定用完就不呼叫 Codex，於是不再產生新 rollout，擋了 spay2 約三天。
// fixture 取自 2026-11-21 20:51 那份 rollout 的最後兩行（去識別化：拿掉 session／turn id 與時間戳以外的欄位），當時額度其實已在恢復途中。
const REAL_DEPLETED_ROLLOUT = [
  { timestamp: '2026-11-21T12:51:43.372Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', limit_name: null, primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: null }, individual_limit: null, spend_control_reached: null, plan_type: null, rate_limit_reached_type: 'workspace_member_credits_depleted' } } },
  { timestamp: '2026-11-21T12:51:43.396Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null, error: { message: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.', codex_error_info: 'usage_limit_exceeded' } } },
];
function depletedHome(t) {
  const home = mkdtempSync(join(realTmpdir(), 'codex-depleted-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'sessions', '2026', '11', '21'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rollout-2026-11-21T20-51-40-fixture.jsonl'), REAL_DEPLETED_ROLLOUT.map(line => JSON.stringify(line)).join('\n') + '\n');
  return home;
}
const reviewerOf = result => result.stdout.trim().split('\n')[0];
test('不做額度預檢：最新 rollout 是 depleted（真實 fixture）時仍呼叫 Codex，成功印 REVIEWER=codex；空 rulings 照常先判 RULINGS_EMPTY', t => {
  const home = depletedHome(t);
  assert.equal(run(home, [process.execPath, join(source, 'run-codex-review.mjs'), '--quota'], { env: { CODEX_HOME: home } }).stdout.trim(),
    'CODEX_QUOTA used_percent=? window_minutes=? resets_at=? reached=workspace_member_credits_depleted');
  const { result, call } = review(t, { codexHome: home });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(call, null);
  assert.equal(reviewerOf(result), 'REVIEWER=codex model=gpt-6.2-sol');
  assert.equal(error(review(t, { rulings: '', codexHome: home }).result), 'RULINGS_EMPTY');
});
test('額度不足（真實 log 字句）、未安裝、未登入、review 逾時、其他失敗都印 REVIEWER=claude reason=…', t => {
  const quota = review(t, { log: header() + `ERROR: ${REAL_DEPLETED_ROLLOUT[1].payload.error.message}\n`, exit: 1 });
  assert.match(reviewerOf(quota.result), /^REVIEWER=claude reason=quota quotaKind=credits resetAt=\S+$/); assert.equal(error(quota.result), 'CODEX_NO_CREDITS');
  const missingBin = review(t, { bin: '/nonexistent/codex-review-fixture/codex' });
  assert.equal(reviewerOf(missingBin.result), 'REVIEWER=claude reason=not-installed'); assert.equal(error(missingBin.result), 'CODEX_NOT_INSTALLED');
  const loggedOut = review(t, { login: 'fail' });
  assert.equal(reviewerOf(loggedOut.result), 'REVIEWER=claude reason=not-logged-in'); assert.equal(error(loggedOut.result), 'CODEX_NOT_LOGGED_IN');
  assert.equal(loggedOut.call, null);
  const slow = review(t, { sleepMs: 8000, timeoutMs: 1500 });
  assert.equal(reviewerOf(slow.result), 'REVIEWER=claude reason=timeout'); assert.equal(error(slow.result), 'CODEX_TIMEOUT');
  const exit = review(t, { exit: 3 });
  assert.equal(reviewerOf(exit.result), 'REVIEWER=claude reason=error:CODEX_EXIT');
});
test('REVIEWER 結論寫進 <out-dir>/reviewer.json 與主 checkout 的 .scratch/review-log.jsonl；參數錯誤不印 REVIEWER 也不記', t => {
  const ok = review(t);
  const okEntry = JSON.parse(readFileSync(join(ok.out, 'reviewer.json'), 'utf8'));
  assert.equal(okEntry.reviewer, 'codex'); assert.equal(okEntry.model, 'gpt-6.2-sol'); assert.equal(okEntry.branch, 'main');
  assert.deepEqual(readFileSync(join(ok.repo, '.scratch', 'review-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).reviewer), ['codex']);
  const out = review(t, { login: 'fail' });
  const entry = JSON.parse(readFileSync(join(out.repo, '.scratch', 'review-log.jsonl'), 'utf8').trim());
  assert.equal(entry.reviewer, 'claude'); assert.equal(entry.reason, 'not-logged-in'); assert.equal(entry.error, 'CODEX_NOT_LOGGED_IN');
  const bad = review(t, { specContent: null });
  assert.equal(error(bad.result), 'SPEC_MISSING'); assert.equal(bad.result.stdout, '');
  assert.equal(existsSync(join(bad.repo, '.scratch', 'review-log.jsonl')), false);
});
test('用量上限字句（直撇號或彎撇號 ’）也判額度不足：REVIEWER=claude reason=quota', t => {
  for (const apostrophe of ["'", '’']) {
    const hit = review(t, { log: header() + `ERROR: You${apostrophe}ve hit your usage limit. Try again later.\n`, exit: 1 });
    assert.match(reviewerOf(hit.result), /^REVIEWER=claude reason=quota quotaKind=unknown resetAt=\S+$/); assert.equal(error(hit.result), 'CODEX_NO_CREDITS');
  }
});

// CoS item 67：NO_CREDITS 時分清 5h／weekly／credits／unknown 並記 resetAt；重置前改用 Claude，時間到自動改回 Codex。
// rollout 只取這次呼叫的那份：codex.log 開頭 `session id: 01a1` 對應檔名結尾 -01a1.jsonl。primary／secondary 的形狀取自 2026-11 真實 rollout
// （limit_id codex、primary window 300、secondary window 10080）。
const QUOTA_LOG = header() + 'ERROR: You’ve hit your usage limit. Try again later.\n';
const window = (used, minutes, resets) => ({ used_percent: used, window_minutes: minutes, resets_at: resets });
const FIVE_HOUR_HIT = { limit_id: 'codex', primary: window(100.0, 300, 1795686819), secondary: window(16.0, 10080, 1796273619), credits: { has_credits: false }, rate_limit_reached_type: null };
const WEEKLY_HIT = { limit_id: 'codex', primary: window(40.0, 300, 1795686819), secondary: window(100.0, 10080, 1796273619), credits: { has_credits: false }, rate_limit_reached_type: null };
function sessionHome(t, sessions) {
  const home = mkdtempSync(join(realTmpdir(), 'codex-session-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  sessions.forEach(([id, limits, mtime], index) => {
    const dir = join(home, 'sessions', '2026', '11', String(20 + index)); mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-11-${20 + index}T00-00-00-${id}.jsonl`);
    const records = (Array.isArray(limits) ? limits : [limits]).map(rate_limits => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits } }));
    writeFileSync(file, [JSON.stringify({ type: 'session_meta', payload: { id } }), ...records].join('\n') + '\n');
    utimesSync(file, mtime, mtime);
  });
  return home;
}
const FIVE_RESET = new Date(1795686819e3).toISOString(); const WEEK_RESET = new Date(1796273619e3).toISOString();
const hitFor = (t, sessions, log = QUOTA_LOG) => {
  const hit = review(t, { log, exit: 1, codexHome: sessionHome(t, sessions) });
  const json = JSON.parse(hit.result.stderr.trim()); assert.equal(json.error, 'CODEX_NO_CREDITS');
  return { ...hit, json, entry: JSON.parse(readFileSync(join(hit.out, 'reviewer.json'), 'utf8')) };
};
test('5h 額度：從這次呼叫的 rollout 解析 quotaKind=5h、resetAt 取 primary，寫進 stdout、reviewer.json 與 review-log', t => {
  const { result, entry, repo } = hitFor(t, [['01a1', FIVE_HOUR_HIT, 1000]]);
  assert.equal(reviewerOf(result), `REVIEWER=claude reason=quota quotaKind=5h resetAt=${FIVE_RESET}`);
  assert.equal(entry.quotaKind, '5h'); assert.equal(entry.resetAt, FIVE_RESET); assert.equal(entry.resetAtSource, 'parsed');
  const logged = JSON.parse(readFileSync(join(repo, '.scratch', 'review-log.jsonl'), 'utf8').trim());
  assert.equal(logged.quotaKind, '5h'); assert.equal(logged.resetAt, FIVE_RESET);
});
test('weekly 額度：quotaKind=weekly、resetAt 取 secondary', t => {
  const { result, entry } = hitFor(t, [['01a1', WEEKLY_HIT, 1000]]);
  assert.equal(reviewerOf(result), `REVIEWER=claude reason=quota quotaKind=weekly resetAt=${WEEK_RESET}`);
  assert.equal(entry.resetAtSource, 'parsed');
});
test('credits 類（11-25 真實形狀：primary／secondary 皆 null、workspace_member_credits_depleted）：quotaKind=credits，resetAt 以撞到時間＋5 小時估計', t => {
  const { entry } = hitFor(t, [['01a1', REAL_DEPLETED_ROLLOUT[0].payload.rate_limits, 1000]]);
  assert.equal(entry.quotaKind, 'credits'); assert.equal(entry.resetAtSource, 'estimated');
  assert.equal(Date.parse(entry.resetAt) - Date.parse(entry.ts) <= 5 * 3600e3 && Date.parse(entry.resetAt) - Date.parse(entry.ts) > 5 * 3600e3 - 60e3, true);
});
test('解析不到（沒有這次的 rollout、訊息沒寫種類與時間）：quotaKind=unknown，resetAt＝撞到時間＋5 小時（estimated）', t => {
  const { entry } = hitFor(t, []);
  assert.equal(entry.quotaKind, 'unknown'); assert.equal(entry.resetAtSource, 'estimated');
  const gap = Date.parse(entry.resetAt) - Date.parse(entry.ts);
  assert.ok(gap <= 5 * 3600e3 && gap > 5 * 3600e3 - 60e3, String(gap));
});
test('兩筆 rollout 不拼湊：別的 session 的 rollout 即使較新且 5h 用完，也不拿來判定這次的種類與 resetAt', t => {
  const { entry } = hitFor(t, [['01a1', DEPLETED, 1000], ['ffff', FIVE_HOUR_HIT, 2000]]);
  assert.equal(entry.quotaKind, 'credits'); assert.equal(entry.resetAtSource, 'estimated');
  const other = hitFor(t, [['01a1', WEEKLY, 1000], ['ffff', FIVE_HOUR_HIT, 2000]]).entry;
  assert.equal(other.quotaKind, 'unknown'); assert.notEqual(other.resetAt, FIVE_RESET);
});
test('錯誤訊息也能解析種類與重置時間：weekly／5-hour 字樣、try again at <時間>、try again in <時長>', t => {
  const at = hitFor(t, [], header() + 'ERROR: You’ve hit your usage limit. Weekly limit reached; upgrade to Pro, or try again at Dec 2nd, 2026 5:33 PM.\n').entry;
  assert.equal(at.quotaKind, 'weekly'); assert.equal(at.resetAtSource, 'parsed');
  assert.equal(at.resetAt, new Date(2026, 11, 2, 17, 33).toISOString());
  const inside = hitFor(t, [], header() + 'ERROR: You’ve hit your usage limit. 5-hour limit reached. Try again in 2 hours 30 minutes.\n').entry;
  assert.equal(inside.quotaKind, '5h'); assert.equal(inside.resetAtSource, 'parsed');
  const gap = Date.parse(inside.resetAt) - Date.parse(inside.ts);
  assert.ok(Math.abs(gap - 2.5 * 3600e3) < 60e3, String(gap));
});
const quotaEntry = (quotaKind, resetAt, extra = {}) => ({ ts: new Date().toISOString(), reviewer: 'claude', reason: 'quota', error: 'CODEX_NO_CREDITS', quotaKind, resetAt, resetAtSource: 'parsed', ...extra });
const inHours = hours => new Date(Date.now() + hours * 3600e3).toISOString();
test('等待中：最近一筆 quota 紀錄的 resetAt 還沒到，直接印 quota-wait 用 Claude，不呼叫 Codex', t => {
  for (const [kind, hours] of [['5h', 2], ['weekly', 72], ['unknown', 4], ['credits', 4]]) {
    const resetAt = inHours(hours);
    const { result, call, out } = review(t, { reviewLog: [quotaEntry(kind, resetAt)] });
    assert.equal(reviewerOf(result), `REVIEWER=claude reason=quota-wait quotaKind=${kind} resetAt=${resetAt}`);
    assert.equal(error(result), 'CODEX_QUOTA_WAIT'); assert.equal(call, null);
    assert.equal(JSON.parse(readFileSync(join(out, 'reviewer.json'), 'utf8')).reason, 'quota-wait');
  }
  // quota-wait 紀錄本身不算 Codex 成功：仍依前一筆 quota 紀錄等待。
  const resetAt = inHours(1);
  const chained = review(t, { reviewLog: [quotaEntry('5h', resetAt), { reviewer: 'claude', reason: 'quota-wait', quotaKind: '5h', resetAt }] });
  assert.equal(chained.call, null);
});
test('時間過了、超過上限、之後已有 Codex 成功或 resetAt 不明：照常先試 Codex', t => {
  for (const log of [
    [quotaEntry('5h', inHours(-0.1))],
    [quotaEntry('5h', inHours(6))],
    [quotaEntry('unknown', inHours(6))],
    [quotaEntry('weekly', inHours(24 * 8))],
    [quotaEntry('5h', inHours(2)), { ts: new Date().toISOString(), reviewer: 'codex', model: 'gpt-6.2-sol' }],
    [quotaEntry('5h', '?')],
    [quotaEntry('unknown', undefined)],
  ]) {
    const { result, call } = review(t, { reviewLog: log });
    assert.equal(result.status, 0, result.stderr); assert.notEqual(call, null);
    assert.equal(reviewerOf(result), 'REVIEWER=codex model=gpt-6.2-sol');
  }
});
test('重置時間前後的切換：撞到後下一次 quota-wait，resetAt 過了改回 Codex；--force-codex 與 CODEX_REVIEW_FORCE=1 略過等待', t => {
  const hit = hitFor(t, []).entry;
  assert.equal(review(t, { reviewLog: [hit] }).call, null);
  assert.notEqual(review(t, { reviewLog: [{ ...hit, resetAt: inHours(-0.01) }] }).call, null);
  const forced = review(t, { reviewLog: [hit], force: true });
  assert.equal(forced.result.status, 0, forced.result.stderr); assert.notEqual(forced.call, null);
  assert.notEqual(review(t, { reviewLog: [hit], env: { CODEX_REVIEW_FORCE: '1' } }).call, null);
});
