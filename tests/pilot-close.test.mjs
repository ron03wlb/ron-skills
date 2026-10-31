import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeSample, orcaReplySource } from './helpers/fake-orca.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const samplesDir = new URL('./helpers/fixtures/gh/', import.meta.url).pathname;
const GH_SAMPLES = Object.fromEntries(['issue-view', 'issue', 'issue-parent', 'issue-parent-404', 'sub-issues']
  .map(name => [name, JSON.parse(readFileSync(join(samplesDir, `${name}.json`), 'utf8'))]));

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
// 每次呼叫都記下參數（換行轉義成 \n，一次呼叫一行）與讀到的 stdin 位元組數；假 Orca 每次都在 stderr 印一行 WSL crashpad 錯誤和一行一般錯誤。
//   pushed     issue 分支也 push 到 origin；
//   unmerged   合入之後 issue 分支又多一個 commit（branch -d 會拒絕）；
//   body       Issue #76 的本文；
//   siblings   母單 #35 其他子單 { 號碼: 'OPEN' | 'CLOSED' }；
//   orcaDeletesBranch  Orca rm 一起刪掉已合入的本機分支（真實行為；false 時 branch 步驟由腳本 branch -d）。
// 假 gh 的輸出從 helpers/fixtures/gh 的真實樣本長出來（同 land.test.mjs）；Orca rm 沒有樣本，比照 land.test.mjs 回空的 result，腳本只看 ok。
function fixture(t, { pushed = false, unmerged = false, body = '', siblings = { 70: 'CLOSED' }, orcaDeletesBranch = true, request = false } = {}) {
  // request：成員是沒有 Issue 的請求分支（Issue 欄 `-`，#143），batch 是 req-10。
  const branch = request ? 'retro/hook-c-var' : BRANCH;
  const key = request ? 'req-10' : '76';
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
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
  writeFileSync(join(worktree, 'close.txt'), 'close\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'member');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #100', branch);
  git(repo, 'push', '-q', 'origin', 'main');
  const mergeSha = git(repo, 'rev-parse', 'HEAD');
  if (pushed) git(repo, 'push', '-q', 'origin', branch);
  if (unmerged) {
    writeFileSync(join(worktree, 'late.txt'), 'late\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'late');
  }
  mkdirSync(join(repo, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(repo, `.scratch/pilot/batch-${key}.md`), `# batch ${key}
current: pushed ${mergeSha.slice(0, 7)}
integration: pilot/integration @ 5d2e5d4

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
| ${request ? '-' : 76} | ${branch} | ${worktree} | term_76 | 2026-10-31T06:38:56+08:00 | 90m | done | abc1234 |
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
  // gh-tracker.mjs 把旗標寫成 `--長名=值`、repo 寫成 `github.com/<owner>/<repo>`，兩種寫法都認。
  const record = `const fs = require('fs'); const args = process.argv.slice(2);
const arg = k => (args.includes(k) ? args[args.indexOf(k) + 1] : args.find(a => a.startsWith(k + '='))?.slice(k.length + 1));
let stdin = 0; try { stdin = fs.readFileSync(0).length; } catch {}
fs.appendFileSync(${JSON.stringify(log)}, require('path').basename(process.argv[1]) + ' ' + args.join(' ').replace(/\\n/g, '\\\\n') + ' <stdin ' + stdin + '>\\n');`;
  const gh = join(temp, 'bin/gh');
  mkdirSync(join(temp, 'bin'));
  writeFileSync(gh, `#!/usr/bin/env node
${record}
const GH_SAMPLES = ${JSON.stringify(GH_SAMPLES)};
const mergeSample = ${mergeSample.toString()};
const out = (name, patch) => console.log(JSON.stringify(mergeSample(GH_SAMPLES[name], patch, name)));
const state = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, 'utf8')); const save = () => fs.writeFileSync(${JSON.stringify(ghState)}, JSON.stringify(state));
const repoOf = () => arg('--repo').replace(/^github\\.com\\//, '');
const key = n => (repoOf() === ${JSON.stringify(REPO)} ? n : repoOf() + '#' + n);
const [a, b, n] = args;
if (a === 'issue' && b === 'view') {
  const issue = state.issues[key(n)];
  const full = { state: issue.state, body: issue.body, comments: issue.comments.map(body => ({ body })) };
  out('issue-view', Object.fromEntries(arg('--json').split(',').map(f => [f, full[f]])));
} else if (a === 'issue' && b === 'comment') {
  state.issues[key(n)].comments.push(arg('--body-file') ? fs.readFileSync(arg('--body-file'), 'utf8') : arg('--body')); save();
} else if (a === 'issue' && b === 'close') {
  Object.assign(state.issues[key(n)], { state: 'CLOSED', reason: 'completed' }); save();
} else if (a === 'api') {
  const [, owner, name, , m, sub] = b.replace(/\\?.*$/, '').split('/');
  if (owner + '/' + name !== ${JSON.stringify(REPO)}) { console.error('fake gh: repo ' + b); process.exit(1); }
  const children = Object.entries(state.issues).filter(([, i]) => i.parent === Number(m));
  if (sub === 'parent') {
    const parent = state.issues[m].parent;
    if (!parent) { const nf = GH_SAMPLES['issue-parent-404']; console.log(JSON.stringify(nf.stdout)); console.error(nf.stderr); process.exit(nf.exit); }
    out('issue-parent', { number: parent, state: state.issues[parent].state.toLowerCase() });
  } else if (sub === 'sub_issues') {
    out('sub-issues', children.map(([c, i]) => ({ number: Number(c), state: i.state.toLowerCase(), state_reason: i.state === 'CLOSED' ? i.reason : null })));
  } else {
    const closed = children.filter(([, i]) => i.state === 'CLOSED').length;
    out('issue', { number: Number(m), state: state.issues[m].state.toLowerCase(),
      sub_issues_summary: { total: children.length, completed: closed, percent_completed: children.length ? Math.round(100 * closed / children.length) : 0 } });
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
// Orca 開的 worktree 只認 path: 選擇器（#49）。
const selector = args.includes('--worktree') ? arg('--worktree') : undefined;
const block = selector && execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  .split(/\\n\\n+/).find(block => selector.startsWith('path:') && block.split('\\n').includes('worktree ' + selector.slice(5)));
if (selector && !block) fail('selector_not_found');
else if (a === 'terminal' && b === 'list') reply('list', { terminals: open.map(handle => ({ handle, worktreePath: selector.slice(5) })), totalCount: open.length });
else if (a === 'terminal' && b === 'close') { fs.writeFileSync(${JSON.stringify(terminals)}, JSON.stringify(open.filter(h => h !== arg('--terminal')))); reply('close', { close: { handle: arg('--terminal') } }); }
else if (a === 'worktree' && b === 'rm') {
  // 照 \`orca worktree rm --help\`：一起刪掉能證明已合入的本機分支；照 WSL 實況把主 checkout 設成 bare（#20）。
  execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'remove', '--force', selector.slice(5)]);
  if (${orcaDeletesBranch}) try { execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'branch', '-d', block.match(/^branch refs\\/heads\\/(.+)$/m)[1]], { stdio: 'ignore' }); } catch {}
  execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'config', 'core.bare', 'true']);
  console.log(JSON.stringify({ ok: true, result: {} }));
}
else fail('unknown');
`);
  chmodSync(gh, 0o755);
  chmodSync(cli, 0o755);
  const close = (args = [key, '100', mergeSha]) => spawnSync('node', [script, ...args], {
    cwd: repo, encoding: 'utf8', input: 'leftover-line\n', timeout: 60000,
    env: { ...env, PATH: `${join(temp, 'bin')}:${env.PATH}`, ORCA_CLI_COMMAND: cli },
  });
  const ghIssues = () => JSON.parse(readFileSync(ghState, 'utf8')).issues;
  const checkpoint = () => readFileSync(join(repo, `.scratch/pilot/batch-${key}.md`), 'utf8');
  const calls = () => readFileSync(log, 'utf8');
  const branchExists = () => spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { env }).status === 0;
  const remoteHas = () => spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { env }).status === 0;
  return { temp, origin, repo, worktree, mergeSha, close, issues: ghIssues, checkpoint, calls, branchExists, remoteHas, terminals: () => JSON.parse(readFileSync(terminals, 'utf8')) };
}

const lines = result => result.stdout.trim().split('\n');
const STEPS = ['evidence', 'counterpart', 'close', 'terminal', 'worktree', 'branch', 'remote', 'parent'];

test('照 Close 依序做完每一步，母單子單全部結束就留言關閉；重跑時每一步都 SKIP', t => {
  const f = fixture(t, { pushed: true });
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Orca rm 把主 checkout 設成 bare 由 Bare guard 還原，也一起刪掉已合入的本機分支，所以 branch 是 SKIP。
  assert.deepEqual(lines(result), ['SKIP 76 main', 'DONE 76 evidence', 'SKIP 76 counterpart', 'DONE 76 close', 'DONE 76 terminal',
    `UNBARE ${f.repo}`, 'DONE 76 worktree', 'SKIP 76 branch', 'DONE 76 remote', 'DONE 76 parent', 'CLOSED 76']);
  assert.equal(git(f.repo, 'rev-parse', '--is-bare-repository'), 'false');
  assert.match(f.calls(), /--worktree path:/);
  assert.doesNotMatch(f.calls(), /--worktree branch:/);
  const issues = f.issues();
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
  assert.equal(f.issues()[76].comments.length, 1);
  assert.equal(f.issues()[35].comments.length, 1);
});

// coordinator 的 retro：LANDED 之後不用先手改成 `pushed`，`current: merged` 的 batch 跑完 Close 一樣是 `closed`。
test('current 還是 merged 時 Close 照樣做完並寫成 closed', t => {
  const f = fixture(t, { pushed: true });
  const file = join(f.repo, '.scratch/pilot/batch-76.md');
  writeFileSync(file, f.checkpoint().replace(/^current: .*$/m, `current: merged ${f.mergeSha}`));
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result).at(-1), 'CLOSED 76');
  assert.match(f.checkpoint(), /^current: closed$/m);
});

// .claude/settings.json 只放行 gh-tracker.mjs（#96）：本 repo 的留言、關單都要經過它，跨 repo 的對應單照 #79 用裸 gh。
test('本 repo 的留言與關單（成員和母單）都經 gh-tracker.mjs；對應單留言照舊直接用 gh', t => {
  const f = fixture(t, { body: '## 背景\napp 對應單：acme/app#7\n' });
  writeFileSync(join(f.repo, '.scratch/pilot/counterpart-76.md'), `成員 ron03wlb/ron-skills#76 已合入（merge ${f.mergeSha}）。\n`);
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const writes = f.calls().split('\n').filter(line => /^gh issue (comment|close) /.test(line));
  assert.deepEqual(writes.map(line => line.split(' ').slice(0, 4).join(' ')),
    ['gh issue comment 76', 'gh issue comment 7', 'gh issue close 76', 'gh issue comment 35', 'gh issue close 35']);
  for (const line of writes.filter(line => !line.startsWith('gh issue comment 7 '))) assert.match(line, new RegExp(`--repo github\\.com/${REPO}\\b`), line);
  assert.match(writes[1], /--repo acme\/app --body-file /);
  assert.equal(f.issues()[76].state, 'CLOSED');
  assert.equal(f.issues()[35].state, 'CLOSED');
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
  const f = fixture(t, { orcaDeletesBranch: false });
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Orca rm 沒刪分支時由腳本 branch -d。
  assert.ok(lines(result).includes('DONE 76 branch'));
  assert.equal(f.branchExists(), false);
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
  assert.equal(g.issues()[76].comments.length, 0);
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
  assert.equal(f.issues()['acme/app#7'].comments.length, 1);
  const third = f.close();
  assert.ok(lines(third).includes('SKIP 76 counterpart'));
  assert.equal(f.issues()['acme/app#7'].comments.length, 1);
});

