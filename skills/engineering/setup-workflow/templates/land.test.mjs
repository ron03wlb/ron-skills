import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeSample } from './test/fake-orca.mjs';
import { GH_SAMPLES } from './test/gh-samples.mjs';
import { checksVerdict, firstSentence, pickMergedPr, pickPr, rollupBucket, rollupChecks } from './land.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./land.mjs', import.meta.url).pathname;
// 同 pilot-unbare.test.mjs：清掉 pre-commit 匯出的 GIT_*，否則 fixture 的 git 指令會寫進本 repo。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

// 假 gh 的輸出一律從真實樣本長出來（test/gh-samples.mjs；statusCheckRollup 取自真實 PR），替身不能自創 gh 沒有的欄位。

// statusCheckRollup 的 CheckRun 項目；`{ head, checks }` 是 PR 的 head 還停在別的 SHA 時那次查詢看到的結果。
const PASS = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const PENDING = [{ status: 'IN_PROGRESS', conclusion: '' }];
const FAIL = [{ status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/2/job/2' }];
const OLD_HEAD = 'cdaebee0000000000000000000000000000000000';
const CHECK_POLL = /^gh pr view \S+ --json headRefOid,statusCheckRollup/gm;

/**
 * bare remote、主 checkout（在 main）、feature 分支的 worktree，以及 PATH 上的假 gh、假 Orca。
 * 假 gh 的狀態存在 gh-state.json：`checks` 依序回應每次 `pr view --json headRefOid,statusCheckRollup`（`'none'` 是 CI 還沒登記，
 * `{ head, checks }` 是 PR 的 head 還沒更新到剛 push 的 SHA），最後一筆重複使用。
 * 假 gh 的 `pr merge` 真的在 remote 上做 --no-ff 合併；假 Orca 的 `worktree rm` 照真實行為把主 checkout 設成 bare、一起刪掉本機分支。
 * branchSelectorMissing：照 `orca-ide worktree create --branch` 開的 worktree，`branch:` 選擇器回 selector_not_found，只認 `path:`（#49）。
 * unstartedJobs：0 個 step 的 job id（帳務擋下，#132，樣本是 run 41164091250 的 job），missingJobs：jobs API 讀不到的 job id，
 * 其他 job 照有 step 的樣本；annotations 是那個 check run 的 annotations
 * （預設是 run 41164091250 的真實樣本，`'error'` 是讀不到）；visibility 是 `gh repo view --json visibility` 的值。
 */
function fixture(t, { seed = {}, mainMovesAtMerge = null, checks = [PASS], orcaFails = false, selfHosted = false, branchSelectorMissing = false, localCheckExit = 0, unstartedJobs = [], missingJobs = [], annotations = GH_SAMPLES['check-run-annotations'], visibility = 'PUBLIC', base = 'main' } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'land-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sh = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...env, ...IDENTITY } });
    assert.equal(result.status, 0, `git ${args.join(' ')}：${result.stderr}`);
    return result.stdout.trim();
  };
  const origin = join(temp, 'origin.git');
  const main = join(temp, 'main');
  const merger = join(temp, 'merger');
  const wt = join(temp, 'wt');
  sh(temp, 'init', '-q', '--bare', '-b', base, origin);
  sh(temp, 'clone', '-q', origin, main);
  writeFileSync(join(main, '.gitignore'), '.scratch/\n');
  sh(main, 'add', '.gitignore');
  // seed：init commit 一起帶的檔案（例如 repo 的 scripts/restamp.mjs 與戳記檔）。
  for (const [path, content] of Object.entries(seed)) {
    mkdirSync(join(main, path, '..'), { recursive: true });
    writeFileSync(join(main, path), content);
    sh(main, 'add', path);
  }
  // selfHosted：repo 自己帶 land.mjs 等腳本，從要被移除的 worktree 裡執行（land 合入自己的分支就是這樣）。
  if (selfHosted) {
    mkdirSync(join(main, 'scripts'));
    for (const name of ['land.mjs', 'orca-session-send.mjs']) cpSync(new URL(`./${name}`, import.meta.url).pathname, join(main, 'scripts', name));
    sh(main, 'add', 'scripts');
  }
  // 假 bin/check：記下參數、所在 SHA 與工作樹是否乾淨，印 CHECK_PASS 行後以 localCheckExit 結束（--local-checks 用）。
  const log = join(temp, 'calls.log');
  mkdirSync(join(main, 'bin'));
  writeFileSync(join(main, 'bin/check'), `#!/usr/bin/env bash
echo "check $* $(git rev-parse HEAD) dirty=[$(git status --porcelain)]" >> ${JSON.stringify(log)}
echo 'ℹ tests 7'
[ ${localCheckExit} = 0 ] && echo 'CHECK_PASS tests 7+2+1'
exit ${localCheckExit}
`);
  chmodSync(join(main, 'bin/check'), 0o755);
  sh(main, 'add', 'bin');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'push', '-q', 'origin', base);
  sh(temp, 'clone', '-q', origin, merger);
  sh(main, 'worktree', 'add', '-q', wt, '-b', 'feature');
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  sh(wt, 'add', 'a.txt');
  sh(wt, 'commit', '-q', '-m', 'feature: a');

  const bin = join(temp, 'bin');
  mkdirSync(bin);
  const state = join(temp, 'gh-state.json');
  writeFileSync(state, JSON.stringify({ prs: [], checks, comments: [] }));
  writeFileSync(log, '');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const SAMPLES = ${JSON.stringify(GH_SAMPLES)};
const mergeSample = ${mergeSample.toString()};
const args = process.argv.slice(2); const arg = k => args[args.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, 'gh ' + args.join(' ') + '\\n');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const out = pr => { const { head, base, ...fields } = pr; return mergeSample(SAMPLES['pr-view'], fields, 'pr'); };
const git = (...a) => execFileSync('git', ['-C', ${JSON.stringify(merger)}, ...a], { encoding: 'utf8' }).trim();
// 開著的 PR，head 跟著 origin 上的分支走（push 新 commit 後 GitHub 會更新 headRefOid）。
const find = ref => {
  const pr = s.prs.find(pr => pr.number === Number(String(ref).split('/').pop()));
  if (pr?.state === 'OPEN') { git('fetch', '-q', 'origin'); pr.headRefOid = git('rev-parse', 'origin/' + pr.head); save(); }
  return pr;
};
const [cmd, sub] = args;
// 失敗 job 的 step 與 annotations（#132）。
if (cmd === 'api' && sub.includes('/actions/jobs/')) {
  const id = Number(sub.split('/').pop());
  if (${JSON.stringify(missingJobs)}.includes(id)) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  console.log(JSON.stringify(SAMPLES[${JSON.stringify(unstartedJobs)}.includes(id) ? 'actions-job-not-started' : 'actions-job']));
}
else if (cmd === 'api' && sub.endsWith('/annotations')) {
  const annotations = ${JSON.stringify(annotations)};
  if (annotations === 'error') { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  console.log(JSON.stringify(mergeSample(SAMPLES['check-run-annotations'], annotations, 'annotations')));
}
else if (cmd === 'repo' && sub === 'view') console.log(JSON.stringify(mergeSample(SAMPLES['repo-view'], { visibility: ${JSON.stringify(visibility)} }, 'repo')));
else if (sub === 'list') console.log(JSON.stringify(s.prs.filter(pr => pr.head === arg('--head')).map(out)));
else if (sub === 'create') {
  const head = arg('--head'); git('fetch', '-q', 'origin');
  const pr = { head, base: arg('--base'), number: 40 + s.prs.length, state: 'OPEN', url: 'https://github.com/o/r/pull/' + (40 + s.prs.length), headRefOid: git('rev-parse', 'origin/' + head), mergeCommit: null };
  s.prs.push(pr); save(); console.log(pr.url);
}
else if (sub === 'view' && arg('--json').includes('statusCheckRollup')) {
  const pr = find(args[2]);
  const next = s.checks.length > 1 ? s.checks.shift() : s.checks[0]; save();
  const entry = next === 'none' ? { checks: [] } : Array.isArray(next) ? { checks: next } : next;
  const { head = pr.headRefOid, checks } = entry;
  console.log(JSON.stringify(mergeSample(SAMPLES['pr-view-checks'], { headRefOid: head, statusCheckRollup: checks }, 'pr')));
}
else if (sub === 'view') console.log(JSON.stringify(out(find(args[2]))));
// 真實 gh pr comment 只印新留言的網址（純文字，land.mjs 不解析）。
else if (sub === 'comment') { s.comments.push({ number: Number(args[2]), body: arg('--body') }); save(); console.log(find(args[2]).url + '#issuecomment-1'); }
else if (sub === 'merge') {
  const pr = find(args[2]);
  git('fetch', '-q', 'origin'); git('checkout', '-q', '-B', ${JSON.stringify(base)}, 'origin/' + ${JSON.stringify(base)});
  // mainMovesAtMerge：等 CI 的期間別的 PR 先合入 main（只發生一次）。
  const moves = ${JSON.stringify(mainMovesAtMerge)};
  if (moves && !s.moved) {
    for (const [path, content] of Object.entries(moves)) fs.writeFileSync(${JSON.stringify(merger)} + '/' + path, content);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'main moves during CI');
    git('push', '-q', 'origin', ${JSON.stringify(base)});
    s.moved = true; save();
  }
  // 和 main 衝突時 GitHub 拒絕合併（retro 1031b，PR #168 的真實訊息）。
  try { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'Merge pull request #' + pr.number, 'origin/' + pr.head); }
  catch { git('merge', '--abort'); console.error('GraphQL: Pull Request has merge conflicts'); process.exit(1); }
  git('push', '-q', 'origin', ${JSON.stringify(base)});
  Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: git('rev-parse', 'HEAD') } }); save();
}
else { console.error('fake gh：未支援 ' + args.join(' ')); process.exit(1); }
`);
  writeFileSync(join(bin, 'orca'), `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, 'orca ' + args.join(' ') + '\\n');
