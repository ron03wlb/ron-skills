// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// #194：/retro-collect 判斷 covered／衝突時，手寫迴圈對每個 worktree 跑 `git diff --name-only $(merge-base …)`，再 grep 改到 pilot.md 哪些條目（1031c、1031d 各寫一次）。
// worktree-overlap.mjs 對每個非主 checkout 的 worktree，列出相對主分支 merge-base 的未合入改動（已 commit 與工作樹）碰到的檔與條目。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { git, run as runIn } from './test/repo-fixture.mjs';

const script = fileURLToPath(new URL('./worktree-overlap.mjs', import.meta.url));
const pilotMd = '# Pilot\n\n段落。\n\n- **Probe.** 每一輪對帳。\n- **Dispatch.** 派工。\n- **Handoff.** 交接。\n';
const PILOT = 'docs/agents/pilot.md';

/**
 * 主 checkout 在 main；worktree `a`（issue/1-a）commit 改了 pilot.md 的 **Probe.** 條目與 README.md（條目以外），
 * worktree `b`（issue/2-b）工作樹有未追蹤的 scripts/x.mjs、未 commit 的 scripts/y.mjs 改動。之後 main 自己改了 **Handoff.**，
 * 主 checkout 也有未追蹤檔：這兩處都不是 worktree 的未合入改動，不該列出。
 */
function fixture(t) {
  const root = mkdtempSync(join(realTmpdir(), 'worktree-overlap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  mkdirSync(join(main, 'docs/agents'), { recursive: true });
  mkdirSync(join(main, 'scripts'));
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture');
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(main, PILOT), pilotMd);
  writeFileSync(join(main, 'README.md'), '# app\n');
  writeFileSync(join(main, 'scripts/y.mjs'), 'export const y = 1;\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  const a = join(root, 'a');
  const b = join(root, 'b');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/1-a', a, 'main');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/2-b', b, 'main');
  writeFileSync(join(a, PILOT), pilotMd.replace('- **Probe.** ', '- **Probe.** 改了。').replace(/^# .*/, '# 標題也改了'));
  writeFileSync(join(a, 'README.md'), '# app\n\n說明\n');
  git(a, 'commit', '-q', '-am', '#1');
  writeFileSync(join(b, 'scripts/x.mjs'), 'export const x = 1;\n');
  writeFileSync(join(b, 'scripts/y.mjs'), 'export const y = 2;\n');
  writeFileSync(join(main, PILOT), pilotMd.replace('- **Handoff.** ', '- **Handoff.** 主分支改了。'));
  git(main, 'commit', '-q', '-am', 'main moved');
  writeFileSync(join(main, 'scratch.txt'), 'x\n');
  return { main, a, b };
}

const run = (cwd, ...args) => runIn(cwd, ['node', script, ...args]);

test('帶兩個檔：已 commit 的條目改動與工作樹的未追蹤檔各印一行，pilot.md 那行附 Probe', t => {
  const { main } = fixture(t);
  const result = run(main, PILOT, 'scripts/x.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'OVERLAP_WT issue/1-a docs/agents/pilot.md **Probe.**',
    'OVERLAP_WT issue/2-b scripts/x.mjs',
  ]);
});

test('不帶檔案：列出每個非主 checkout worktree 的所有改動檔；.md 同時改了條目外的標題仍附條目，main 自己的改動不列', t => {
  const { main } = fixture(t);
  const result = run(main);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'OVERLAP_WT issue/1-a README.md',
    'OVERLAP_WT issue/1-a docs/agents/pilot.md **Probe.**',
    'OVERLAP_WT issue/2-b scripts/x.mjs',
    'OVERLAP_WT issue/2-b scripts/y.mjs',
  ]);
});

test('在 linked worktree 的子目錄執行也一樣：檔案以 repo 根為準，主 checkout 照樣不列', t => {
  const { b } = fixture(t);
  const result = run(join(b, 'scripts'), PILOT);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['OVERLAP_WT issue/1-a docs/agents/pilot.md **Probe.**']);
});

test('沒有命中時不輸出、exit 0；未知旗標 exit 2', t => {
  const { main } = fixture(t);
  const none = run(main, 'nothing.md');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');
  assert.equal(run(main, '--bogus').status, 2);
});