test('母單還有開著的子單就不關母單', t => {
  const f = fixture(t, { siblings: { 70: 'OPEN' } });
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(lines(result).includes('SKIP 76 parent'));
  assert.equal(f.issues()[35].state, 'OPEN');
});

test('任何失敗都印 STOP：checkpoint 不在、gh 回的不是 JSON', t => {
  const f = fixture(t);
  const missing = f.close(['76-85', '100', f.mergeSha]);
  assert.equal(missing.status, 4, missing.stdout + missing.stderr);
  assert.deepEqual(lines(missing), [`STOP 76-85 checkpoint 缺 ${f.repo}/.scratch/pilot/batch-76-85.md`]);

  writeFileSync(join(f.temp, 'bin/gh'), '#!/bin/sh\necho "<html>rate limited</html>"\n');
  const garbled = f.close();
  assert.equal(garbled.status, 4, garbled.stdout + garbled.stderr);
  assert.match(lines(garbled).pop(), /^STOP 76 evidence /);
});

// git 對設了 upstream 的分支只比 upstream：分支 push 過、沒合進 main，`branch -d` 也只印 warning 就刪掉（review 實測）。
test('分支有 upstream 但沒合進 main：branch 步驟 STOP，不交給 branch -d，本機與遠端分支都還在', t => {
  const f = fixture(t, { pushed: true, unmerged: true, orcaDeletesBranch: false });
  git(f.worktree, 'push', '-q', '-u', 'origin', BRANCH);
  const result = f.close();
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(lines(result).pop(), /^STOP 76 branch .*main/);
  assert.equal(f.branchExists(), true);
  assert.equal(f.remoteHas(), true);
});