if (${orcaFails}) { console.log(JSON.stringify({ ok: false, error: { code: 'runtime_unavailable' } })); process.exit(0); }
const selector = args[args.indexOf('--worktree') + 1];
const list = execFileSync('git', ['-C', ${JSON.stringify(main)}, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
const block = list.split('\\n\\n').find(b => selector.startsWith('path:') ? b.split('\\n').includes('worktree ' + selector.slice(5))
  : !${branchSelectorMissing} && b.split('\\n').includes('branch refs/heads/' + selector.replace(/^branch:/, '')));
if (!block) { console.log(JSON.stringify({ ok: false, error: { code: 'selector_not_found' } })); process.exit(0); }
const branch = block.match(/^branch refs\\/heads\\/(.+)$/m)[1];
execFileSync('git', ['-C', ${JSON.stringify(main)}, 'worktree', 'remove', block.match(/^worktree (.+)$/m)[1]]);
execFileSync('git', ['-C', ${JSON.stringify(main)}, 'branch', '-D', branch]);
execFileSync('git', ['-C', ${JSON.stringify(main)}, 'config', 'core.bare', 'true']);
console.log(JSON.stringify({ ok: true, result: {} }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'orca'), 0o755);
  const body = join(temp, 'body.md');
  writeFileSync(body, '## Summary\n');

  const land = (args, cwd = wt) => spawnSync('node', [selfHosted ? join(wt, 'scripts/land.mjs') : script, ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...env, ...IDENTITY, PATH: `${bin}:${env.PATH}`, ORCA_CLI_COMMAND: join(bin, 'orca'), LAND_CHECKS_POLL_MS: '1', LAND_CHECKS_TIMEOUT_MS: '2000' },
  });
  const calls = () => readFileSync(log, 'utf8');
  const prs = () => JSON.parse(readFileSync(state, 'utf8')).prs;
  const comments = () => JSON.parse(readFileSync(state, 'utf8')).comments;
  const remoteHas = branch => spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  const last = result => result.stdout.trim().split('\n').pop();
  /** 在 origin/main 上直接 commit 這些檔案（別的 PR 先合入了）。 */
  const pushMain = files => {
    sh(merger, 'fetch', '-q', 'origin');
    sh(merger, 'checkout', '-q', '-B', base, `origin/${base}`);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(merger, path, '..'), { recursive: true });
      writeFileSync(join(merger, path), content);
      sh(merger, 'add', path);
    }
    sh(merger, 'commit', '-q', '-m', 'main moves on');
    sh(merger, 'push', '-q', 'origin', base);
  };
  /** 在 feature worktree commit 這些檔案。 */
  const commitFeature = files => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(wt, path, '..'), { recursive: true });
      writeFileSync(join(wt, path), content);
      sh(wt, 'add', path);
    }
    sh(wt, 'commit', '-q', '-m', 'feature moves on');
  };
  return { temp, main, wt, origin, body, sh, land, calls, prs, comments, remoteHas, last, pushMain, commitFeature };
}

