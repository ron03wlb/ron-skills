#!/usr/bin/env node
// 把開著的 Issue 逐張分桶，pilot 的 Pool 從 ready 桶依序挑；tracker 支援 GitHub（gh）與 GitLab（glab，含自架），本機 Markdown tracker 不支援。
// 用法：node scripts/issue-pool.mjs [--repo <專案>] [--stale-hours <h>] [--categories <label>,...]
//       node scripts/issue-pool.mjs claim <n> [--repo <專案>] [--session <id>] [--take-stale]
//       node scripts/issue-pool.mjs children <母單> [--repo <專案>] [--ask-prefix <前綴>]...
// tracker 讀 repo 根的 docs/agents/issue-tracker.md（寫 glab 是 GitLab、寫 gh 是 GitHub、沒有這份文件時依 origin，同 HOSTS.md；判定在 lib/hosts.mjs），與程式碼 host（origin）分開：
// 兩者同種時 CLI 從 checkout 推得主機與專案；不同種時取文件裡第一個該種主機的專案網址（GitLab 寫到 `/-/` 之前）。<專案> 是 GitHub 的 <owner>/<name>
// 或 GitLab 的 group/…/project，覆寫推得的專案。GitLab 的子項目（Issue 底下是 Task）算 sub-issue，所以掛了 Task 的單歸 parent 桶，`is_blocked_by`／`blocks` 連結算相依，系統紀錄裡的「assigned to」算指派
// （最近 100 則系統紀錄內）；`blocks` 連結是 GitLab Premium 以上才有，Free 版沒有 blocked 桶。
// 一張只歸一個桶，依序取第一個符合的：parent（有 sub-issue；GitLab 是有子項目）、human（`ready-for-human`，指派給人不算認領）、
// stale（已指派，超過 --stale-hours（預設 24）沒有新留言或新指派）、claimed（已指派）、retro-candidates（`retro-candidates` label：retro 的候選清單，等 `/retro-collect`）、blocked（有開著的 blocked_by）、
// needs-info、needs-triage、ready（`ready-for-agent`）、unlabeled。所以 ready 桶就是池子。過期的認領只歸到 stale，不自動釋放。
// 輸出順序：ready 桶先印，依 `retro` label 的先（retro 判定太複雜、交給 worker 的單）、`priority` label 的先、直接或間接 block 最多開著的單的先（關鍵路徑）、號碼小的先；
// 其餘依上面的桶順序、桶內號碼小的先。
// stdout：每張一行 `<桶> #<n> <標題>`；之後對開著、有 triage 狀態 label（TRIAGE_STATES）卻沒有分類 label 的單各印一行 `NO_CATEGORY <n>`（號碼小的先），
// 母單（有 sub-issue 或 `parent` label）與 `retro-candidates` 不算。分類 label 預設是 DEFAULT_CATEGORIES（triage 的 `bug`、`enhancement`），
// adapter 用的 label 不同時以 `--categories` 覆寫（逗號分隔）。exit 0。gh 或 glab 失敗時 stderr 印原因、exit 1；用法錯誤或本機 Markdown tracker 時 exit 2。
// claim 是 session 開始處理一張 Issue 前的認領：先留「認領：<機器>／<session>」（整則留言只有這一行；session 預設
// $CLAUDE_CODE_SESSION_ID，其次 $ORCA_TERMINAL_HANDLE），再指派給自己（HOSTS.md 的 Assign yourself），印 `CLAIMED <n>`。同一個帳號會在好幾台機器上跑，
// 指派分不出是誰，所以看認領留言：
// - 已被指派時，最近一則認領留言必須是這個 session、作者還在指派名單裡，才再認領一次（重派；新留言順便更新 stale 的時間），否則不改 Issue。
// - 還沒人指派、但最近一則認領是別的 session 在 5 分鐘內留的：對方正在認領，不改 Issue。
// - 寫入後重讀：這次讀到之後新增的認領留言裡，最早一則不是自己就是別台搶先了，收回自己的留言（指派到這裡一定是同一個帳號，不動）。
// - 擋下的認領者是這台機器上已交接出去的前任 coordinator（主 checkout 的 `.scratch/pilot/sessions.md` 有它的 handoff 行），
//   而這個 session 是現任 coordinator（有 start 行、沒交接出去）時，改以前任的 session 認領，成功印 `CLAIMED <n> takeover <session>`（#135）。
// - 擋下的認領者是這台機器上的 session、它的 transcript（`$CLAUDE_CONFIG_DIR` 或 `~/.claude` 底下 `projects/*/<session>.jsonl`）超過 1 小時沒有寫入：
//   STOP 之前先印 `STALE_CLAIM <n> <機器>／<session> <最後寫入的 ISO 時間>`；帶 `--take-stale` 時改以這個 session 認領，成功印 `CLAIMED <n> stale <session>`。
//   transcript 沒寫入不代表 session 結束（可能在等人回覆），所以只有不等人的流程（/retro-collect）才帶 --take-stale（#212：#201 的認領者認領一分鐘後被中斷）。
// 被擋時印 `STOP <n> claimed <機器>／<session>`（沒有認領留言、或最近一則認領的作者已不在指派名單時，是指派者登入名），exit 4。
// children 是母單（Map）視圖，只支援 GitHub（tracker 是 GitLab 時 exit 2）：一次 `gh api graphql` 取回母單的 subIssues（GitHub 每張母單最多 100 張子單），
// 依 GitHub 的子單順序每張印一行 `<ask|child> #<n> <open|closed> labels:<a,b|-> blocked-by:<#m|<owner>/<repo>#m,...|-> <標題>`，blocked-by 只列開著的。
// 開著的子單最後一則留言的本文（略過開頭的引言行與空行，即 AI 聲明）以任一個 --ask-prefix 開頭時印 `ask`（agent 提問、還沒人回），否則 `child`；
// 沒給 --ask-prefix 時全是 `child`。前綴由呼叫端帶入，這支腳本不預設任何前綴。exit 0；母單沒有子單時印 `STOP <母單> no-children`、exit 4；查不到母單時同 gh 失敗，exit 1。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codeHost, projectInDoc, trackerKind } from './lib/hosts.mjs';