test('還沒有 commit 的 orphan worktree 略過，不擋住其他 worktree', t => {
  const { main } = fixture(t);
  git(main, 'worktree', 'add', '-q', '--orphan', '-b', 'orph', join(main, '..', 'o'));
  const result = run(main, 'scripts/x.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['OVERLAP_WT issue/2-b scripts/x.mjs']);
});

// #224：retro worktree 用 `$(git diff --name-only main HEAD)` 當清單，本機 main 已被別的 session 推進（#220），
// 清單多了 main 自己改的檔（24 檔，本次只改 14 檔），印出跟本次無關的 OVERLAP_WT。
// --mine 改取目前 worktree 自己從 merge-base 起改的檔（含未 commit、未追蹤），只比其他 worktree。
test('--mine：本機 main 在 merge-base 之後前進時，只拿自己改過的檔比對其他 worktree，自己不列', t => {
  const { main, a, b } = fixture(t);
  // main 在 a 的 merge-base 之後改了 y.mjs（b 的工作樹也改了它），b 另外改了 a 也改過的 README.md。
  writeFileSync(join(main, 'scripts/y.mjs'), 'export const y = 3;\n');
  git(main, 'commit', '-q', '-am', 'main moved y');
  writeFileSync(join(b, 'README.md'), '# app\n\nb 的說明\n');
  // a 自己還有一個未追蹤的 scripts/x.mjs：未 commit 的改動也算 a 的。
  writeFileSync(join(a, 'scripts/x.mjs'), 'export const x = 2;\n');

  // 重現原本的做法：清單混進 main 自己改的 y.mjs，多印一行 b 的無關重疊。
  const listed = git(a, 'diff', '--name-only', 'main', 'HEAD').trim().split('\n');
  assert.ok(listed.includes('scripts/y.mjs'), listed.join('\n'));
  assert.ok(run(a, ...listed).stdout.includes('OVERLAP_WT issue/2-b scripts/y.mjs'));

  const result = run(join(a, 'docs'), '--mine');
  assert.equal(result.status, 0, result.stderr);
  // --mine 的行尾多一個 hunk 欄位（retro spay2 e9234021#2）：兩邊都在 README.md 第 1 行後插入；x.mjs 兩邊都是未追蹤新檔，整檔算。
  // main 在 merge-base 後改了 pilot.md 的 Handoff（第 7 行），a 改了第 1、5 行：相距 2 行 → OVERLAP_MAIN near（retro spay2 31d564a6#1）。
  // near 再附 merge-tree 的結果（#376）：README.md 同處插入、x.mjs 兩邊新增不同內容 → conflict；pilot.md 中間隔了沒改的行 → clean。
  const handoff = git(main, 'log', '-1', '--format=%H', 'main', '--', PILOT).trim().slice(0, 7);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'OVERLAP_WT issue/2-b README.md hunks=near 1 merge=conflict',
    'OVERLAP_WT issue/2-b scripts/x.mjs hunks=near 1 merge=conflict',
    `OVERLAP_MAIN docs/agents/pilot.md ${handoff} hunks=near 5 merge=clean`,
  ]);
});

test('--mine：自己沒有改動時不輸出；和檔案參數一起給時 exit 2', t => {
  const { main, a } = fixture(t);
  const c = join(main, '..', 'c');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/3-c', c, 'main');
  const none = run(c, '--mine');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');
  assert.equal(run(a, '--mine', PILOT).status, 2);
});

// retro spay2 6d21b9cc#4：spay2 沒有 main 這條分支，整合分支是 `feature/ron/#24846`，每輪 collect 都手寫重疊檢查。
test('--main：沒有 main 分支的 repo 以整合分支當基準；不帶時 git merge-base 失敗，exit 1', t => {
  const { main, a } = fixture(t);
  git(main, 'branch', '-m', 'main', 'feature/ron/#24846');
  const result = run(a, '--main', 'feature/ron/#24846', '--mine');
  assert.equal(result.status, 0, result.stderr);
  // a 改的檔其他 worktree 都沒碰；只有整合分支自己在 merge-base 後改了 pilot.md。
  assert.match(result.stdout, /^OVERLAP_MAIN docs\/agents\/pilot\.md [0-9a-f]{7} hunks=near 5 merge=clean\n$/);
  const listed = run(main, '--main', 'feature/ron/#24846', 'scripts/x.mjs');
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n'), ['OVERLAP_WT issue/2-b scripts/x.mjs']);
  assert.equal(run(main, 'scripts/x.mjs').status, 1);
});

