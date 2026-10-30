import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

// pilot_git.py 正本不寫死某台機器的路徑（#93）：主 checkout 從 script 所在 repo 的 git common dir 推，
// worktree root 是 ~/orca/workspaces/<主 checkout 名稱>（WSL、macOS 的 Orca 都放這裡），兩者都可用環境變數覆寫；
// 白名單（主 checkout 只讀、寫入只到 root 下 prefix 開頭的 worktree、參數不得以 - 開頭、push 只推 prefix 分支）不變。
const TEMPLATE = new URL('../skills/engineering/issue-run/templates/pilot_git.py', import.meta.url);

function fixture(t) {
  const base = mkdtempSync(join(realTmpdir(), 'pilot-git-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const main = join(home, 'code', 'acme');
  const root = join(home, 'orca', 'workspaces', 'acme');
  mkdirSync(join(main, 'scripts'), { recursive: true });
  mkdirSync(root, { recursive: true });
  copyFileSync(TEMPLATE, join(main, 'scripts', 'pilot_git.py'));
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'base');
  const worktree = join(root, 'feature-ron-x');
  git(main, 'worktree', 'add', '-q', '-b', 'feature-ron-x', worktree);
  const run = (script, args, extra = {}) => {
    const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('PILOT_GIT_')));
    return spawnSync('python3', [script, ...args], { encoding: 'utf8', env: { ...clean, HOME: home, ...extra } });
  };
  return { base, home, main, root, worktree, run, sha: git(main, 'rev-parse', 'HEAD') };
}

test('沒有環境變數時從 script 所在 repo 偵測主 checkout，worktree root 是 ~/orca/workspaces/<名稱>', t => {
  const { main, worktree, run, sha } = fixture(t);
  for (const script of [join(main, 'scripts', 'pilot_git.py'), join(worktree, 'scripts', 'pilot_git.py')]) {
    const rev = run(script, ['rev', main, 'HEAD']);
    assert.equal(rev.status, 0, rev.stderr);
    assert.equal(rev.stdout.trim(), sha);
    const log = run(script, ['log', worktree, 'HEAD']);
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /base/);
  }
});

test('PILOT_GIT_MAIN_CHECKOUT、PILOT_GIT_WORKTREE_ROOT 覆寫偵測結果', t => {
  const { base, main, worktree, run } = fixture(t);
  const other = join(base, 'elsewhere', 'acme');
  const otherRoot = join(base, 'trees');
  mkdirSync(other, { recursive: true });
  mkdirSync(otherRoot, { recursive: true });
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'other');
  const otherTree = join(otherRoot, 'feature-ron-y');
  git(other, 'worktree', 'add', '-q', '-b', 'feature-ron-y', otherTree);
  const script = join(main, 'scripts', 'pilot_git.py');
  const vars = { PILOT_GIT_MAIN_CHECKOUT: other, PILOT_GIT_WORKTREE_ROOT: otherRoot };

  assert.equal(run(script, ['rev', other, 'HEAD'], vars).status, 0);
  assert.equal(run(script, ['log', otherTree, 'HEAD'], vars).status, 0);
  // 偵測到的路徑被覆寫後就不再放行。
  for (const target of [main, worktree]) {
    const refused = run(script, ['rev', target, 'HEAD'], vars);
    assert.equal(refused.status, 2, `${target} 應被拒絕`);
    assert.match(refused.stderr, /^拒絕：/);
  }
});

test('白名單照舊：主 checkout 只讀、寫入只到 root 下 prefix worktree、參數不得以 - 開頭、push 只推 prefix 分支', t => {
  const { base, main, root, worktree, run } = fixture(t);
  const script = join(main, 'scripts', 'pilot_git.py');
  const stray = join(base, 'feature-ron-z');
  const unprefixed = join(root, 'other');
  mkdirSync(stray);
  mkdirSync(unprefixed);
  const cases = [
    [['sync', main], /不能在主 checkout/],
    [['stage', main, 'a..b'], /不能在主 checkout/],
    [['push', main, 'feature-ron-x'], /不能在主 checkout/],
    [['sync', stray], /不是主 checkout/],
    [['sync', unprefixed], /不是主 checkout/],
    [['log', worktree, '--output=/tmp/x'], /參數不合法/],
    [['push', worktree, 'main'], /只能推 feature-ron-\* branch/],
    [['stage', worktree, 'HEAD'], /需要 <a>\.\.<b>/],
    [['rev', worktree], /用法錯誤/],
  ];
  for (const [args, reason] of cases) {
    const result = run(script, args);
    assert.equal(result.status, 2, `${args.join(' ')} 應 exit 2：${result.stderr}`);
    assert.match(result.stderr, reason, args.join(' '));
  }
});

test('script 不在 git repo 裡、又沒有 PILOT_GIT_MAIN_CHECKOUT 時拒絕，不猜路徑', t => {
  const { base, main, run } = fixture(t);
  const loose = join(base, 'loose');
  mkdirSync(loose);
  copyFileSync(join(main, 'scripts', 'pilot_git.py'), join(loose, 'pilot_git.py'));
  const result = run(join(loose, 'pilot_git.py'), ['rev', main, 'HEAD'], { GIT_CEILING_DIRECTORIES: base });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^拒絕：.*PILOT_GIT_MAIN_CHECKOUT/);
});
