#!/usr/bin/env node
// 把一條分支從 push 一路做到合入 main 並收尾（#40）：手動分支（retro、單獨跑的 /issue-run）與 pilot 的 Push gate 共用。
// 步驟：push → 找或開 PR → 等 CI → 以 merge commit 合併 → 收尾（移除 worktree、還原 core.bare、刪本機與 origin 分支）
//   → 主 checkout 的 main 以 --ff-only 跟上 origin/main → bin/sync-skills。
// 每一步都能從中斷處重跑：還開著的 PR 沿用；head 等於分支 tip 的 PR 已合入就直接收尾，不重開、不重合。
// 本機分支已經不在（Orca rm 會一起刪掉，#49）時不 push，只從已合入的 PR 接著收尾。
// `--keep-branch`（pilot/integration）：不刪分支、不移除 worktree，改把分支 --ff-only 跟上 origin/main 再 push；
// 不用 `git branch -f`，它會把 upstream 改成 origin/main（#27）。
// Orca 從 WSL 移除 worktree 會把主 checkout 設成 bare，所以移除後一律跑 pilot-unbare.sh。
//
// 用法：node scripts/land.mjs <branch> [--keep-branch] [--body-file <file>] [--title <title>]
// stdout：每步一行進度；最後一行 LANDED <pr> <merge sha>，或 STOP <原因>
//   （checked-out-in-main、dirty-worktree、no-branch、push、no-body、pr-create、ci-failed、checks-timeout、merge、not-merged、worktree-rm）。
// 合入之後的收尾問題（main 沒跟上、sync-skills 失敗）印 WARN，不影響 LANDED。
// exit：0 已合入；4 STOP；2 用法錯誤；1 其他失敗。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { orca } from './orca-session-send.mjs';

const USAGE = '用法：node scripts/land.mjs <branch> [--keep-branch] [--body-file <file>] [--title <title>]';

/** CI 輪詢：剛 push 時 checks 可能還沒登記（空陣列或 `no checks reported`），照 pending 處理到逾時。 */
const CHECKS_POLL_MS = Number(process.env.LAND_CHECKS_POLL_MS || 10000);
/** Bash 工具最多等 600 秒；逾時 STOP checks-timeout，重跑會沿用同一個 PR 接著等。 */
const CHECKS_TIMEOUT_MS = Number(process.env.LAND_CHECKS_TIMEOUT_MS || 480000);

