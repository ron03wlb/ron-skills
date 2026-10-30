#!/usr/bin/env node
// /issue-pilot coordinator 的 Close：batch 的 merge 進到 origin/main 之後，照 docs/agents/pilot.md 的 Close 收掉每個 done 成員。
// 先確認 merge SHA 已在 origin/main、主 checkout 的 main 跟上 origin/main（落後就 --ff-only），再對每個成員依序做
// evidence（證據留言）→ counterpart（對應單交接）→ close（關 Issue）→ terminal → worktree（rm 後跑 Bare guard）→ branch（`branch -d`）
// → remote（刪遠端分支）→ parent（子單全部結束就留言關母單）。每一步先看做過沒有，做過就 SKIP，所以中斷後可以重跑。
// 本機分支一律 `branch -d`，沒合進 main 就讓 git 拒絕（batch-40-51 手寫的 `-D` 會刪掉沒合入的分支）。
// 所有子行程的 stdin 都接 /dev/null（Orca CLI 會吃掉 stdin）；stderr 照常顯示，只濾掉 WSL 上 Orca 每次都印的 crashpad 錯誤行（#73）。
// 對應單的交接內容要人寫：coordinator 先寫 <主 checkout>/.scratch/pilot/counterpart-<n>.md，內容要有 merge SHA 與 `ron03wlb/ron-skills#<n>`，
// 重跑時才認得出已經留過言。
//
// 用法：node scripts/pilot-close.mjs <batch key> <pr> <merge sha>（在主 checkout 跑，需要 ORCA_CLI_COMMAND）
// stdout：每一步一行 `DONE <n> <step>` 或 `SKIP <n> <step>`；失敗時印 `STOP <n> <step> <原因>` 並停下（main 那步的 <n> 是 batch key）。
//   Bare guard 還原主 checkout 時另有一行 UNBARE <主 checkout>。全部成員做完，checkpoint 的 `current:` 寫成 `closed`，最後一行 `CLOSED <key>`。
// exit：0 CLOSED；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/pilot-close.mjs <batch key> <pr> <merge sha>（需要 ORCA_CLI_COMMAND）';
const REPO = 'ron03wlb/ron-skills';
const here = dirname(fileURLToPath(import.meta.url));

/** STOP 用的錯誤：`step` 與原因組成 `STOP <n> <step> <原因>`。 */
class Stop extends Error {
  constructor(step, reason) {
    super(reason);
    this.step = step;
  }
}

/** 同步跑子行程：stdin 接 /dev/null（有 `input` 時改送它），stderr 濾掉 crashpad 行後照常寫到本行程的 stderr。 */
function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: 120000 });
  const stderr = (result.stderr ?? '').split('\n').filter(line => !line.includes('registration_protocol_win.cc')).join('\n');
  if (stderr.trim()) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  const reason = stderr.trim().split('\n').pop() || (result.error?.message ?? `exit ${result.status}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr, reason };
}

/** 跑子行程，exit 非 0 就以 `step` STOP。 */
function must(step, command, args, input) {
  const result = run(command, args, input);
  if (result.status !== 0) throw new Stop(step, result.reason);
  return result.stdout;
}

const gitIn = (main, ...args) => run('git', ['-C', main, ...args]);

/** Orca CLI 呼叫；回傳 JSON 的 result，`ok: false` 或輸出不是 JSON 時以 `step` STOP。 */
function orca(cli, step, ...args) {
  const result = run(cli, [...args, '--json']);
  let body;
  try { body = JSON.parse(result.stdout); } catch { throw new Stop(step, `orca ${result.reason}`); }
  if (!body.ok) throw new Stop(step, `orca ${body.error?.code ?? body.error?.message ?? 'failed'}`);
  return body.result;
}

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) throw new Error(`git worktree list 失敗：${result.reason}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** `git worktree list` 裡分支是 `branch` 的 worktree 路徑；沒有傳回 undefined。 */
function worktreeOf(main, branch) {
  return gitIn(main, 'worktree', 'list', '--porcelain').stdout.split(/\n\n+/)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.branch === branch)?.path;
}

