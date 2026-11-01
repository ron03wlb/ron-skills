import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-pr-body.mjs', import.meta.url));
const checkout = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-pr-body-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  return dir;
};
const run = (dir, ...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8' });
const HEAD = '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n';
const batch = (dir, key, current, rows, regression = []) => writeFileSync(join(dir, `.scratch/pilot/batch-${key}.md`),
  `# batch ${key}\ncurrent: ${current}\nintegration: pilot/integration @ 1111111\n\n${HEAD}${rows.join('\n')}\n${regression.map(r => `regression: ${r}\n`).join('')}`);
const row = (n, branch, state, candidate = '') => `| ${n} | ${branch} | /w/${branch} | term_x | 2026-10-31T12:00:00+08:00 | 90m | ${state} | ${candidate} |`;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const SIGNATURE = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

/** 兩個 merged batch（其中一個是請求分支）、一個 staged、一個 dispatched、一個已 closed。 */
function fixture(t) {
  const dir = checkout(t);
  batch(dir, '7-42', `merged ${A}`, [row(7, 'issue/7-x', 'done', A), row(42, 'issue/42-y', 'done', A), row(50, 'issue/50-z', 'moved batch-50')],
    [`${C} exit 1`, `${A} exit 0 CHECK_PASS tests 1+2+3`]);
  batch(dir, 'req-12', `merged ${B} PR #9`, ['| - | retro/1031a | | | 2026-10-31T12:00:00+08:00 | | done | ' + B + ' |'], [`${B} exit 0 CHECK_PASS tests 4+5+6`]);
  batch(dir, '60', `staged ${C} onto 1111111`, [row(60, 'issue/60-s', 'done', C)], [`${C} exit 0`]);
  batch(dir, '61', 'dispatched 2026-10-31T12:00:00+08:00', [row(61, 'issue/61-d', 'running')]);
  batch(dir, '30', 'closed', [row(30, 'issue/30-c', 'done', C)], [`${C} exit 0`]);
  return dir;
}

test('merged batch 各一列（key、staged SHA、regression 行），只有 Issue 成員有 Closes；staged、未 merged 的不列', t => {
  const result = run(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    '## Batches',
    '',
    `- batch 7-42：staged ${A}，\`regression: ${A} exit 0 CHECK_PASS tests 1+2+3\``,
    `- batch req-12（retro/1031a）：staged ${B}，\`regression: ${B} exit 0 CHECK_PASS tests 4+5+6\``,
    '',
    'Closes #7',
    'Closes #42',
    '',
    SIGNATURE,
    '',
  ].join('\n'));
});

test('--out 把同一份 body 寫進檔案，stdout 只印 PR_BODY 摘要', t => {
  const dir = fixture(t);
  const file = join(dir, 'pr-body.md');
  const result = run(dir, '--out', file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `PR_BODY ${file} batches 2 closes 2\n`);
  assert.equal(readFileSync(file, 'utf8'), run(dir).stdout);
});

test('只有請求 batch：沒有 Closes 行，署名照樣在結尾', t => {
  const dir = checkout(t);
  batch(dir, 'req-3', `merged ${B}`, ['| - | retro/x | | | 2026-10-31T12:00:00+08:00 | | done | ' + B + ' |'], [`${B} exit 0`]);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `## Batches\n\n- batch req-3（retro/x）：staged ${B}，\`regression: ${B} exit 0\`\n\n${SIGNATURE}\n`);
});

test('沒有 merged batch：STOP no-merged-batch，exit 4', t => {
  const dir = checkout(t);
  batch(dir, '60', `staged ${C} onto 1111111`, [row(60, 'issue/60-s', 'done', C)], [`${C} exit 0`]);
  const result = run(dir);
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'STOP no-merged-batch\n');
});

test('merged batch 最後的 regression 不是它的 staged SHA exit 0：STOP regression <key>，exit 4，不寫檔', t => {
  for (const regression of [[], [`${A} exit 0`, `${A} exit 1`], [`${C} exit 0`]]) {
    const dir = checkout(t);
    batch(dir, '7', `merged ${A}`, [row(7, 'issue/7-x', 'done', A)], regression);
    const result = run(dir, '--out', join(dir, 'pr-body.md'));
    assert.equal(result.status, 4, regression.join(';'));
    assert.equal(result.stdout, 'STOP regression 7\n');
    assert.ok(!existsSync(join(dir, 'pr-body.md')));
  }
});

