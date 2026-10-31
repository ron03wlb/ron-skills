// #123：同一批 stage 的兩個成員都改了 pilot.md 的同一個條目（#56、#57 的 Handoff），兩邊做完才在 stage 衝突。
// Probe 在派工與 stage 之前就印 OVERLAP；這裡用本 repo 真正的 pilot.md 當 fixture，比對的是副本 scripts/pilot-probe.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/pilot-probe.mjs', import.meta.url).pathname;
const pilotMd = readFileSync(new URL('../docs/agents/pilot.md', import.meta.url), 'utf8');
const PATH = 'docs/agents/pilot.md';

/** 主 checkout 在 main 上；`edits` 是 Issue 號碼 → 對 pilot.md 原文的改寫，每個各開一個 `issue/<n>-x` 分支，batch 裡記成 done。 */
function fixture(t, edits) {
  const repo = mkdtempSync(join(realTmpdir(), 'pilot-probe-overlap-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), '.scratch/\n');
  writeFileSync(join(repo, PATH), pilotMd);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'pilot/integration');
  for (const [n, edit] of Object.entries(edits)) {
    git(repo, 'switch', '-q', '-c', `issue/${n}-x`, 'pilot/integration');
    writeFileSync(join(repo, PATH), edit(pilotMd));
    git(repo, 'commit', '-q', '-am', `#${n}`);
  }
  git(repo, 'switch', '-q', 'main');
  mkdirSync(join(repo, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(repo, '.scratch/pilot/batch-56-57.md'), `# batch 56-57
current: dispatched 2026-10-31T00:00:00+08:00
integration: pilot/integration @ 1234567

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
${Object.keys(edits).map(n => `| ${n} | issue/${n}-x | /w/issue-${n} | term_${n} | 2026-10-31T00:00:00+08:00 | 90m | done | ${'a'.repeat(40)} |`).join('\n')}
`);
  // Probe 也用 gh 讀開著的 Issue（DEPS_PROSE）；暫存 repo 沒有 remote，換成回空頁的假 gh。
  const bin = join(repo, '.scratch/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
[ "$1" = repo ] && echo acme/app && exit 0
echo '{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}'
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return spawnSync('node', [script, repo], { encoding: 'utf8', env: { ...env, ORCA_CLI_COMMAND: '', PATH: `${bin}:${env.PATH}` } });
}

/** 在 `- **<名稱>.**` 條目那一行的尾端加字。 */
const append = (name, text) => md => {
  assert.ok(md.includes(`- **${name}.**`), `pilot.md 沒有 ${name} 條目`);
  return md.replace(new RegExp(`^(- \\*\\*${name}\\.\\*\\*.*)$`, 'm'), `$1${text}`);
};

test('兩個成員都改了 pilot.md 的 Handoff 條目時印 OVERLAP 56 57 1 files **Handoff.**', t => {
  const result = fixture(t, { 56: append('Handoff', '（#56）'), 57: append('Handoff', '（#57）') });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(line => line.startsWith('OVERLAP ')), ['OVERLAP 56 57 1 files **Handoff.**']);
});

test('兩個成員改的是 pilot.md 的不同條目時不印 OVERLAP', t => {
  const result = fixture(t, { 56: append('Handoff', '（#56）'), 57: append('Close', '（#57）') });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(line => line.startsWith('OVERLAP ')), []);
});

// review：兩邊都在 Handoff 後面（隔一行空行）各補一個新條目，名稱不同，git 合併照樣衝突；撞到的是緊接在插入點後面的條目。
test('兩個成員都在 Handoff 後面各加一個新條目時，印插入點緊接的條目', t => {
  const insert = name => md => md.replace(/^(- \*\*Handoff\.\*\*.*\n)/m, `$1\n- **${name}.** 新的。\n`);
  const result = fixture(t, { 56: insert('New56'), 57: insert('New57') });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(line => line.startsWith('OVERLAP ')),
    ['OVERLAP 56 57 1 files **Project tick hooks.**']);
});

// review 第二輪：插入新條目和改隔一行空行的條目，git 不會衝突（中間的空行沒人改），不印。
test('在 Handoff 前面插入新條目、另一個成員改 Close 時不印 OVERLAP', t => {
  const before = md => md.replace(/^(- \*\*Handoff\.\*\*)/m, '- **X.** a\n\n$1');
  const result = fixture(t, { 56: before, 57: append('Close', '（#57）') });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(line => line.startsWith('OVERLAP ')), []);
});
