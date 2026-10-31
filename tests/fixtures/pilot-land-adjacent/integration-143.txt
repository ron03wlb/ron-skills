#!/usr/bin/env node
// /issue-pilot coordinator 的 Close：batch 的 merge 進到 origin/main 之後，照 docs/agents/pilot.md 的 Close 收掉每個 done 成員。
// 先跑 Bare guard（上一輪可能中斷在 Orca 設成 bare 之後），確認 merge SHA 已在 origin/main、主 checkout 的 main 跟上 origin/main（落後就 --ff-only），再對每個成員依序做
// evidence（證據留言）→ counterpart（對應單交接）→ close（關 Issue）→ terminal → worktree（rm 後跑 Bare guard）→ branch（`branch -d`）
// → remote（刪遠端分支）→ parent（子單全部結束就留言關母單）。每一步先看做過沒有，做過就 SKIP，所以中斷後可以重跑。
// 本機分支一律 `branch -d`，沒合進 main 就讓 git 拒絕（batch-40-51 手寫的 `-D` 會刪掉沒合入的分支）；設了 upstream 的分支 `-d` 只比 upstream，先自己比 main。
// Orca 一律用 `path:` 選擇器：Orca 開的 worktree 用 `branch:` 找不到（selector_not_found，#49）。
// Orca rm 會順便刪掉它能證明已合入的本機分支，這時 branch 步驟就 SKIP。
// 所有子行程的 stdin 都接 /dev/null（Orca CLI 會吃掉 stdin）；stderr 照常顯示，只濾掉 WSL 上 Orca 每次都印的 crashpad 錯誤行（#73）。
// 本 repo 的留言與關單都經 scripts/gh-tracker.mjs：.claude/settings.json 只放行它（#96）；跨 repo 的對應單留言照 #79 直接用 gh。
// 請求分支成員（Issue 欄 `-`、branch `retro/<x>`，#143）沒有 Issue：只做 terminal → worktree → branch → remote，不呼叫 gh 也不經 gh-tracker；
// 它的 DONE／SKIP／STOP 行以分支名稱代替 <n>（STOP branch-malformed 例外，照 checkpoint 印 `-`），Bare guard 的時機是 `close <分支>`。
// 對應單的交接內容要人寫：coordinator 先寫 <主 checkout>/.scratch/pilot/counterpart-<n>.md，內容要有 merge SHA 與 `ron03wlb/ron-skills#<n>`，
// 重跑時才認得出已經留過言。
//
// 用法：node scripts/pilot-close.mjs <batch key> <pr> <merge sha>（在主 checkout 跑，需要 ORCA_CLI_COMMAND）
// stdout：每一步一行 `DONE <n> <step>` 或 `SKIP <n> <step>`；任何一步失敗都印 `STOP <n> <step> <原因>` 並停下
//   （開頭 main 那步的 <n> 是 batch key；checkpoint 讀不到或沒有 done 成員只印 STOP <key> checkpoint；
//   done 成員的 branch 不是 `issue/<n>-<slug>`（請求分支成員是 `retro/<x>`）時，在任何寫入之前只印 STOP branch-malformed <n> <JSON 字串的 branch>）。Bare guard 還原主 checkout 時另有一行 UNBARE <主 checkout>。
//   全部成員做完，checkpoint 的 `current:` 寫成 `closed`，最後一行 `CLOSED <key>`。
// exit：0 CLOSED；4 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/pilot-close.mjs <batch key> <pr> <merge sha>（需要 ORCA_CLI_COMMAND）';
const REPO = 'ron03wlb/ron-skills';
const here = dirname(fileURLToPath(import.meta.url));

