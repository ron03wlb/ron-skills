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