/** batch checkpoint 裡 state 是 done 的成員：`{ n, branch, handle }`。 */
function doneMembers(text) {
  return text.split('\n').map(line => line.split('|').map(cell => cell.trim()))
    .filter(cells => /^\d+$/.test(cells[1] ?? '') && cells[7] === 'done')
    .map(cells => ({ n: cells[1], branch: cells[2], handle: cells[4] }));
}

/** merge SHA 要已在 origin/main；主 checkout 要在 main 上，落後 origin/main 就 --ff-only 跟上。 */
function syncMain(main, sha) {
  if (gitIn(main, 'merge-base', '--is-ancestor', sha, 'origin/main').status !== 0) throw new Stop('main', `merge ${sha} 不在 origin/main`);
  const head = gitIn(main, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  if (head !== 'main') throw new Stop('main', `主 checkout 在 ${head || 'detached HEAD'}，不是 main`);
  const behind = gitIn(main, 'merge-base', '--is-ancestor', 'origin/main', 'main').status;
  if (behind === 0) return 'SKIP';
  if (behind !== 1) throw new Stop('main', `merge-base exit ${behind}`);
  must('main', 'git', ['-C', main, 'merge', '--ff-only', 'origin/main']);
  return 'DONE';
}

const issueView = (step, n, repo, fields) => JSON.parse(must(step, 'gh', ['issue', 'view', String(n), '--repo', repo, '--json', fields]));
const api = (step, path) => JSON.parse(must(step, 'gh', ['api', `repos/${REPO}/${path}`]));

/** 一個成員的 Close 各步驟，依序傳回 [step, 'DONE' | 'SKIP']；失敗丟 Stop。 */
function* closeMember({ cli, main, key, pr, sha, regression }, { n, branch, handle }) {
  const issue = issueView('evidence', n, REPO, 'state,body,comments');

  if (issue.comments.some(c => c.body.includes(sha))) yield ['evidence', 'SKIP'];
  else {
    const body = [`已隨 https://github.com/${REPO}/pull/${pr} 合入 \`main\`（merge ${sha}），batch ${key}。`, regression].filter(Boolean).join('\n\n');
    must('evidence', 'gh', ['issue', 'comment', n, '--repo', REPO, '--body', body]);
    yield ['evidence', 'DONE'];
  }

  const refs = must('counterpart', 'node', [join(here, 'pilot-counterpart.mjs')], issue.body);
  yield ['counterpart', counterpart({ main, sha, n }, refs)];

  if (issue.state === 'CLOSED') yield ['close', 'SKIP'];
  else {
    must('close', 'gh', ['issue', 'close', n, '--repo', REPO]);
    yield ['close', 'DONE'];
  }

  // worktree 已經移除時，它的 terminal 也跟著關了，Orca 也認不得那個 branch selector。
  const open = handle && worktreeOf(main, branch)
    && orca(cli, 'terminal', 'terminal', 'list', '--worktree', `branch:${branch}`).terminals.some(t => t.handle === handle);
  if (!open) yield ['terminal', 'SKIP'];
  else {
    orca(cli, 'terminal', 'terminal', 'close', '--terminal', handle);
    yield ['terminal', 'DONE'];
  }

  if (!worktreeOf(main, branch)) yield ['worktree', 'SKIP'];
  else {
    let failed;
    try { orca(cli, 'worktree', 'worktree', 'rm', '--worktree', `branch:${branch}`); } catch (error) { failed = error; }
    const unbare = run(join(here, 'pilot-unbare.sh'), [main, `close #${n}`]);
    if (unbare.stdout) process.stdout.write(unbare.stdout);
    if (unbare.status !== 0) throw new Stop('worktree', `unbare ${unbare.reason}`);
    if (failed) throw failed;
    if (worktreeOf(main, branch)) throw new Stop('worktree', 'rm 之後 git worktree list 仍有這個分支');
    yield ['worktree', 'DONE'];
  }

  if (!gitIn(main, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).stdout.trim()) yield ['branch', 'SKIP'];
  else {
    must('branch', 'git', ['-C', main, 'branch', '-d', branch]);
    yield ['branch', 'DONE'];
  }

  const remote = gitIn(main, 'ls-remote', '--exit-code', '--heads', 'origin', branch).status;
  if (remote === 2) yield ['remote', 'SKIP'];
  else if (remote !== 0) throw new Stop('remote', `ls-remote exit ${remote}`);
  else {
    must('remote', 'git', ['-C', main, 'push', 'origin', '--delete', branch]);
    yield ['remote', 'DONE'];
  }

  yield ['parent', closeParent(n)];
}

/** 對應單交接；沒有對應單或每張都已留過言傳回 SKIP。 */
function counterpart({ main, sha, n }, refs) {
  const file = join(main, `.scratch/pilot/counterpart-${n}.md`);
  const member = `${REPO}#${n}`;
  let posted = false;
  for (const [, repo, m] of refs.matchAll(/^COUNTERPART (\S+)#(\d+)$/gm)) {
    const done = new RegExp(`${member.replace(/[/#]/g, '\\$&')}\\b`);
    if (issueView('counterpart', m, repo, 'comments').comments.some(c => c.body.includes(sha) && done.test(c.body))) continue;
    if (!existsSync(file)) throw new Stop('counterpart', `${repo}#${m} 缺 ${file}`);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(sha) || !done.test(text)) throw new Stop('counterpart', `${repo}#${m} ${file} 要寫出 merge ${sha} 與成員 ${member}`);
    must('counterpart', 'gh', ['issue', 'comment', m, '--repo', repo, '--body-file', file]);
    posted = true;
  }
  return posted ? 'DONE' : 'SKIP';
}

/** 成員有母單、母單還開著而且子單全部結束，就留言列出每張子單的 state_reason 再關母單。 */
function closeParent(n) {
  const found = run('gh', ['api', `repos/${REPO}/issues/${n}/parent`]);
  if (found.status !== 0) {
    if (/HTTP 404/.test(found.stderr)) return 'SKIP';
    throw new Stop('parent', found.reason);
  }
  const parent = JSON.parse(found.stdout).number;
  const { state, sub_issues_summary: summary } = api('parent', `issues/${parent}`);
  if (state === 'closed' || summary.completed !== summary.total) return 'SKIP';
  const children = api('parent', `issues/${parent}/sub_issues`).map(c => `- #${c.number} ${c.state_reason}`);
  const body = `子單全部結束，關閉母單：\n\n${children.join('\n')}`;
  if (!issueView('parent', parent, REPO, 'comments').comments.some(c => c.body === body)) {
    must('parent', 'gh', ['issue', 'comment', String(parent), '--repo', REPO, '--body', body]);
  }
  must('parent', 'gh', ['issue', 'close', String(parent), '--repo', REPO]);
  return 'DONE';
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [key, pr, sha] = process.argv.slice(2);
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!key || !/^\d+$/.test(pr ?? '') || !/^[0-9a-f]{7,40}$/.test(sha ?? '') || !cli) {
    console.error(USAGE);
    process.exit(2);
  }
  let current = key;
  try {
    const main = mainCheckout();
    const checkpoint = join(main, `.scratch/pilot/batch-${key}.md`);
    const text = readFileSync(checkpoint, 'utf8');
    const regression = text.match(/^regression: .*$/gm)?.pop();
    console.log(`${syncMain(main, sha)} ${key} main`);
    for (const member of doneMembers(text)) {
      current = member.n;
      for (const [step, outcome] of closeMember({ cli, main, key, pr, sha, regression }, member)) console.log(`${outcome} ${member.n} ${step}`);
    }
    writeFileSync(checkpoint, readFileSync(checkpoint, 'utf8').replace(/^current: .*$/m, 'current: closed'));
    console.log(`CLOSED ${key}`);
  } catch (error) {
    if (!(error instanceof Stop)) {
      console.error(error.message);
      process.exit(1);
    }
    console.log(`STOP ${current} ${error.step} ${error.message}`);
    process.exit(4);
  }
}
