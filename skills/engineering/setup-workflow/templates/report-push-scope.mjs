#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

// 只輸出受控錯誤；Git stderr 可能包含 remote URL 或 credential。
function git(args, failure) {
  const result = spawnSync('git', args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(failure);
  return result.stdout;
}
function options() {
  const args = process.argv.slice(2); const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!['--remote', '--ref', '--base'].includes(key) || !value || values[key]) throw new Error('ARGUMENTS_INVALID');
    values[key] = value;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values['--remote'] ?? '') || !values['--ref']?.startsWith('refs/heads/')) throw new Error('BRANCH_REMOTE_REQUIRED');
  git(['check-ref-format', values['--ref']], 'BRANCH_REF_INVALID');
  if (values['--base'] && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(values['--base'])) throw new Error('BASE_SHA_INVALID');
  return values;
}
try {
  const values = options(); const remote = values['--remote']; const ref = values['--ref'];
  if (!git(['remote'], 'REPOSITORY_REQUIRED').trim().split('\n').includes(remote)) throw new Error('REMOTE_NOT_CONFIGURED');
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], 'HEAD_COMMIT_REQUIRED').trim();
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'WORKTREE_STATUS_FAILED');
  const rows = git(['ls-remote', '--refs', remote, ref], 'REMOTE_QUERY_FAILED').trim().split('\n').filter(Boolean);
  let remoteSha = null;
  if (rows.length) {
    if (rows.length !== 1) throw new Error('REMOTE_RESPONSE_INVALID');
    const [sha, returnedRef] = rows[0].split('\t');
    if (returnedRef !== ref || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('REMOTE_RESPONSE_INVALID');
    remoteSha = sha;
  }
  const base = remoteSha ?? values['--base'];
  if (!base) throw new Error('NEW_BRANCH_BASE_REQUIRED');
  if (git(['cat-file', '-t', base], remoteSha ? 'REMOTE_OBJECT_MISSING_FETCH_REQUIRED' : 'BASE_OBJECT_MISSING').trim() !== 'commit') throw new Error('BASE_COMMIT_REQUIRED');
  git(['merge-base', '--is-ancestor', base, head], 'BASE_NOT_HEAD_ANCESTOR');
  const shas = git(['rev-list', '--reverse', `${base}..${head}`], 'OUTGOING_COMMITS_FAILED').trim().split('\n').filter(Boolean);
  const commits = shas.map(sha => ({ sha, subject: git(['show', '-s', '--format=%s', sha], 'COMMIT_SUBJECT_FAILED').replace(/\n$/, '') }));
  // 完整 outgoing 範圍內曾改動的 paths；不會漏掉後續 commit 抵銷的修改。
  const paths = new Set(shas.flatMap(sha => git(['diff-tree', '--root', '-m', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', sha], 'CHANGED_PATHS_FAILED').split('\0').filter(Boolean)));
  if (git(['rev-parse', '--verify', 'HEAD^{commit}'], 'HEAD_COMMIT_REQUIRED').trim() !== head || git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'WORKTREE_STATUS_FAILED') !== status) throw new Error('WORKTREE_CHANGED_DURING_REPORT');
  console.log(JSON.stringify({ candidateHead: head, remote: { name: remote, ref, sha: remoteSha }, comparisonBase: base, worktreeClean: status.length === 0, commits, changedPaths: [...paths].sort() }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
