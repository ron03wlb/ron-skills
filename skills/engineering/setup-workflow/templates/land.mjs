#!/usr/bin/env node
// 把一條分支從 push 一路做到合入 main 並收尾（#40）：手動分支（retro、單獨跑的 /issue-run）與 pilot 的 Push gate 共用。
// setup-workflow 正本（#139），L2 起由 adapter 的交付段指向 scripts/land.mjs；第一版只支援 GitHub（gh）。
// 步驟：push → 找或開 PR → 等 CI → 以 merge commit 合併 → 收尾（移除 worktree、還原 core.bare、刪本機與 origin 分支）
//   → 主 checkout 的 main 以 --ff-only 跟上 origin/main → bin/sync-skills（repo 有這支時）。
// 每一步都能從中斷處重跑：還開著的 PR 沿用；head 等於分支 tip 的 PR 已合入就直接收尾，不重開、不重合。
// 本機分支已經不在（Orca rm 會一起刪掉，#49）時不 push，只從已合入的 PR 接著收尾。
// push 前先擋：沒有 origin/main 以外的 commit（no-commits）；`--keep-branch` 時分支沒包含 origin/main（behind-main）。
// `--keep-branch`（pilot/integration）：不刪分支、不移除 worktree，改把分支 --ff-only 跟上 origin/main 再 push；
// 不用 `git branch -f`，它會把 upstream 改成 origin/main（#27）。
// `--local-checks <sha>`（CI 執行端改用本機：只在 GitHub Actions 沒啟動時用，#137）：不等 CI；push 前確認分支 tip 是 <sha>，
// 在 <sha> 的暫時 detached worktree（工作樹必定乾淨）以 sh 跑 `--check-command` 的單一檢查入口（預設 `bin/check`；
// ron-skills 是 `bin/check --upstream`），exit 0 才繼續，合併前在 PR 留言附 SHA 與結果行（CHECK_PASS 行，沒有時是最後一行）。
// 直接重跑而不驗證 pilot 的 regression 記錄：land 也給非 pilot 的分支用，不綁 checkpoint 格式。
// CI 失敗而失敗的 job 全都 0 個 step（帳務或 spending limit 擋下、沒有啟動，#132）時印 ci-not-started，帶 check-run annotation
// 的第一句與 repo 可見性：log 讀不到，重跑也沒用；原因是帳務時 Push gate 才改用 `--local-checks`，有 step 的失敗照舊是 ci-failed。
// Orca 從 WSL 移除 worktree 會把主 checkout 設成 bare，所以移除後一律還原：有 scripts/pilot-unbare.sh 就交給它，沒有就自己還原並印 UNBARE。
// 合併因 PR 和 main 衝突被拒時（#173）：fetch、把 origin/main 合入分支（在分支的 worktree，沒有就開暫時 worktree）。repo 有
// scripts/restamp.mjs、衝突檔全在它 export 的 STAMP_FILES 裡時，呼叫它的 restamp(tree, files)（在合併中途：取目標分支版本、重算並 git add，
// 回傳 false 表示解不了），commit，在新 tip 以 sh 跑 `--check-command`（預設 bin/check），通過才 push、印 RESTAMPED，再等 CI、合併一次。
// 其他衝突（或 repo 沒有 restamp.mjs）照舊 merge --abort，STOP merge <pr> conflict <檔案…>，分支停在原來的 tip。
//
// 用法：node scripts/land.mjs <branch> [--keep-branch] [--local-checks <sha>] [--check-command <command>] [--body-file <file>] [--title <title>]
// stdout：每步一行進度（PUSHED、PR、CHECKS_PASSED、RESTAMPED <pr> <新 tip>，`--local-checks` 時是 LOCAL_CHECKS <pr> <sha> <結果行>，收尾的 UNBARE、
//   WORKTREE_REMOVED、BRANCH_DELETED，最後 MAIN、SYNC_SKILLS）；最後一行 LANDED <pr> <merge sha>，或 STOP <原因>
//   （checked-out-in-main、dirty-worktree、no-branch、no-commits、behind-main、push、no-body、pr-create、ci-failed、ci-not-started、checks-timeout、local-checks-sha、local-checks-failed、restamp-checks-failed、merge、not-merged、worktree-rm）。
// 合入之後的收尾問題（main 沒跟上、sync-skills 失敗）印 WARN，不影響 LANDED。
// exit：0 已合入；4 STOP；2 用法錯誤；1 其他失敗。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { orca } from './orca-session-send.mjs';