test('手動分支：push、開 PR、等 CI 登記並通過、合併、收尾、main 跟上', t => {
  const { main, wt, body, sh, land, calls, prs, remoteHas, last } = fixture(t, { checks: ['none', PENDING, PASS] });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [pr] = prs();
  assert.equal(pr.state, 'MERGED');
  assert.equal(last(result), `LANDED ${pr.number} ${pr.mergeCommit.oid}`);
  assert.equal((calls().match(CHECK_POLL) || []).length, 3);
  assert.equal(existsSync(wt), false);
  assert.equal(sh(main, 'branch', '--list', 'feature'), '');
  assert.equal(remoteHas('feature'), false);
  assert.equal(sh(main, 'rev-parse', 'HEAD'), pr.mergeCommit.oid);
});

// #137（G4）：Actions 帳務停擺時 CI 不會啟動，改以本機 bin/check --upstream 當 CI。
test('--local-checks：tip 等於 SHA、本機 bin/check 通過時不讀 checks，留言註明取代 CI 後合併', t => {
  const { wt, body, sh, land, calls, prs, comments, last } = fixture(t, { checks: [FAIL] });
  const tip = sh(wt, 'rev-parse', 'HEAD');

  const result = land(['feature', '--body-file', body, '--local-checks', tip, '--check-command', 'bin/check --upstream']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(calls(), CHECK_POLL);
  assert.doesNotMatch(calls(), /^gh pr checks /m);
  assert.match(calls(), new RegExp(`^check --upstream ${tip} dirty=\\[\\]$`, 'm'));
  const [pr] = prs();
  assert.equal(last(result), `LANDED ${pr.number} ${pr.mergeCommit.oid}`);
  assert.equal(comments().length, 1);
  assert.equal(comments()[0].number, pr.number);
  assert.match(comments()[0].body, new RegExp(tip));
  assert.match(comments()[0].body, /bin\/check --upstream/);
  assert.match(comments()[0].body, /CHECK_PASS tests 7\+2\+1/);
});

test('--local-checks：分支 tip 不是指定的 SHA 時 STOP local-checks-sha，不跑 bin/check、不 push、不合併', t => {
  const { wt, body, sh, land, calls, prs, remoteHas, last } = fixture(t);
  const stale = sh(wt, 'rev-parse', 'HEAD~1');

  const result = land(['feature', '--body-file', body, '--local-checks', stale]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(last(result), new RegExp(`^STOP local-checks-sha feature .* ${stale}$`));
  // 傳 ref 而不是 SHA：ref 一定等於 tip，比對沒有作用，同樣 STOP。
  const byRef = land(['feature', '--body-file', body, '--local-checks', 'feature']);
  assert.equal(byRef.status, 4, byRef.stdout + byRef.stderr);
  assert.match(last(byRef), /^STOP local-checks-sha feature 不是 SHA/);
  assert.doesNotMatch(calls(), /^check /m);
  assert.equal(remoteHas('feature'), false);
  assert.equal(prs().length, 0);
  assert.doesNotMatch(calls(), /^gh pr merge /m);
});

test('--local-checks：本機 bin/check 失敗時 STOP local-checks-failed，不 push、不合併，暫時 worktree 不留下', t => {
  const { main, wt, body, sh, land, calls, prs, remoteHas, last } = fixture(t, { localCheckExit: 1 });
  const tip = sh(wt, 'rev-parse', 'HEAD');

  const result = land(['feature', '--body-file', body, '--local-checks', tip]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(last(result), new RegExp(`^STOP local-checks-failed ${tip} exit 1 `));
  // 沒帶 --check-command 時跑 bin/check（目標專案常見的單一檢查入口），不帶參數。
  assert.match(calls(), new RegExp(`^check +${tip} dirty=\\[\\]$`, 'm'));
  assert.equal(remoteHas('feature'), false);
  assert.equal(prs().length, 0);
  assert.doesNotMatch(calls(), /^gh pr merge /m);
  assert.equal(sh(main, 'worktree', 'list').split('\n').length, 2);
});

// 真實發生過的錯：Orca 從 WSL 移除 worktree 後主 checkout 變成 bare，之後的 git 全部失敗（memory、#20、retro 2026-10-30）。
test('Orca 移除 worktree 把主 checkout 設成 bare：收尾後還原，main 照樣跟上', t => {
  const { main, body, sh, land } = fixture(t);

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^UNBARE /m);
  assert.equal(sh(main, 'rev-parse', '--is-bare-repository'), 'false');
  assert.match(result.stdout, /^MAIN /m);
});

// 真實發生過的錯：Orca 開的 worktree 用 branch: 選擇器找不到，收尾 STOP worktree-rm selector_not_found（#49，PR #48 收尾）。
test('Orca 的 branch: 選擇器找不到 worktree：改用 path: 移除並 LANDED', t => {
  const { main, wt, body, sh, land, prs, remoteHas, last } = fixture(t, { branchSelectorMissing: true });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(last(result), `LANDED ${prs()[0].number} ${prs()[0].mergeCommit.oid}`);
  assert.match(result.stdout, new RegExp(`^WORKTREE_REMOVED ${wt}$`, 'm'));
  assert.equal(existsSync(wt), false);
  assert.equal(remoteHas('feature'), false);
  assert.equal(sh(main, 'rev-parse', 'HEAD'), prs()[0].mergeCommit.oid);
});

// 真實發生過的錯：land 合入自己的分支時，收尾移除了腳本所在的 worktree，之後才去跑同目錄的 pilot-unbare.sh（#40 實作時發現）。
test('從要被移除的 worktree 執行：收尾仍能還原 bare 並 LANDED', t => {
  const { main, wt, body, sh, land, prs, last } = fixture(t, { selfHosted: true });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(last(result), `LANDED ${prs()[0].number} ${prs()[0].mergeCommit.oid}`);
  assert.equal(existsSync(wt), false);
  assert.equal(sh(main, 'rev-parse', '--is-bare-repository'), 'false');
});

test('CI 紅燈：STOP ci-failed，附新 head 的 run 網址，不合併、不收尾', t => {
  const { wt, body, land, calls, prs, remoteHas, last } = fixture(t, { checks: [PENDING, FAIL] });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.equal(last(result), `STOP ci-failed 40 ${FAIL[0].detailsUrl}`);
  assert.doesNotMatch(calls(), /^gh pr merge /m);
  assert.equal(prs()[0].state, 'OPEN');
  assert.equal(existsSync(wt), true);
  assert.equal(remoteHas('feature'), true);
});

// G4（#132）：帳務或 spending limit 擋下的 job 是 0 個 step 的 failure，log 讀不到，原因只在 check-run annotations。
const BILLING = 'The job was not started because recent account payments have failed or your spending limit needs to be increased.';
const PRIVATE_HINT = /帳號下所有 private repo 共用 Actions 額度.*Billing & plans → Usage/;

test('CI 沒啟動（0 個 step）：STOP ci-not-started 帶 annotation 第一句與 repo 可見性，不合併', t => {
  const { wt, body, land, calls, prs, last } = fixture(t, { checks: [FAIL], unstartedJobs: [2] });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.equal(last(result), `STOP ci-not-started 40 ${BILLING} repo public ${FAIL[0].detailsUrl}`);
  assert.doesNotMatch(result.stdout, PRIVATE_HINT);
  assert.match(calls(), /^gh api repos\/\{owner\}\/\{repo\}\/check-runs\/2\/annotations/m);
  assert.doesNotMatch(calls(), /^gh pr merge /m);
  assert.equal(prs()[0].state, 'OPEN');
  assert.equal(existsSync(wt), true);
});

test('CI 沒啟動、repo 是 private：提示帳號下 private repo 共用 Actions 額度', t => {
  const { body, land, last } = fixture(t, { checks: [FAIL], unstartedJobs: [2], visibility: 'PRIVATE' });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.match(last(result), new RegExp(`^STOP ci-not-started 40 ${BILLING.replace(/\./g, '\\.')} repo private`));
  assert.match(last(result), PRIVATE_HINT);
});

test('CI 沒啟動、讀不到 annotations：仍是 ci-not-started，原因寫 unknown', t => {
  const { body, land, last } = fixture(t, { checks: [FAIL], unstartedJobs: [2], annotations: 'error' });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.equal(last(result), `STOP ci-not-started 40 unknown repo public ${FAIL[0].detailsUrl}`);
});

test('一個 job 沒啟動、另一個有 step 而失敗：照 ci-failed，不能改用本機結果', t => {
  const started = { ...FAIL[0], detailsUrl: 'https://github.com/o/r/actions/runs/3/job/3' };
  const { body, land, last } = fixture(t, { checks: [[FAIL[0], started]], unstartedJobs: [2] });
  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.equal(last(result), `STOP ci-failed 40 ${FAIL[0].detailsUrl} ${started.detailsUrl}`);
});

test('讀不到失敗 job 的 step：不能確認沒啟動，照 ci-failed', t => {
  const { body, land, last } = fixture(t, { checks: [FAIL], missingJobs: [2] });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.equal(last(result), `STOP ci-failed 40 ${FAIL[0].detailsUrl}`);
});

test('firstSentence：取到第一個句點（後面接空白或結尾）；沒有內容回 null', () => {
  assert.equal(firstSentence(`${BILLING} Please check the 'Billing & plans' section in your settings`), BILLING);
  assert.equal(firstSentence('no period here'), 'no period here');
  assert.equal(firstSentence('see ubuntu-latest v1.2 now. next'), 'see ubuntu-latest v1.2 now.');
  assert.equal(firstSentence('  '), null);
});

// 真實發生過的錯（#128，PR #125）：push 後 PR 的 head 還停在前一個 SHA，讀到它失敗的 run 就 STOP ci-failed；重跑才 LANDED。
test('PR 的 head 還是前一個 SHA 時不採計它的 checks：等到新 head 通過才合併', t => {
  const { body, land, calls, prs, last } = fixture(t, { checks: [{ head: OLD_HEAD, checks: FAIL }, { head: OLD_HEAD, checks: PASS }, PENDING, PASS] });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /STOP ci-failed/);
  assert.match(result.stdout, /^CHECKS_PASSED 40 1$/m);
  assert.equal(last(result), `LANDED 40 ${prs()[0].mergeCommit.oid}`);
  assert.equal((calls().match(CHECK_POLL) || []).length, 4);
});

test('PR 的 head 一直沒更新到 push 的 SHA：STOP checks-timeout，不合併', t => {
  const { body, land, calls, prs, last } = fixture(t, { checks: [{ head: OLD_HEAD, checks: PASS }] });

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.equal(last(result), 'STOP checks-timeout 40');
  assert.doesNotMatch(calls(), /^gh pr merge /m);
  assert.equal(prs()[0].state, 'OPEN');
});

// 真實發生過的錯：Push gate 中途斷掉，重跑時重開 PR 或重複合併（#27 commit 8dcea3d「Push gate 中斷可接回」）。
test('合併後收尾中斷，重跑：不重開 PR、不重複合併，只補完收尾', t => {
  const { main, wt, body, sh, land, calls, prs, temp, last } = fixture(t, { orcaFails: true });

  const first = land(['feature', '--body-file', body]);
  assert.equal(first.status, 4);
  assert.match(last(first), /^STOP worktree-rm /);
  assert.equal(prs()[0].state, 'MERGED');
  assert.equal(existsSync(wt), true);

  // Orca 恢復：換回會成功的假 Orca。
  const orca = join(temp, 'bin/orca');
  writeFileSync(orca, readFileSync(orca, 'utf8').replace('if (true)', 'if (false)'));
  const second = land(['feature', '--body-file', body], main);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(last(second), `LANDED ${prs()[0].number} ${prs()[0].mergeCommit.oid}`);
  assert.equal(prs().length, 1);
  assert.equal((calls().match(/^gh pr merge /gm) || []).length, 1);
  assert.equal((calls().match(/^gh pr create /gm) || []).length, 1);
  assert.equal(existsSync(wt), false);
  assert.equal(sh(main, 'rev-parse', 'HEAD'), prs()[0].mergeCommit.oid);
});

// 真實發生過的錯：收尾 STOP 後人手動用 Orca 移除 worktree，Orca 一起刪掉本機分支，重跑在 rev-parse refs/heads/<branch> 失敗（#49）。
test('本機分支已被刪、PR 已合入，重跑：接著刪 origin 分支、main 跟上，LANDED', t => {
  const { main, wt, body, sh, land, calls, prs, remoteHas, temp, last } = fixture(t, { orcaFails: true });

  const first = land(['feature', '--body-file', body]);
  assert.equal(first.status, 4);
  assert.match(last(first), /^STOP worktree-rm /);
  // 人手動移除：Orca 刪掉 worktree 與本機分支，並把主 checkout 設成 bare，再自己還原。
  const orca = join(temp, 'bin/orca');
  writeFileSync(orca, readFileSync(orca, 'utf8').replace('if (true)', 'if (false)'));
  assert.equal(spawnSync(orca, ['worktree', 'rm', '--worktree', `path:${wt}`], { env: { ...env, ...IDENTITY } }).status, 0);
  sh(main, 'config', 'core.bare', 'false');
  assert.equal(sh(main, 'branch', '--list', 'feature'), '');
  assert.equal(remoteHas('feature'), true);

  const second = land(['feature', '--body-file', body], main);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(last(second), `LANDED ${prs()[0].number} ${prs()[0].mergeCommit.oid}`);
  assert.equal(prs().length, 1);
  assert.equal((calls().match(/^gh pr merge /gm) || []).length, 1);
  assert.equal(remoteHas('feature'), false);
  assert.equal(sh(main, 'rev-parse', 'HEAD'), prs()[0].mergeCommit.oid);
});

test('本機分支不在、也沒有已合入的 PR：STOP no-branch，不開 PR', t => {
  const { main, wt, body, sh, land, calls, last } = fixture(t);
  sh(main, 'worktree', 'remove', wt);
  sh(main, 'branch', '-D', 'feature');

  const result = land(['feature', '--body-file', body], main);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(last(result), /^STOP no-branch feature/);
  assert.doesNotMatch(calls(), /^gh pr create /m);
});

// #37：pilot 的 batch 已 push、PR 還開著就中斷（如 CI 等到逾時），checkpoint 還是 `merged <sha>`（LANDED 之後才設 pushed），
// Probe 印 RESUME_PUSH 後重跑 Push gate：沿用開著的 PR 從等 CI、合併那步接著做，不重開 PR。
test('--keep-branch：PR 開著時中斷，重跑沿用同一個 PR 接著合併', t => {
  const { main, wt, body, sh, land, calls, prs, last, temp } = fixture(t, { checks: [PENDING] });
  sh(main, 'worktree', 'remove', wt);
  sh(main, 'branch', '-m', 'feature', 'integration');

  const first = land(['integration', '--keep-branch', '--body-file', body], main);
  assert.equal(first.status, 4);
  assert.match(last(first), /^STOP checks-timeout/);
  assert.equal(prs()[0].state, 'OPEN');

  const state = join(temp, 'gh-state.json');
  writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), checks: [PASS] }));
  const second = land(['integration', '--keep-branch', '--body-file', body], main);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(prs().length, 1);
  assert.equal(last(second), `LANDED ${prs()[0].number} ${prs()[0].mergeCommit.oid}`);
  assert.equal((calls().match(/^gh pr create /gm) || []).length, 1);
});

