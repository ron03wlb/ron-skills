import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { hasSystemBash, systemBashPath } from './helpers/bash32.mjs';

const unbare = new URL('../scripts/pilot-unbare.sh', import.meta.url).pathname;
// pre-commit hook 會匯出 GIT_DIR、GIT_INDEX_FILE；不清掉的話 `git -C <暫存 repo> config core.bare true` 會寫進本 repo 的共用 config（#20 worker 實測）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function checkout(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'pilot-unbare-'));
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
  assert.equal(result.stdout, `UNBARE ${repo}\n`);
  // decisions.md 是 issue-pilot 的五欄表格（time | decision | reason | evidence | result），追加的必須是同格式的一列。
  const row = readFileSync(join(repo, '.scratch/pilot/decisions.md'), 'utf8').trim().split('\n').at(-1);
  assert.match(row, /^\| \S+ \| 還原 core\.bare \| [^|]*dispatch #20[^|]* \| [^|]+ \| [^|]+ \|$/);
});

// 重現真實歷史：bash 3.2 把緊接在 `$when` 後的全形括號算進變數名，set -u 下 `when?: unbound variable`（#85）。
test('PATH 上的 bash 是 /bin/bash 時照樣還原並記一筆', { skip: !hasSystemBash && '沒有 /bin/bash' }, t => {
  const { repo, git } = checkout(t);
  git('config', 'core.bare', 'true');

  const result = spawnSync(unbare, [repo, 'probe'], { encoding: 'utf8', env: { ...env, PATH: systemBashPath(t) } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('rev-parse', '--is-bare-repository').stdout.trim(), 'false');
  assert.match(readFileSync(join(repo, '.scratch/pilot/decisions.md'), 'utf8'), /被設成 true（probe）/);
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
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-unbare-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = spawnSync(unbare, [dir, 'probe'], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
});
