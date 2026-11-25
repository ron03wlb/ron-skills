import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, write, env } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { mergeText } from '../scripts/merge-line-inserts.mjs';

// fixture 是真實衝突裁到衝突區塊的三方各列與當時手工合併的結果（#557）：
//   408-pilot-store       git cherry-pick 108161c（#408）到 d7bd159：PILOT-STORE.md 的 pilot-hold、pilot-probe 兩列，期望 2db5e1d
//   556-<檔>              base 425387e、ours 0974271、theirs 423648d（#556）：pilot-round.md、PILOT-STORE.md、PILOT-ROUND-TEMPLATE.md 各一列，期望 eb879be
const FIXTURE = (name, part) => readFileSync(new URL(`fixtures/merge-line-inserts/${name}/${part}.txt`, import.meta.url), 'utf8');

for (const name of ['408-pilot-store', '556-pilot-round', '556-PILOT-STORE', '556-PILOT-ROUND-TEMPLATE']) {
  test(`真實同列衝突 ${name}：自動合出和手工合併相同的列`, () => {
    const [base, ours, theirs, expect] = ['base', 'ours', 'theirs', 'expect'].map(part => FIXTURE(name, part));
    const result = mergeText(base, ours, theirs);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.text, expect);
  });
}

test('兩邊改到同一段：不合併，保留 diff3 衝突並回報 <<<<<<< 的行號', () => {
  const base = 'head\n| a | x one two three |\ntail\n';
  const result = mergeText(base, base.replace('one', 'ONE'), base.replace('one', 'uno'));
  assert.deepEqual(result.conflicts, [2]);
  assert.equal(result.text.split('\n')[1], '<<<<<<< ours');
  assert.ok(result.text.includes('||||||| base\n| a | x one two three |\n=======\n| a | x uno two three |\n>>>>>>> theirs\n'));
});

test('錨點不唯一：重複的片段裡插入，位置有兩種讀法，不合併', () => {
  const row = `| a | ${'step then wait, '.repeat(12)}done |`;
  const base = `head\n${row}\ntail\n`;
  const ours = base.replace('done', 'DONE');
  // theirs 在第六段之後插入 `check, `；前後各 8 個 token 的錨點在整列重複出現，插在哪一段讀不出來。
  const theirs = base.replace(row, row.replace(/((?:step then wait, ){6})/, '$1check, '));
  const result = mergeText(base, ours, theirs);
  assert.deepEqual(result.conflicts, [2]);
});

test('同一列兩邊各插一處、錨點唯一：合併，其他列不受影響', () => {
  const base = 'top\n| x | 甲、`B`、`C`、`D`、丁 |\n| y | 不動的一列 |\nend\n';
  const ours = base.replace('`B`、', '`B`、`B2`、');
  const theirs = base.replace('`D`、', '`D`、`D2`、').replace('不動的一列', '另一列改了');
  const result = mergeText(base, ours, theirs);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.text, 'top\n| x | 甲、`B`、`B2`、`C`、`D`、`D2`、丁 |\n| y | 另一列改了 |\nend\n');
});

const SCRIPT = fileURLToPath(new URL('../scripts/merge-line-inserts.mjs', import.meta.url));
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env });