const USAGE = '用法：node scripts/issue-pool.mjs [--repo <專案>] [--stale-hours <h>] [--categories <label>,...] | claim <n> [--repo <專案>] [--session <id>] [--take-stale] | children <母單> [--repo <專案>] [--ask-prefix <前綴>]...';
/** pool() 與 children 共用的 label、blocked-by 欄位片段。 */
const LABEL_FIELDS = 'labels(first:50){nodes{name}}';
const BLOCKED_BY_FIELDS = 'blockedBy(first:50){nodes{number state repository{nameWithOwner}}}';
/** pool() 分桶與排序要的 GitHub Issue 欄位；pilot-probe 的查詢也引用這一段，bucketOf 多要欄位時只改這裡（#240）。 */
export const POOL_FIELDS = `number title ${LABEL_FIELDS} assignees(first:20){nodes{login}} subIssuesSummary{total} ${BLOCKED_BY_FIELDS} blocking(first:50){nodes{number state repository{nameWithOwner}}} comments(last:1){nodes{createdAt}} timelineItems(last:1,itemTypes:[ASSIGNED_EVENT]){nodes{... on AssignedEvent{createdAt}}}`;
const QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{${POOL_FIELDS}}}}}`;
const CHILDREN_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number subIssues(first:100){nodes{number title state ${LABEL_FIELDS} ${BLOCKED_BY_FIELDS} comments(last:1){nodes{body}}}}}}}`;
// GitLab 的 Issue 是 work item：label、指派、子項目、相依與留言都在 widgets 裡；notes 分成留言（comments）與系統紀錄（activity，指派紀錄在這裡）。
const GITLAB_QUERY = `query($fullPath:ID!,$cursor:String){project(fullPath:$fullPath){workItems(types:[ISSUE],state:opened,first:50,after:$cursor){pageInfo{hasNextPage endCursor} nodes{iid title widgets{__typename ... on WorkItemWidgetLabels{labels(first:50){nodes{title}}} ... on WorkItemWidgetAssignees{assignees(first:20){nodes{username}}} ... on WorkItemWidgetHierarchy{hasChildren} ... on WorkItemWidgetLinkedItems{linkedItems(first:50){nodes{linkType workItem{iid state namespace{fullPath}}}}} ... on WorkItemWidgetNotes{comments:notes(filter:ONLY_COMMENTS,last:1){nodes{createdAt}} activity:notes(filter:ONLY_ACTIVITY,last:100){nodes{createdAt body}}}}}}}}`;

