import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { orcaReplySource } from './helpers/fake-orca.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/pilot-close.mjs', import.meta.url).pathname;
// pre-commit hook 匯出 GIT_DIR 等變數；繼承下去，腳本的 git 會指回本 repo 而不是 fixture。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const BRANCH = 'issue/76-pilot-close';
const REPO = 'ron03wlb/ron-skills';

// origin（bare）、主 checkout（main 已合入 issue 分支並 push）、Orca 建的成員 worktree，以及假 gh 與假 Orca。
// 假 gh 的狀態在 gh.json：issues 以號碼（跨 repo 用 `<owner>/<repo>#<m>`）為鍵，parent 指向母單，母單的子單由 parent 反查。
// 每次呼叫都記下參數與讀到的 stdin 位元組數；假 Orca 每次都在 stderr 印一行 WSL crashpad 錯誤和一行一般錯誤。
//   pushed     issue 分支也 push 到 origin；
//   unmerged   合入之後 issue 分支又多一個 commit（branch -d 會拒絕）；
//   body       Issue #76 的本文；
//   siblings   母單 #35 其他子單 { 號碼: 'OPEN' | 'CLOSED' }。
function fixture(t, { pushed = false, unmerged = false, body = '', siblings = { 70: 'CLOSED' } } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-close-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const origin = join(temp, 'origin.git');
  const repo = join(temp, 'repo');
  const worktree = join(temp, 'workspaces/issue-76');
  git(temp, 'init', '-q', '--bare', '--initial-branch=main', origin);
  mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main');
  writeFileSync(join(worktree, 'close.txt'), 'close\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'member');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #100', BRANCH);
  git(repo, 'push', '-q', 'origin', 'main');
  const mergeSha = git(repo, 'rev-parse', 'HEAD');
  if (pushed) git(repo, 'push', '-q', 'origin', BRANCH);
  if (unmerged) {
    writeFileSync(join(worktree, 'late.txt'), 'late\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'late');
  }
  mkdirSync(join(repo, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(repo, '.scratch/pilot/batch-76.md'), `# batch 76
current: pushed ${mergeSha.slice(0, 7)}
integration: pilot/integration @ 5d2e5d4

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
| 76 | ${BRANCH} | ${worktree} | term_76 | 2026-10-31T06:38:56+08:00 | 90m | done | abc1234 |
| 77 | issue/77-other | /nowhere/issue-77 | term_77 | 2026-10-31T06:38:56+08:00 | 90m | moved batch-77 | |
regression: abc1234 exit 0 CHECK_PASS tests 300+40
`);

  const ghState = join(temp, 'gh.json');
  const issues = { 76: { state: 'OPEN', body, comments: [], parent: 35 }, 35: { state: 'OPEN', body: '', comments: [] } };
  for (const [n, state] of Object.entries(siblings)) issues[n] = { state, body: '', comments: [], parent: 35, reason: state === 'CLOSED' ? 'not_planned' : null };
  issues['acme/app#7'] = { state: 'OPEN', body: '', comments: [] };
  writeFileSync(ghState, JSON.stringify({ issues }));
  const log = join(temp, 'calls.log');
  writeFileSync(log, '');
  const record = `const fs = require('fs'); const args = process.argv.slice(2); const arg = k => args[args.indexOf(k) + 1];
let stdin = 0; try { stdin = fs.readFileSync(0).length; } catch {}
fs.appendFileSync(${JSON.stringify(log)}, require('path').basename(process.argv[1]) + ' ' + args.join(' ') + ' <stdin ' + stdin + '>\\n');`;
  const gh = join(temp, 'bin/gh');
  mkdirSync(join(temp, 'bin'));
  writeFileSync(gh, `#!/usr/bin/env node
${record}
const state = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, 'utf8')); const save = () => fs.writeFileSync(${JSON.stringify(ghState)}, JSON.stringify(state));
const key = n => (arg('--repo') === ${JSON.stringify(REPO)} ? n : arg('--repo') + '#' + n);
const [a, b, n] = args;
if (a === 'issue' && b === 'view') {
  const issue = state.issues[key(n)];
  const out = {}; for (const f of arg('--json').split(',')) out[f] = f === 'comments' ? issue.comments.map(body => ({ body })) : issue[f];
  console.log(JSON.stringify(out));
} else if (a === 'issue' && b === 'comment') {
  state.issues[key(n)].comments.push(args.includes('--body-file') ? fs.readFileSync(arg('--body-file'), 'utf8') : arg('--body')); save();
} else if (a === 'issue' && b === 'close') {
  Object.assign(state.issues[key(n)], { state: 'CLOSED', reason: 'completed' }); save();
} else if (a === 'api') {
  const [, owner, name, , m, sub] = b.split('/');
  if (owner + '/' + name !== ${JSON.stringify(REPO)}) { console.error('fake gh: repo ' + b); process.exit(1); }
  const children = Object.entries(state.issues).filter(([, i]) => i.parent === Number(m));
  if (sub === 'parent') {
    if (!state.issues[m].parent) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
    console.log(JSON.stringify({ number: state.issues[m].parent }));
  } else if (sub === 'sub_issues') {
    console.log(JSON.stringify(children.map(([c, i]) => ({ number: Number(c), state_reason: i.state === 'CLOSED' ? i.reason : null }))));
  } else {
    const issue = state.issues[m];
    console.log(JSON.stringify({ number: Number(m), state: issue.state.toLowerCase(),
      sub_issues_summary: { total: children.length, completed: children.filter(([, i]) => i.state === 'CLOSED').length } }));
  }
} else { console.error('fake gh: unknown ' + args.join(' ')); process.exit(1); }
`);
  const terminals = join(temp, 'terminals.json');
  writeFileSync(terminals, JSON.stringify(['term_76']));
  const cli = join(temp, 'bin/orca');
  writeFileSync(cli, `#!/usr/bin/env node
${record}
${orcaReplySource()}
const { execFileSync } = require('child_process');
console.error('[1031/064000.123:ERROR:registration_protocol_win.cc(108)] CreateFile: 系統找不到指定的檔案。 (0x2)');
console.error('orca: warn sample');
const open = JSON.parse(fs.readFileSync(${JSON.stringify(terminals)}, 'utf8'));
const [a, b] = args;
if (a === 'terminal' && b === 'list') reply('list', { terminals: open.map(handle => ({ handle, branch: arg('--worktree').replace(/^branch:/, '') })), totalCount: open.length });
else if (a === 'terminal' && b === 'close') { fs.writeFileSync(${JSON.stringify(terminals)}, JSON.stringify(open.filter(h => h !== arg('--terminal')))); reply('close', { close: { handle: arg('--terminal') } }); }
else if (a === 'worktree' && b === 'rm') {
  const branch = arg('--worktree').replace(/^branch:/, '');
  const list = execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const path = list.split(/\\n\\n+/).find(block => block.includes('branch refs/heads/' + branch))?.match(/^worktree (.*)$/m)[1];
  execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'remove', '--force', path]);
  console.log(JSON.stringify({ ok: true, result: { removed: true } }));
}
else fail('unknown');
`);
  chmodSync(gh, 0o755);
  chmodSync(cli, 0o755);
  const close = (args = ['76', '100', mergeSha]) => spawnSync('node', [script, ...args], {
    cwd: repo, encoding: 'utf8', input: 'leftover-line\n', timeout: 60000,
    env: { ...env, PATH: `${join(temp, 'bin')}:${env.PATH}`, ORCA_CLI_COMMAND: cli },
  });
  const gh_ = () => JSON.parse(readFileSync(ghState, 'utf8')).issues;
  const checkpoint = () => readFileSync(join(repo, '.scratch/pilot/batch-76.md'), 'utf8');
  const calls = () => readFileSync(log, 'utf8');
  const branchExists = () => spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], { env }).status === 0;
  const remoteHas = () => spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], { env }).status === 0;
  return { temp, origin, repo, worktree, mergeSha, close, gh: gh_, checkpoint, calls, branchExists, remoteHas, terminals: () => JSON.parse(readFileSync(terminals, 'utf8')) };
}

