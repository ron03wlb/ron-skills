#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 把一個 commit 的完整檢查交給 GitHub Actions、讀它的結論（CoS item 67：heavy-slot 名額 0 的 repo，完整檢查改走 CI）。
// 呼叫端（bin/check 的完整跑、pilot-land 的 Regression）在 heavy-slot 印 SLOT_DELEGATED（exit 76）時改呼叫它；
// CI 不可用（CI_UNAVAILABLE，exit 76）才以 `heavy-slot.mjs run --fallback` 回到本機排隊。CI 跑完而失敗（CI_FAIL）是檢查沒過，不退回本機。
//
// 用法：node scripts/ci-run.mjs [<rev>] [--ref <分支>] [--workflow <檔名>] [--job <名稱>] [--timeout <秒>] [--start-timeout <秒>] [--queue-timeout <秒>]
//   <rev>          預設 HEAD；取它的 commit SHA。
//   --ref          沒有現成的 run 時 push 到這條分支（預設 `ci/<SHA 前 12 字元>`）；workflow 要在 push 這條分支時觸發。
//   --workflow     預設 checks.yml；--job 預設 checks（讀這個 job 的結論，其他 job 不看）。
//   --timeout      總共最多等幾秒（預設 $CI_RUN_TIMEOUT_S，再來 540：留在 Bash 工具 600 秒內）；等不完印 CI_PENDING，重跑同一行會找到同一個 run 接著等。
//   --start-timeout push 後等 run 出現的上限（預設 300）；--queue-timeout job 停在 queued 的上限（從 run 建立起算，預設 1200）。
// 步驟：先找這個 SHA 上已有的 run（`gh run list --commit <sha> --workflow <檔名>`，含先前 push 的 worker 分支、PR）；沒有才 push <sha> 到 --ref。
//   之後每 $CI_RUN_POLL_S 秒（預設 15）讀一次 run 與 job；job 結束就印結果。--ref 是一次性分支（`ci/` 或 pilot-land 用的 `pilot/stage-` 開頭）、
//   而且遠端那條分支還指著 <sha> 時，有結論後刪掉它（CI_PENDING 不刪：重跑要接著等同一個 run）。
// 「CI 不可用」（CI_UNAVAILABLE）的判斷，任一成立：push 失敗（伺服器暫時失敗重試一次後）；push 後 start-timeout 秒內沒有 run；
//   job 以 0 個 step 結束（runner 沒接單、帳務）或 run 是 startup_failure；job 被取消；job 停在 queued 超過 queue-timeout；`gh` 連續 3 次失敗。
// stdout 最後一行（之前的進度行在 stderr：`CI_WAIT <sha> <run url|-> <已等秒數>s <狀態>`，每 60 秒一行）：
//   CI_PASS <sha> <run url> <job 秒數>s          exit 0
//   CI_FAIL <sha> <run url> <失敗的 step>        exit 1（job 有跑、沒過；不要退回本機重跑同一個 SHA）
//   CI_PENDING <sha> <run url|->                 exit 75（時限內沒跑完；稍後重跑同一行）
//   CI_UNAVAILABLE <sha> <原因> [<run url>]      exit 76（呼叫端退回本機：heavy-slot.mjs run --fallback）
//   用法錯誤 exit 2。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CI_PENDING_EXIT = 75;
export const CI_UNAVAILABLE_EXIT = 76;
const USAGE = '用法：node scripts/ci-run.mjs [<rev>] [--ref <分支>] [--workflow <檔名>] [--job <名稱>] [--timeout <秒>] [--start-timeout <秒>] [--queue-timeout <秒>]';
const PUSH_TRANSIENT = /fatal error in commit_refs|\[remote rejected\][^\n]*\(failure\)|Could not resolve host|Connection (reset|timed out)|HTTP 5\d\d/;
/** 有結論後可以刪掉的一次性分支：ci-run 自己的 `ci/<sha>`，與 pilot-land Regression 的 `pilot/stage-<key>`（只在本機用，推上去只為了觸發 CI）。 */
const DISPOSABLE_REF = /^(ci\/|pilot\/stage-[^/]+$)/;
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));