/** 步驟失敗：印成 `STOP <n> <step> <原因>`；沒帶 step 的錯誤由呼叫端補上正在做的那一步。 */
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
  if (result.status !== 0) throw new Stop('checkpoint', `git worktree list ${result.reason}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** `git worktree list` 裡分支是 `branch` 的 worktree 路徑；沒有傳回 undefined。 */
function worktreeOf(main, branch) {
  return gitIn(main, 'worktree', 'list', '--porcelain').stdout.split(/\n\n+/)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.branch === branch)?.path;
}

/** batch checkpoint 裡 state 是 done 的成員：`{ n, branch, handle, id }`（欄位見 PILOT-STORE.md）；`id` 是結果行裡的名稱，請求分支成員（n 是 `-`）用分支。 */
function doneMembers(text) {
  return text.split('\n').filter(line => line.startsWith('|')).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(([n, , , , , , state]) => /^(\d+|-)$/.test(n) && state === 'done')
    .map(([n, branch, , handle]) => ({ n, branch, handle, id: n === '-' ? branch : n }));
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
const tracker = (step, ...args) => must(step, 'node', [join(here, 'gh-tracker.mjs'), ...args]);
const api = (step, path) => JSON.parse(must(step, 'gh', ['api', `repos/${REPO}/${path}`]));

/**
 * 一個成員的 Close 各步驟，每一步先把 `at.step` 設成自己的名字，再傳回 'DONE' 或 'SKIP'；失敗丟錯。
 * 呼叫端用 `at.step` 印 DONE／SKIP 行，也替不是 Stop 的錯誤標出 STOP 的步驟。
 */
function* closeMember({ cli, main, key, pr, sha, regression }, { n, branch, handle }, at) {
  if (n !== '-') yield* closeIssue({ main, key, pr, sha, regression }, n, at);
  yield* cleanUp({ cli, main }, { n, branch, handle }, at);
  if (n !== '-') {
    at.step = 'parent';
    yield closeParent(n);
  }
}

/** Issue 成員的 evidence → counterpart → close。 */
function* closeIssue({ main, key, pr, sha, regression }, n, at) {
  at.step = 'evidence';
  const issue = issueView('evidence', n, REPO, 'state,body,comments');

  if (issue.comments.some(c => c.body.includes(sha))) yield 'SKIP';
  else {
    const body = [`已隨 https://github.com/${REPO}/pull/${pr} 合入 \`main\`（merge ${sha}），batch ${key}。`, regression].filter(Boolean).join('\n\n');
    tracker('evidence', 'comment', n, '--body', body);
    yield 'DONE';
  }

  at.step = 'counterpart';
  yield counterpart({ main, sha, n }, must('counterpart', 'node', [join(here, 'pilot-counterpart.mjs')], issue.body));

  at.step = 'close';
  if (issue.state === 'CLOSED') yield 'SKIP';
  else {
    tracker('close', 'close', n);
    yield 'DONE';
  }
}

