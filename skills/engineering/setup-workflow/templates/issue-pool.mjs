#!/usr/bin/env node
// 把開著的 Issue 逐張分桶，pilot 的 Pool 從 ready 桶依序挑；第一版只支援 GitHub（gh CLI）。
// 用法：node scripts/issue-pool.mjs [--repo <owner>/<name>] [--stale-hours <h>] [--categories <label>,...]
//       node scripts/issue-pool.mjs claim <n> [--repo <owner>/<name>] [--session <id>]
// 一張只歸一個桶，依序取第一個符合的：parent（有 sub-issue）、human（`ready-for-human`，指派給人不算認領）、
// stale（已指派，超過 --stale-hours（預設 24）沒有新留言或新指派）、claimed（已指派）、retro-candidates（`retro-candidates` label：retro 的候選清單，等 `/retro-collect`）、blocked（有開著的 blocked_by）、
// needs-info、needs-triage、ready（`ready-for-agent`）、unlabeled。所以 ready 桶就是池子。過期的認領只歸到 stale，不自動釋放。
// 輸出順序：ready 桶先印，依 `retro` label 的先（retro 判定太複雜、交給 worker 的單）、`priority` label 的先、直接或間接 block 最多開著的單的先（關鍵路徑）、號碼小的先；
// 其餘依上面的桶順序、桶內號碼小的先。
// stdout：每張一行 `<桶> #<n> <標題>`；之後對開著、有 triage 狀態 label（TRIAGE_STATES）卻沒有分類 label 的單各印一行 `NO_CATEGORY <n>`（號碼小的先），
// 母單（有 sub-issue 或 `parent` label）與 `retro-candidates` 不算。分類 label 預設是 DEFAULT_CATEGORIES（triage 的 `bug`、`enhancement`），
// adapter 用的 label 不同時以 `--categories` 覆寫（逗號分隔）。exit 0。gh 失敗時 stderr 印原因、exit 1；用法錯誤 exit 2。
// claim 是 session 開始處理一張 Issue 前的認領：先留「認領：<機器>／<session>」（整則留言只有這一行；session 預設
// $CLAUDE_CODE_SESSION_ID，其次 $ORCA_TERMINAL_HANDLE），再 `--add-assignee @me`，印 `CLAIMED <n>`。同一個帳號會在好幾台機器上跑，
// 指派分不出是誰，所以看認領留言：
// - 已被指派時，最近一則認領留言必須是這個 session、作者還在指派名單裡，才再認領一次（重派；新留言順便更新 stale 的時間），否則不改 Issue。
// - 還沒人指派、但最近一則認領是別的 session 在 5 分鐘內留的：對方正在認領，不改 Issue。
// - 寫入後重讀：這次讀到之後新增的認領留言裡，最早一則不是自己就是別台搶先了，收回自己的留言（指派到這裡一定是同一個帳號，不動）。
// - 擋下的認領者是這台機器上已交接出去的前任 coordinator（主 checkout 的 `.scratch/pilot/sessions.md` 有它的 handoff 行），
//   而這個 session 是現任 coordinator（有 start 行、沒交接出去）時，改以前任的 session 認領，成功印 `CLAIMED <n> takeover <session>`（#135）。
// 被擋時印 `STOP <n> claimed <機器>／<session>`（沒有認領留言、或最近一則認領的作者已不在指派名單時，是指派者登入名），exit 4。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/issue-pool.mjs [--repo <owner>/<name>] [--stale-hours <h>] [--categories <label>,...] | claim <n> [--repo <owner>/<name>] [--session <id>]';
const QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{number title labels(first:50){nodes{name}} assignees(first:20){nodes{login}} subIssuesSummary{total} blockedBy(first:50){nodes{number state repository{nameWithOwner}}} blocking(first:50){nodes{number state repository{nameWithOwner}}} comments(last:1){nodes{createdAt}} timelineItems(last:1,itemTypes:[ASSIGNED_EVENT]){nodes{... on AssignedEvent{createdAt}}}}}}}`;

class GhError extends Error {}
function gh(...args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new GhError(`gh ${args.slice(0, 2).join(' ')} 失敗：${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

function openIssues(repo) {
  const [owner, name] = repo.split('/');
  const issues = [];
  for (let cursor = null, more = true; more;) {
    const page = JSON.parse(gh('api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, ...(cursor ? ['-F', `cursor=${cursor}`] : []), '-f', `query=${QUERY}`)).data.repository.issues;
    issues.push(...page.nodes);
    ({ hasNextPage: more, endCursor: cursor } = page.pageInfo);
  }
  return issues;
}

const openNodes = ({ nodes }) => nodes.filter(({ state }) => state === 'OPEN');

/** 認領之後最後一次動靜：最近一則留言或最近一次指派，取較晚的；都沒有時是 0（視為過期）。 */
const lastActivity = issue => Math.max(0, ...[...issue.comments.nodes, ...issue.timelineItems.nodes].map(({ createdAt }) => Date.parse(createdAt)));

const labelsOf = issue => new Set(issue.labels.nodes.map(({ name }) => name));

/** 每張 Issue 歸到一個桶，優先序見檔頭。 */
export function bucketOf(issue, { staleHours = 24, now = Date.now() } = {}) {
  const labels = labelsOf(issue);
  if (issue.subIssuesSummary.total > 0) return 'parent';
  if (labels.has('ready-for-human')) return 'human';
  if (issue.assignees.nodes.length) return now - lastActivity(issue) > staleHours * 3600_000 ? 'stale' : 'claimed';
  if (labels.has('retro-candidates')) return 'retro-candidates';
  if (openNodes(issue.blockedBy).length) return 'blocked';
  if (labels.has('needs-info')) return 'needs-info';
  if (labels.has('needs-triage')) return 'needs-triage';
  if (labels.has('ready-for-agent')) return 'ready';
  return 'unlabeled';
}

const BUCKETS = ['ready', 'parent', 'human', 'stale', 'claimed', 'retro-candidates', 'blocked', 'needs-info', 'needs-triage', 'unlabeled'];

/** 直接或間接被這張 block、而且還開著的 Issue 數；沿本 repo 列表裡的 blocking 邊走，別的 repo 或不在列表裡的開著的單只算一張。 */
function blockingCount(issue, byNumber, repo) {
  const seen = new Set([`${repo}#${issue.number}`]);
  const walk = node => {
    for (const { number, repository: { nameWithOwner } } of openNodes(node.blocking)) {
      const key = `${nameWithOwner}#${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (nameWithOwner === repo && byNumber.has(number)) walk(byNumber.get(number));
    }
  };
  walk(issue);
  return seen.size - 1;
}

/** 分好桶、排好序的 Issue 列表（順序見檔頭）；repo 是 `<owner>/<name>`，用來分辨 blocking 邊是不是本 repo 的單。 */
export function pool(issues, { repo, ...options }) {
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const rows = issues.map(issue => ({
    issue, bucket: bucketOf(issue, options),
    retro: issue.labels.nodes.some(({ name }) => name === 'retro') ? 1 : 0,
    priority: issue.labels.nodes.some(({ name }) => name === 'priority') ? 1 : 0,
    blocks: blockingCount(issue, byNumber, repo),
  }));
  const rank = row => BUCKETS.indexOf(row.bucket);
  return rows.sort((a, b) => rank(a) - rank(b)
    || (a.bucket === 'ready' && (b.retro - a.retro || b.priority - a.priority || b.blocks - a.blocks))
    || a.issue.number - b.issue.number);
}

/** triage 的五個狀態 label 與兩個分類 label 預設值（Matt 的 `/triage`：每張一個分類加一個狀態）。 */
export const TRIAGE_STATES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];
export const DEFAULT_CATEGORIES = ['bug', 'enhancement'];

/** 有 triage 狀態卻沒有分類的單，號碼小的先；母單與 retro 候選清單本來就不掛分類，不算。
 * 母單除了 parent 桶看的 sub-issue，也認 `parent` label：子單還沒建好、只掛了 label 的母單同樣不該被要求補分類。 */
export function missingCategory(issues, categories = DEFAULT_CATEGORIES) {
  return issues.filter(issue => {
    const labels = labelsOf(issue);
    if (issue.subIssuesSummary.total > 0 || labels.has('parent') || labels.has('retro-candidates')) return false;
    return TRIAGE_STATES.some(name => labels.has(name)) && !categories.some(name => labels.has(name));
  }).map(({ number }) => number).sort((a, b) => a - b);
}

/** 沒人指派時，這段時間內別人留的認領留言算進行中（留言與指派之間的空檔）；更舊的視為已被取消指派。 */
const IN_FLIGHT_MS = 5 * 60_000;

/** 整則留言只有「認領：<機器>／<session>」一行時回傳認領者；引用或夾在其他文字裡的不算。 */
const claimerOf = ({ body }) => body.trim().match(/^認領：([^\n]+)$/)?.[1];
const latestClaimer = comments => claimerOf(comments.filter(claimerOf).at(-1) ?? { body: '' });
const claimerName = session => `${hostname()}／${session}`;

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處；不在 git repo 裡時是 undefined（claim 照舊 STOP，不像 pilot-dispatch 那樣丟錯）。 */
function mainCheckout() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.split('\n')[0].replace(/^worktree /, '') : undefined;
}

/** 擋下認領的是本機已交接出去的前任 coordinator、而 claim 的 session 是現任 coordinator（有 start 行、沒交接出去）時，傳回前任的 session；
 * 都照主 checkout 的 sessions.md（PILOT-STORE.md 的格式）判斷，讀不到時是 undefined。 */
function takeoverSession(claimer, session) {
  const [host, previous] = claimer.split('／');
  const main = host === hostname() && previous ? mainCheckout() : undefined;
  if (!main) return undefined;
  let lines;
  try { lines = readFileSync(join(main, '.scratch/pilot/sessions.md'), 'utf8').split('\n'); } catch { return undefined; }
  const retired = id => lines.some(line => line.includes(`   handoff from-session ${id} `));
  const started = id => lines.some(line => line.includes(`   session ${id}   `) || (line.endsWith('  coordinator start') && line.includes(`  ${id}  `)));
  return retired(previous) && started(session) && !retired(session) ? previous : undefined;
}

/** claim 與 pilot-dispatch 預設的 session。 */
export const defaultSession = () => process.env.CLAUDE_CODE_SESSION_ID || process.env.ORCA_TERMINAL_HANDLE || 'unknown';

/** 最近一則認領留言是 `session` 的（含 claim 以前任 coordinator 的 session 接手的）時為真；沒有認領留言時為假。pilot-dispatch 派工前用（#165）。 */
export function claimedBy(comments, session) {
  const claimer = latestClaimer(comments);
  return Boolean(claimer) && (claimer === claimerName(session) || Boolean(takeoverSession(claimer, session)));
}

function claim(n, repo, session) {
  const target = [n, ...(repo ? ['--repo', repo] : [])];
  const read = () => JSON.parse(gh('issue', 'view', ...target, '--json', 'assignees,comments'));
  const stop = claimer => { console.log(`STOP ${n} claimed ${claimer}`); return 4; };
  const mine = claimerName(session);
  const before = read();
  const last = before.comments.filter(claimerOf).at(-1);
  let blocker;
  if (before.assignees.length) {
    const logins = before.assignees.map(({ login }) => login);
    if (!last || !logins.includes(last.author.login)) return stop(logins.join(','));
    if (claimerOf(last) !== mine) blocker = claimerOf(last);
  } else if (last && claimerOf(last) !== mine && Date.now() - Date.parse(last.createdAt) < IN_FLIGHT_MS) {
    // 別的 session 剛留言、還沒指派：當成進行中的認領，不然兩邊都會在對方指派前寫入、各自以為贏了。
    blocker = claimerOf(last);
  }
  const takeover = blocker && takeoverSession(blocker, session);
  if (blocker && !takeover) return stop(blocker);
  const claimant = takeover ? blocker : mine;
  // 先留言再指派：指派成功、留言失敗時，重跑會被自己沒有留言的指派擋住。
  gh('issue', 'comment', ...target, '--body', `認領：${claimant}`);
  gh('issue', 'edit', ...target, '--add-assignee', '@me');
  const first = read().comments.slice(before.comments.length).find(claimerOf);
  if (first && claimerOf(first) !== claimant) {
    // 收回搶輸的留言，不然贏家重派時最近一則認領是自己的，會被擋下；輸家的留言在贏家的認領之後，`--delete-last` 刪的是這個帳號最新一則，所以前提是贏家這幾秒內沒有再留言。
    gh('issue', 'comment', ...target, '--delete-last', '--yes');
    return stop(claimerOf(first));
  }
  console.log(takeover ? `CLAIMED ${n} takeover ${takeover}` : `CLAIMED ${n}`);
  return 0;
}

function main(argv) {
  let repo, staleHours = 24, categories = DEFAULT_CATEGORIES, session = defaultSession();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) repo = argv[++i];
    else if (argv[i] === '--stale-hours' && Number(argv[i + 1]) > 0) staleHours = Number(argv[++i]);
    else if (argv[i] === '--categories' && argv[i + 1]) categories = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--session' && argv[i + 1]) session = argv[++i];
    else if (!argv[i].startsWith('-')) positional.push(argv[i]);
    else { console.error(USAGE); return 2; }
  }
  const [command, n] = positional;
  if (command !== undefined && !(command === 'claim' && /^\d+$/.test(n ?? '') && positional.length === 2)) { console.error(USAGE); return 2; }
  try {
    if (command === 'claim') return claim(n, repo, session);
    repo ??= gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
    const issues = openIssues(repo);
    for (const { issue, bucket } of pool(issues, { repo, staleHours })) console.log(`${bucket} #${issue.number} ${issue.title}`);
    for (const number of missingCategory(issues, categories)) console.log(`NO_CATEGORY ${number}`);
    return 0;
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