// pilot/integration 每批都開新 PR，舊的已合入 PR 不能被誤認成「已經合過」；upstream 不能被改成 origin/main（#27）。
test('--keep-branch：保留分支並跟上 origin/main；下一批有新 commit 時開新 PR', t => {
  const { main, wt, body, sh, land, calls, prs, remoteHas, last } = fixture(t);
  sh(main, 'worktree', 'remove', wt);
  sh(main, 'branch', '-m', 'feature', 'integration');

  const first = land(['integration', '--keep-branch', '--body-file', body], main);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.doesNotMatch(calls(), /^orca /m);
  assert.equal(remoteHas('integration'), true);
  assert.equal(sh(main, 'rev-parse', 'integration'), prs()[0].mergeCommit.oid);
  assert.equal(sh(main, 'rev-parse', 'origin/integration'), prs()[0].mergeCommit.oid);
  assert.equal(sh(main, 'rev-parse', '--abbrev-ref', 'integration@{upstream}'), 'origin/integration');

  sh(main, 'worktree', 'add', '-q', wt, 'integration');
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  sh(wt, 'add', 'b.txt');
  sh(wt, 'commit', '-q', '-m', 'batch 2');
  const second = land(['integration', '--keep-branch', '--body-file', body], main);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(prs().length, 2);
  assert.equal(last(second), `LANDED ${prs()[1].number} ${prs()[1].mergeCommit.oid}`);
  assert.equal(existsSync(wt), true);
});

