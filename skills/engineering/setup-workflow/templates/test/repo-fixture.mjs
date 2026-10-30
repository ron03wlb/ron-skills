import './isolate-git-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './real-tmpdir.mjs';

/** 被測 script 所在的目錄（本 helper 的上一層）。 */
export const source = fileURLToPath(new URL('../', import.meta.url));
export function run(cwd, args, options = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', timeout: 30000, ...options,
    env: { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...options.env } });
}
export function git(cwd, ...args) {
  const result = run(cwd, ['git', ...args]); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
export function repoFixture(t) {
  const temp = mkdtempSync(join(realTmpdir(), 'workflow-scripts-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo'); const remote = join(temp, 'remote.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(temp, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  const commit = (name = 'fixture', content = name) => {
    writeFileSync(join(repo, 'source.md'), content); git(repo, 'add', '.'); git(repo, 'commit', '-qm', name); return git(repo, 'rev-parse', 'HEAD');
  };
  const base = commit();
  return { temp, repo, remote, base, commit };
}