class CliError extends Error {}
class UsageError extends Error {}
function cli(command, args, env = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  if (result.status !== 0) throw new CliError(`${command} ${args.slice(0, 2).join(' ')} 失敗：${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

const gitOut = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/** GitLab work item 轉成 GitHub 列表的形狀，分桶與排序共用同一套：子項目算 sub-issue，`is_blocked_by`、`blocks` 連結算相依，
 * 系統紀錄裡只有「assigned to」算指派。 */
export function fromWorkItem({ iid, title, widgets }) {
  const widget = name => widgets.find(({ __typename }) => __typename === `WorkItemWidget${name}`) ?? {};
  const links = type => (widget('LinkedItems').linkedItems?.nodes ?? []).filter(({ linkType, workItem }) => linkType === type && workItem)
    .map(({ workItem }) => ({ number: Number(workItem.iid), state: workItem.state, repository: { nameWithOwner: workItem.namespace?.fullPath } }));
  const notes = widget('Notes');
  return {
    number: Number(iid), title,
    labels: { nodes: (widget('Labels').labels?.nodes ?? []).map(({ title: name }) => ({ name })) },
    assignees: { nodes: (widget('Assignees').assignees?.nodes ?? []).map(({ username }) => ({ login: username })) },
    subIssuesSummary: { total: widget('Hierarchy').hasChildren ? 1 : 0 },
    blockedBy: { nodes: links('is_blocked_by') }, blocking: { nodes: links('blocks') },
    comments: { nodes: notes.comments?.nodes ?? [] },
    timelineItems: { nodes: (notes.activity?.nodes ?? []).filter(({ body }) => /^assigned to /.test(body)) },
  };
}

/** GitHub tracker：repo 是 <owner>/<name>；host 不是 github.com 時以 GH_HOST 指定（GitHub Enterprise）。 */
function github({ repo, host }) {
  const gh = (...args) => cli('gh', args, host && host !== 'github.com' ? { GH_HOST: host } : {});
  const target = n => [n, ...(repo ? ['--repo', repo] : [])];
  return {
    repo: () => repo ?? gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim(),
    issues(fullName) {
      const [owner, name] = fullName.split('/');
      const issues = [];
      for (let cursor = null, more = true; more;) {
        const page = JSON.parse(gh('api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, ...(cursor ? ['-F', `cursor=${cursor}`] : []), '-f', `query=${QUERY}`)).data.repository.issues;
        issues.push(...page.nodes);
        ({ hasNextPage: more, endCursor: cursor } = page.pageInfo);
      }
      return issues;
    },
    children(fullName, n) {
      const [owner, name] = fullName.split('/');
      return JSON.parse(gh('api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${n}`, '-f', `query=${CHILDREN_QUERY}`)).data.repository.issue.subIssues.nodes;
    },
    view: n => JSON.parse(gh('issue', 'view', ...target(n), '--json', 'assignees,comments')),
    comment: (n, body) => gh('issue', 'comment', ...target(n), '--body', body),
    assign: n => gh('issue', 'edit', ...target(n), '--add-assignee', '@me'),
    // `--delete-last` 刪的是這個帳號最新一則，前提見 claim。
    retract: n => gh('issue', 'comment', ...target(n), '--delete-last', '--yes'),
  };
}

/** GitLab tracker（含自架）：repo 是完整的 group/…/project；沒給時 glab 從 checkout 的 remote 推得專案與主機（`:id`）。
 * 留言與指派用 HOSTS.md 對照表的 `glab issue note`、`glab issue update`；讀取與刪留言用 `glab api`（REST 與 GraphQL）。 */
function gitlab({ repo, host, origin }) {
  const glab = (...args) => cli('glab', args);
  const raw = (...args) => glab('api', ...args, ...(host ? ['--hostname', host] : []));
  const api = (...args) => JSON.parse(raw(...args));
  const project = repo ? encodeURIComponent(repo) : ':id';
  const target = n => [n, ...(repo ? ['-R', origin ? `${origin}/${repo}` : repo] : [])];
  return {
    repo: () => repo ?? api(`projects/${project}`).path_with_namespace,
    issues(fullPath) {
      const issues = [];
      for (let cursor = null, more = true; more;) {
        const page = api('graphql', '-f', `fullPath=${fullPath}`, ...(cursor ? ['-f', `cursor=${cursor}`] : []), '-f', `query=${GITLAB_QUERY}`).data.project.workItems;
        issues.push(...page.nodes.map(fromWorkItem));
        ({ hasNextPage: more, endCursor: cursor } = page.pageInfo);
      }
      return issues;
    },
    view(n) {
      const issue = api(`projects/${project}/issues/${n}`);
      // --paginate 預設逐頁原樣印出（`[...][...]`，help 說會合併但 v1.126.0 的 api.go 沒有），所以用 ndjson 一行一則。
      const notes = raw(`projects/${project}/issues/${n}/notes?sort=asc&order_by=created_at&per_page=100`, '--paginate', '--output', 'ndjson')
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
      return {
        assignees: issue.assignees.map(({ username }) => ({ login: username })),
        comments: notes.filter(({ system }) => !system).map(({ id, author, body, created_at }) => ({ id, author: { login: author.username }, body, createdAt: created_at })),
      };
    },
    comment: (n, body) => glab('issue', 'note', ...target(n), '-m', body),
    assign: n => glab('issue', 'update', ...target(n), '--assignee', `+${api('user').username}`),
    // DELETE 回 204、沒有內容，不解析；重讀還看不到自己那則時無從依 id 收回，留著。
    retract: (n, note) => note && raw('-X', 'DELETE', `projects/${project}/issues/${n}/notes/${note.id}`),
  };
}

