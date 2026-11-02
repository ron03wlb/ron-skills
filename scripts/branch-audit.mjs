#!/usr/bin/env node
// 唯讀：一次看完本機分支與 worktree 的狀態，回答「這些有沒有併到 main、留著要做什麼」（#287：用了四輪臨時 Bash；沒有 upstream 也沒有 PR 的分支放了三天）。不刪任何東西。
// 用法：node scripts/branch-audit.mjs [--main <分支>]（預設 main，有 origin/<分支> 就以它為準）
// stdout：每個本機分支一行 `BRANCH <名稱> <merged|unmerged> <upstream|no-upstream> <pr#<n>:<STATE>|no-pr|pr-unknown> <worktree:clean|worktree:dirty|no-worktree>`。
// exit：0；1 不是 git repo；2 用法錯誤。gh 失敗時 PR 欄印 pr-unknown，其他欄照印。
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });

/** gh 的 PR：分支名 → 最新一張；gh 失敗時 null。 */
function pullRequests(cwd) {
  const result = spawnSync('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,headRefName,state'], { cwd, encoding: 'utf8', env });
  if (result.status !== 0) return null;
  const prs = new Map();
  for (const pr of JSON.parse(result.stdout)) if (!prs.has(pr.headRefName) || prs.get(pr.headRefName).number < pr.number) prs.set(pr.headRefName, pr);
  return prs;
}

/** `git worktree list --porcelain`：分支名 → 路徑。 */
function worktrees(cwd) {
  const out = new Map();
  let path;
  for (const line of git(cwd, 'worktree', 'list', '--porcelain').stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/')) out.set(line.slice('branch refs/heads/'.length), path);
  }
  return out;
}

export function audit(cwd, main = 'main') {
  const base = git(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${main}`).status === 0 ? `origin/${main}` : main;
  const prs = pullRequests(cwd);
  const trees = worktrees(cwd);
  const rows = git(cwd, 'for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads').stdout.split('\n').filter(Boolean);
  return rows.map(row => {
    const [name, upstream] = row.split('\t');
    const merged = git(cwd, 'merge-base', '--is-ancestor', name, base).status === 0 ? 'merged' : 'unmerged';
    const pr = prs ? prs.get(name) : undefined;
    const prField = !prs ? 'pr-unknown' : pr ? `pr#${pr.number}:${pr.state}` : 'no-pr';
    const tree = trees.get(name);
    const treeField = !tree ? 'no-worktree' : git(tree, 'status', '--porcelain').stdout.trim() ? 'worktree:dirty' : 'worktree:clean';
    return `BRANCH ${name} ${merged} ${upstream ? 'upstream' : 'no-upstream'} ${prField} ${treeField}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--main')) {
    console.error('用法：node scripts/branch-audit.mjs [--main <分支>]');
    process.exit(2);
  }
  if (git('.', 'rev-parse', '--git-dir').status !== 0) {
    console.error('不是 git repo');
    process.exit(1);
  }
  for (const line of audit('.', args[1])) console.log(line);
}