// 這支要能複製到沒有 pilot-probe.mjs 的 repo，所以只靠 lib/changed-units.mjs 與 lib/merge-tree.mjs。
test('只帶自己與 lib/changed-units.mjs、lib/merge-tree.mjs 也能執行', t => {
  const { main } = fixture(t);
  const copy = join(main, '..', 'copy');
  mkdirSync(join(copy, 'lib'), { recursive: true });
  for (const name of ['worktree-overlap.mjs', 'lib/changed-units.mjs', 'lib/merge-tree.mjs']) copyFileSync(new URL(`./${name}`, import.meta.url), join(copy, name));
  const result = runIn(main, ['node', join(copy, 'worktree-overlap.mjs'), 'scripts/x.mjs']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['OVERLAP_WT issue/2-b scripts/x.mjs']);
});

// retro spay2 0cd3fdeb#1：計畫把範本副本 scripts/run-codex-review.mjs 派給子代理直接改，overlap 沒有提示它是副本，
// 到 check-contracts --static 的 TEMPLATE_COPY_MISMATCH 才發現。
test('TEMPLATE_COPY：給的檔是 workflow-templates.json 列出的副本時，在 OVERLAP_WT 之前依輸入順序各印一行，exit 0', t => {
  const { main, b } = fixture(t);
  const template = 'skills/engineering/setup-workflow/templates/run-codex-review.mjs';
  const manifest = { source: 'ron03wlb/ron-skills', copies: {
    'scripts/run-codex-review.mjs': { template, commit: '0'.repeat(40), sha256: '0'.repeat(64) },
    'scripts/x.mjs': { template: 'skills/engineering/setup-workflow/templates/x.mjs', commit: '0'.repeat(40), sha256: '0'.repeat(64) },
  } };
  writeFileSync(join(main, 'docs/agents/workflow-templates.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = run(main, 'scripts/run-codex-review.mjs', PILOT, 'scripts/x.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `TEMPLATE_COPY scripts/run-codex-review.mjs ${template}`,
    'TEMPLATE_COPY scripts/x.mjs skills/engineering/setup-workflow/templates/x.mjs',
    'OVERLAP_WT issue/1-a docs/agents/pilot.md **Probe.**',
    'OVERLAP_WT issue/2-b scripts/x.mjs',
  ]);
  // 不帶檔案時不印；清單看的是 cwd 所在 worktree，b 沒有這份清單。
  assert.doesNotMatch(run(main).stdout, /TEMPLATE_COPY/);
  assert.doesNotMatch(run(b, 'scripts/run-codex-review.mjs').stdout, /TEMPLATE_COPY/);
});

