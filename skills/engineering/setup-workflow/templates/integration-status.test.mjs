import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./integration-status.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const commit = (cwd, file, message) => { writeFileSync(join(cwd, file), message); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', message); };
const status = (cwd, ...iids) => {
  const result = spawnSync('node', [SCRIPT, ...iids], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

/** 主 worktree 在整合分支 integration：#7 已合入並推送，#8 只合入本機，#9 分支未合入。 */
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'integration-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'); const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', '-b', 'integration', main);
  commit(main, 'a.txt', 'base');
  git(main, 'remote', 'add', 'origin', origin);
  for (const iid of [7, 8, 9]) {
    git(main, 'checkout', '-q', '-b', `user/issue-${iid}`, 'integration');
    commit(main, `${iid}.txt`, `feat: #${iid}`);
    git(main, 'checkout', '-q', 'integration');
    if (iid === 9) continue;
    git(main, 'merge', '-q', '--no-ff', '-m', `merge: 整合 #${iid}`, `user/issue-${iid}`);
    if (iid === 7) git(main, 'push', '-q', '-u', 'origin', 'integration');
  }
  return { root, main, origin };
};

test('區分已推送、只合入本機、未合入；#7 不配 #70', t => {
  const f = fixture(t);
  const result = status(f.main, '7', '8', '9', '70');
  assert.equal(result.integration, 'integration');
  assert.equal(result.remote.ahead, 2); assert.equal(result.remote.behind, 0);
  const [i7, i8, i9, i70] = result.issues;
  assert.deepEqual([i7.mergedLocal, i7.pushed], [true, true]);
  assert.deepEqual([i8.mergedLocal, i8.pushed], [true, false]);
  assert.deepEqual([i9.mergedLocal, i9.pushed, i9.commits.length], [false, false, 0]);
  assert.equal(i9.branches[0].branch, 'user/issue-9');
  assert.deepEqual([i70.mergedLocal, i70.commits.length, i70.branches.length], [false, 0, 0]);
});

test('分支刪除後仍以 first-parent 合入紀錄判定；從其他 worktree 執行也以主 worktree 分支為整合分支', t => {
  const f = fixture(t);
  git(f.main, 'branch', '-q', '-D', 'user/issue-7');
  const other = join(f.root, 'wt9'); git(f.main, 'worktree', 'add', '-q', other, 'user/issue-9');
  const [i7] = status(other, '7').issues;
  assert.deepEqual([i7.mergedLocal, i7.pushed, i7.branches.length], [true, true, 0]);
});

test('remote 已前進但本機缺物件：inRemote 為 null，提示先 fetch', t => {
  const f = fixture(t);
  const clone = join(f.root, 'clone'); git(f.root, 'clone', '-q', '-b', 'integration', f.origin, clone);
  commit(clone, 'z.txt', 'remote only'); git(clone, 'push', '-q', 'origin', 'integration');
  const result = status(f.main, '7');
  assert.equal(result.remote.objectPresent, false); assert.equal(result.remote.ahead, null);
  assert.equal(result.issues[0].commits[0].inRemote, null); assert.equal(result.issues[0].pushed, null);
});