/** base 提交後 theirs 分支改 doc.md（另改 clean.md），main 上改 doc.md 後 cherry-pick theirs 留下衝突；傳回 repo。 */
function cherryPicked(t, base, ours, theirs) {
  const repo = mkdtempSync(join(realTmpdir(), 'merge-line-inserts-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, { 'docs/doc.md': base, 'clean.md': 'x\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'switch', '-qc', 'theirs');
  write(repo, { 'docs/doc.md': theirs, 'clean.md': 'y\n' });
  git(repo, 'commit', '-qam', 'theirs');
  git(repo, 'switch', '-q', 'main');
  write(repo, { 'docs/doc.md': ours });
  git(repo, 'commit', '-qam', 'ours');
  const pick = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', '--no-commit', 'theirs'], { encoding: 'utf8', env });
  assert.equal(pick.status, 1, pick.stdout + pick.stderr);
  return repo;
}

test('CLI：cherry-pick 留下的同列衝突，從 index 三個 stage 合併寫回工作樹，印 MERGED，exit 0；不 git add', t => {
  const name = '556-pilot-round';
  const [base, ours, theirs, expect] = ['base', 'ours', 'theirs', 'expect'].map(part => FIXTURE(name, part));
  const repo = cherryPicked(t, `# 標題\n\n${base}\n尾\n`, `# 標題\n\n${ours}\n尾\n`, `# 標題\n\n${theirs}\n尾\n`);
  const result = run(join(repo, 'docs'), 'doc.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'MERGED doc.md 1\n');
  assert.equal(readFileSync(join(repo, 'docs/doc.md'), 'utf8'), `# 標題\n\n${expect}\n尾\n`);
  assert.match(git(repo, 'ls-files', '-u'), /docs\/doc\.md/, '仍未 git add');
  const again = run(repo, 'docs/doc.md', 'clean.md');
  assert.equal(again.status, 0);
  assert.equal(again.stdout, 'NO_CONFLICT docs/doc.md\nNO_CONFLICT clean.md\n', '已解過、沒衝突的檔都不動');
});

test('CLI：合不了的區塊保留衝突，印 LINE_CONFLICT <檔> <行>，exit 1', t => {
  const base = 'a\n| r | one two three |\nb\n';
  const repo = cherryPicked(t, base, base.replace('one', 'ONE'), base.replace('one', 'uno'));
  const result = run(repo, 'docs/doc.md');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, 'LINE_CONFLICT docs/doc.md 2\n');
  assert.equal(readFileSync(join(repo, 'docs/doc.md'), 'utf8').split('\n')[1], '<<<<<<< ours');
});

test('CLI：沒給檔、不在 git repo：exit 2', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'merge-line-inserts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run(dir).status, 2);
  assert.equal(run(dir, 'x.md').status, 2);
});

// 整檔版：本機 clone 有這些 commit 時直接拿原始三方整檔合併，和當時提交的檔逐位元比對；CI 的淺 clone 沒有就跳過（上面的裁切 fixture 照跑）。
const REPO = fileURLToPath(new URL('..', import.meta.url));
const show = (ref, path) => {
  const result = spawnSync('git', ['-C', REPO, 'show', `${ref}:${path}`], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
};
for (const [base, ours, theirs, expect, path] of [
  ['108161c^', 'd7bd159', '108161c', '2db5e1d', 'skills/engineering/issue-pilot/PILOT-STORE.md'],
  ['425387e', '0974271', '423648d', 'eb879be', 'docs/agents/pilot-round.md'],
  ['425387e', '0974271', '423648d', 'eb879be', 'skills/engineering/issue-pilot/PILOT-STORE.md'],
  ['425387e', '0974271', '423648d', 'eb879be', 'skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md'],
]) {
  test(`整檔：${path}（base ${base}、ours ${ours}、theirs ${theirs}）合出 ${expect} 的版本`, t => {
    const texts = [base, ours, theirs, expect].map(ref => show(ref, path));
    if (texts.includes(undefined)) return t.skip('本機沒有這些 commit（淺 clone）');
    const result = mergeText(...texts.slice(0, 3));
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.text, texts[3]);
  });
}

test('CRLF 檔：辨識衝突標記，照樣逐列合併，換行維持 CRLF（審查探測：曾印 MERGED 0 而把標記留在檔裡）', () => {
  const base = 'k\r\n| r | one two three four five six |\r\nz\r\n';
  const result = mergeText(base, base.replace('two', 'two-a'), base.replace('five', 'five-b'));
  assert.equal(result.blocks, 1);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.text, 'k\r\n| r | one two-a three four five-b six |\r\nz\r\n');
  const clash = mergeText(base, base.replace('one', 'ONE'), base.replace('one', 'uno'));
  assert.deepEqual(clash.conflicts, [2]);
  assert.match(clash.text, /^k\r\n<<<<<<< ours\r\n/);
});

test('檔尾沒有換行：合併結果也不補換行；三方檔尾換行不一致時不合併', () => {
  const base = 'k\nalpha beta gamma delta epsilon zeta eta';
  const result = mergeText(base, base.replace('alpha', 'ALPHA'), base.replace(/eta$/, 'ETA'));
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.text, 'k\nALPHA beta gamma delta epsilon zeta ETA');
  const mixed = mergeText(base, `${base.replace('alpha', 'ALPHA')}\n`, base.replace('beta', 'BETA'));
  assert.equal(mixed.conflicts.length, 1);
});