/** 命令列 → 選項；錯誤時 { error }。 */
export function parseArgs(argv, env = process.env) {
  const options = { rev: 'HEAD', workflow: 'checks.yml', job: 'checks', timeoutSec: Number(env.CI_RUN_TIMEOUT_S ?? 540), startTimeoutSec: 300, queueTimeoutSec: 1200 };
  const numeric = { '--timeout': 'timeoutSec', '--start-timeout': 'startTimeoutSec', '--queue-timeout': 'queueTimeoutSec' };
  const text = { '--ref': 'ref', '--workflow': 'workflow', '--job': 'job' };
  let rev;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (numeric[flag] || text[flag]) {
      const value = argv[++i];
      if (value === undefined) return { error: `${flag} 要有值` };
      if (numeric[flag]) {
        if (!/^\d+(\.\d+)?$/.test(value)) return { error: `${flag} 要是非負數：${value}` };
        options[numeric[flag]] = Number(value);
      } else options[text[flag]] = value;
    } else if (flag.startsWith('--')) return { error: `不認得的選項 ${flag}` };
    else if (rev === undefined) rev = flag;
    else return { error: `多出來的參數 ${flag}` };
  }
  if (rev !== undefined) options.rev = rev;
  if (!Number.isFinite(options.timeoutSec)) return { error: `CI_RUN_TIMEOUT_S 要是數字：${env.CI_RUN_TIMEOUT_S}` };
  return options;
}

/**
 * 一個 job（`gh run view --json jobs` 的一項）與它的 run 的結論 → { state: 'pass'|'fail'|'pending'|'unavailable', detail }。
 * job 是 undefined 時看 run：startup_failure 或 run 已結束卻沒有這個 job 是 unavailable，其他 pending。
 */
export function jobVerdict(job, run = {}) {
  if (!job) {
    if (run.conclusion === 'startup_failure') return { state: 'unavailable', detail: 'startup_failure' };
    if (run.status === 'completed') return { state: 'unavailable', detail: `no-job ${run.conclusion ?? ''}`.trim() };
    return { state: 'pending', detail: run.status ?? 'queued' };
  }
  if (job.status !== 'completed') return { state: 'pending', detail: job.status ?? 'queued' };
  if (job.conclusion === 'success') return { state: 'pass', detail: `${seconds(job)}s` };
  if (job.conclusion === 'cancelled') return { state: 'unavailable', detail: 'cancelled' };
  if (!job.steps?.length) return { state: 'unavailable', detail: `no-steps ${job.conclusion ?? ''}`.trim() };
  const failed = job.steps.find(step => step.conclusion === 'failure') ?? job.steps.find(step => step.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped');
  return { state: 'fail', detail: (failed?.name ?? job.conclusion ?? 'failure').replace(/\s+/g, '_') };
}

const seconds = job => Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000) || 0;

/** 預設的外部命令：gh 與 git 在 cwd 執行，傳回 { status, stdout, stderr }。 */
export function shell(cwd = process.cwd()) {
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: childEnv });
    return { status: result.error ? 127 : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
  };
  return { gh: args => run('gh', args), git: args => run('git', args) };
}

/**
 * 主流程（測試注入 gh、git、now、sleep、log）。傳回 { line, code }：line 是 stdout 的結果行。
 */
