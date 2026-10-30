import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoFixture, source, run, git } from './test/repo-fixture.mjs';

function report(f, extra = [], options = {}) {
  return run(f.repo, [process.execPath, join(source, 'report-push-scope.mjs'), '--remote', 'origin', '--ref', 'refs/heads/main', ...extra], options);
}
function parsed(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }
function failed(result, code) { assert.notEqual(result.status, 0); assert.deepEqual(JSON.parse(result.stderr), { error: code }); assert.equal(result.stdout, ''); }

test('既有 branch：完整多 commits／特殊 paths、不輸出 diff；zero outgoing', t => {
  const f = repoFixture(t); git(f.repo, 'push', '-q', 'origin', 'main');
  const first = f.commit('第一筆'); const special = '含 空白\t換行\n".md';
  writeFileSync(join(f.repo, special), '不應出現在 JSON 的內容'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', '第二筆');
  const second = git(f.repo, 'rev-parse', 'HEAD');
  const result = report(f, ['--base', first]); const data = parsed(result);
  assert.equal(data.candidateHead, second); assert.deepEqual(data.remote, { name: 'origin', ref: 'refs/heads/main', sha: f.base });
  assert.equal(data.comparisonBase, f.base); assert.equal(data.worktreeClean, true);
  assert.deepEqual(data.commits, [{ sha: first, subject: '第一筆' }, { sha: second, subject: '第二筆' }]);
  assert.deepEqual(data.changedPaths, ['source.md', special].sort()); assert.ok(!result.stdout.includes('不應出現在'));
  git(f.repo, 'push', '-q', 'origin', 'main'); assert.deepEqual(parsed(report(f)).commits, []); assert.deepEqual(parsed(report(f)).changedPaths, []);
});
test('新 branch 必須 explicit ancestor base；dirty／detached HEAD 可報告，不寫 refs', t => {
  const f = repoFixture(t); failed(report(f), 'NEW_BRANCH_BASE_REQUIRED');
  f.commit('new'); git(f.repo, 'checkout', '-q', '--detach'); writeFileSync(join(f.repo, 'dirty.md'), 'dirty');
  const refs = git(f.repo, 'show-ref'); const headFile = readFileSync(join(f.repo, '.git/HEAD'));
  const data = parsed(report(f, ['--base', f.base]));
  assert.equal(data.worktreeClean, false); assert.equal(data.remote.sha, null); assert.equal(data.commits.length, 1);
  assert.equal(git(f.repo, 'show-ref'), refs); assert.deepEqual(readFileSync(join(f.repo, '.git/HEAD')), headFile);
});
test('缺 remote object 明確要求自行 fetch、不自動寫入 object／ref', t => {
  const f = repoFixture(t); git(f.repo, 'push', '-q', 'origin', 'main');
  const other = join(f.temp, 'other'); git(f.temp, 'clone', '-q', f.remote, other);
  git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(other, 'new.md'), 'remote'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q');
  const sha = git(other, 'rev-parse', 'HEAD'); const refs = git(f.repo, 'show-ref');
  failed(report(f), 'REMOTE_OBJECT_MISSING_FETCH_REQUIRED'); assert.notEqual(run(f.repo, ['git', 'cat-file', '-e', sha]).status, 0); assert.equal(git(f.repo, 'show-ref'), refs);
});
test('divergent remote 與非 ancestor base 都拒絕', t => {
  const f = repoFixture(t); const other = f.commit('remote'); git(f.repo, 'push', '-q', 'origin', 'main');
  git(f.repo, 'checkout', '-qb', 'candidate', f.base); f.commit('candidate');
  failed(report(f), 'BASE_NOT_HEAD_ANCESTOR'); git(f.remote, 'update-ref', '-d', 'refs/heads/main');
  failed(report(f, ['--base', other]), 'BASE_NOT_HEAD_ANCESTOR');
});
test('錯誤 SHA、非 branch ref、重複／未知 args 與非 commit 拒絕', t => {
  const f = repoFixture(t);
  failed(report(f, ['--base', 'HEAD']), 'BASE_SHA_INVALID');
  failed(report(f, ['--ref', 'refs/tags/v1']), 'ARGUMENTS_INVALID');
  const tag = run(f.repo, [process.execPath, join(source, 'report-push-scope.mjs'), '--remote', 'origin', '--ref', 'refs/tags/v1']); failed(tag, 'BRANCH_REMOTE_REQUIRED');
  failed(report(f, ['--extra', 'x']), 'ARGUMENTS_INVALID');
  failed(report(f, ['--base', git(f.repo, 'rev-parse', 'HEAD^{tree}')]), 'BASE_COMMIT_REQUIRED');
  failed(report(f, ['--base', '0'.repeat(40)]), 'BASE_OBJECT_MISSING');
});
test('query failure 不洩漏 URL／raw stderr', t => {
  const f = repoFixture(t); git(f.repo, 'remote', 'set-url', 'origin', 'https://credential:secret@example.invalid/repo');
  const bin = join(f.temp, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = ls-remote ]; then printf '%s\\n' 'https://credential:secret@example.invalid raw-stderr' >&2; exit 8; fi\nexec '${run(f.repo, ['which', 'git']).stdout.trim()}' "$@"\n`, { mode: 0o755 });
  const result = report(f, ['--base', f.base], { env: { PATH: `${bin}:${process.env.PATH}` } });
  failed(result, 'REMOTE_QUERY_FAILED'); assert.doesNotMatch(result.stderr + result.stdout, /credential|secret|example|raw-stderr/);
});
test('後續抵銷的 paths 仍包含於 outgoing report', t => {
  const f = repoFixture(t); writeFileSync(join(f.repo, 'transient.md'), 'temporary'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', '新增');
  git(f.repo, 'rm', '-q', 'transient.md'); git(f.repo, 'commit', '-qm', '刪除');
  assert.deepEqual(parsed(report(f, ['--base', f.base])).changedPaths, ['transient.md']);
});