/** terminal → worktree → branch → remote：只動本機與 origin 的 git、Orca，不碰 tracker。 */
function* cleanUp({ cli, main }, { n, branch, handle }, at) {
  at.step = 'terminal';
  // worktree 已經移除時，它的 terminal 也跟著關了，Orca 也認不得那個選擇器。
  const tree = worktreeOf(main, branch);
  const terminalOpen = handle && tree
    && orca(cli, 'terminal', 'terminal', 'list', '--worktree', `path:${tree}`).terminals.some(t => t.handle === handle);
  if (!terminalOpen) yield 'SKIP';
  else {
    orca(cli, 'terminal', 'terminal', 'close', '--terminal', handle);
    yield 'DONE';
  }

  at.step = 'worktree';
  if (!tree) yield 'SKIP';
  else {
    let failed;
    try { orca(cli, 'worktree', 'worktree', 'rm', '--worktree', `path:${tree}`); } catch (error) { failed = error; }
    // rm 失敗也可能已把主 checkout 設成 bare，或其實已經移除（Orca 曾在建好 worktree 時回 ok:false）；以 git worktree list 為準。
    const unbare = run(join(here, 'pilot-unbare.sh'), [main, `close ${n === '-' ? branch : `#${n}`}`]);
    if (unbare.stdout) process.stdout.write(unbare.stdout);
    if (unbare.status !== 0) throw new Stop('worktree', [failed?.message, `unbare ${unbare.reason}`].filter(Boolean).join('；'));
    if (worktreeOf(main, branch)) throw failed ?? new Stop('worktree', 'rm 之後 git worktree list 仍有這個分支');
    yield 'DONE';
  }

  at.step = 'branch';
  if (!gitIn(main, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).stdout.trim()) yield 'SKIP';
  else {
    // 分支設了 upstream 時 `branch -d` 只比 upstream，沒合進 main 也會刪掉，所以這時先自己比 main；沒有 upstream 就讓 `branch -d` 拒絕。
    const upstream = gitIn(main, 'for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`).stdout.trim();
    if (upstream && gitIn(main, 'merge-base', '--is-ancestor', branch, 'main').status !== 0) throw new Stop('branch', `${branch} 有沒合進 main 的 commit（upstream 已有，branch -d 不會擋）`);
    must('branch', 'git', ['-C', main, 'branch', '-d', branch]);
    yield 'DONE';
  }

  at.step = 'remote';
  const remote = gitIn(main, 'ls-remote', '--exit-code', '--heads', 'origin', branch).status;
  if (remote === 2) yield 'SKIP';
  else if (remote !== 0) throw new Stop('remote', `ls-remote exit ${remote}`);
  else {
    must('remote', 'git', ['-C', main, 'push', 'origin', '--delete', branch]);
    yield 'DONE';
  }
}

/** 對應單交接；沒有對應單或每張都已留過言傳回 SKIP。 */
function counterpart({ main, sha, n }, refs) {
  const file = join(main, `.scratch/pilot/counterpart-${n}.md`);
  const member = `${REPO}#${n}`;
  const namesMember = new RegExp(`${member.replace(/[/#]/g, '\\$&')}\\b`);
  let posted = false;
  for (const [, repo, m] of refs.matchAll(/^COUNTERPART (\S+)#(\d+)$/gm)) {
    if (issueView('counterpart', m, repo, 'comments').comments.some(c => c.body.includes(sha) && namesMember.test(c.body))) continue;
    if (!existsSync(file)) throw new Stop('counterpart', `${repo}#${m} 缺 ${file}`);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(sha) || !namesMember.test(text)) throw new Stop('counterpart', `${repo}#${m} ${file} 要寫出 merge ${sha} 與成員 ${member}`);
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
  const children = api('parent', `issues/${parent}/sub_issues?per_page=100`).map(c => `- #${c.number} ${c.state_reason}`);
  const body = `子單全部結束，關閉母單：\n\n${children.join('\n')}`;
  if (!issueView('parent', parent, REPO, 'comments').comments.some(c => c.body === body)) {
    tracker('parent', 'comment', String(parent), '--body', body);
  }
  tracker('parent', 'close', String(parent));
  return 'DONE';
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [key, pr, sha] = process.argv.slice(2);
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!key || !/^\d+$/.test(pr ?? '') || !/^[0-9a-f]{7,40}$/.test(sha ?? '') || !cli) {
    console.error(USAGE);
    process.exit(2);
  }
  // 正在做的那一步：不是 Stop 的錯誤（gh 回的不是 JSON 等）也照樣印成 STOP。
  const at = { n: key, step: 'checkpoint' };
  try {
    const main = mainCheckout();
    const checkpoint = join(main, `.scratch/pilot/batch-${key}.md`);
    if (!existsSync(checkpoint)) throw new Stop('checkpoint', `缺 ${checkpoint}`);
    const text = readFileSync(checkpoint, 'utf8');
    if (!/^current: /m.test(text)) throw new Stop('checkpoint', `${checkpoint} 沒有 current: 行`);
    const members = doneMembers(text);
    if (!members.length) throw new Stop('checkpoint', `${checkpoint} 沒有 done 成員`);
    // 空的或手寫錯的 branch 會讓 remote 步驟拿它跑 ls-remote（空 pattern 列出全部 heads，exit 0）再 push --delete（#120），
    // 所以在 Bare guard、main 與任何成員的寫入之前，先確認每個 done 成員的 branch 都是 issue/<這一列的 n>-<slug>。
    const malformed = members.find(({ n, branch }) => !new RegExp(n === '-' ? '^retro/[a-z0-9][a-z0-9-]*$' : `^issue/${n}-[a-z0-9-]+$`).test(branch));
    if (malformed) {
      console.log(`STOP branch-malformed ${malformed.n} ${JSON.stringify(malformed.branch)}`);
      process.exit(4);
    }
    const regression = text.match(/^regression: .*$/gm)?.pop();
    // 上一輪可能中斷在 Orca rm 把主 checkout 設成 bare 之後；那時 worktree 已經不在，worktree 步驟不會再跑 Bare guard。
    const unbare = run(join(here, 'pilot-unbare.sh'), [main, `close #${key}`]);
    if (unbare.stdout) process.stdout.write(unbare.stdout);
    if (unbare.status !== 0) throw new Stop('checkpoint', `unbare ${unbare.reason}`);
    at.step = 'main';
    console.log(`${syncMain(main, sha)} ${key} main`);
    for (const member of members) {
      at.n = member.id;
      for (const outcome of closeMember({ cli, main, key, pr, sha, regression }, member, at)) console.log(`${outcome} ${member.id} ${at.step}`);
    }
    Object.assign(at, { n: key, step: 'checkpoint' });
    writeFileSync(checkpoint, readFileSync(checkpoint, 'utf8').replace(/^current: .*$/m, 'current: closed'));
    console.log(`CLOSED ${key}`);
  } catch (error) {
    console.log(`STOP ${at.n} ${error instanceof Stop ? error.step : at.step} ${error.message.split('\n')[0]}`);
    process.exit(4);
  }
}