const USAGE = '用法：node scripts/land.mjs <branch> [--keep-branch] [--local-checks <sha>] [--check-command <command>] [--body-file <file>] [--title <title>]';

/** CI 輪詢：剛 push 時 PR 的 head 可能還沒更新、checks 可能還沒登記（空陣列），都照 pending 處理到逾時。 */
const CHECKS_POLL_MS = Number(process.env.LAND_CHECKS_POLL_MS || 10000);
/** Bash 工具最多等 600 秒；逾時 STOP checks-timeout，重跑會沿用同一個 PR 接著等。 */
const CHECKS_TIMEOUT_MS = Number(process.env.LAND_CHECKS_TIMEOUT_MS || 480000);
/** `--local-checks` 的檢查：ron-skills 的 bin/check --upstream 實測 166 秒（#137，macOS）；420 秒之後還留 180 秒給 Bash 600 秒內的 push、合併與收尾。 */
const LOCAL_CHECKS_TIMEOUT_MS = Number(process.env.LAND_LOCAL_CHECKS_TIMEOUT_MS || 420000);

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
  return prs.find(pr => pr.state === 'OPEN') ?? pickMergedPr(prs, tip);
}

/**
 * head 等於 tip 的已合入 PR，沒有回 null。本機分支已不在時只用它、tip 取 origin 上的分支：
 * 不比對 tip 就取最新一個，分支名稱重用時會把舊 PR 誤報成 LANDED。
 */
export function pickMergedPr(prs, tip) {
  return (tip && prs.find(pr => pr.state === 'MERGED' && pr.headRefOid === tip)) || null;
}

/** checks 的總結：fail（有失敗或取消）、pass（有檢查而且全部通過或略過）、pending（其他，含還沒登記）。 */
export function checksVerdict(checks) {
  if (checks.some(check => check.bucket === 'fail' || check.bucket === 'cancel')) return 'fail';
  if (checks.length > 0 && checks.every(check => check.bucket === 'pass' || check.bucket === 'skipping')) return 'pass';
  return 'pending';
}

/** statusCheckRollup 的一項（CheckRun 或 StatusContext）換成 `gh pr checks` 的 bucket，分類照 gh 的 aggregate.go。 */
export function rollupBucket(item) {
  const state = item.state || (item.status === 'COMPLETED' ? item.conclusion : item.status);
  if (state === 'SUCCESS') return 'pass';
  if (state === 'SKIPPED' || state === 'NEUTRAL') return 'skipping';
  if (['ERROR', 'FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(state)) return 'fail';
  if (state === 'CANCELLED') return 'cancel';
  return 'pending';
}

/**
 * `gh pr view --json headRefOid,statusCheckRollup` 的結果換成 head 這個 SHA 上的 checks（`{ name, link, bucket }`）。
 * PR 的 head 還不是 push 的 SHA（參數 head）時回空陣列（照 pending）：`gh pr checks` 不帶 SHA，push 後 PR 的 head 還沒更新時
 * 會讀到前一個 head 的失敗 run（#128，PR #125）。headRefOid 與 rollup 取自同一次查詢，所以 rollup 屬於那個 head。
 * 重跑會留下同一個 run 的舊結果：同 `gh pr checks` 只留最新開始的一筆。gh 以 name、workflow、event 去重，
 * `pr view` 沒有 event，改用 Actions 網址裡的 run id 區分 push 與 pull_request 兩個 run（重跑沿用 run id）。
 * 同一個 SHA、同一種 event 有兩個 run 時（PR 重開、兩次 workflow_dispatch）gh 只留新的、這裡兩個都留：只會多報 ci-failed，不會誤合。
 */
export function rollupChecks(view, head) {
  if (view.headRefOid !== head) return [];
  const latest = new Map();
  for (const item of [...(view.statusCheckRollup ?? [])].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))) {
    const link = item.detailsUrl || item.targetUrl;
    const key = item.context ?? `${item.name}/${item.workflowName}/${link?.match(/\/actions\/runs\/(\d+)\//)?.[1] ?? ''}`;
    if (!latest.has(key)) latest.set(key, { name: item.name || item.context, link, bucket: rollupBucket(item) });
  }
  return [...latest.values()];
}

/** 文字的第一句（到後面接空白或結尾的 . ! ?），空白壓成一格；沒有句尾就整段，空的回 null。 */
export function firstSentence(text) {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.match(/^.*?[.!?](?= |$)/)?.[0] ?? flat;
}