// #193：pilot-land.mjs sync-main 讓整合分支合入 origin/main 後，在 merged batch 追加 `regression: <sync sha> exit 0 sync-main …`，
// Probe 才認得新的 tip。PR body 要照樣認得 staged SHA 那一行，並把 sync-main 那一行一起列出，不能印 STOP regression。
test('最後幾行是 sync-main 的 regression：往前取 staged SHA 那一行驗，兩行都列出', t => {
  const dir = checkout(t);
  batch(dir, '7', `merged ${A}`, [row(7, 'issue/7-x', 'done', A)],
    [`${A} exit 0 CHECK_PASS tests 1+2+3`, `${C} exit 0 sync-main CHECK_PASS tests 4+5+6`, `${B} exit 0 sync-main CHECK_PASS tests 7+8+9`]);
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, `## Batches\n\n- batch 7：staged ${A}，\`regression: ${A} exit 0 CHECK_PASS tests 1+2+3\`，`
    + `\`regression: ${B} exit 0 sync-main CHECK_PASS tests 7+8+9\`\n\nCloses #7\n\n${SIGNATURE}\n`);
  // sync-main 行之前不是 staged SHA 的 exit 0，或 sync-main 行本身沒過：照樣 STOP。
  for (const regression of [[`${C} exit 0`, `${B} exit 0 sync-main`], [`${A} exit 0`, `${B} exit 1 sync-main`], [`${B} exit 0 sync-main`]]) {
    batch(dir, '7', `merged ${A}`, [row(7, 'issue/7-x', 'done', A)], regression);
    assert.equal(run(dir).stdout, 'STOP regression 7\n', regression.join(';'));
  }
});

test('用法錯誤：exit 2', t => {
  const dir = checkout(t);
  for (const args of [[], ['--out', 'x'], [dir, '--out'], [dir, 'extra'], [dir, '--out', 'a', 'b']]) {
    const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
  }
});

// #239：Push gate 在主 checkout 跑 main 上的舊版，它不認得 batch 193 的 regression 行，印 STOP regression 193。
// #275：為了避開它，每任 coordinator 都手算 `<stage worktree>` 路徑。主 checkout 的入口要自己轉到 stage worktree 的版本。
function entryRepo(t, branch) {
  const main = mkdtempSync(join(realTmpdir(), 'pilot-entry-'));
  const stage = `${main}-stage`;
  t.after(() => { rmSync(main, { recursive: true, force: true }); rmSync(stage, { recursive: true, force: true }); });
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const here = fileURLToPath(new URL('.', import.meta.url));
  mkdirSync(join(main, 'scripts/lib'), { recursive: true });
  for (const name of ['pilot-pr-body.mjs', 'pilot-land.mjs', 'lib/pilot-store.mjs']) copyFileSync(join(here, name), join(main, 'scripts', name));
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  if (branch) {
    git(main, 'worktree', 'add', '-q', '-b', branch, stage, 'main');
    // stage worktree 的版本：batch 改過的新版，只要跑到就看得出來。
    for (const name of ['pilot-pr-body.mjs', 'pilot-land.mjs']) writeFileSync(join(stage, 'scripts', name), 'console.log(`STAGE_VERSION ${process.argv.slice(2).join(" ")}`); process.exit(4);\n');
  }
  return { main, stage };
}
const entry = (main, script, ...args) => spawnSync('node', [join(main, 'scripts', script), ...args], { cwd: main, encoding: 'utf8' });

test('從主 checkout 跑 pilot-pr-body 與 pilot-land sync-main，改跑 stage worktree 的版本，參數與 exit code 都轉交', t => {
  for (const branch of ['pilot/integration', 'pilot/stage-193']) {
    const { main } = entryRepo(t, branch);
    const body = entry(main, 'pilot-pr-body.mjs', main, '--out', 'x.md');
    assert.equal(body.stdout, `STAGE_VERSION ${main} --out x.md\n`, branch);
    assert.equal(body.status, 4);
    const sync = entry(main, 'pilot-land.mjs', 'sync-main', '--check-command', 'true');
    assert.equal(sync.stdout, 'STAGE_VERSION sync-main --check-command true\n', branch);
    assert.equal(sync.status, 4);
  }
});

test('沒有 stage worktree 時照常跑本檔；pilot-land 的 batch 不轉交', t => {
  const bare = entryRepo(t);
  mkdirSync(join(bare.main, '.scratch/pilot'), { recursive: true });
  const body = entry(bare.main, 'pilot-pr-body.mjs', bare.main);
  assert.equal(body.stdout, 'STOP no-merged-batch\n');
  assert.equal(body.status, 4);
  const { main } = entryRepo(t, 'pilot/integration');
  assert.doesNotMatch(entry(main, 'pilot-land.mjs', 'nosuch').stdout, /STAGE_VERSION/);
});

test('stage worktree 的副本自己跑時不再轉交（不會無限遞迴）', t => {
  const { main, stage } = entryRepo(t, 'pilot/integration');
  mkdirSync(join(main, '.scratch/pilot'), { recursive: true });
  copyFileSync(join(main, 'scripts/pilot-pr-body.mjs'), join(stage, 'scripts/pilot-pr-body.mjs'));
  mkdirSync(join(stage, 'scripts/lib'), { recursive: true });
  const result = spawnSync('node', [join(stage, 'scripts/pilot-pr-body.mjs'), main], { cwd: main, encoding: 'utf8' });
  assert.equal(result.stdout, 'STOP no-merged-batch\n');
  // 主 checkout 的入口轉過去，結果相同。
  assert.equal(entry(main, 'pilot-pr-body.mjs', main).stdout, 'STOP no-merged-batch\n');
});