/** tracker 依 repo 根的 docs/agents/issue-tracker.md 判定（hosts.mjs 的 trackerKind：寫 glab 是 GitLab；沒有這份文件時依 origin），
 * 與程式碼 host（origin）分開：同種時 CLI 從 checkout 推得主機與專案，不同種時取文件裡第一個該種主機的專案網址；--repo 覆寫專案。 */
function trackerOf(repoArg) {
  const top = gitOut('rev-parse', '--show-toplevel');
  let doc = null;
  try { doc = top ? readFileSync(join(top, 'docs/agents/issue-tracker.md'), 'utf8') : null; } catch {}
  const originUrl = gitOut('remote', 'get-url', 'origin');
  const { value: code, host: codeHostname } = codeHost(originUrl);
  const documented = trackerKind(doc);
  if (documented === 'local') throw new UsageError('issue-tracker.md 的 tracker 是本機 Markdown（local），issue-pool 只支援 GitHub 與 GitLab');
  // 還沒有這份文件時照 HOSTS.md 依 origin 推；origin 也不是 GitLab 時當 GitHub（同第一版）。
  const kind = documented === 'none' ? (code === 'gitlab' ? 'gitlab' : 'github') : documented;
  // 同種又給了 --repo 時主機取 origin 的：不帶主機的 `glab … -R <專案>` 會落到 glab 的預設主機，與 checkout 推得的讀取分屬兩台。
  const remote = code !== kind ? projectInDoc(doc, kind)
    : repoArg && codeHostname ? { host: codeHostname, origin: /^https?:\/\//i.test(originUrl) ? new URL(originUrl).origin : `https://${codeHostname}` } : null;
  const options = { repo: repoArg ?? remote?.path, host: remote?.host, origin: remote?.origin };
  return kind === 'gitlab' ? gitlab(options) : github(options);
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
/** 本機認領者的 transcript 超過這麼久沒寫入就算沒有活動。 */
const IDLE_MS = 60 * 60_000;

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

/** 本機認領者的 transcript 最後寫入時間（ms）；認領者在別台、或找不到它的 transcript 時是 undefined。 */
function transcriptActivity(claimer) {
  const [host, session] = claimer.split('／');
  if (host !== hostname() || !session) return undefined;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  let dirs;
  try { dirs = readdirSync(projects); } catch { return undefined; }
  const times = dirs.map(dir => { try { return statSync(join(projects, dir, `${session}.jsonl`)).mtimeMs; } catch { return undefined; } }).filter(Boolean);
  return times.length ? Math.max(...times) : undefined;
}

/** claim 與 pilot-dispatch 預設的 session。 */
export const defaultSession = () => process.env.CLAUDE_CODE_SESSION_ID || process.env.ORCA_TERMINAL_HANDLE || 'unknown';

/** 最近一則認領留言是 `session` 的（含 claim 以前任 coordinator 的 session 接手的）時為真；沒有認領留言時為假。pilot-dispatch 派工前用（#165）。 */
export function claimedBy(comments, session) {
  const claimer = latestClaimer(comments);
  return Boolean(claimer) && (claimer === claimerName(session) || Boolean(takeoverSession(claimer, session)));
}

function claim(n, tracker, session, takeStale) {
  const read = () => tracker.view(n);
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
  let stale;
  if (blocker && !takeover) {
    const active = transcriptActivity(blocker);
    if (active === undefined || Date.now() - active < IDLE_MS) return stop(blocker);
    console.log(`STALE_CLAIM ${n} ${blocker} ${new Date(active).toISOString()}`);
    if (!takeStale) return stop(blocker);
    stale = blocker.split('／')[1];
  }
  const claimant = takeover ? blocker : mine;
  // 先留言再指派：指派成功、留言失敗時，重跑會被自己沒有留言的指派擋住。
  tracker.comment(n, `認領：${claimant}`);
  tracker.assign(n);
  const added = read().comments.slice(before.comments.length);
  const first = added.find(claimerOf);
  if (first && claimerOf(first) !== claimant) {
    // 收回搶輸的留言，不然贏家重派時最近一則認領是自己的，會被擋下。GitHub 的 `--delete-last` 刪的是這個帳號最新一則（輸家的留言在贏家的認領之後），
    // 所以前提是贏家這幾秒內沒有再留言；GitLab 依重讀到的留言 id 刪自己那則。
    tracker.retract(n, added.findLast(comment => claimerOf(comment) === claimant));
    return stop(claimerOf(first));
  }
  console.log(takeover ? `CLAIMED ${n} takeover ${takeover}` : stale ? `CLAIMED ${n} stale ${stale}` : `CLAIMED ${n}`);
  return 0;
}

/** 留言本文去掉開頭的引言行與空行（AI 聲明）之後，以任一個前綴開頭時為真。 */
export function isAsking(body, prefixes) {
  const lines = body.split('\n');
  const start = lines.findIndex(line => line.trim() && !line.startsWith('>'));
  const text = start < 0 ? '' : lines.slice(start).join('\n').trimStart();
  return prefixes.some(prefix => text.startsWith(prefix));
}

/** 母單視圖的一行（格式見檔頭）；repo 是 `<owner>/<name>`，同 repo 的 blocker 只寫 `#<n>`。 */
export function childLine(issue, { repo, askPrefixes = [] }) {
  const open = issue.state === 'OPEN';
  const body = issue.comments.nodes.at(-1)?.body;
  const mark = open && body !== undefined && isAsking(body, askPrefixes) ? 'ask' : 'child';
  const labels = issue.labels.nodes.map(({ name }) => name).join(',') || '-';
  const blockers = openNodes(issue.blockedBy).map(({ number, repository: { nameWithOwner } }) => nameWithOwner === repo ? `#${number}` : `${nameWithOwner}#${number}`).join(',') || '-';
  return `${mark} #${issue.number} ${open ? 'open' : 'closed'} labels:${labels} blocked-by:${blockers} ${issue.title}`;
}

function children(n, tracker, askPrefixes) {
  if (!tracker.children) throw new UsageError('children 只支援 GitHub tracker（GitHub 的 subIssues）');
  const repo = tracker.repo();
  const nodes = tracker.children(repo, n);
  if (!nodes.length) { console.log(`STOP ${n} no-children`); return 4; }
  for (const issue of nodes) console.log(childLine(issue, { repo, askPrefixes }));
  return 0;
}

function main(argv) {
  let repo, staleHours = 24, categories = DEFAULT_CATEGORIES, session = defaultSession(), takeStale = false;
  const askPrefixes = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) repo = argv[++i];
    else if (argv[i] === '--stale-hours' && Number(argv[i + 1]) > 0) staleHours = Number(argv[++i]);
    else if (argv[i] === '--categories' && argv[i + 1]) categories = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--session' && argv[i + 1]) session = argv[++i];
    else if (argv[i] === '--take-stale') takeStale = true;
    else if (argv[i] === '--ask-prefix' && argv[i + 1]) askPrefixes.push(argv[++i]);
    else if (!argv[i].startsWith('-')) positional.push(argv[i]);
    else { console.error(USAGE); return 2; }
  }
  const [command, n] = positional;
  if (command !== undefined && !(['claim', 'children'].includes(command) && /^\d+$/.test(n ?? '') && positional.length === 2)) { console.error(USAGE); return 2; }
  try {
    const tracker = trackerOf(repo);
    if (command === 'claim') return claim(n, tracker, session, takeStale);
    if (command === 'children') return children(n, tracker, askPrefixes);
    repo = tracker.repo();
    const issues = tracker.issues(repo);
    for (const { issue, bucket } of pool(issues, { repo, staleHours })) console.log(`${bucket} #${issue.number} ${issue.title}`);
    for (const number of missingCategory(issues, categories)) console.log(`NO_CATEGORY ${number}`);
    return 0;
  } catch (error) {
    if (!(error instanceof CliError) && !(error instanceof UsageError)) throw error;
    console.error(error.message);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