// retro spay2 e9234021#1：spay2 的 followups.mjs 頂層 import 本檔，batch-merge.test 以 `node --input-type=module -e` 載入時 argv[1] 是 undefined，
// 舊的 main guard `pathToFileURL(process.argv[1])` 丟 ERR_INVALID_ARG_TYPE，exit 1。
test('以 node --input-type=module -e import（argv[1] 為 undefined）時不執行 main、exit 0', t => {
  const { main } = fixture(t);
  const result = runIn(main, ['node', '--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); if (typeof m.worktreeOverlaps !== 'function') process.exit(3);`]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

// retro spay2 e9234021#2：落地前 `--mine` 只印檔名，協調者另跑 `git diff … | grep '^@@'` 才看出對方改 SKILL.md @@ -91、本方改 107 行，
// 對方改 spay4-verify.md @@ -250、本方改 57 行，都不相鄰；scripts/workflow-doc-sync.json 是產生檔，衝突時重跑產生器即可。
test('--mine：每行附 hunks=apart／hunks=near <本方行>，--generated 的檔標 generated；--near 調整距離', t => {
  const { main } = fixture(t);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  const edit = (dir, file, ...at) => {
    const copy = [...lines];
    for (const n of at) copy[n - 1] = `${copy[n - 1]} 改了`;
    writeFileSync(join(dir, file), `${copy.join('\n')}\n`);
  };
  for (const file of ['SKILL.md', 'verify.md', 'near.txt']) writeFileSync(join(main, file), `${lines.join('\n')}\n`);
  writeFileSync(join(main, 'scripts/workflow-doc-sync.json'), '{"a": 1}\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'long files');
  const mine = join(main, '..', 'mine');
  const other = join(main, '..', 'other');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/9-mine', mine, 'main');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/8-other', other, 'main');
  edit(other, 'SKILL.md', 91, 92, 93);
  edit(other, 'verify.md', 250);
  edit(other, 'near.txt', 40);
  writeFileSync(join(other, 'scripts/workflow-doc-sync.json'), '{"a": 2}\n');
  git(other, 'commit', '-q', '-am', 'other');
  edit(mine, 'SKILL.md', 107);
  edit(mine, 'verify.md', 57);
  edit(mine, 'near.txt', 44);
  writeFileSync(join(mine, 'scripts/workflow-doc-sync.json'), '{"a": 3}\n');

  const result = run(mine, '--mine', '--generated', 'scripts/*.json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'OVERLAP_WT issue/8-other SKILL.md hunks=apart',
    'OVERLAP_WT issue/8-other near.txt hunks=near 44 merge=clean',
    'OVERLAP_WT issue/8-other scripts/workflow-doc-sync.json generated',
    'OVERLAP_WT issue/8-other verify.md hunks=apart',
  ]);
  // 既有解析：行首仍是 OVERLAP_WT <分支> <檔案>。
  for (const line of result.stdout.trim().split('\n')) assert.match(line, /^OVERLAP_WT issue\/8-other \S+ /);
  // 不帶 --generated 時產生檔照樣比 hunk（同一行 → near 1）；--near 20 時 SKILL.md（相距 14 行）變 near。
  const wide = run(mine, '--mine', '--near', '20');
  assert.equal(wide.status, 0, wide.stderr);
  assert.ok(wide.stdout.includes('OVERLAP_WT issue/8-other SKILL.md hunks=near 107 merge=clean\n'), wide.stdout);
  assert.ok(wide.stdout.includes('OVERLAP_WT issue/8-other scripts/workflow-doc-sync.json hunks=near 1 merge=conflict\n'), wide.stdout);
  assert.ok(wide.stdout.includes('OVERLAP_WT issue/8-other verify.md hunks=apart\n'), wide.stdout);
  // 不帶 --mine 時不加欄位；--near／--generated 沒有 --mine 是用法錯誤。
  assert.equal(run(main, 'SKILL.md').stdout, 'OVERLAP_WT issue/9-mine SKILL.md\nOVERLAP_WT issue/8-other SKILL.md\n');
  assert.equal(run(main, '--near', '3').status, 2);
  assert.equal(run(main, '--generated', 'x').status, 2);
});

// #376（#324 第 4 項）：hunks=near 只說兩邊靠近，還要另跑 merge 才知道會不會衝突。near 行尾以 git merge-tree 的結果附 merge=clean|conflict；
// 本方未 commit 的改動（含未追蹤新檔）以 lib/merge-tree.mjs 的工作樹快照 commit 參與合併（工作樹乾淨時用 HEAD），對方同理。
test('--mine：hunks=near 行尾附 merge=conflict（兩邊改同一行）或 merge=clean（相近但不相接）；apart、generated 不附', t => {
  const { main } = fixture(t);
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  const edit = (dir, file, n) => writeFileSync(join(dir, file), `${lines.map((text, i) => (i === n - 1 ? `${text} ${dir}` : text)).join('\n')}\n`);
  for (const file of ['same.txt', 'close.txt', 'far.txt', 'gen.json']) writeFileSync(join(main, file), `${lines.join('\n')}\n`);
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'files');
  const mine = join(main, '..', 'mine');
  const other = join(main, '..', 'other');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/9-mine', mine, 'main');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/8-other', other, 'main');
  // 對方：same、gen 已 commit；close、far 留在工作樹（未 commit）。
  edit(other, 'same.txt', 20);
  edit(other, 'gen.json', 20);
  git(other, 'commit', '-q', '-am', 'other');
  edit(other, 'close.txt', 20);
  edit(other, 'far.txt', 5);
  // 本方：same 已 commit，其餘未 commit。
  edit(mine, 'same.txt', 20);
  git(mine, 'commit', '-q', '-am', 'mine');
  edit(mine, 'close.txt', 23);
  edit(mine, 'far.txt', 45);
  edit(mine, 'gen.json', 20);

  const result = run(mine, '--mine', '--generated', '*.json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'OVERLAP_WT issue/8-other close.txt hunks=near 23 merge=clean',
    'OVERLAP_WT issue/8-other far.txt hunks=apart',
    'OVERLAP_WT issue/8-other gen.json generated',
    'OVERLAP_WT issue/8-other same.txt hunks=near 20 merge=conflict',
  ]);
  // 唯讀：兩邊的 stash 清單與工作樹都沒變。
  for (const dir of [mine, other]) assert.equal(git(dir, 'stash', 'list'), '');
  assert.equal(git(other, 'status', '--short').trim(), 'M close.txt\n M far.txt');
});

