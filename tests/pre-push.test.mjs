// .githooks/pre-push 擋直接更新遠端 main（#306-1）：spay2 的 session 曾 `cd ~/code/ron-skills; … git push origin main`，ca1a40a 沒有 PR 就進了 main。
// Claude hook 只在 ron-skills 這個 project 生效，別的 project 的 session 擋不到，所以用 git hook。fixture：本地 bare repo 當 origin，不碰 GitHub。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const hook = new URL('../.githooks/pre-push', import.meta.url).pathname;
// 本檔自己也會在 pre-commit hook 裡跑：先清掉繼承來的 GIT_*。
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function fixture(t, { withHook }) {
  const tmp = mkdtempSync(join(realTmpdir(), 'pre-push-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env });
  const origin = join(tmp, 'origin.git'), seed = join(tmp, 'seed'), clone = join(tmp, 'clone');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(seed, 'push', '-q', origin, 'main');
  git(tmp, 'clone', '-q', origin, clone);
  // 和 bin/sync-skills 建的一樣：hooks 目錄裡是指向 .githooks/pre-push 的 symlink。
  if (withHook) symlinkSync(hook, join(clone, '.git/hooks/pre-push'));
  const commit = message => {
    writeFileSync(join(clone, `${message}.txt`), message);
    git(clone, 'add', '.');
    return git(clone, 'commit', '-q', '-m', message);
  };
  return { origin, clone, git, commit };
}

const remoteHead = (git, origin, branch) => git(origin, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`).stdout.trim();

test('沒有 hook 時，在 clone 裡 commit 後 git push origin main 會成功（重現 ca1a40a）', t => {
  const { origin, clone, git, commit } = fixture(t, { withHook: false });
  commit('direct');
  const push = git(clone, 'push', 'origin', 'main');
  assert.equal(push.status, 0, push.stderr);
  assert.equal(remoteHead(git, origin, 'main'), git(clone, 'rev-parse', 'HEAD').stdout.trim());
});

test('有 hook 時 git push origin main 被拒，遠端 main 不變，訊息指向 land.mjs', t => {
  const { origin, clone, git, commit } = fixture(t, { withHook: true });
  const before = remoteHead(git, origin, 'main');
  commit('direct');
  const push = git(clone, 'push', 'origin', 'main');
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /^PUSH_MAIN_BLOCKED origin refs\/heads\/main：.*scripts\/land\.mjs/m);
  assert.equal(remoteHead(git, origin, 'main'), before);

  // 從別的分支以 HEAD:main 推、或刪除遠端 main，一樣擋。
  git(clone, 'switch', '-q', '-c', 'feature');
  assert.notEqual(git(clone, 'push', 'origin', 'HEAD:main').status, 0);
  const del = git(clone, 'push', 'origin', '--delete', 'main');
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /PUSH_MAIN_BLOCKED .*刪除/);
  assert.equal(remoteHead(git, origin, 'main'), before);
});

test('有 hook 時 push 其他分支、刪除其他分支照常成功', t => {
  const { origin, clone, git, commit } = fixture(t, { withHook: true });
  git(clone, 'switch', '-q', '-c', 'retro/x');
  commit('branch');
  const push = git(clone, 'push', '-u', 'origin', 'retro/x');
  assert.equal(push.status, 0, push.stderr);
  assert.equal(remoteHead(git, origin, 'retro/x'), git(clone, 'rev-parse', 'HEAD').stdout.trim());
  const del = git(clone, 'push', 'origin', '--delete', 'retro/x');
  assert.equal(del.status, 0, del.stderr);
  assert.equal(remoteHead(git, origin, 'retro/x'), '');
});