// 真實發生過的錯（PR #50）：pilot/integration 沒包含 origin/main 的 #48（CI 改 Node 24），push 事件跑舊 workflow 紅燈。
test('--keep-branch：分支沒包含 origin/main 時 STOP behind-main，不 push、不開 PR', t => {
  const { main, wt, body, sh, land, calls, remoteHas, last, temp } = fixture(t);
  sh(main, 'worktree', 'remove', wt);
  sh(main, 'branch', '-m', 'feature', 'integration');
  const other = join(temp, 'other');
  sh(temp, 'clone', '-q', join(temp, 'origin.git'), other);
  writeFileSync(join(other, 'ci.txt'), 'node 24\n');
  sh(other, 'add', 'ci.txt');
  sh(other, 'commit', '-q', '-m', 'ci: node 24');
  sh(other, 'push', '-q', 'origin', 'main');

  const result = land(['integration', '--keep-branch', '--body-file', body], main);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(last(result), /^STOP behind-main integration/);
  assert.equal(remoteHas('integration'), false);
  assert.doesNotMatch(calls(), /^gh pr create /m);
});

// 真實發生過的錯（retro 2026-10-30）：開分支後主 checkout 被別的 session 切走，commit 落在別條分支，推出去的分支停在 main。
test('分支沒有 origin/main 以外的 commit：STOP no-commits，不 push、不開 PR', t => {
  const { main, body, sh, land, calls, remoteHas, last } = fixture(t);
  sh(main, 'branch', 'empty', 'origin/main');

  const result = land(['empty', '--body-file', body], main);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(last(result), /^STOP no-commits empty/);
  assert.equal(remoteHas('empty'), false);
  assert.doesNotMatch(calls(), /^gh pr create /m);
});