export async function ciRun(options, { gh, git, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = line => process.stderr.write(`${line}\n`), pollMs = Number(process.env.CI_RUN_POLL_S ?? 15) * 1000 } = {}) {
  const resolved = git(['rev-parse', '--verify', '-q', `${options.rev}^{commit}`]);
  if (resolved.status !== 0) return { line: `ci-run: 找不到 commit ${options.rev}`, code: 2 };
  const sha = resolved.stdout.trim();
  const ref = options.ref ?? `ci/${sha.slice(0, 12)}`;
  const started = now();
  let ghFailures = 0;
  let lastError = '';
  /** gh 讀 JSON；失敗時累計，連續 3 次就丟出 unavailable。 */
  const ghJson = args => {
    const result = gh(args);
    if (result.status === 0) {
      try { ghFailures = 0; return JSON.parse(result.stdout); } catch { lastError = 'bad-json'; }
    } else lastError = (result.stderr.trim().split('\n')[0] || `exit ${result.status}`).replace(/\s+/g, '_');
    ghFailures += 1;
    if (ghFailures >= 3) throw Object.assign(new Error(lastError), { unavailable: `gh ${lastError}` });
    return undefined;
  };
  const cleanup = () => {
    if (!DISPOSABLE_REF.test(ref)) return;
    const remote = git(['ls-remote', 'origin', `refs/heads/${ref}`]);
    if (remote.status === 0 && remote.stdout.startsWith(sha)) git(['push', '-q', 'origin', '--delete', ref]);
  };
  const finish = (line, code) => { if (code !== CI_PENDING_EXIT) cleanup(); return { line, code }; };

  /** 這個 SHA 上有這個 job 的最新 run：{ run, job }；沒有時 undefined。 */
  const findRun = () => {
    const runs = ghJson(['run', 'list', '--commit', sha, '--workflow', options.workflow, '--limit', '20', '--json', 'databaseId,status,conclusion,event,createdAt,url']);
    if (!runs) return undefined;
    for (const run of [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
      const view = ghJson(['run', 'view', String(run.databaseId), '--json', 'jobs,status,conclusion,url']);
      if (!view) return undefined;
      const job = view.jobs?.find(item => item.name === options.job);
      if (job || view.status !== 'completed') return { run: { ...run, ...view }, job };
    }
    return undefined;
  };

  try {
    let found = findRun();
    let pushedAt;
    if (!found) {
      let push = git(['push', '-q', 'origin', `${sha}:refs/heads/${ref}`]);
      if (push.status !== 0 && PUSH_TRANSIENT.test(push.stderr)) push = git(['push', '-q', 'origin', `${sha}:refs/heads/${ref}`]);
      if (push.status !== 0) return finish(`CI_UNAVAILABLE ${sha} push ${(push.stderr.trim().split('\n').pop() || `exit ${push.status}`).replace(/\s+/g, '_')}`, CI_UNAVAILABLE_EXIT);
      pushedAt = now();
    }
    let lastLog = started;
    for (;;) {
      found ??= findRun();
      const url = found?.run.url ?? '-';
      if (found) {
        const verdict = jobVerdict(found.job, found.run);
        if (verdict.state === 'pass') return finish(`CI_PASS ${sha} ${url} ${verdict.detail}`, 0);
        if (verdict.state === 'fail') return finish(`CI_FAIL ${sha} ${url} ${verdict.detail}`, 1);
        if (verdict.state === 'unavailable') return finish(`CI_UNAVAILABLE ${sha} ${verdict.detail} ${url}`, CI_UNAVAILABLE_EXIT);
        const queued = !found.job || ['queued', 'waiting', 'pending', 'requested'].includes(found.job.status);
        if (queued && now() - Date.parse(found.run.createdAt) > options.queueTimeoutSec * 1000) return finish(`CI_UNAVAILABLE ${sha} queued ${url}`, CI_UNAVAILABLE_EXIT);
      } else if (pushedAt !== undefined && now() - pushedAt > options.startTimeoutSec * 1000) {
        return finish(`CI_UNAVAILABLE ${sha} no-run`, CI_UNAVAILABLE_EXIT);
      }
      if (now() - started >= options.timeoutSec * 1000) return finish(`CI_PENDING ${sha} ${url}`, CI_PENDING_EXIT);
      if (now() - lastLog >= 60_000) {
        log(`CI_WAIT ${sha} ${url} ${Math.round((now() - started) / 1000)}s ${found ? jobVerdict(found.job, found.run).detail : 'no-run'}`);
        lastLog = now();
      }
      await sleep(pollMs);
      // 已找到的 run 每輪重讀狀態（同一個 run id）。
      if (found) {
        const view = ghJson(['run', 'view', String(found.run.databaseId), '--json', 'jobs,status,conclusion,url']);
        if (view) found = { run: { ...found.run, ...view }, job: view.jobs?.find(item => item.name === options.job) };
      }
    }
  } catch (error) {
    if (error.unavailable) return finish(`CI_UNAVAILABLE ${sha} ${error.unavailable}`, CI_UNAVAILABLE_EXIT);
    throw error;
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`${options.error}\n${USAGE}\n`);
    return 2;
  }
  const { line, code } = await ciRun(options, shell());
  console.log(line);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
