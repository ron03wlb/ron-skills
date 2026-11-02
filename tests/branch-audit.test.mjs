import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/branch-audit.mjs', import.meta.url).pathname;
const base = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};

function fixture(t, ghScript) {
  const temp = mkdtempSync(join(realTmpdir(), 'branch-audit-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo'), bin = join(temp, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), ghScript);
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...base, PATH: `${bin}:${base.PATH}` };
  const git = (...args) => assert.equal(spawnSync('git', ['-C', repo, ...args], { env }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a'), '0\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('branch', 'done-branch');
  git('checkout', '-qb', 'wip');
  writeFileSync(join(repo, 'a'), '1\n');
  git('commit', '-qam', 'wip');
  git('checkout', '-q', 'main');
  git('update-ref', 'refs/remotes/up/wip', 'wip');
  git('config', 'branch.wip.remote', 'up');
  git('config', 'branch.wip.merge', 'refs/heads/wip');
  git('config', 'remote.up.fetch', '+refs/heads/*:refs/remotes/up/*');
  git('config', 'remote.up.url', temp);
  const tree = join(temp, 'tree');
  git('worktree', 'add', '-q', '-b', 'in-tree', tree, 'main');
  writeFileSync(join(tree, 'untracked'), '');
  return { repo, run: () => spawnSync('node', [script], { cwd: repo, encoding: 'utf8', env }) };
}

const GH = `#!/bin/sh
echo '[{"number":5,"headRefName":"wip","state":"CLOSED"},{"number":9,"headRefName":"wip","state":"OPEN"}]'
`;

test('每個分支一行：併入與否、upstream、最新的 PR、worktree 乾淨與否', t => {
  const result = fixture(t, GH).run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').sort(), [
    'BRANCH done-branch merged no-upstream no-pr no-worktree',
    'BRANCH in-tree merged no-upstream no-pr worktree:dirty',
    'BRANCH main merged no-upstream no-pr worktree:clean',
    'BRANCH wip unmerged upstream pr#9:OPEN no-worktree',
  ]);
});

test('gh 失敗時 PR 欄印 pr-unknown，其他欄照印', t => {
  const result = fixture(t, '#!/bin/sh\nexit 1\n').run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^BRANCH wip unmerged upstream pr-unknown no-worktree$/m);
});