/** Actions job 的網址（`/actions/runs/<run>/job/<job>`）裡的 job id，它也是 check run id；不是 Actions 的 check 回 null。 */
const jobId = link => link?.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1] ?? null;

/** `gh` 的 JSON 回應；失敗或不是 JSON 時回 null（只用在讀不到也有退路的查詢）。 */
function ghJson(cwd, ...args) {
  const result = run('gh', args, cwd);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** job 確定沒有啟動（讀得到、0 個 step）才回 true；讀不到不能確認，照一般失敗。 */
const jobNotStarted = (cwd, id) => ghJson(cwd, 'api', `repos/{owner}/{repo}/actions/jobs/${id}`)?.steps?.length === 0;

/**
 * 失敗的 check 全都是沒啟動的 Actions job 時，回傳 ci-not-started 的原因（annotation 第一句與 repo 可見性），否則 null。
 * 取消（cancel）的不算：沒啟動就取消的 job 也是 0 個 step，但它不是帳務問題，不能放寬成 `--local-checks`。
 * 0 個 step 也可能是帳務以外的原因（runner 沒接單、policy），所以原因照實印出，要不要改用本機結果由 Push gate 看原因決定。
 */
function notStartedReason(cwd, failed) {
  const ids = failed.map(check => check.bucket === 'fail' && jobId(check.link));
  if (!ids.every(id => id && jobNotStarted(cwd, id))) return null;
  let reason = null;
  for (const id of ids) {
    const annotations = ghJson(cwd, 'api', `repos/{owner}/{repo}/check-runs/${id}/annotations`) ?? [];
    reason = firstSentence((annotations.find(item => item.annotation_level === 'failure') ?? annotations[0])?.message);
    if (reason) break;
  }
  const visibility = ghJson(cwd, 'repo', 'view', '--json', 'visibility')?.visibility?.toLowerCase() ?? 'unknown';
  // 根因（#132 留言）：GitHub Free 的 Actions 分鐘數由帳號所有 private repo 共用，billing API 回 404 查不到。
  const hint = visibility === 'private' ? '（帳號下所有 private repo 共用 Actions 額度，到 Billing & plans → Usage 查看）' : '';
  return `${reason ?? 'unknown'} repo ${visibility}${hint}`;
}

async function waitChecks(cwd, number, head) {
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  for (;;) {
    const checks = rollupChecks(JSON.parse(gh(cwd, 'pr', 'view', String(number), '--json', 'headRefOid,statusCheckRollup')), head);
    const verdict = checksVerdict(checks);
    if (verdict === 'fail') {
      const failed = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel');
      const links = failed.map(check => check.link || check.name).join(' ');
      const reason = notStartedReason(cwd, failed);
      throw new Stop(reason ? `ci-not-started ${number} ${reason} ${links}` : `ci-failed ${number} ${links}`);
    }
    if (verdict === 'pass') return checks.length;
    if (Date.now() >= deadline) throw new Stop(`checks-timeout ${number}`);
    await sleep(CHECKS_POLL_MS);
  }
}

/** 檢查入口要在暫時 worktree 裡跑，不能被呼叫端（hook、別的 worktree）的 GIT_* 帶到別的 repo。 */
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));

/**
 * 在 tip 的暫時 detached worktree 以 sh 跑 command，回傳結果行（CHECK_PASS 行，沒有時是輸出的最後一行）；完整輸出留在主 checkout 的 `.scratch/`。
 * expected 不是 SHA（ref 一定等於 tip，比對就沒作用）、tip 不是 expected、檢查失敗或沒有任何輸出時 Stop，這時還沒 push。
 */
