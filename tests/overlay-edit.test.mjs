import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { applyOverlay, upstreamDir } from './helpers/apply-overlay.mjs';

const root = new URL('..', import.meta.url).pathname;
// 被測腳本不能拿到這個 session 的 ORCA_CLI_COMMAND，也不能繼承 pre-commit 匯出的 GIT_*（#25）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'ORCA_CLI_COMMAND'));

/**
 * 暫存的 repo 複本：只帶 overlay-edit 需要的檔，--write 才不會改到真的 overlays/。
 * 做成 git repo：預設編輯目錄 .scratch/overlay-edit/<name> 在 repo 底下，git apply 會以 repo 根目錄解讀路徑而略過 SKILL.md。
 */
function fixture(t) {
  const dir = mkdtempSync(join(realTmpdir(), 'overlay-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['scripts/overlay-edit.mjs', 'scripts/sync-skills.mjs', 'matt-skills.txt', 'pstack-skills.txt', 'overlays']) {
    cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  spawnSync('git', ['init', '-q', dir], { env });
  return dir;
}
const edit = (repo, ...args) => spawnSync('node', [join(repo, 'scripts/overlay-edit.mjs'), ...args], { cwd: repo, encoding: 'utf8', env });

/** 在 t 底下以 repo 複本的補丁套用上游，回傳 SKILL.md。 */
const appliedWith = (t, repo, name) => {
  const tmp = mkdtempSync(join(realTmpdir(), 'overlay-edit-apply-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  cpSync(upstreamDir(name), tmp, { recursive: true });
  const result = spawnSync('git', ['apply', join(repo, 'overlays', `${name}.patch`)], { cwd: tmp, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(join(tmp, 'SKILL.md'), 'utf8');
};

// #462-1：每次修 overlay 都手寫 `diff -u a b | sed …` 重產補丁。不改內容就 --write，套用結果要和原補丁一樣。
for (const name of ['code-review', 'poteto-mode']) {
  test(`${name}：開編輯目錄後不改內容就 --write，補丁套用結果和原本相同`, t => {
    const repo = fixture(t);
    const opened = edit(repo, name);
    assert.equal(opened.status, 0, opened.stderr);
    const dir = join(repo, '.scratch/overlay-edit', name);
    assert.equal(opened.stdout, `OVERLAY_EDIT ${dir}\n`);
    const before = applyOverlay(t, name);
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), before, '編輯目錄要是套上現有補丁後的內容');

    const written = edit(repo, name, '--write');
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, `OVERLAY_WRITTEN ${join(repo, 'overlays', `${name}.patch`)}\n`);
    const patch = readFileSync(join(repo, 'overlays', `${name}.patch`), 'utf8');
    assert.match(patch, /^diff --git a\/SKILL\.md b\/SKILL\.md\n(index \S+ \d+\n)?--- a\/SKILL\.md\n\+\+\+ b\/SKILL\.md\n/, '格式要和現有補丁一樣：a/、b/ 前綴，沒有暫存目錄路徑');
    assert.equal(appliedWith(t, repo, name), before);
  });
}

test('改了編輯目錄再 --write：新補丁套用後就是編輯後的內容；編輯目錄已存在時不覆蓋，--reset 才重來', t => {
  const repo = fixture(t);
  const dir = join(realTmpdir(), `overlay-edit-dir-${process.pid}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(edit(repo, 'wizard', '--dir', dir).status, 0);
  const changed = `${readFileSync(join(dir, 'SKILL.md'), 'utf8')}\nAn added line.\n`;
  writeFileSync(join(dir, 'SKILL.md'), changed);

  const again = edit(repo, 'wizard', '--dir', dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^EXISTS /);
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), changed, '沒有 --reset 不能蓋掉改到一半的內容');

  assert.equal(edit(repo, 'wizard', '--write', '--dir', dir).status, 0);
  assert.match(readFileSync(join(repo, 'overlays/wizard.patch'), 'utf8'), /^\+An added line\.$/m);
  assert.equal(appliedWith(t, repo, 'wizard'), changed);

  assert.equal(edit(repo, 'wizard', '--reset', '--dir', dir).status, 0);
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), changed, '--reset 從上游重新套用剛寫入的補丁');
});

test('沒有 overlay 的上游 skill：編輯目錄就是上游原版；沒改就 --write 印 NO_CHANGES 不寫檔', t => {
  const repo = fixture(t);
  const name = readFileSync(join(root, 'matt-skills.txt'), 'utf8').split('\n').map(line => line.trim())
    .filter(line => line && !/^[#-]/.test(line)).map(line => line.split('/').pop())
    .find(candidate => !existsSync(join(root, 'overlays', `${candidate}.patch`)));
  assert.ok(name, 'matt-skills.txt 每個都有 overlay');
  assert.equal(edit(repo, name).status, 0);
  assert.equal(readFileSync(join(repo, '.scratch/overlay-edit', name, 'SKILL.md'), 'utf8'), readFileSync(join(upstreamDir(name), 'SKILL.md'), 'utf8'));
  const written = edit(repo, name, '--write');
  assert.equal(written.status, 1);
  assert.match(written.stderr, /^NO_CHANGES /);
  assert.equal(existsSync(join(repo, 'overlays', `${name}.patch`)), false);
});

test('清單沒有的名稱印 UNKNOWN_SKILL；缺名稱或未知旗標印用法 exit 2', t => {
  const repo = fixture(t);
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const unknown = edit(repo, 'no-such-skill');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^UNKNOWN_SKILL no-such-skill/);
  for (const args of [[], ['wizard', '--bogus'], ['wizard', '--write', '--reset']]) {
    const result = edit(repo, ...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^用法：node scripts\/overlay-edit\.mjs/);
  }
});