class Stop extends Error {}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function must(cmd, args, cwd) {
  const result = run(cmd, args, cwd);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失敗：${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

const git = (cwd, ...args) => must('git', args, cwd);
const gh = (cwd, ...args) => must('gh', args, cwd);

/** `git worktree list` 的各列；第一列是主 checkout。 */
function worktrees(cwd) {
  return git(cwd, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).map(block => ({
    path: block.match(/^worktree (.+)$/m)[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  }));
}

/** head 為 branch 的 PR：還開著的優先；其次是 head 等於 tip 的已合入 PR（中斷後重跑）；都沒有回 null。 */
export function pickPr(prs, tip) {
  return prs.find(pr => pr.state === 'OPEN') ?? prs.find(pr => pr.state === 'MERGED' && pr.headRefOid === tip) ?? null;
}

/** 本機分支已不在時只接已合入的 PR：origin 還有這條分支就要 head 等於它的 tip，否則取最新的一個（gh 由新到舊列）。 */
export function pickMergedPr(prs, remoteTip) {
  return prs.find(pr => pr.state === 'MERGED' && (!remoteTip || pr.headRefOid === remoteTip)) ?? null;
}

/** checks 的總結：fail（有失敗或取消）、pass（有檢查而且全部通過或略過）、pending（其他，含還沒登記）。 */
export function checksVerdict(checks) {
  if (checks.some(check => check.bucket === 'fail' || check.bucket === 'cancel')) return 'fail';
  if (checks.length > 0 && checks.every(check => check.bucket === 'pass' || check.bucket === 'skipping')) return 'pass';
  return 'pending';
}

async function waitChecks(cwd, number) {
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  for (;;) {
    const result = run('gh', ['pr', 'checks', String(number), '--json', 'name,bucket,state,link'], cwd);
    // exit 8 是 pending，輸出照樣是 JSON；`no checks reported` 是 CI 還沒登記。
    let checks = [];
    if (result.stdout.trim()) checks = JSON.parse(result.stdout);
    else if (!/no checks reported/i.test(result.stderr)) throw new Error(`gh pr checks 失敗：${result.stderr.trim()}`);
    const verdict = checksVerdict(checks);
    if (verdict === 'fail') {
      const failed = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel').map(check => check.link || check.name);
      throw new Stop(`ci-failed ${number} ${failed.join(' ')}`);
    }
    if (verdict === 'pass') return checks.length;
    if (Date.now() >= deadline) throw new Stop(`checks-timeout ${number}`);
    await sleep(CHECKS_POLL_MS);
  }
}

/** 主 checkout 在 main 而且乾淨才 --ff-only；否則回傳原因（WARN，不擋）。 */
function syncMain(main) {
  const current = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], main).stdout.trim();
  if (current !== 'main') return `主 checkout 在 ${current || 'detached HEAD'}`;
  if (git(main, 'status', '--porcelain')) return '主 checkout 有未提交的改動';
  const result = run('git', ['merge', '--ff-only', 'origin/main'], main);
  return result.status === 0 ? null : `ff 失敗：${result.stderr.trim()}`;
}

/** 分支以 --ff-only 跟上 origin/main 並 push；有 worktree 就在那裡 merge，否則用 fetch 更新 ref（同樣拒絕非 ff，upstream 不變）。 */
function fastForwardBranch(main, branch, tree) {
  if (tree) git(tree.path, 'merge', '--ff-only', 'origin/main');
  else git(main, 'fetch', '.', `refs/remotes/origin/main:refs/heads/${branch}`);
  git(main, 'push', 'origin', branch);
}

async function cleanup(main, branch, tree) {
  if (tree) {
    const cli = process.env.ORCA_CLI_COMMAND;
    try {
      // `orca-ide worktree create --branch` 開的 worktree 用 branch: 選擇器找不到（selector_not_found），path: 才找得到（#49）。
      if (cli) await orca({ cli }, 'worktree', 'rm', '--worktree', `path:${tree.path}`);
      else git(main, 'worktree', 'remove', tree.path);
    } catch (error) {
      throw new Stop(`worktree-rm ${error.message}`);
    } finally {
      // rm 失敗也可能已把主 checkout 設成 bare；pilot-unbare.sh 自己會印 UNBARE。
      // 從被移除的 worktree 執行時（land 合入自己的分支），本檔旁的 pilot-unbare.sh 已跟著刪掉，所以先找主 checkout 的。
      const unbarePath = [join(main, 'scripts/pilot-unbare.sh'), join(import.meta.dirname, 'pilot-unbare.sh')].find(existsSync);
      const unbare = run(unbarePath, [main, `land ${branch}`], main);
      if (unbare.stdout) process.stdout.write(unbare.stdout);
    }
    console.log(`WORKTREE_REMOVED ${tree.path}`);
  }
  if (run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], main).status === 0) {
    git(main, 'branch', '-D', branch);
    console.log(`BRANCH_DELETED local ${branch}`);
  }
  if (run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], main).status === 0) {
    git(main, 'push', 'origin', '--delete', branch);
    console.log(`BRANCH_DELETED origin ${branch}`);
  }
}

