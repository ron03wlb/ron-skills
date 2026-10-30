#!/usr/bin/env node
// 把開著的 Issue 逐張分桶，pilot 的 Pool 從 ready 桶依序挑；第一版只支援 GitHub（gh CLI）。
// 用法：node scripts/issue-pool.mjs [--repo <owner>/<name>] [--stale-hours <h>]
//       node scripts/issue-pool.mjs claim <n> [--repo <owner>/<name>] [--session <id>]
// 一張只歸一個桶，依序取第一個符合的：parent（有 sub-issue）、stale（已指派，超過 --stale-hours（預設 24）沒有新留言）、claimed（已指派）、
// retro（`retro` label）、blocked（有開著的 blocked_by）、human（`ready-for-human`）、needs-info、needs-triage、ready（`ready-for-agent`）、unlabeled。
// 過期的認領只歸到 stale，不自動釋放。
// 輸出順序：ready 桶先印，依 `priority` label 的先、直接或間接 block 最多開著的單的先（關鍵路徑）、號碼小的先；
// 其餘依上面的桶順序、桶內號碼小的先。
// stdout：每張一行 `<桶> #<n> <標題>`；exit 0。gh 失敗時 stderr 印原因、exit 1；用法錯誤 exit 2。
// claim 是 session 開始處理一張 Issue 前的認領：`--add-assignee @me`，再留「認領：<機器>／<session>」（session 預設
// $CLAUDE_CODE_SESSION_ID，其次 $ORCA_TERMINAL_HANDLE），印 `CLAIMED <n>`。同一個帳號會在好幾台機器上跑，所以已被指派就看最近一則認領留言：
// 是這台機器（同機器的重派由 batch checkpoint 擋）印 `CLAIMED <n> already`、不再留言；其他情況印 `STOP <n> claimed <認領者>`、exit 4，不改 Issue。
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/issue-pool.mjs [--repo <owner>/<name>] [--stale-hours <h>] | claim <n> [--repo <owner>/<name>] [--session <id>]';
const QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{number title labels(first:20){nodes{name}} assignees(first:10){nodes{login}} subIssuesSummary{total} blockedBy(first:20){nodes{number state}} blocking(first:20){nodes{number state}} comments(last:1){nodes{createdAt}} timelineItems(last:1,itemTypes:[ASSIGNED_EVENT]){nodes{... on AssignedEvent{createdAt}}}}}}}`;

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

const open = ({ nodes }) => nodes.filter(({ state }) => state === 'OPEN');

/** 認領之後最後一次動靜：最近一則留言或最近一次指派，取較晚的；都沒有時是 0（視為過期）。 */
const lastActivity = issue => Math.max(0, ...[...issue.comments.nodes, ...issue.timelineItems.nodes].map(({ createdAt }) => Date.parse(createdAt)));

/** 每張 Issue 歸到一個桶，優先序見檔頭。 */
export function bucketOf(issue, { staleHours = 24, now = Date.now() } = {}) {
  const labels = new Set(issue.labels.nodes.map(({ name }) => name));
  if (issue.subIssuesSummary.total > 0) return 'parent';
  if (issue.assignees.nodes.length) return now - lastActivity(issue) > staleHours * 3600_000 ? 'stale' : 'claimed';
  if (labels.has('retro')) return 'retro';
  if (open(issue.blockedBy).length) return 'blocked';
  if (labels.has('ready-for-human')) return 'human';
  if (labels.has('needs-info')) return 'needs-info';
  if (labels.has('needs-triage')) return 'needs-triage';
  if (labels.has('ready-for-agent')) return 'ready';
  return 'unlabeled';
}

const BUCKETS = ['ready', 'parent', 'stale', 'claimed', 'retro', 'blocked', 'human', 'needs-info', 'needs-triage', 'unlabeled'];

/** 直接或間接被這張 block、而且還開著的 Issue 數；沿列表裡的 blocking 邊走，不在列表裡的開著的單只算一張。 */
function blockedCount(issue, byNumber) {
  const seen = new Set();
  const walk = node => {
    for (const { number } of open(node.blocking)) {
      if (seen.has(number)) continue;
      seen.add(number);
      if (byNumber.has(number)) walk(byNumber.get(number));
    }
  };
  walk(issue);
  seen.delete(issue.number);
  return seen.size;
}

/** 分好桶、排好序的 Issue 列表（順序見檔頭）。 */
export function pool(issues, options) {
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const rows = issues.map(issue => ({
    issue, bucket: bucketOf(issue, options),
    priority: issue.labels.nodes.some(({ name }) => name === 'priority') ? 1 : 0,
    blocks: blockedCount(issue, byNumber),
  }));
  const rank = row => BUCKETS.indexOf(row.bucket);
  return rows.sort((a, b) => rank(a) - rank(b)
    || (a.bucket === 'ready' && (b.priority - a.priority || b.blocks - a.blocks))
    || a.issue.number - b.issue.number);
}

function claim(n, repo, session) {
  const target = [n, ...(repo ? ['--repo', repo] : [])];
  const { assignees, comments } = JSON.parse(gh('issue', 'view', ...target, '--json', 'assignees,comments'));
  if (assignees.length) {
    const claimer = comments.map(({ body }) => body.match(/^認領：(.+)$/m)?.[1]).filter(Boolean).at(-1);
    if (claimer?.split('／')[0] === hostname()) { console.log(`CLAIMED ${n} already`); return 0; }
    console.log(`STOP ${n} claimed ${claimer ?? assignees.map(({ login }) => login).join(',')}`);
    return 4;
  }
  gh('issue', 'edit', ...target, '--add-assignee', '@me');
  gh('issue', 'comment', ...target, '--body', `認領：${hostname()}／${session}`);
  console.log(`CLAIMED ${n}`);
  return 0;
}

function main(argv) {
  let repo, staleHours = 24, session = process.env.CLAUDE_CODE_SESSION_ID || process.env.ORCA_TERMINAL_HANDLE || 'unknown';
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) repo = argv[++i];
    else if (argv[i] === '--stale-hours' && Number(argv[i + 1]) > 0) staleHours = Number(argv[++i]);
    else if (argv[i] === '--session' && argv[i + 1]) session = argv[++i];
    else if (!argv[i].startsWith('-')) positional.push(argv[i]);
    else { console.error(USAGE); return 2; }
  }
  const [command, n] = positional;
  if (command !== undefined && !(command === 'claim' && /^\d+$/.test(n ?? '') && positional.length === 2)) { console.error(USAGE); return 2; }
  try {
    if (command === 'claim') return claim(n, repo, session);
    repo ??= gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
    for (const { issue, bucket } of pool(openIssues(repo), { staleHours })) console.log(`${bucket} #${issue.number} ${issue.title}`);
    return 0;
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