test('上一輪中斷在 Orca 設成 bare 之後：重跑先還原 bare，再接著做', t => {
  const f = fixture(t);
  git(f.repo, 'worktree', 'remove', '--force', f.worktree);
  git(f.repo, 'config', 'core.bare', 'true');
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result)[0], `UNBARE ${f.repo}`);
  assert.equal(git(f.repo, 'rev-parse', '--is-bare-repository'), 'false');
  assert.equal(lines(result).pop(), 'CLOSED 76');
});

test('checkpoint 沒有 done 成員：STOP，不把 current 寫成 closed', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, '.scratch/pilot/batch-76.md'), f.checkpoint().replace('| done |', '| stop |'));
  const result = f.close();
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(lines(result).pop(), /^STOP 76 checkpoint /);
  assert.doesNotMatch(f.checkpoint(), /^current: closed$/m);
});

// 空的或手寫錯的 branch 會讓 remote 步驟拿它跑 ls-remote（空 pattern 列出全部 heads，exit 0）再 push --delete（#120）。
// 包一層 git 記下每次呼叫，確認停在任何寫入之前，連 ls-remote 都沒跑。
for (const [title, row, value] of [
  ['branch 欄是空字串', '| 76 |  |', ''],
  ['branch 的號碼和這一列的 Issue 不同', '| 71 | issue/72-x |', 'issue/72-x'],
]) {
  test(`done 成員的 ${title}：STOP branch-malformed，不跑任何 git 寫入、不留言`, t => {
    const f = fixture(t, { pushed: true });
    const gitLog = join(f.temp, 'git.log');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env }).stdout.trim();
    writeFileSync(join(f.temp, 'bin/git'), `#!/bin/sh\necho "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`);
    chmodSync(join(f.temp, 'bin/git'), 0o755);
    writeFileSync(join(f.repo, '.scratch/pilot/batch-76.md'), f.checkpoint().replace(`| 76 | ${BRANCH} |`, row));
    const result = f.close();
    assert.equal(result.status, 4, result.stdout + result.stderr);
    const n = row.match(/\d+/)[0];
    assert.deepEqual(lines(result), [`STOP branch-malformed ${n} ${JSON.stringify(value)}`]);
    const gitCalls = existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : '';
    // 腳本找主 checkout 的 `git worktree list` 有記到，才證明 PATH 上的 wrapper 有被用到。
    assert.match(gitCalls, /^worktree list/m);
    assert.doesNotMatch(gitCalls, /ls-remote|push|merge --ff-only|config core\.bare|branch -d/);
    assert.doesNotMatch(f.calls(), /issue comment|issue close|worktree rm|terminal close/);
    assert.equal(f.remoteHas(), true);
    assert.equal(f.issues()[76].state, 'OPEN');
    assert.doesNotMatch(f.checkpoint(), /^current: closed$/m);
  });
}