export async function land({ branch, keepBranch = false, bodyFile, title, cwd = process.cwd() }) {
  const main = worktrees(cwd)[0].path;
  // 主 checkout 也算：--keep-branch 時在那裡 ff；收尾時無法刪掉主 checkout 正在用的分支，開頭就停。
  const tree = worktrees(main).find(item => item.branch === branch);
  if (tree?.path === main && !keepBranch) throw new Stop(`checked-out-in-main ${branch}`);
  if (tree && git(tree.path, 'status', '--porcelain')) throw new Stop(`dirty-worktree ${tree.path}`);
  const tip = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], main).stdout.trim();
  if (!tip && keepBranch) throw new Stop(`no-branch ${branch}`);

  if (tip) {
    const push = run('git', ['push', '-u', 'origin', branch], main);
    if (push.status !== 0) throw new Stop(`push ${push.stderr.trim().split('\n').pop()}`);
    console.log(`PUSHED ${branch} ${tip}`);
  }

  const prs = JSON.parse(gh(main, 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', 'number,state,url,headRefOid,mergeCommit'));
  let pr;
  if (tip) pr = pickPr(prs, tip);
  else {
    const remote = git(main, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split('\n').find(line => line.endsWith(`\trefs/heads/${branch}`));
    pr = pickMergedPr(prs, remote?.split('\t')[0]);
    if (!pr) throw new Stop(`no-branch ${branch} 本機沒有這條分支，也找不到已合入的 PR`);
  }
  if (!pr) {
    if (!bodyFile) throw new Stop('no-body 新開 PR 要 --body-file');
    const subject = title ?? git(main, 'log', '-1', '--format=%s', tip);
    const created = run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', subject, '--body-file', bodyFile], main);
    if (created.status !== 0) throw new Stop(`pr-create ${created.stderr.trim().split('\n').pop()}`);
    pr = JSON.parse(gh(main, 'pr', 'view', created.stdout.trim().split('\n').pop(), '--json', 'number,state,url,headRefOid,mergeCommit'));
    console.log(`PR_CREATED ${pr.number} ${pr.url}`);
  } else {
    console.log(`PR ${pr.number} ${pr.state} ${pr.url}`);
  }

  if (pr.state === 'OPEN') {
    console.log(`CHECKS_PASSED ${pr.number} ${await waitChecks(main, pr.number)}`);
    const merged = run('gh', ['pr', 'merge', String(pr.number), '--merge'], main);
    if (merged.status !== 0) throw new Stop(`merge ${pr.number} ${merged.stderr.trim().split('\n').pop()}`);
    pr = JSON.parse(gh(main, 'pr', 'view', String(pr.number), '--json', 'number,state,url,headRefOid,mergeCommit'));
    if (pr.state !== 'MERGED') throw new Stop(`not-merged ${pr.number} ${pr.state}`);
  }
  const sha = pr.mergeCommit.oid;
  console.log(`MERGED ${pr.number} ${sha}`);

  git(main, 'fetch', 'origin');
  if (keepBranch) fastForwardBranch(main, branch, tree);
  else await cleanup(main, branch, tree);

  const notSynced = syncMain(main);
  console.log(notSynced ? `WARN main-not-synced ${notSynced}` : `MAIN ${git(main, 'rev-parse', 'HEAD')}`);
  const sync = join(main, 'bin/sync-skills');
  if (existsSync(sync)) {
    const result = run(sync, [], main);
    console.log(result.status === 0 ? 'SYNC_SKILLS ok' : `WARN sync-skills exit ${result.status}`);
  }
  return { number: pr.number, sha };
}

function parseArgs(argv) {
  const options = { keepBranch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep-branch') options.keepBranch = true;
    else if (arg === '--body-file' || arg === '--title') {
      if (argv[i + 1] === undefined) return null;
      options[arg === '--title' ? 'title' : 'bodyFile'] = argv[++i];
    } else if (!arg.startsWith('-') && !options.branch) options.branch = arg;
    else return null;
  }
  return options.branch ? options : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const { number, sha } = await land(options);
    console.log(`LANDED ${number} ${sha}`);
  } catch (error) {
    if (!(error instanceof Stop)) {
      console.error(error.message);
      process.exit(1);
    }
    console.log(`STOP ${error.message}`);
    process.exit(4);
  }
}
