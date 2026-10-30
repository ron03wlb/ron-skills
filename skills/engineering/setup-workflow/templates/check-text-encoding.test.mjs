import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, unlinkSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoFixture, source, run, git } from './test/repo-fixture.mjs';

function scan(f) { return run(f.repo, [process.execPath, join(source, 'check-text-encoding.mjs')]); }
function failures(result) { assert.notEqual(result.status, 0); return result.stderr.trim().split('\n').map(line => JSON.parse(line)); }
test('Unicode／escaped NUL 合法；涵蓋新增 files 與兩個 extensionless hooks', t => {
  const f = repoFixture(t);
  for (const ext of ['java', 'md', 'sql', 'yml', 'yaml', 'properties', 'mjs', 'mts', 'js', 'ts', 'sh', 'json']) writeFileSync(join(f.repo, `新增.${ext}`), '繁體中文 😀 \\u0000');
  mkdirSync(join(f.repo, 'scripts/git-hooks'), { recursive: true });
  for (const hook of ['pre-push', 'pre-push-wrapper']) writeFileSync(join(f.repo, 'scripts/git-hooks', hook), '#!/bin/bash\n# 正常\n');
  const result = scan(f); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
});
for (const [kind, bytes] of [['INVALID_UTF8', Buffer.from([0xc3, 0x28])], ['UTF8_BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x61])], ['NUL_BYTE', Buffer.from('隱私\0內容')]]) {
  test(`${kind} 拒絕，不輸出 file contents`, t => {
    const f = repoFixture(t); writeFileSync(join(f.repo, 'bad.md'), bytes);
    assert.deepEqual(failures(scan(f)), [{ path: 'bad.md', error: kind }]);
  });
}
test('tracked invalid、deleted 略過、ignored／binary／.git 不掃描', t => {
  const f = repoFixture(t); writeFileSync(join(f.repo, 'bad.java'), Buffer.from([0xff])); git(f.repo, 'add', '.');
  assert.deepEqual(failures(scan(f)), [{ path: 'bad.java', error: 'INVALID_UTF8' }]);
  unlinkSync(join(f.repo, 'bad.java')); unlinkSync(join(f.repo, 'source.md'));
  writeFileSync(join(f.repo, '.gitignore'), 'ignored.md\n');
  for (const file of ['ignored.md', 'image.png', '.git/internal.md']) writeFileSync(join(f.repo, file), Buffer.from([0xff, 0]));
  assert.equal(scan(f).status, 0);
});
test('範圍內 symlink 與 symlink ancestor 不跟隨；repo 外 bytes 不改變', t => {
  const f = repoFixture(t); const outside = join(f.temp, 'private.md'); writeFileSync(outside, '不讀取的外部內容');
  symlinkSync(outside, join(f.repo, 'link.md'));
  assert.deepEqual(failures(scan(f)), [{ path: 'link.md', error: 'SYMLINK' }]);
  unlinkSync(join(f.repo, 'link.md')); mkdirSync(join(f.repo, 'dir')); writeFileSync(join(f.repo, 'dir/out.md'), 'tracked'); git(f.repo, 'add', '.');
  unlinkSync(join(f.repo, 'dir/out.md')); run(f.repo, ['rmdir', 'dir']);
  symlinkSync(f.temp, join(f.repo, 'dir'));
  assert.deepEqual(failures(scan(f)), [{ path: 'dir/out.md', error: 'SYMLINK' }]); assert.equal(readFileSync(outside, 'utf8'), '不讀取的外部內容');
});