// #143：請求分支成員沒有 Issue，Close 只清理 worktree 與分支，不留言、不關單、不碰 tracker。
test('請求分支成員（Issue 欄 -）：只做 terminal、worktree、branch、remote，不呼叫 gh 與 gh-tracker', t => {
  const f = fixture(t, { pushed: true, request: true });
  const result = f.close();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const member = 'retro/hook-c-var';
  assert.deepEqual(lines(result), ['SKIP req-10 main', `DONE ${member} terminal`, `UNBARE ${f.repo}`, `DONE ${member} worktree`,
    `SKIP ${member} branch`, `DONE ${member} remote`, 'CLOSED req-10']);
  assert.doesNotMatch(f.calls(), /^(gh|gh-tracker\.mjs) /m);
  assert.deepEqual(f.issues()[76].comments, []);
  assert.equal(f.issues()[76].state, 'OPEN');
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.branchExists(), false);
  assert.equal(f.remoteHas(), false);
  assert.match(f.checkpoint(), /^current: closed$/m);
});

test('請求分支成員的 branch 不是 retro/<x>：任何寫入之前 STOP branch-malformed', t => {
  const f = fixture(t, { request: true });
  writeFileSync(join(f.repo, '.scratch/pilot/batch-req-10.md'), f.checkpoint().replace('| retro/hook-c-var |', '| main |'));
  const result = f.close();
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(lines(result), ['STOP branch-malformed - "main"']);
  assert.equal(f.calls(), '');
});
