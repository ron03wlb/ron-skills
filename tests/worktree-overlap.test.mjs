// #194：/retro-collect 判斷 covered／衝突時，手寫迴圈對每個 worktree 跑 `git diff --name-only $(merge-base …)`，再 grep 改到 pilot.md 哪些條目（1031c、1031d 各寫一次）。
// worktree-overlap.mjs 對每個非主 checkout 的 worktree，列出相對主分支 merge-base 的未合入改動（已 commit 與工作樹）碰到的檔與條目。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/worktree-overlap.mjs', import.meta.url).pathname;
const pilotMd = readFileSync(new URL('../docs/agents/pilot.md', import.meta.url), 'utf8');
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
  writeFileSync(join(main, PILOT), pilotMd);
  writeFileSync(join(main, 'README.md'), '# app\n');
  writeFileSync(join(main, 'scripts/y.mjs'), 'export const y = 1;\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  const a = join(root, 'a');
  const b = join(root, 'b');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/1-a', a, 'main');
  git(main, 'worktree', 'add', '-q', '-b', 'issue/2-b', b, 'main');
  // fixture 用本 repo 真正的 pilot.md；條目改名時 replace 不會報錯，先確認兩個條目都在。
  for (const entry of ['- **Probe.** ', '- **Handoff.** ']) assert.ok(pilotMd.includes(entry), `pilot.md 沒有 ${entry}`);
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

const run = (cwd, ...args) => spawnSync('node', [script, ...args], { cwd, encoding: 'utf8', env });

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
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'OVERLAP_WT issue/2-b README.md',
    'OVERLAP_WT issue/2-b scripts/x.mjs',
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
