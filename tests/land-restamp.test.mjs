// #173 的驗收：本 repo 的 scripts/land.mjs 經 scripts/restamp.mjs 解掉只有 scripts/workflow-doc-sync.json 的衝突，
// 合入後的戳記和合併後的來源一致。land.mjs 其他行為的測試在 setup-workflow 的 templates/land.test.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { mergeSample } from '../skills/engineering/setup-workflow/templates/test/fake-orca.mjs';
import { GH_SAMPLES } from '../skills/engineering/setup-workflow/templates/test/gh-samples.mjs';

const repoRoot = new URL('..', import.meta.url).pathname;
// restamp.mjs 的副本清單由 pilot-land.mjs（正本）重算、流程站戳記由 pilot-resolve.mjs 重算（#245），一起複製。
const SCRIPTS = ['land.mjs', 'orca-session-send.mjs', 'restamp.mjs', 'pilot-land.mjs', 'pilot-resolve.mjs', 'check-workflow-sync.mjs'];
const SYNC_SOURCES = Object.keys(JSON.parse(readFileSync(join(repoRoot, 'scripts/workflow-doc-sync.json'), 'utf8')).sources);
const STAMPS = 'scripts/workflow-doc-sync.json';
// 不用 Orca（收尾走 git worktree remove），也不讓外層的 GIT_* 寫進本 repo。
// user.useConfigOnly 讓 git 不從帳號資料猜 identity，本機也像沒有全域 identity 的 CI runner 一樣；
// land.mjs 內部的 git merge 從 GIT_AUTHOR_*、GIT_COMMITTER_* 拿 identity（#197）。
const landEnv = {
  ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('ORCA_'))),
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

/**
 * bare remote、主 checkout、feature worktree 與 PATH 上的假 gh（輸出從真實樣本長出來；`pr merge` 在 remote 上真的合併，
 * 衝突時照 PR #168 的訊息拒絕）。feature 與 main 各改一個 check-workflow-sync 的來源並各自 restamp：戳記檔衝突（retro 1031b）。
 * 假 bin/check 跑 check-workflow-sync，記下所在 SHA。
 */
