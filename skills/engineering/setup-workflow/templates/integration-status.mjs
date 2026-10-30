#!/usr/bin/env node
// 唯讀查詢：指定 issue 是否已合入整合分支（主 worktree 目前的分支）、是否已在 remote；remote 以 ls-remote 即時讀取，不依賴對話開頭的 git 快照或過期的 remote-tracking ref。
// 用法：node scripts/integration-status.mjs <issue 編號…>
// stdout 一段 JSON；inRemote 為 null 表示本機缺 remote tip 物件，先 git fetch 再查。
import { spawnSync } from 'node:child_process';

const USAGE = '用法：node scripts/integration-status.mjs <issue 編號…>';

/** 名稱含 issue-<n> 且後面不接數字的分支（issue-24 不配 issue-247）。 */
export function issueBranches(refs, iid) {
  const pattern = new RegExp(`issue-${iid}(?!\\d)`);
  return refs.filter(ref => pattern.test(ref));
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: result.status === 0, out: (result.stdout || '').trimEnd() };
}
const fail = message => { console.error(JSON.stringify({ error: message })); process.exit(1); };
const ancestor = (commit, tip) => git('merge-base', '--is-ancestor', commit, tip).ok;

const iids = process.argv.slice(2);
if (!iids.length || iids.some(iid => !/^\d+$/.test(iid))) { console.error(USAGE); process.exit(2); }

const main = git('worktree', 'list', '--porcelain').out.split('\n\n')[0];
const integration = main.match(/^branch refs\/heads\/(.+)$/m)?.[1];
if (!integration) fail('主 worktree 不在分支上，無法判定整合分支');
const local = git('rev-parse', `refs/heads/${integration}`).out;
const remoteName = git('config', `branch.${integration}.remote`).out || 'origin';
const listed = git('ls-remote', '--refs', remoteName, `refs/heads/${integration}`);
if (!listed.ok) fail(`無法讀取 ${remoteName}（ls-remote 失敗）`);
const remoteSha = listed.out.split('\t')[0] || null;
const remoteKnown = Boolean(remoteSha) && git('cat-file', '-e', `${remoteSha}^{commit}`).ok;
const [ahead, behind] = remoteKnown ? git('rev-list', '--left-right', '--count', `${local}...${remoteSha}`).out.split('\t').map(Number) : [null, null];
const inRemote = commit => (remoteSha ? (remoteKnown ? ancestor(commit, remoteSha) : null) : false);

// 整合分支的 first-parent 歷史即合入紀錄；remote 若已前進，一併掃描它的 first-parent。
const tips = remoteKnown && remoteSha !== local ? [local, remoteSha] : [local];
const history = new Map();
for (const tip of tips) {
  for (const line of git('log', '--first-parent', '--format=%H%x09%s', tip).out.split('\n').filter(Boolean)) {
    const [sha, subject] = line.split('\t'); history.set(sha, subject);
  }
}
const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').out.split('\n').filter(Boolean);

const issues = iids.map(iid => {
  const pattern = new RegExp(`#${iid}(?!\\d)`);
  const commits = [...history].filter(([, subject]) => pattern.test(subject))
    .map(([sha, subject]) => ({ sha, subject, inLocal: ancestor(sha, local), inRemote: inRemote(sha) }));
  const issueBranchState = issueBranches(branches, iid).map(branch => {
    const tip = git('rev-parse', branch).out;
    return { branch, tip, inLocal: ancestor(tip, local), inRemote: inRemote(tip) };
  });
  const all = [...commits, ...issueBranchState];
  return {
    iid: Number(iid),
    mergedLocal: all.some(item => item.inLocal),
    // 有任一筆在 remote 即 true；無法判定（缺 remote 物件）時為 null。
    pushed: all.some(item => item.inRemote === true) || (all.some(item => item.inRemote === null) ? null : false),
    commits, branches: issueBranchState,
  };
});

console.log(JSON.stringify({
  integration, local, remote: { name: remoteName, sha: remoteSha, objectPresent: remoteKnown, ahead, behind }, issues,
}, null, 2));