function runLocalChecks(main, branch, tip, expected, command) {
  if (!/^[0-9a-f]{7,40}$/i.test(expected)) throw new Stop(`local-checks-sha ${expected} 不是 SHA：帶 Regression 通過的那個 SHA`);
  const sha = run('git', ['rev-parse', '--verify', '--quiet', `${expected}^{commit}`], main).stdout.trim();
  if (sha !== tip) throw new Stop(`local-checks-sha ${branch} 的 tip ${tip} 不是 ${expected}`);
  const temp = mkdtempSync(join(tmpdir(), 'land-check-'));
  const tree = join(temp, 'tree');
  try {
    const added = spawnSync('git', ['worktree', 'add', '--detach', '-q', tree, tip], { cwd: main, encoding: 'utf8', env: childEnv });
    if (added.status !== 0) throw new Error(`git worktree add 失敗：${added.stderr.trim()}`);
    const result = spawnSync('sh', ['-c', command], { cwd: tree, encoding: 'utf8', env: childEnv, timeout: LOCAL_CHECKS_TIMEOUT_MS });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    mkdirSync(join(main, '.scratch'), { recursive: true });
    const log = join(main, '.scratch', `land-local-checks-${tip}.log`);
    writeFileSync(log, output);
    const pass = output.match(/^CHECK_PASS .*$/m)?.[0] ?? output.trim().split('\n').pop();
    if (result.status !== 0 || !pass) throw new Stop(`local-checks-failed ${tip} exit ${result.error?.code ?? result.status}${pass ? '' : ' 沒有輸出'} ${log}`);
    return pass;
  } finally {
    run('git', ['worktree', 'remove', '--force', tree], main);
    rmSync(temp, { recursive: true, force: true });
    // remove 失敗時目錄已被 rmSync 刪掉，prune 清掉留在 .git/worktrees/ 的登記。
    run('git', ['worktree', 'prune'], main);
  }
}

/** 衝突檔全是 repo 宣告的戳記檔時交給 `<tree>/scripts/restamp.mjs` 重算，回傳是否解完；repo 沒有這支時回 false。 */
async function restampConflicts(tree, files) {
  const hook = join(tree, 'scripts/restamp.mjs');
  if (!files.length || !existsSync(hook)) return false;
  const { STAMP_FILES = [], restamp } = await import(pathToFileURL(hook).href);
  if (!files.every(file => STAMP_FILES.includes(file))) return false;
  return (await restamp(tree, files)) !== false;
}

/**
 * PR 和 main 衝突：把 origin/main 合入分支，只有戳記檔衝突時 restamp、commit、在新 tip 跑檢查入口、push，回傳新 tip。
 * 其他衝突（或 restamp、commit 途中失敗）merge --abort 後 Stop，分支不留合併中途狀態；檢查失敗時合併 commit 留在本機分支、不 push。
 */