// retro spay2 31d564a6#1（jsonl 1057–1125）：`--mine --main 'feature/ron/#24846'` 只印 OVERLAP_WT，整合分支 08:42 已合入改同檔的批次，
// coordinator 依輸出判斷可落地，fix-land 才 STOP merge-conflict。--mine 另比 merge-base..<主分支>，同一套 hunk 距離判斷。
test('--mine：主分支在 merge-base 後改了本方檔案的相鄰行時印 OVERLAP_MAIN … hunks=near，遠處印 apart，產生檔印 generated', t => {
  const { main } = fixture(t);
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const edit = (dir, file, n) => writeFileSync(join(dir, file), `${lines.map((text, i) => (i === n - 1 ? `${text} 改了` : text)).join('\n')}\n`);
  for (const file of ['status.mjs', 'far.md']) writeFileSync(join(main, file), `${lines.join('\n')}\n`);
  writeFileSync(join(main, 'scripts/sync.json'), '{"a": 1}\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'files');
  const mine = join(main, '..', 'mine');
  git(main, 'worktree', 'add', '-q', '-b', 'retro/mine', mine, 'main');
  edit(mine, 'status.mjs', 41);
  edit(mine, 'far.md', 10);
  writeFileSync(join(mine, 'scripts/sync.json'), '{"a": 2}\n');
  git(mine, 'commit', '-q', '-am', 'mine');
  edit(main, 'status.mjs', 40);
  edit(main, 'far.md', 90);
  writeFileSync(join(main, 'scripts/sync.json'), '{"a": 3}\n');
  git(main, 'commit', '-q', '-am', 'batch merged');
  const sha = git(main, 'rev-parse', 'HEAD').trim().slice(0, 7);
  const result = run(mine, '--mine', '--generated', 'scripts/*.json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `OVERLAP_MAIN far.md ${sha} hunks=apart`,
    `OVERLAP_MAIN scripts/sync.json ${sha} generated`,
    `OVERLAP_MAIN status.mjs ${sha} hunks=near 41 merge=conflict`,
  ]);
  // 主分支還在 merge-base（沒有新 commit）時不印。
  git(main, 'reset', '-q', '--hard', 'HEAD~1');
  assert.equal(run(mine, '--mine').stdout, '');
});

// #365（#336 第 2 項）：investing 的 develop 領先 main 263 個 commit，`--mine` 不帶 --main 時每個改動檔都對約 20 個 worktree
// 算 hunk，300 秒跑不完（帶 `--main develop` 只要 0.09 秒）。
/**
 * main 只有一個 commit；develop 以 fast-import 疊了 300 個 commit，第 i 個改 develop/<i % files>.txt（預設 files 300，各加一個檔）；worktree `feat`（issue/9-feat）從 develop 開，
 * 自己改了 develop/0.txt；另一個 worktree `other`（issue/8-other）從 develop 開、也改了 develop/0.txt。
 */
