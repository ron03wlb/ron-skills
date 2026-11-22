// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoFixture, source, run, git } from './test/repo-fixture.mjs';

const BODY = 'A'.repeat(80);
function scan(f) { return run(f.repo, [process.execPath, join(source, 'check-secrets.mjs')]); }
function failures(result) {
  assert.notEqual(result.status, 0);
  return result.stderr.trim().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}

test('PEM private key、service account JSON 與 *-firebase.json 皆拒絕且不輸出內容', t => {
  const f = repoFixture(t);
  writeFileSync(join(f.repo, 'key.pem'), `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----\n`);
  writeFileSync(join(f.repo, 'account.json'), JSON.stringify({ type: 'service_account', private_key: `-----BEGIN PRIVATE KEY-----\n${BODY}` }));
  writeFileSync(join(f.repo, 'app-firebase.json'), '{}');
  const result = scan(f);
  assert.deepEqual(failures(result), [
    { path: 'account.json', error: 'PRIVATE_KEY_PEM' }, { path: 'account.json', error: 'SERVICE_ACCOUNT_KEY' },
    { path: 'app-firebase.json', error: 'FIREBASE_CREDENTIAL_FILE' }, { path: 'key.pem', error: 'PRIVATE_KEY_PEM' }]);
  assert.ok(!result.stderr.includes(BODY));
  assert.ok(!result.stdout.includes(BODY));
});

test('只提及 PEM header 或測試用串接字串的 source 不誤判', t => {
  const f = repoFixture(t);
  mkdirSync(join(f.repo, 'src'));
  writeFileSync(join(f.repo, 'src/Parser.java'), 'String der = pem.replace("-----BEGIN PRIVATE KEY-----", "");');
  writeFileSync(join(f.repo, 'src/Fixture.java'), 'String pem = "-----BEGIN PRIVATE KEY-----\\n" + Base64.getMimeEncoder().encodeToString(key);');
  writeFileSync(join(f.repo, 'src/Account.java'), 'Map.of("type", "service_account", "private_key", pem);');
  const result = scan(f);
  assert.equal(result.status, 0, result.stderr);
});

test('ignored 與已移出版控的憑證不掃描', t => {
  const f = repoFixture(t);
  writeFileSync(join(f.repo, 'local-firebase.json'), JSON.stringify({ type: 'service_account', private_key: 'x' }));
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'tracked secret');
  assert.equal(scan(f).status, 1);
  git(f.repo, 'rm', '--cached', '-q', 'local-firebase.json');
  writeFileSync(join(f.repo, '.gitignore'), 'local-firebase.json\n');
  const result = scan(f);
  assert.equal(result.status, 0, result.stderr);
});

// #499：f575e017 版 mjs_line_length/550-long-line.diff 前 8 行的形狀（git show 的 commit header），email 用假值。
const FAKE_EMAIL = 'someone@example.com';
const GIT_SHOW_HEADER = ['commit 067ba975aa11bb22cc33dd44ee55ff6677889900', `Author: someone <${FAKE_EMAIL}>`,
  'Date:   Sat Nov 21 10:00:00 2026 +0800', '', '    Fix long line', '',
  'diff --git a/scripts/x.mjs b/scripts/x.mjs', 'index 1111111..2222222 100644', '--- a/scripts/x.mjs', ''].join('\n');
function put(f, path, content) {
  mkdirSync(join(f.repo, path, '..'), { recursive: true });
  writeFileSync(join(f.repo, path), content);
}

test('測試 fixture 路徑裡的 git Author header 拒絕，只輸出路徑與代碼並提示改法', t => {
  const f = repoFixture(t);
  put(f, 'scripts/tests/fixtures/mjs_line_length/550-long-line.diff', GIT_SHOW_HEADER);
  put(f, 'tests/case.txt', GIT_SHOW_HEADER.replaceAll('\n', '\r\n'));
  const result = scan(f);
  assert.deepEqual(failures(result), [
    { path: 'scripts/tests/fixtures/mjs_line_length/550-long-line.diff', error: 'GIT_AUTHOR_HEADER_IN_FIXTURE' },
    { path: 'tests/case.txt', error: 'GIT_AUTHOR_HEADER_IN_FIXTURE' }]);
  assert.match(result.stderr, /git show --format=%H%n%s --no-patch/);
  assert.ok(!result.stderr.includes(FAKE_EMAIL));
  assert.ok(!result.stdout.includes(FAKE_EMAIL));
});

test('fixture 路徑以外的 Author header、沒有 email 的 Author 行都放行', t => {
  const f = repoFixture(t);
  put(f, 'docs/x.md', GIT_SHOW_HEADER);
  put(f, 'docs/fixtures.md', GIT_SHOW_HEADER);
  put(f, 'tests/fixtures/no-email.diff', GIT_SHOW_HEADER.replace(`Author: someone <${FAKE_EMAIL}>`, 'Author: Name'));
  const result = scan(f);
  assert.equal(result.status, 0, result.stderr);
});