async function restampBranch(main, branch, tree, number, command) {
  git(main, 'fetch', 'origin', 'main');
  const temp = tree ? null : mkdtempSync(join(tmpdir(), 'land-restamp-'));
  const path = tree?.path ?? join(temp, 'tree');
  try {
    if (temp) {
      const added = spawnSync('git', ['worktree', 'add', '-q', path, branch], { cwd: main, encoding: 'utf8', env: childEnv });
      if (added.status !== 0) throw new Error(`git worktree add 失敗：${added.stderr.trim()}`);
    }
    const merge = spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: path, encoding: 'utf8', env: childEnv });
    if (merge.status !== 0) {
      const conflicted = git(path, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      try {
        if (!(await restampConflicts(path, conflicted))) throw new Stop(`merge ${number} conflict ${conflicted.join(' ') || merge.stderr.trim().split('\n').pop()}`);
        const commit = spawnSync('git', ['commit', '--no-edit'], { cwd: path, encoding: 'utf8', env: childEnv });
        if (commit.status !== 0) throw new Error(`git commit 失敗：${(commit.stderr || commit.stdout).trim()}`);
      } catch (error) {
        if (run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path).status === 0) git(path, 'merge', '--abort');
        throw error;
      }
    }
    const sha = git(path, 'rev-parse', 'HEAD');
    const result = spawnSync('sh', ['-c', command], { cwd: path, encoding: 'utf8', env: childEnv, timeout: LOCAL_CHECKS_TIMEOUT_MS });
    mkdirSync(join(main, '.scratch'), { recursive: true });
    const log = join(main, '.scratch', `land-restamp-checks-${sha}.log`);
    writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (result.status !== 0) throw new Stop(`restamp-checks-failed ${sha} exit ${result.error?.code ?? result.status} ${log}`);
    const push = run('git', ['push', 'origin', branch], main);
    if (push.status !== 0) throw new Stop(`push ${push.stderr.trim().split('\n').pop()}`);
    return sha;
  } finally {
    if (temp) {
      run('git', ['worktree', 'remove', '--force', path], main);
      rmSync(temp, { recursive: true, force: true });
      run('git', ['worktree', 'prune'], main);
    }
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
      if (unbarePath) {
        const unbare = run(unbarePath, [main, `land ${branch}`], main);
        if (unbare.stdout) process.stdout.write(unbare.stdout);
      } else if (run('git', ['rev-parse', '--is-bare-repository'], main).stdout.trim() === 'true') {
        git(main, 'config', 'core.bare', 'false');
        console.log(`UNBARE ${main}`);
      }
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

export async function land({ branch, keepBranch = false, localChecksSha, checkCommand = 'bin/check', bodyFile, title, cwd = process.cwd() }) {
  const main = worktrees(cwd)[0].path;
  // 主 checkout 也算：--keep-branch 時在那裡 ff；收尾時無法刪掉主 checkout 正在用的分支，開頭就停。
  const tree = worktrees(main).find(item => item.branch === branch);
  if (tree?.path === main && !keepBranch) throw new Stop(`checked-out-in-main ${branch}`);
  if (tree && git(tree.path, 'status', '--porcelain')) throw new Stop(`dirty-worktree ${tree.path}`);
  const tip = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], main).stdout.trim();
  if (!tip && keepBranch) throw new Stop(`no-branch ${branch} --keep-branch 要本機分支`);

  const prs = JSON.parse(gh(main, 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', 'number,state,url,headRefOid,mergeCommit'));
  let pr;
  let checkPass;
  if (tip) {
    pr = pickPr(prs, tip);
    if (pr?.state !== 'MERGED') {
      git(main, 'fetch', 'origin', 'main');
      const contains = (ancestor, descendant) => run('git', ['merge-base', '--is-ancestor', ancestor, descendant], main).status === 0;
      // 分支在送出前被別的 session 切走，commit 落到別條分支，推出去的是沒有新 commit 的空分支（retro 2026-10-30 ron-skills-0d）。
      if (!pr && contains(tip, 'origin/main')) throw new Stop(`no-commits ${branch} 沒有 origin/main 以外的 commit`);
      // push 事件的 CI 跑分支自己那份 workflow：沒合入 origin/main 的 CI 修正（#48 的 Node 版本）就會紅燈（PR #50）。
      if (keepBranch && !contains('origin/main', tip)) throw new Stop(`behind-main ${branch} 沒有包含 origin/main：先合入 origin/main 並重跑 Regression`);
      if (localChecksSha) checkPass = runLocalChecks(main, branch, tip, localChecksSha, checkCommand);
    }
    const push = run('git', ['push', '-u', 'origin', branch], main);
    if (push.status !== 0) throw new Stop(`push ${push.stderr.trim().split('\n').pop()}`);
    console.log(`PUSHED ${branch} ${tip}`);
  } else {
    const remote = git(main, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split('\n').find(line => line.endsWith(`\trefs/heads/${branch}`));
    pr = pickMergedPr(prs, remote?.split('\t')[0]);
    if (!pr) throw new Stop(`no-branch ${branch} 本機沒有這條分支，也沒有 head 等於 origin 分支 tip 的已合入 PR`);
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
    if (checkPass) {
      // PR 開著時重跑（例如上次 STOP merge）會再檢查一次、再留一則：每則留言各對應一次實際跑過的 bin/check。
      const note = `CI 沒有啟動，以本機 \`${checkCommand}\` 取代 GitHub checks（\`land.mjs --local-checks\`）：SHA ${tip}，exit 0，\`${checkPass}\`。`;
      gh(main, 'pr', 'comment', String(pr.number), '--body', note);
      console.log(`LOCAL_CHECKS ${pr.number} ${tip} ${checkPass}`);
    } else {
      console.log(`CHECKS_PASSED ${pr.number} ${await waitChecks(main, pr.number, tip)}`);
    }
    let merged = run('gh', ['pr', 'merge', String(pr.number), '--merge'], main);
    if (merged.status !== 0 && /merge conflicts/i.test(merged.stderr)) {
      const head = await restampBranch(main, branch, tree, pr.number, checkCommand);
      console.log(`RESTAMPED ${pr.number} ${head}`);
      console.log(`CHECKS_PASSED ${pr.number} ${await waitChecks(main, pr.number, head)}`);
      merged = run('gh', ['pr', 'merge', String(pr.number), '--merge'], main);
    }
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

/** 帶值的旗標與它在 land() 選項裡的名稱。 */
const VALUE_FLAGS = { '--body-file': 'bodyFile', '--title': 'title', '--local-checks': 'localChecksSha', '--check-command': 'checkCommand' };

function parseArgs(argv) {
  const options = { keepBranch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep-branch') options.keepBranch = true;
    else if (arg in VALUE_FLAGS) {
      if (argv[i + 1] === undefined) return null;
      options[VALUE_FLAGS[arg]] = argv[++i];
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
