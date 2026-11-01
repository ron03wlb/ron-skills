import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

// pilot-unbare.sh 本身的行為測在 setup-workflow 正本旁（templates/pilot-unbare.test.mjs）；這裡只測本 repo 的副本擺放（#246）。
// pre-commit hook 會匯出 GIT_DIR、GIT_INDEX_FILE；不清掉的話 `git -C <暫存 repo> config core.bare true` 會寫進本 repo 的共用 config（#20 worker 實測）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function checkout(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'pilot-unbare-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  git('init', '-q');
  return { repo, git };
}

// pilot-probe、pilot-dispatch 是 setup-workflow 正本的副本，只在同目錄有 pilot-unbare.sh 時跑 Bare guard（#58）：
// 本 repo 的副本旁邊要有它，Probe 才會照舊在 bare 時還原、印 UNBARE 並記一列。
test('scripts/pilot-probe.mjs 跑本 repo 的 pilot-unbare.sh：bare 時還原、印 UNBARE、記一列（時機 probe）', t => {
  const { repo, git } = checkout(t);
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('branch', '-q', '-M', 'main');
  git('config', 'core.bare', 'true');

  // Probe 也用 gh 讀開著的 Issue（DEPS_PROSE、池子摘要；空頁時印 POOL_EMPTY）；暫存 repo 沒有 remote，換成回空頁的假 gh。
  const bin = join(repo, '.scratch/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
[ "$1" = repo ] && echo acme/app && exit 0
echo '{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}'
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const probe = new URL('../scripts/pilot-probe.mjs', import.meta.url).pathname;
  const probeEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'ORCA_CLI_COMMAND'));
  const result = spawnSync('node', [probe, repo], { encoding: 'utf8', env: { ...probeEnv, PATH: `${bin}:${probeEnv.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [`UNBARE ${repo}`, 'DIRTY ?? .scratch/', 'POOL_EMPTY']);
  assert.equal(git('rev-parse', '--is-bare-repository').stdout.trim(), 'false');
  assert.match(readFileSync(join(repo, '.scratch/pilot/decisions.md'), 'utf8'), /被設成 true（probe）/);
});

test('scripts/pilot-dispatch.mjs 旁邊有可執行的 pilot-unbare.sh', () => {
  const dispatch = new URL('../scripts/pilot-dispatch.mjs', import.meta.url).pathname;
  assert.equal(spawnSync('test', ['-x', join(dispatch, '..', 'pilot-unbare.sh')]).status, 0);
});
