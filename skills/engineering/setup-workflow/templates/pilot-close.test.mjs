import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './test/real-tmpdir.mjs';

// 正本的通用路徑：tracker 專案由 --repo 給（[host/]owner/repo），主分支由 --main 給；旁邊沒有 gh-tracker.mjs 時留言、關單直接用 gh。
// 經 gh-tracker、Orca 的 terminal／worktree 步驟、對應單與母單另在 ron-skills 的 tests/pilot-close.test.mjs 測。
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * origin（bare）＋ 主 checkout（`main` 分支已合入成員分支並 push）＋ 複製到 scripts/ 的正本（旁邊放什麼都不做的 pilot-unbare.sh）。
 * 成員 worktree 已經移除（terminal、worktree 步驟 SKIP），成員分支也 push 過。假 gh 以號碼記 Issue 狀態，每次呼叫記一行參數。
 */
function fixture(t, { main = 'main', tracker = false } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-close-template-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const origin = join(temp, 'origin.git');
  const repo = join(temp, 'repo');
  git(temp, 'init', '-q', '--bare', `--initial-branch=${main}`, origin);
  mkdirSync(repo);
  git(repo, 'init', '-q', `--initial-branch=${main}`);
  writeFileSync(join(repo, '.gitignore'), '.scratch/\nscripts/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', main);
  git(repo, 'switch', '-q', '-c', 'issue/12-x');
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  git(repo, 'add', 'x.txt');
  git(repo, 'commit', '-qm', 'member');
  git(repo, 'push', '-q', 'origin', 'issue/12-x');
  git(repo, 'switch', '-q', main);
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #5', 'issue/12-x');
  git(repo, 'push', '-q', 'origin', main);
  const sha = git(repo, 'rev-parse', 'HEAD');
  // 主 checkout 的 main 落後 origin/main 時 Close 要 --ff-only 跟上：讓本機退回一個 commit。
  git(repo, 'reset', '-q', '--hard', 'HEAD^');

  const scripts = join(repo, 'scripts');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  for (const name of ['pilot-close.mjs', 'pilot-counterpart.mjs', 'lib/hosts.mjs']) copyFileSync(new URL(`./${name}`, import.meta.url), join(scripts, name));
  writeFileSync(join(scripts, 'pilot-unbare.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(scripts, 'pilot-unbare.sh'), 0o755);
  const log = join(temp, 'calls.log');
  writeFileSync(log, '');
  if (tracker) writeFileSync(join(scripts, 'gh-tracker.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, 'tracker ' + process.argv.slice(2).join(' ') + '\\n');\n`);

  mkdirSync(join(repo, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(repo, '.scratch/pilot/batch-12.md'), `# batch 12
current: pushed ${sha.slice(0, 7)}

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
| 12 | issue/12-x | ${temp}/gone | term_12 | 2026-11-01T07:00:00+08:00 | 90m | done | abc1234 |
regression: abc1234 exit 0 CHECK_PASS tests 1+2
`);
  const state = join(temp, 'gh.json');
  writeFileSync(state, JSON.stringify({ state: 'OPEN', comments: [] }));
  mkdirSync(join(temp, 'bin'));
  const gh = join(temp, 'bin/gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, 'gh ' + args.join(' ').replace(/\\n/g, '\\\\n') + '\\n');
const issue = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(issue));
const arg = k => args[args.indexOf(k) + 1];
if (args[0] === 'issue' && args[1] === 'view') console.log(JSON.stringify({ state: issue.state, body: '', comments: issue.comments.map(body => ({ body })) }));
else if (args[0] === 'issue' && args[1] === 'comment') { issue.comments.push(arg('--body')); save(); }
else if (args[0] === 'issue' && args[1] === 'close') { issue.state = 'CLOSED'; save(); }
else if (args[0] === 'api' && args.at(-1).endsWith('/parent')) { console.error('gh: No parent issue found (HTTP 404)'); process.exit(1); }
else { console.error('fake gh: unknown ' + args.join(' ')); process.exit(1); }
`);
  chmodSync(gh, 0o755);
  const close = (...extra) => spawnSync('node', [join(scripts, 'pilot-close.mjs'), '12', '5', sha, ...extra], {
    cwd: repo, encoding: 'utf8', timeout: 60000, env: { ...env, PATH: `${join(temp, 'bin')}:${env.PATH}`, ORCA_CLI_COMMAND: 'false' },
  });
  return {
    repo, origin, sha, close,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    issue: () => JSON.parse(readFileSync(state, 'utf8')),
    checkpoint: () => readFileSync(join(repo, '.scratch/pilot/batch-12.md'), 'utf8'),
  };
}

const lines = result => result.stdout.trim().split('\n');

test('沒有 gh-tracker.mjs：留言與關單直接用 gh --repo <repo>，證據裡的 PR 網址照 --repo；主分支用 --main', t => {
  const f = fixture(t, { main: 'trunk' });
  const result = f.close('--repo', 'acme/app', '--main', 'trunk');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['DONE 12 main', 'DONE 12 evidence', 'SKIP 12 counterpart', 'DONE 12 close', 'SKIP 12 terminal',
    'SKIP 12 worktree', 'DONE 12 branch', 'DONE 12 remote', 'SKIP 12 parent', 'CLOSED 12']);
  const issue = f.issue();
  assert.equal(issue.state, 'CLOSED');
  assert.match(issue.comments[0], new RegExp(`^已隨 https://github\\.com/acme/app/pull/5 合入 \`trunk\`（merge ${f.sha}）`));
  assert.match(issue.comments[0], /regression: abc1234 exit 0/);
  const writes = f.calls().filter(line => /^gh issue (comment|close) /.test(line));
  assert.deepEqual(writes.map(line => line.split(' ').slice(0, 6).join(' ')), ['gh issue comment 12 --repo acme/app', 'gh issue close 12 --repo acme/app']);
  assert.ok(f.calls().includes('gh api repos/acme/app/issues/12/parent'), f.calls().join('\n'));
  assert.equal(git(f.repo, 'rev-parse', 'trunk'), f.sha, '主 checkout 的 trunk 跟上 origin/trunk');
  assert.match(f.checkpoint(), /^current: closed$/m);
});

test('--repo 帶主機（GitHub Enterprise）：gh 的 --repo 帶主機、gh api 帶 --hostname，PR 網址用那個主機', t => {
  const f = fixture(t);
  const result = f.close('--repo', 'ghe.example.com/acme/app');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(f.issue().comments[0], /^已隨 https:\/\/ghe\.example\.com\/acme\/app\/pull\/5 合入 `main`/);
  assert.ok(f.calls().some(line => line.startsWith('gh issue comment 12 --repo ghe.example.com/acme/app ')), f.calls().join('\n'));
  assert.ok(f.calls().includes('gh api --hostname ghe.example.com repos/acme/app/issues/12/parent'), f.calls().join('\n'));
});

test('旁邊有 gh-tracker.mjs：留言與關單經它寫，不直接呼叫 gh 寫入', t => {
  const f = fixture(t, { tracker: true });
  const result = f.close('--repo', 'acme/app');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().filter(line => line.startsWith('tracker ')).map(line => line.split(' ').slice(0, 3).join(' ')),
    ['tracker comment 12', 'tracker close 12']);
  assert.equal(f.calls().filter(line => /^gh issue (comment|close) /.test(line)).length, 0);
});

test('沒有 --repo、--repo 格式不對或 --main 不是分支名稱：用法錯誤 exit 2，什麼都不動', t => {
  const f = fixture(t);
  for (const extra of [[], ['--repo', 'acme'], ['--repo', 'a/b/c/d'], ['--repo', 'acme/app', '--main', '-x'], ['--repo', 'acme/app', '--bogus', '1']]) {
    const result = f.close(...extra);
    assert.equal(result.status, 2, `${extra.join(' ')}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /用法/);
  }
  assert.deepEqual(f.calls(), []);
  assert.match(f.checkpoint(), /^current: pushed /m);
});