function behindFixture(t, { files = 300 } = {}) {
  const root = mkdtempSync(join(realTmpdir(), 'worktree-overlap-behind-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture');
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(main, 'README.md'), '# app\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  const commits = 300;
  let stream = '';
  for (let i = 0; i < commits; i++) {
    const body = `line ${i % files}\n${i}\n`;
    const message = `c${i}`;
    stream += `commit refs/heads/develop\ncommitter Fixture <fixture@example.invalid> ${1700000000 + i} +0000\ndata ${message.length}\n${message}\n`;
    if (i === 0) stream += 'from refs/heads/main\n';
    stream += `M 100644 inline develop/${i % files}.txt\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  }
  const imported = runIn(main, ['git', 'fast-import', '--quiet'], { input: stream });
  assert.equal(imported.status, 0, imported.stderr);
  const feat = join(root, 'feat');
  const other = join(root, 'other');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/9-feat', feat, 'develop');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/8-other', other, 'develop');
  writeFileSync(join(feat, 'develop/0.txt'), 'feat\n');
  git(feat, 'commit', '-q', '-am', '#9');
  writeFileSync(join(other, 'develop/0.txt'), 'other\n');
  return { main, feat, other, commits };
}

test('--mine 不帶 --main、改動檔數超過上限：比對 worktree 前印 OVERLAP_BASE_BEHIND <main> <N> --main <建議分支>，exit 3', t => {
  const { feat, commits } = behindFixture(t);
  const result = run(feat, '--mine');
  assert.equal(result.status, 3, result.stderr);
  // N 是 merge-base(HEAD, main)..HEAD 的 commit 數：develop 的 300 個加 feat 自己的 1 個；只印這一行，沒有算任何 hunk。
  assert.equal(result.stdout, `OVERLAP_BASE_BEHIND main ${commits + 1} --main develop\n`);
});

test('同一 repo 帶 --main <整合分支> 照常輸出；--max-files 不帶 --mine 是用法錯誤', t => {
  const { feat } = behindFixture(t);
  const explicit = run(feat, '--mine', '--main', 'develop');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, 'OVERLAP_WT issue/8-other develop/0.txt hunks=near 1 merge=conflict\n');
  // 帶了 --main 就不檢查，上限設 0 也照常比對。
  assert.equal(run(feat, '--mine', '--main', 'develop', '--max-files', '0').stdout, explicit.stdout);
  assert.equal(run(feat, '--max-files', '10').status, 2);
});

test('落後 300 個 commit 但改動檔數在上限內：不觸發，照常比對；--max-files 調低到檔數以下才觸發', t => {
  const { feat, commits } = behindFixture(t, { files: 5 });
  const within = run(feat, '--mine');
  assert.equal(within.status, 0, within.stderr);
  // 基準是 main 時 other 的改動也是 develop/0～4.txt 這 5 個檔，都和 feat 的改動重疊。
  assert.deepEqual(within.stdout.trim().split('\n').map(line => line.split(' ').slice(0, 3).join(' ')),
    [0, 1, 2, 3, 4].map(i => `OVERLAP_WT issue/8-other develop/${i}.txt`));
  const lowered = run(feat, '--mine', '--max-files', '4');
  assert.equal(lowered.status, 3, lowered.stderr);
  assert.equal(lowered.stdout, `OVERLAP_BASE_BEHIND main ${commits + 1} --main develop\n`);
});

test('沒有比 main 更近的分支時建議欄印 -', t => {
  const { main, feat } = behindFixture(t);
  git(main, 'branch', '-D', 'develop');
  const result = run(feat, '--mine', '--max-files', '10');
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, 'OVERLAP_BASE_BEHIND main 301 --main -\n');
});

test('建議分支：已含 HEAD 的分支（如合入了本方的 stage 分支）不建議；沒有本機 develop 時建議 remote-tracking 的 origin/develop', t => {
  const { main, feat, commits } = behindFixture(t);
  // pilot/stage-9 含 feat 的 HEAD：merge-base 就是 HEAD，拿它當基準本方 commit 會整個消失。
  git(main, 'branch', 'pilot/stage-9', 'issue/9-feat');
  const develop = git(main, 'rev-parse', 'develop');
  git(main, 'update-ref', 'refs/remotes/origin/develop', develop);
  git(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const both = run(feat, '--mine');
  assert.equal(both.status, 3, both.stderr);
  assert.equal(both.stdout, `OVERLAP_BASE_BEHIND main ${commits + 1} --main develop\n`);
  git(main, 'branch', '-D', 'develop');
  const remote = run(feat, '--mine');
  assert.equal(remote.status, 3, remote.stderr);
  assert.equal(remote.stdout, `OVERLAP_BASE_BEHIND main ${commits + 1} --main origin/develop\n`);
});

test('建議分支：自己與其他 worktree 分支的 remote-tracking 分身（origin/issue/…）也不建議', t => {
  const { main, feat, other, commits } = behindFixture(t);
  // feat 推過一次後又多了 2 個 commit：origin/issue/9-feat 離 HEAD 只有 2 個 commit，比 develop 的 3 個近，但拿它當基準會藏掉本方改動。
  git(main, 'update-ref', 'refs/remotes/origin/issue/9-feat', git(feat, 'rev-parse', 'HEAD'));
  for (const n of [1, 2]) {
    writeFileSync(join(feat, `develop/${n}.txt`), `feat ${n}\n`);
    git(feat, 'commit', '-q', '-am', `#9 ${n}`);
  }
  git(other, 'commit', '-q', '-am', '#8');
  git(main, 'update-ref', 'refs/remotes/origin/issue/8-other', git(other, 'rev-parse', 'HEAD'));
  const result = run(feat, '--mine');
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, `OVERLAP_BASE_BEHIND main ${commits + 3} --main develop\n`);
});