const lines = result => result.stdout.trim().split('\n');
const STEPS = ['evidence', 'counterpart', 'close', 'terminal', 'worktree', 'branch', 'remote', 'parent'];

test('照 Close 依序做完每一步，母單子單全部結束就留言關閉；重跑時每一步都 SKIP', t => {
  const f = fixture(t, { pushed: true });
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['SKIP 76 main', ...STEPS.map(step => `${step === 'counterpart' ? 'SKIP' : 'DONE'} 76 ${step}`), 'CLOSED 76']);
  const issues = f.gh();
  assert.equal(issues[76].state, 'CLOSED');
  assert.match(issues[76].comments[0], new RegExp(`https://github.com/${REPO}/pull/100`));
  assert.ok(issues[76].comments[0].includes(f.mergeSha));
  assert.match(issues[76].comments[0], /regression: abc1234 exit 0/);
  assert.equal(issues[35].state, 'CLOSED');
  assert.match(issues[35].comments[0], /#76 completed/);
  assert.match(issues[35].comments[0], /#70 not_planned/);
  assert.deepEqual(f.terminals(), []);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.branchExists(), false);
  assert.equal(f.remoteHas(), false);
  assert.match(f.checkpoint(), /^current: closed$/m);
  // moved 的成員不處理。
  assert.doesNotMatch(result.stdout + f.calls(), /\b77\b/);

  const again = f.close();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(lines(again), ['SKIP 76 main', ...STEPS.map(step => `SKIP 76 ${step}`), 'CLOSED 76']);
  assert.equal(f.gh()[76].comments.length, 1);
  assert.equal(f.gh()[35].comments.length, 1);
});

