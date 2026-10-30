import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const unbare = new URL('../scripts/pilot-unbare.sh', import.meta.url).pathname;
// pre-commit hook 會匯出 GIT_DIR、GIT_INDEX_FILE；不清掉的話 `git -C <暫存 repo> config core.bare true` 會寫進本 repo 的共用 config（#20 worker 實測）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function checkout(t) {
  const repo = mkdtempSync(join(tmpdir(), 'pilot-unbare-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  git('init', '-q');
  return { repo, git };
}

// 重現真實歷史：Orca 從 WSL 做 worktree create／rm 後，主 checkout 的 core.bare 變成 true（#20）。
test('core.bare 被設成 true 時還原為 false，並在 decisions.md 記一筆', t => {
  const { repo, git } = checkout(t);
  git('config', 'core.bare', 'true');

  const result = spawnSync(unbare, [repo, 'dispatch #20'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('rev-parse', '--is-bare-repository').stdout.trim(), 'false');
  assert.match(result.stdout, /^UNBARE /m);
  assert.match(readFileSync(join(repo, '.scratch/pilot/decisions.md'), 'utf8'), /core\.bare.*dispatch #20/);
});

test('不是 bare 時不輸出、不寫 decisions.md', t => {
  const { repo, git } = checkout(t);

  const result = spawnSync(unbare, [repo, 'probe'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(git('rev-parse', '--is-bare-repository').stdout.trim(), 'false');
  assert.equal(existsSync(join(repo, '.scratch/pilot/decisions.md')), false);
});

test('路徑不是 git checkout 時以非 0 結束，不當成「不是 bare」', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-unbare-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = spawnSync(unbare, [dir, 'probe'], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
});