test('沒有 PR 也沒給 --body-file：STOP no-body，不開 PR', t => {
  const { land, calls, last } = fixture(t);

  const result = land(['feature']);
  assert.equal(result.status, 4);
  assert.match(last(result), /^STOP no-body/);
  assert.doesNotMatch(calls(), /^gh pr create /m);
});

test('worktree 有未提交的改動：STOP dirty-worktree，連 push 都不做', t => {
  const { wt, body, land, remoteHas, last } = fixture(t);
  writeFileSync(join(wt, 'a.txt'), 'changed\n');

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4);
  assert.match(last(result), /^STOP dirty-worktree /);
  assert.equal(remoteHas('feature'), false);
});

// #173：retro 1031b（PR #168）兩次 STOP merge，衝突都只在戳記檔，手動 checkout --theirs、restamp、重跑檢查。
// repo 的 scripts/restamp.mjs（選配，同 pilot-unbare.sh）宣告戳記檔並負責重算；這裡的替身把 src/ 底下每個檔的內容記成一行。
const STAMP_HOOK = `import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
export const STAMP_FILES = ['stamp.json'];
export function restamp(tree, files) {
  const sources = Object.fromEntries(readdirSync(join(tree, 'src')).sort().map(name => [name, readFileSync(join(tree, 'src', name), 'utf8')]));
  writeFileSync(join(tree, 'stamp.json'), JSON.stringify({ files, sources }, null, 2) + '\\n');
  return spawnSync('git', ['-C', tree, 'add', 'stamp.json']).status === 0;
}
`;
const stamp = (sources, files = ['stamp.json']) => `${JSON.stringify({ files, sources }, null, 2)}\n`;
const STAMP_SEED = { 'scripts/restamp.mjs': STAMP_HOOK, 'src/a.txt': 'a0\n', 'src/b.txt': 'b0\n', 'stamp.json': stamp({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' }) };

test('PR 只有戳記檔和 main 衝突：合入 origin/main、restamp、跑檢查入口、push，印 RESTAMPED 後等 CI 並合併', t => {
  const { main, wt, origin, body, sh, land, calls, prs, last, pushMain, commitFeature } = fixture(t, { seed: STAMP_SEED });
  commitFeature({ 'src/a.txt': 'a1\n', 'stamp.json': stamp({ 'a.txt': 'a1\n', 'b.txt': 'b0\n' }) });
  pushMain({ 'src/b.txt': 'b1\n', 'stamp.json': stamp({ 'a.txt': 'a0\n', 'b.txt': 'b1\n' }) });

  const result = land(['feature', '--body-file', body, '--check-command', 'bin/check --upstream']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [pr] = prs();
  const restamped = result.stdout.match(/^RESTAMPED (\d+) ([0-9a-f]{40})$/m);
  assert.ok(restamped, result.stdout);
  assert.equal(Number(restamped[1]), pr.number);
  // 檢查入口在 restamp 之後的 tip、工作樹乾淨時跑；CI 等的是那個 tip。
  assert.match(calls(), new RegExp(`^check --upstream ${restamped[2]} dirty=\\[\\]$`, 'm'));
  // 在等 CI 之前就先合入 main：只等一輪 CI（Bash 600 秒內放得下）、只送一次合併。
  const checkAt = calls().indexOf(`check --upstream ${restamped[2]}`);
  assert.ok(checkAt < calls().search(CHECK_POLL), calls());
  assert.equal((calls().match(/^gh pr merge /gm) || []).length, 1);
  assert.equal(last(result), `LANDED ${pr.number} ${pr.mergeCommit.oid}`);
  // 合併後 main 的戳記是 restamp 以合併後的來源重算的，不是任何一邊的舊戳記。
  assert.equal(sh(origin, 'show', 'main:stamp.json') + '\n', stamp({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' }));
  assert.equal(sh(main, 'rev-parse', 'HEAD'), pr.mergeCommit.oid);
  assert.equal(existsSync(wt), false);
});

test('等 CI 期間 main 前進而合併被拒（--local-checks）：合入、restamp，改附新 tip 的本機檢查結果，不等 CI', t => {
  const { wt, origin, body, sh, land, calls, prs, comments, last, commitFeature } = fixture(t, {
    seed: STAMP_SEED, checks: [FAIL], mainMovesAtMerge: { 'src/b.txt': 'b1\n', 'stamp.json': stamp({ 'a.txt': 'a0\n', 'b.txt': 'b1\n' }) },
  });
  commitFeature({ 'src/a.txt': 'a1\n', 'stamp.json': stamp({ 'a.txt': 'a1\n', 'b.txt': 'b0\n' }) });
  const tip = sh(wt, 'rev-parse', 'HEAD');

  const result = land(['feature', '--body-file', body, '--local-checks', tip]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const restamped = result.stdout.match(/^RESTAMPED (\d+) ([0-9a-f]{40})$/m);
  assert.ok(restamped, result.stdout);
  // CI 沒啟動（FAIL 只會被 waitChecks 讀到）：兩次都改用本機檢查，第二則留言附 restamp 後的 tip。
  assert.doesNotMatch(calls(), CHECK_POLL);
  assert.equal(comments().length, 2);
  assert.match(comments()[1].body, new RegExp(restamped[2]));
  assert.match(result.stdout, new RegExp(`^LOCAL_CHECKS ${restamped[1]} ${restamped[2]} CHECK_PASS`, 'm'));
  const [pr] = prs();
  assert.equal(last(result), `LANDED ${pr.number} ${pr.mergeCommit.oid}`);
  assert.equal(sh(origin, 'show', 'main:stamp.json') + '\n', stamp({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' }));
});

test('戳記檔和其他檔一起衝突：merge --abort，STOP merge 列出衝突檔，分支不留合併中途狀態、不 push', t => {
  const { wt, origin, body, sh, land, prs, last, pushMain, commitFeature } = fixture(t, { seed: { ...STAMP_SEED, 'other.txt': 'o0\n' } });
  commitFeature({ 'other.txt': 'o1\n', 'stamp.json': stamp({ 'a.txt': 'a1\n', 'b.txt': 'b0\n' }) });
  pushMain({ 'other.txt': 'o2\n', 'stamp.json': stamp({ 'a.txt': 'a0\n', 'b.txt': 'b1\n' }) });
  const tip = sh(wt, 'rev-parse', 'HEAD');

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  const [pr] = prs();
  assert.equal(last(result), `STOP merge ${pr.number} conflict other.txt stamp.json`);
  assert.doesNotMatch(result.stdout, /^RESTAMPED /m);
  assert.equal(pr.state, 'OPEN');
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(sh(wt, 'status', '--porcelain'), '');
  assert.equal(spawnSync('git', ['-C', wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 1);
  assert.equal(sh(origin, 'rev-parse', 'feature'), tip);
});

test('repo 沒有 scripts/restamp.mjs：衝突照舊 STOP merge，分支不留合併中途狀態', t => {
  const { wt, body, sh, land, prs, last, pushMain, commitFeature } = fixture(t, { seed: { 'stamp.json': 'x\n' } });
  commitFeature({ 'stamp.json': 'feature\n' });
  pushMain({ 'stamp.json': 'main\n' });
  const tip = sh(wt, 'rev-parse', 'HEAD');

  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(last(result), `STOP merge ${prs()[0].number} conflict stamp.json`);
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(sh(wt, 'status', '--porcelain'), '');
});

// #281：mec-wiki 的預設分支是 master，land.mjs 寫死 main 逼得 setup 改名預設分支。
test('預設分支是 master：讀 origin/HEAD，PR 開向 master、合併後主 checkout 的 master 跟上', t => {
  const { main, body, sh, land, prs, last } = fixture(t, { base: 'master' });
  const result = land(['feature', '--body-file', body]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [pr] = prs();
  assert.equal(pr.base, 'master');
  assert.equal(last(result), `LANDED ${pr.number} ${pr.mergeCommit.oid}`);
  assert.equal(sh(main, 'symbolic-ref', '--short', 'HEAD'), 'master');
  assert.equal(sh(main, 'rev-parse', 'HEAD'), pr.mergeCommit.oid);
});

test('--main <branch> 優先於 origin/HEAD', t => {
  const { body, sh, land, prs, main } = fixture(t, { base: 'master' });
  sh(main, 'remote', 'set-head', 'origin', '--delete');
  const result = land(['feature', '--body-file', body, '--main', 'master']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(prs()[0].base, 'master');
});

test('pickPr：開著的優先；已合入只在 head 等於 tip 時沿用', () => {
  const merged = { state: 'MERGED', headRefOid: 'old' };
  assert.equal(pickPr([merged, { state: 'OPEN', number: 2 }], 'new').number, 2);
  assert.equal(pickPr([merged], 'old'), merged);
  assert.equal(pickPr([merged], 'new'), null);
});

test('pickMergedPr：只接 head 等於 tip 的已合入 PR；沒有 tip（origin 也沒有分支）回 null，不取最新的', () => {
  const newer = { state: 'MERGED', number: 3, headRefOid: 'b' };
  const older = { state: 'MERGED', number: 1, headRefOid: 'a' };
  assert.equal(pickMergedPr([{ state: 'OPEN', number: 4, headRefOid: 'a' }, newer, older], 'a'), older);
  assert.equal(pickMergedPr([newer, older], undefined), null);
  assert.equal(pickMergedPr([newer], 'c'), null);
});

test('checksVerdict：空的是 pending；有失敗或取消是 fail；全部通過或略過是 pass', () => {
  assert.equal(checksVerdict([]), 'pending');
  assert.equal(checksVerdict([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending');
  assert.equal(checksVerdict([{ bucket: 'pass' }, { bucket: 'cancel' }]), 'fail');
  assert.equal(checksVerdict([{ bucket: 'pass' }, { bucket: 'skipping' }]), 'pass');
});

test('rollupBucket：CheckRun 看 status 與 conclusion，StatusContext 看 state，分類同 gh pr checks', () => {
  assert.equal(rollupBucket({ status: 'COMPLETED', conclusion: 'SUCCESS' }), 'pass');
  assert.equal(rollupBucket({ status: 'COMPLETED', conclusion: 'NEUTRAL' }), 'skipping');
  assert.equal(rollupBucket({ status: 'COMPLETED', conclusion: 'SKIPPED' }), 'skipping');
  assert.equal(rollupBucket({ status: 'COMPLETED', conclusion: 'TIMED_OUT' }), 'fail');
  assert.equal(rollupBucket({ status: 'COMPLETED', conclusion: 'CANCELLED' }), 'cancel');
  assert.equal(rollupBucket({ status: 'QUEUED', conclusion: '' }), 'pending');
  assert.equal(rollupBucket({ state: 'ERROR' }), 'fail');
  assert.equal(rollupBucket({ state: 'PENDING' }), 'pending');
});

test('rollupChecks：head 不符回空；同一個 run 重跑只留最新一筆，push 與 pull_request 兩個 run 都留', () => {
  const run = (id, startedAt, conclusion) => ({ status: 'COMPLETED', conclusion, startedAt, name: 'checks', workflowName: 'w', detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/${id}${startedAt.slice(1)}` });
  const view = statusCheckRollup => ({ headRefOid: 'new', statusCheckRollup });
  assert.deepEqual(rollupChecks({ headRefOid: 'old', statusCheckRollup: [run(1, 't1', 'FAILURE')] }, 'new'), []);
  assert.deepEqual(rollupChecks(view(null), 'new'), []);
  // 重跑：run 1 第一次失敗、第二次通過。
  assert.deepEqual(rollupChecks(view([run(1, 't1', 'FAILURE'), run(1, 't2', 'SUCCESS')]), 'new').map(check => check.bucket), ['pass']);
  // push 與 pull_request：不同 run id，晚開始的通過也不能蓋掉另一個 run 的失敗。
  assert.equal(checksVerdict(rollupChecks(view([run(1, 't1', 'FAILURE'), run(2, 't2', 'SUCCESS')]), 'new')), 'fail');
});