test('分支沒合進 main：branch -d 被拒時 STOP，分支還在，current 不改', t => {
  const f = fixture(t, { unmerged: true });
  const result = f.close();
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(lines(result).pop(), /^STOP 76 branch .+/);
  assert.equal(f.branchExists(), true);
  assert.match(result.stderr, /not fully merged|未完全合併/, 'git 的 stderr 照常顯示');
  assert.doesNotMatch(f.checkpoint(), /^current: closed$/m);
  assert.doesNotMatch(result.stdout, /remote|parent|CLOSED/);
});

test('遠端沒有分支（ls-remote 回 2）印 SKIP；ls-remote 回其他 exit code 印 STOP', t => {
  const f = fixture(t);
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(lines(result).includes('SKIP 76 remote'));

  const g = fixture(t, { siblings: {} });
  spawnSync('git', ['-C', g.repo, 'remote', 'set-url', 'origin', join(g.temp, 'missing.git')], { env });
  // main 已是 origin/main 的祖先：remote-tracking ref 還在，所以 main 步驟照常 SKIP。
  const broken = g.close();
  assert.equal(broken.status, 4, broken.stdout + broken.stderr);
  assert.match(lines(broken).pop(), /^STOP 76 remote ls-remote exit \d+/);
  assert.doesNotMatch(lines(broken).pop(), /exit 2\b/);
});

test('子行程的 stdin 接 /dev/null；Orca 的 crashpad 錯誤行濾掉，其他 stderr 照常顯示', t => {
  const f = fixture(t);
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(f.calls(), /<stdin [1-9]/);
  assert.doesNotMatch(result.stderr, /registration_protocol_win\.cc/);
  assert.match(result.stderr, /orca: warn sample/);
});

test('主 checkout 的 main 落後 origin/main 就先快轉；merge SHA 不在 origin/main 就 STOP，不動任何成員', t => {
  const f = fixture(t);
  git(f.repo, 'reset', '-q', '--hard', 'HEAD~1');
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result)[0], 'DONE 76 main');
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.mergeSha);

  const g = fixture(t);
  const result2 = g.close(['76', '100', '0123456789abcdef0123456789abcdef01234567']);
  assert.equal(result2.status, 4, result2.stdout + result2.stderr);
  assert.deepEqual(lines(result2), [lines(result2)[0]]);
  assert.match(lines(result2)[0], /^STOP 76 main /);
  assert.equal(g.gh()[76].comments.length, 0);
});

test('有對應單：交接檔不在就 STOP；寫好後重跑留言，再重跑就 SKIP', t => {
  const f = fixture(t, { body: '## 背景\napp 對應單：acme/app#7\n' });
  const first = f.close();
  assert.equal(first.status, 4, first.stdout + first.stderr);
  assert.deepEqual(lines(first), ['SKIP 76 main', 'DONE 76 evidence', `STOP 76 counterpart acme/app#7 缺 ${f.repo}/.scratch/pilot/counterpart-76.md`]);

  // 交接檔要寫出 merge SHA 與成員，重跑時才認得出已經留過言。
  writeFileSync(join(f.repo, '.scratch/pilot/counterpart-76.md'), '改了 Close\n');
  const incomplete = f.close();
  assert.equal(incomplete.status, 4);
  assert.match(lines(incomplete).pop(), /^STOP 76 counterpart acme\/app#7 .*ron03wlb\/ron-skills#76/);

  writeFileSync(join(f.repo, '.scratch/pilot/counterpart-76.md'), `成員 ron03wlb/ron-skills#76 已合入（merge ${f.mergeSha}）。\n`);
  const second = f.close();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(lines(second).slice(0, 3), ['SKIP 76 main', 'SKIP 76 evidence', 'DONE 76 counterpart']);
  assert.equal(f.gh()['acme/app#7'].comments.length, 1);
  const third = f.close();
  assert.ok(lines(third).includes('SKIP 76 counterpart'));
  assert.equal(f.gh()['acme/app#7'].comments.length, 1);
});

test('母單還有開著的子單就不關母單', t => {
  const f = fixture(t, { siblings: { 70: 'OPEN' } });
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(lines(result).includes('SKIP 76 parent'));
  assert.equal(f.gh()[35].state, 'OPEN');
});