function fixture(t, { scripts = SCRIPTS } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'land-restamp-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const [origin, main, merger, wt, bin] = ['origin.git', 'main', 'merger', 'wt', 'bin'].map(name => join(temp, name));
  const log = join(temp, 'calls.log');
  const restampIn = dir => assert.equal(spawnSync('node', [join(dir, 'scripts/check-workflow-sync.mjs'), '--restamp'], { cwd: dir, env }).status, 0);

  git(temp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(temp, 'clone', '-q', origin, main);
  write(main, {
    '.gitignore': '.scratch/\n',
    ...Object.fromEntries(SYNC_SOURCES.map(path => [path, `# ${path}\n`])),
    'bin/check': `#!/usr/bin/env bash\nset -e\nnode scripts/check-workflow-sync.mjs\necho "check $(git rev-parse HEAD)" >> ${JSON.stringify(log)}\necho 'CHECK_PASS tests 1'\n`,
  });
  chmodSync(join(main, 'bin/check'), 0o755);
  for (const name of scripts) cpSync(join(repoRoot, 'scripts', name), join(main, 'scripts', name));
  restampIn(main);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'push', '-q', 'origin', 'main');

  git(main, 'worktree', 'add', '-q', wt, '-b', 'feature');
  write(wt, { [SYNC_SOURCES[0]]: '# feature\n' });
  restampIn(wt);
  git(wt, 'commit', '-q', '-am', 'feature');

  git(temp, 'clone', '-q', origin, merger);
  write(merger, { [SYNC_SOURCES[1]]: '# main\n' });
  restampIn(merger);
  git(merger, 'commit', '-q', '-am', 'main moves on');
  git(merger, 'push', '-q', 'origin', 'main');

  mkdirSync(bin);
  const state = join(temp, 'gh-state.json');
  writeFileSync(state, JSON.stringify({ prs: [] }));
  writeFileSync(log, '');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const SAMPLES = ${JSON.stringify(GH_SAMPLES)};
const mergeSample = ${mergeSample.toString()};
const args = process.argv.slice(2); const arg = k => args[args.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, 'gh ' + args.join(' ') + '\\n');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const git = (...a) => execFileSync('git', ['-C', ${JSON.stringify(merger)}, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
const find = ref => {
  const pr = s.prs.find(pr => pr.number === Number(String(ref).split('/').pop()));
  if (pr.state === 'OPEN') { git('fetch', '-q', 'origin'); pr.headRefOid = git('rev-parse', 'origin/' + pr.head); save(); }
  return pr;
};
const out = ({ head, ...fields }) => mergeSample(SAMPLES['pr-view'], fields, 'pr');
const [, sub] = args;
if (sub === 'list') console.log(JSON.stringify(s.prs.filter(pr => pr.head === arg('--head')).map(out)));
else if (sub === 'create') {
  git('fetch', '-q', 'origin');
  const pr = { head: arg('--head'), number: 40, state: 'OPEN', url: 'https://github.com/o/r/pull/40', headRefOid: git('rev-parse', 'origin/' + arg('--head')), mergeCommit: null };
  s.prs.push(pr); save(); console.log(pr.url);
}
else if (sub === 'view' && arg('--json').includes('statusCheckRollup')) {
  const pr = find(args[2]);
  console.log(JSON.stringify(mergeSample(SAMPLES['pr-view-checks'], { headRefOid: pr.headRefOid, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }, 'pr')));
}
else if (sub === 'view') console.log(JSON.stringify(out(find(args[2]))));
else if (sub === 'merge') {
  const pr = find(args[2]);
  git('checkout', '-q', '-B', 'main', 'origin/main');
  try { git('merge', '-q', '--no-ff', '-m', 'Merge pull request #' + pr.number, 'origin/' + pr.head); }
  catch { git('merge', '--abort'); console.error('GraphQL: Pull Request has merge conflicts'); process.exit(1); }
  git('push', '-q', 'origin', 'main');
  Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: git('rev-parse', 'HEAD') } }); save();
}
else { console.error('fake gh：未支援 ' + args.join(' ')); process.exit(1); }
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const body = join(temp, 'body.md');
  writeFileSync(body, '## Summary\n');
  const land = () => spawnSync('node', [join(wt, 'scripts/land.mjs'), 'feature', '--body-file', body], {
    cwd: wt, encoding: 'utf8', timeout: 60000,
    env: { ...landEnv, PATH: `${bin}:${landEnv.PATH}`, LAND_CHECKS_POLL_MS: '1', LAND_CHECKS_TIMEOUT_MS: '2000' },
  });
  return { origin, wt, land, calls: () => readFileSync(log, 'utf8'), prs: () => JSON.parse(readFileSync(state, 'utf8')).prs };
}

test('只有 workflow-doc-sync.json 衝突：印 RESTAMPED 並合入，main 上的戳記和合併後的來源一致', t => {
  const { origin, land, calls, prs } = fixture(t);

  const result = land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [pr] = prs();
  const restamped = result.stdout.match(/^RESTAMPED 40 ([0-9a-f]{40})$/m);
  assert.ok(restamped, result.stdout);
  assert.match(calls(), new RegExp(`^check ${restamped[1]}$`, 'm'));
  assert.equal(result.stdout.trim().split('\n').pop(), `LANDED 40 ${pr.mergeCommit.oid}`);
  // 合併後的 main 上，check-workflow-sync 通過：戳記記的是兩邊的來源合起來的結果。
  const checkout = join(realTmpdir(), `land-restamp-main-${process.pid}`);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  git(realTmpdir(), 'clone', '-q', origin, checkout);
  assert.equal(readFileSync(join(checkout, SYNC_SOURCES[0]), 'utf8'), '# feature\n');
  assert.equal(readFileSync(join(checkout, SYNC_SOURCES[1]), 'utf8'), '# main\n');
  const check = spawnSync('node', [join(checkout, 'scripts/check-workflow-sync.mjs')], { cwd: checkout, encoding: 'utf8', env });
  assert.equal(check.status, 0, check.stdout);
});

test('repo 沒有 scripts/restamp.mjs（#173 之前）：同樣的衝突 STOP merge，分支停在原來的 tip', t => {
  const { wt, land } = fixture(t, { scripts: SCRIPTS.filter(name => name !== 'restamp.mjs') });
  const tip = git(wt, 'rev-parse', 'HEAD');

  const result = land();
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), `STOP merge 40 conflict ${STAMPS}`);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(wt, 'status', '--porcelain'), '');
});