// #413 第 6 項（investing#505）：retro 計畫把 #499 兩項記成 adopted，其實候選寫下之後 875275d4 已落地；只看其他 worktree 看不到主分支動過的檔。
// --since <ISO>：主分支第一父線上該時間之後改到給的檔的 commit 各印 LANDED_SINCE；以落地（合併）時間算，側分支 commit 較早也算。
test('--since <ISO>：主分支在該時間後落地、改到給的檔的 commit 各印 LANDED_SINCE <檔> <commit7> <subject>，排在 OVERLAP_WT 之前', t => {
  const { main } = fixture(t);
  const at = (date, ...args) => {
    const result = runIn(main, ['git', ...args], { env: { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
    assert.equal(result.status, 0, result.stderr);
  };
  writeFileSync(join(main, 'README.md'), '# app\n\n舊\n');
  at('2026-11-01T00:00:00Z', 'commit', '-q', '-am', 'old readme');
  git(main, 'switch', '-q', '-c', 'retro/x');
  writeFileSync(join(main, 'README.md'), '# app\n\n新\n');
  at('2026-11-02T00:00:00Z', 'commit', '-q', '-am', 'retro x readme');
  git(main, 'switch', '-q', 'main');
  at('2026-11-10T00:00:00Z', 'merge', '-q', '--no-ff', '-m', 'Merge retro/x', 'retro/x');
  const merge = git(main, 'rev-parse', 'HEAD').slice(0, 7);
  const result = run(main, '--since', '2026-11-05T00:00:00Z', 'README.md', 'scripts/x.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `LANDED_SINCE README.md ${merge} Merge retro/x`,
    'OVERLAP_WT issue/1-a README.md',
    'OVERLAP_WT issue/2-b scripts/x.mjs',
  ]);
  const later = run(main, '--since', '2026-11-11T00:00:00Z', 'README.md');
  assert.equal(later.status, 0, later.stderr);
  assert.deepEqual(later.stdout.trim().split('\n'), ['OVERLAP_WT issue/1-a README.md']);
});

test('--since：沒給檔案、和 --mine 併用、時間解析不了時是用法錯誤（exit 2）', t => {
  const { main } = fixture(t);
  assert.equal(run(main, '--since', '2026-11-05T00:00:00Z').status, 2);
  assert.equal(run(main, '--mine', '--since', '2026-11-05T00:00:00Z').status, 2);
  assert.equal(run(main, '--since', 'yesterday-ish', 'README.md').status, 2);
  assert.equal(run(main, '--since').status, 2);
});
