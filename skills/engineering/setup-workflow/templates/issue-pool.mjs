#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 把開著的 Issue 逐張分桶，pilot 的 Pool 從 ready 桶依序挑；tracker 支援 GitHub（gh）與 GitLab（glab，含自架），本機 Markdown tracker 不支援。
// 用法：node scripts/issue-pool.mjs [--repo <專案>] [--stale-hours <h>] [--stale] [--categories <label>,...] [--skip-labels <label>,...] [--integration <分支>]
//       node scripts/issue-pool.mjs --pickable-blocked [--repo <專案>] [--integration <分支>]
//       node scripts/issue-pool.mjs claim <n> [--repo <專案>] [--session <id>] [--take-stale] [--integration <分支>]
//       node scripts/issue-pool.mjs children <母單> [--repo <專案>] [--ask-prefix <前綴>]...
//       node scripts/issue-pool.mjs open-work <n> [--repo <專案>]
// open-work 列出這張單已經在進行的工作，給 `/issue-run` 的 Gate 用（#300：#286 沒指派、沒留言，PR #288 卻已開了 15 小時）：`OPEN_PR <n> <pr> <分支> <網址>` 是開著、會關掉它的 PR，
// 判斷和 in-review 桶同一個欄位（GitLab 列表沒有這個欄位，只看分支）；`BRANCH <n> <分支> local|origin` 是最後一段以 `<n>-` 開頭的分支；都沒有時印 `NO_OPEN_WORK <n>`。exit 0，查不到 tracker 時 exit 1。
// tracker 讀 repo 根的 docs/agents/issue-tracker.md（寫 glab 是 GitLab、寫 gh 是 GitHub、沒有這份文件時依 origin，同 HOSTS.md；判定在 lib/hosts.mjs），與程式碼 host（origin）分開：
// 兩者同種時 CLI 從 checkout 推得主機與專案；不同種時取文件裡第一個該種主機的專案網址（GitLab 寫到 `/-/` 之前）。<專案> 是 GitHub 的 <owner>/<name>
// 或 GitLab 的 group/…/project，覆寫推得的專案。GitLab 的子項目（Issue 底下是 Task）算 sub-issue，所以掛了 Task 的單歸 parent 桶，`is_blocked_by`／`blocks` 連結算相依，系統紀錄裡的「assigned to」算指派
// （最近 100 則系統紀錄內）；`blocks` 連結是 GitLab Premium 以上才有，Free 版沒有 blocked 桶。
// 一張只歸一個桶，依序取第一個符合的：parent（有 sub-issue；GitLab 是有子項目）、human（`ready-for-human`，指派給人不算認領）、
// retro-candidates（`retro-candidates` label：retro 的候選清單，等 `/retro-collect`；被 `/retro-collect` 認領、指派之後也歸這裡，不混進 claimed、stale，#270）、
// `--skip-labels` 帶的每個 label（逗號分隔，adapter 宣告的「不進分級的 label」，例如 investing 的 `ci-report` 報告單）：歸到以該 label 命名的桶，與 retro-candidates 同樣處理，排在它之後，
// 多個時取 --skip-labels 裡第一個掛著的（#326；沒帶時沒有這些桶）、
// landed（只在帶 --integration 時：已指派，且最近一則認領留言之後有 `DONE <n> <sha>` 結果行而且那個 sha 是整合分支的祖先，或已落地在整合分支（landedOn；落地 commit 已在 origin 的共用分支、而本文最後編輯與最近一則認領都比它晚的不算，#692）；已做完、等合入 main，不算進行中，#352；
// DONE 的 sha 不在整合分支（stage 衝突沒合進去）不算落地，照 claimed／stale 分，#644）、
// stale（已指派，超過 --stale-hours（預設 24）沒有新留言或新指派）、claimed（已指派）、
// in-review（有開著的 PR 以 closing reference 指向這張單：單獨跑的 /issue-run 做完、沒留指派也沒留認領的單，不能再派一次，#284；只看 GitHub，GitLab 沒有這個桶）、blocked（有開著的 blocked_by）、
// needs-info、needs-triage、ready（`ready-for-agent`）、unlabeled。所以 ready 桶就是池子。過期的認領只歸到 stale，不自動釋放。
// 輸出順序：ready 桶先印，依 `retro` label 的先（retro 判定太複雜、交給 worker 的單）、`priority` label 的先、直接或間接 block 最多開著的單的先（關鍵路徑）、號碼小的先；
// 其餘依上面的桶順序、桶內號碼小的先。
// （抄寫下面 stdout 行格式的文件：`skills/engineering/issue-queue/SKILL.md` step 1、`docs/agents/pilot.md` 的 **Pool.**；改格式時一起改，#440。）
// stdout：每張一行 `<桶> #<n> <標題>`；blocked 桶在號碼與標題之間多寫狀態與開著的 blocker：`blocked #<n> <triage 狀態 label|unlabeled> by #<m>,<owner>/<repo>#<k> <標題>`，
// 帶 --integration 時已落地在整合分支的本 repo blocker 後面接 ` (landed <分支>)`（#352）。帶 --integration 而且主 checkout 的 main 暫停旗標有效時
// （`.scratch/pilot/main-paused`，`pilot-hold.mjs set-main` 寫、until 當天仍有效，判斷是 export 的 mainPause，Probe 的 MAIN_PAUSED 共用，#379），
// landed 桶不逐張印，在它的位置收成一行 `LANDED_COUNT <數量> <整合分支>`；旗標過期、讀不懂或沒有時照逐行印。stale 桶預設也不逐張印，在它的位置收成一行 `STALE <數量>`，
// 帶 `--stale` 才逐行印（/issue-queue 要逐張列認領者時帶；investing retro 1123c：每輪 Pool 約 190 行 stale 蓋過 4 行 needs-triage，#550）；Probe 的 BLOCKER_OPEN_SCOPE 用同一份 blocker 資料（export 的 blockerOpenScope，#359），這支 CLI 不印。之後 ready 桶本文有行首的 `<字> prerequisite：<內容>` 一行（可帶清單標記與粗體；散文或行內碼裡提到的不算，#692）、內容不是「無」的，
// 依 ready 的順序各印一行 `PREREQ <n> <內容>`（先查環境或開 gate 再派；沒有這行或寫「無」、但本文有 `#` 開頭的「為什麼是 needs-…」標題時，內容是去掉 `#` 的標題文字，#666）；再對 ready 桶前 PICK_TOP（5）張印 Pick 前的重疊提示（#591）：
// 前面的 n 與後面的 m 本文提到同一個檔（帶常見副檔名的路徑，URL 裡的不算；裸檔名對得上完整路徑的尾段）印 `PICK_OVERLAP <n> <m> <檔>`，提到同一個 `**<條目>.**` 印 `PICK_OVERLAP <n> <m> **<條目>.**`；
// n 本文提到的檔在別的 worktree 的實際改動裡（worktree-overlap.mjs 的 OVERLAP_WT，基準是 --integration 的分支、沒帶時 main；基底過舊的不算，n 自己號碼的分支不算）
// 印 `PICK_OVERLAP <n> <m> <改到的檔> [**<條目>.**…]`，m 是分支最後一段 `<m>-` 的號碼、取不到時是分支名，條目是本文也提到、那個檔也改到的。
// 只是提示、不保證準（本文推測會漏，#355 本文沒提 `orca-session-send.mjs` 卻改了它）；查不了 worktree 改動時 stderr 印 `PICK_OVERLAP_SKIP <原因>`、只比本文，exit 不變。最後對開著、有 triage 狀態 label（TRIAGE_STATES）卻沒有分類 label 的單印一行
// `NO_CATEGORY <n> <n>...`（號碼升冪，沒有時不印），母單（有 sub-issue 或 `parent` label）、`retro-candidates` 與 `--skip-labels` 的 label 不算。分類 label 預設是 DEFAULT_CATEGORIES（triage 的 `bug`、`enhancement`），
// adapter 用的 label 不同時以 `--categories` 覆寫（逗號分隔）。exit 0。gh 或 glab 失敗時 stderr 印原因、exit 1；用法錯誤或本機 Markdown tracker 時 exit 2。
// 有母單的 ready 行在號碼與標題之間多寫 `parent #<p> `（`ready #<n> parent #<p> <標題>`；別的 repo 的母單寫 `<owner>/<repo>#<p>`，GitLab 是父項目），
// Shared registry 看同一母單不必逐張查 sub-issue（#397）；其他桶不寫。
// --pickable-blocked（唯讀，#501：POOL_EMPTY 時 coordinator 逐張手寫 gh api 迴圈判斷 blocked 桶，每輪約 40 次 gh 呼叫）不印上面的行，改為 blocked 桶的單依號碼各一行：
// 開著的 blocker 都已落地在整合分支（判斷同 blocked 行的 `(landed …)`；沒帶 --integration 時是目前分支 HEAD），而且沒有一個命中 blockerOpenScope 時印 `PICKABLE <n>`；
// 否則以第一個擋住的 blocker 印 `WAIT <n> <blocker>:<原因>`，blocker 本 repo 寫號碼、別的 repo 寫 `<owner>/<repo>#<k>`，原因是 `not-integrated`（還沒落地）、
// `open-scope`（Probe 會印 BLOCKER_OPEN_SCOPE 的那種）或 `other-repo`（別的 repo，無從在整合分支判斷）。只判 blocker，這張自己的 triage label 照 Pool 處理。不留言、不指派，exit 同上。
// claim 是 session 開始處理一張 Issue 前的認領：先留「認領：<機器>／<session>」（整則留言只有這一行；<機器> 是 $ISSUE_POOL_HOSTNAME，沒設時 os.hostname()，本機認領者的判斷也用它；session 預設
// $CLAUDE_CODE_SESSION_ID，其次 $ORCA_TERMINAL_HANDLE），再指派給自己（HOSTS.md 的 Assign yourself），印 `CLAIMED <n>`。同一個帳號會在好幾台機器上跑，
// 指派分不出是誰，所以看認領留言：
// - 已被指派時，最近一則認領留言必須是這個 session、作者還在指派名單裡，才再認領一次（重派），否則不改 Issue。重派不再留一則一樣的認領（#692：#632 留了 9 則），
//   改成放掉再加回自己的指派，新的指派事件更新 stale 的時間；之後重讀，這期間有別的 session 留了認領就 STOP。沒被指派（已釋放）時照常留言。
// - 還沒人指派、但最近一則認領是別的 session 在 5 分鐘內留的：對方正在認領，不改 Issue。
// - 寫入後重讀：這次讀到之後新增的認領留言裡，最早一則不是自己就是別台搶先了，收回自己的留言（指派到這裡一定是同一個帳號，不動）。
// - 擋下的認領者是這台機器上已交接出去的前任 coordinator（主 checkout 的 `.scratch/pilot/sessions.md` 有它的 handoff 行），
//   而這個 session 是現任 coordinator（有 start 行、沒交接出去）時，改以前任的 session 認領，成功印 `CLAIMED <n> takeover <session>`（#135）。
//   前任暫停、沒有 handoff 行時也算：它有帶 pid 的 start 行、該 pid 已不存在（`kill -0` 失敗）、也沒交接出去，同樣 takeover（#573：前任暫停後 transcript 一小時內都算活著，claim 一直 STOP）。
// - 擋下的認領者是這台機器上的 session、它的 transcript（`$CLAUDE_CONFIG_DIR` 或 `~/.claude` 底下 `projects/*/<session>.jsonl`）超過 1 小時沒有寫入：
//   STOP 之前先印 `STALE_CLAIM <n> <機器>／<session> <最後寫入的 ISO 時間>`；帶 `--take-stale` 時改以這個 session 認領，成功印 `CLAIMED <n> stale <session>`。
//   transcript 沒寫入不代表 session 結束（可能在等人回覆），所以只有不等人的流程（/retro-collect）才帶 --take-stale（#212：#201 的認領者認領一分鐘後被中斷）。
// 被擋時印 `STOP <n> claimed <機器>／<session>`（沒有認領留言、或最近一則認領的作者已不在指派名單時，是指派者登入名），exit 4。
// 帶 --integration 時先看是否已落地：整合分支有這張的落地 commit（landedOn），或已指派且最近一則認領留言之後有 `DONE <n> <sha>` 而且那個 sha 是整合分支的祖先，就印 `LANDED <n> <sha>`、
// exit 4，不留言也不指派（#352：#145 的 commit 早已在 develop，claim 照樣認領，worker 白跑），交給收尾。
// 落地的 sha 已在 origin 的預設分支（origin/HEAD，沒設時 origin/main）、Issue 還開著，而且本文或 label 在落地之後（DONE 留言的時間，否則那個 commit 的 committer date）變動過時，
// 是重新細化的單（#692：#507 先做完的一半早在 main，本文改寫成新範圍），先印 `LANDED_STALE <n> <sha>` 再照常認領；之後 landed 桶
// 在本文最後編輯與最近一則認領都比那個落地 commit 晚時不再把它算落地（只改 label 的照舊算；claim 每次都照上面重新判斷）。
// 只有 DONE、sha 不在整合分支（#644：stage 衝突沒合進去，不能當落地漏派）時先印 `DONE_NOT_LANDED <n> <sha>`，再照常認領。
// --integration 的分支查不到時同 gh 失敗，exit 1。
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
import { worktreeOverlaps } from './worktree-overlap.mjs';

const USAGE = '用法：node scripts/issue-pool.mjs [--repo <專案>] [--stale-hours <h>] [--stale] [--categories <label>,...] [--skip-labels <label>,...] [--integration <分支>] [--pickable-blocked] | claim <n> [--repo <專案>] [--session <id>] [--take-stale] [--integration <分支>] | children <母單> [--repo <專案>] [--ask-prefix <前綴>]... | open-work <n> [--repo <專案>]';
/** pool() 與 children 共用的 label、blocked-by 欄位片段。 */
const LABEL_FIELDS = 'labels(first:50){nodes{name}}';
const BLOCKED_BY_FIELDS = 'blockedBy(first:50){nodes{number state repository{nameWithOwner}}}';
/** pool() 分桶與排序要的 GitHub Issue 欄位；pilot-probe 的查詢也引用這一段，bucketOf 多要欄位時只改這裡（#240）。
 * body 給 PREREQ，最後 10 則留言的內文給 landed 桶找 `DONE` 結果行（#352），parent 給 ready 行的 `parent #<p>`（#397）。 */
export const POOL_FIELDS = `number title body ${LABEL_FIELDS} assignees(first:20){nodes{login}} subIssuesSummary{total} ${BLOCKED_BY_FIELDS} blocking(first:50){nodes{number state repository{nameWithOwner}}} comments(last:10){nodes{createdAt body}} timelineItems(last:1,itemTypes:[ASSIGNED_EVENT]){nodes{... on AssignedEvent{createdAt}}} closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{state}} parent{number repository{nameWithOwner}}`;
const QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{${POOL_FIELDS} lastEditedAt}}}}`;
const OPEN_WORK_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{number state url headRefName}}}}}`;
// claim 的 LANDED_STALE（#692）：Issue 是否開著、本文最後編輯與最近的 label 增減。
const REVISION_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){state lastEditedAt timelineItems(last:50,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{... on LabeledEvent{createdAt} ... on UnlabeledEvent{createdAt}}}}}}`;
const CHILDREN_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number subIssues(first:100){nodes{number title state ${LABEL_FIELDS} ${BLOCKED_BY_FIELDS} comments(last:1){nodes{body}}}}}}}`;
// GitLab 的 Issue 是 work item：label、指派、子項目、相依與留言都在 widgets 裡；notes 分成留言（comments）與系統紀錄（activity，指派紀錄在這裡）。
const GITLAB_QUERY = `query($fullPath:ID!,$cursor:String){project(fullPath:$fullPath){workItems(types:[ISSUE],state:opened,first:50,after:$cursor){pageInfo{hasNextPage endCursor} nodes{iid title widgets{__typename ... on WorkItemWidgetLabels{labels(first:50){nodes{title}}} ... on WorkItemWidgetAssignees{assignees(first:20){nodes{username}}} ... on WorkItemWidgetHierarchy{hasChildren parent{iid namespace{fullPath}}} ... on WorkItemWidgetLinkedItems{linkedItems(first:50){nodes{linkType workItem{iid state namespace{fullPath}}}}} ... on WorkItemWidgetNotes{comments:notes(filter:ONLY_COMMENTS,last:10){nodes{createdAt body}} activity:notes(filter:ONLY_ACTIVITY,last:100){nodes{createdAt body}}} ... on WorkItemWidgetDescription{description}}}}}}`;

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
  const parent = widget('Hierarchy').parent;
  return {
    number: Number(iid), title, body: widget('Description').description ?? '',
    labels: { nodes: (widget('Labels').labels?.nodes ?? []).map(({ title: name }) => ({ name })) },
    assignees: { nodes: (widget('Assignees').assignees?.nodes ?? []).map(({ username }) => ({ login: username })) },
    subIssuesSummary: { total: widget('Hierarchy').hasChildren ? 1 : 0 },
    blockedBy: { nodes: links('is_blocked_by') }, blocking: { nodes: links('blocks') },
    comments: { nodes: notes.comments?.nodes ?? [] },
    timelineItems: { nodes: (notes.activity?.nodes ?? []).filter(({ body }) => /^assigned to /.test(body)) },
    closedByPullRequestsReferences: { nodes: [] },
    parent: parent ? { number: Number(parent.iid), repository: { nameWithOwner: parent.namespace?.fullPath } } : null,
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
    closingPrs(fullName, n) {
      const [owner, name] = fullName.split('/');
      return JSON.parse(gh('api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${n}`, '-f', `query=${OPEN_WORK_QUERY}`)).data.repository.issue.closedByPullRequestsReferences.nodes;
    },
    view: n => JSON.parse(gh('issue', 'view', ...target(n), '--json', 'assignees,comments')),
    revision(n) {
      const [owner, name] = this.repo().split('/');
      const issue = JSON.parse(gh('api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${n}`, '-f', `query=${REVISION_QUERY}`)).data.repository.issue;
      return { open: issue.state === 'OPEN', changedAt: latest([issue.lastEditedAt, ...issue.timelineItems.nodes.map(({ createdAt }) => createdAt)]) };
    },
    comment: (n, body) => gh('issue', 'comment', ...target(n), '--body', body),
    assign: n => gh('issue', 'edit', ...target(n), '--add-assignee', '@me'),
    // 已指派給自己時再 add 不產生指派事件，所以先放掉再加回（#692）。
    reassign(n) { gh('issue', 'edit', ...target(n), '--remove-assignee', '@me'); gh('issue', 'edit', ...target(n), '--add-assignee', '@me'); },
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
  // --paginate 預設逐頁原樣印出（`[...][...]`，help 說會合併但 v1.126.0 的 api.go 沒有），所以用 ndjson 一行一則。
  const notesOf = n => raw(`projects/${project}/issues/${n}/notes?sort=asc&order_by=created_at&per_page=100`, '--paginate', '--output', 'ndjson')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    closingPrs: () => [],
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
      const notes = notesOf(n);
      return {
        assignees: issue.assignees.map(({ username }) => ({ login: username })),
        comments: notes.filter(({ system }) => !system).map(({ id, author, body, created_at }) => ({ id, author: { login: author.username }, body, createdAt: created_at })),
      };
    },
    // 本文編輯在系統紀錄（`changed the description`）；label 增減不在系統紀錄裡，只在 resource_label_events（spay2 #1201 實查，#692 review r1）。
    revision(n) {
      const edits = notesOf(n).filter(({ system, body }) => system && /^changed the description/.test(body ?? ''));
      const labels = raw(`projects/${project}/issues/${n}/resource_label_events?per_page=100`, '--paginate', '--output', 'ndjson').split('\n').filter(Boolean).map(line => JSON.parse(line));
      return { open: api(`projects/${project}/issues/${n}`).state === 'opened', changedAt: latest([...edits, ...labels].map(({ created_at }) => created_at)) };
    },
    comment: (n, body) => glab('issue', 'note', ...target(n), '-m', body),
    assign: n => glab('issue', 'update', ...target(n), '--assignee', `+${api('user').username}`),
    // `-` 從指派名單移除、`+` 加回（HOSTS.md 的 glab issue update 旗標），產生新的「assigned to」系統紀錄（#692）。
    reassign(n) {
      const { username } = api('user');
      glab('issue', 'update', ...target(n), '--assignee', `-${username}`);
      glab('issue', 'update', ...target(n), '--assignee', `+${username}`);
    },
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

/** ISO 時間裡最晚的一個（ms），沒有或都讀不懂時 0。 */
const latest = times => Math.max(0, ...times.filter(Boolean).map(Date.parse).filter(Number.isFinite));

const openNodes = ({ nodes }) => nodes.filter(({ state }) => state === 'OPEN');

/** 認領之後最後一次動靜：最近一則留言或最近一次指派，取較晚的；都沒有時是 0（視為過期）。 */
const lastActivity = issue => Math.max(0, ...[...issue.comments.nodes, ...issue.timelineItems.nodes].map(({ createdAt }) => Date.parse(createdAt)));

const labelsOf = issue => new Set(issue.labels.nodes.map(({ name }) => name));

/** ready 行號碼與標題之間的一段（格式見檔頭）：有母單時是 `parent #<p> `，沒有時是空字串。 */
function parentDetail({ parent }, repo) {
  if (!parent) return '';
  const owner = parent.repository?.nameWithOwner;
  return `parent ${owner && owner !== repo ? owner : ''}#${parent.number} `;
}

/** 本文第一行 `<字> prerequisite：<內容>` 的內容（去掉頭尾空白），沒有這行時 undefined；PREREQ 與 pilot-probe 的 HUMAN_NO_GATE 共用（#352）。
 * 只認行首：前面只能有縮排、一個清單標記與粗體／斜體記號，`prerequisite` 前最多一個英文字（`Operator`、`Human`）；散文或行內碼裡提到的不算（#692：#666 本文的 `` `Operator prerequisite：` 行 ``）。 */
export const prerequisiteOf = body => (body ?? '').match(/^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[*_]*(?:[A-Za-z]+[ \t]+)?prerequisite[*_]*[ \t]*[：:][ \t]*(?:[*_]+[ \t]*)?(\S.*?)[ \t]*$/im)?.[1];
/** prerequisite 寫「無」（或 none，後面可接標點或括號說明）表示不用等人；`**Operator prerequisite：** 無` 的粗體記號由 prerequisiteOf 略過。 */
const NO_PREREQUISITE = /^(?:無|none)(?:$|[\s。.,，、;；（(])/i;
/** 本文第一個以「為什麼是 needs-」開頭的 Markdown 標題（任一層級，去掉開頭的 `#` 與空白），沒有時 undefined：本文自己寫著還不能做（#666）。
 * 只認標題行；散文、行內文字與 ``` / ~~~ 程式碼區塊裡的不算（圍欄開閉照 GFM）。 */
export function needsHeadingOf(body) {
  let fence;
  const items = []; // 外層到內層各清單項的內容縮排；圍欄與標題都相對於最內層的判斷
  for (const raw of (body ?? '').split(/\r?\n/)) {
    // 行首 Tab 照 4 欄 tab stop 展開成空白，縮排才和 GFM 一致。
    const line = raw.replace(/^[ \t]+/, lead => [...lead].reduce((s, c) => s + (c === '\t' ? ' '.repeat(4 - s.length % 4) : c), ''));
    const indent = line.match(/^ */)[0].length;
    if (fence) {
      // 圍欄屬於開啟時所在的清單項：比那一項內容縮排少的非空行結束該項、區塊一起關閉，該行照常判斷；
      // 否則去掉那一項的縮排後判斷結束圍欄（同符號、不短於開啟的、後面只能有空白），其餘都是區塊內容。
      if (!line.trim() || indent >= fence.container) {
        const [, marker, rest] = line.slice(fence.container).match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
        if (marker?.[0] === fence.marker[0] && marker.length >= fence.marker.length && !rest.trim()) fence = undefined;
        continue;
      }
      fence = undefined;
    }
    if (line.trim()) {
      while (items.length && indent < items.at(-1)) items.pop();
      // 清單標記離所在清單項的內容縮排 0–3 格（再多是縮排程式碼）；內容縮排是標記後的空白，空清單項或空白超過 4 格時只算 1 格。
      const [, lead, marker, gap, text] = line.match(/^( *)([-*+]|\d{1,9}[.)])( *)(.*)$/) ?? [];
      if (marker && lead.length - (items.at(-1) ?? 0) <= 3 && (gap || !text)) items.push(lead.length + marker.length + (!text || gap.length > 4 ? 1 : gap.length));
    }
    const container = items.at(-1) ?? 0;
    const relative = line.slice(container);
    // ``` 開啟時資訊字串不能含 `（否則是行內碼）。
    const [, marker, rest] = relative.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    if (marker && !(marker[0] === '`' && rest.includes('`'))) { fence = { marker, container }; continue; }
    const heading = relative.match(/^ {0,3}#{1,6}[ \t]+(為什麼是 needs-.*?)[ \t#]*$/)?.[1];
    if (heading) return heading;
  }
}

/** 留言（依時間先後）裡，最近一則認領留言之後（沒有認領留言時是全部）最新一行 `DONE <n> <sha>` 的 sha；沒有時 undefined。
 * 認領之前的 DONE 不算：之後又被認領，表示要重做。 */
export const doneSha = (comments, n) => lastDone(comments, n)?.sha;

/** doneSha 的那一行連同所在留言：{ sha, createdAt }；沒有時 undefined。 */
function lastDone(comments, n) {
  const start = comments.findLastIndex(({ body }) => claimerOf({ body: body ?? '' }));
  const pattern = new RegExp(`^\\s*DONE ${n}\\s+(\\S+)`, 'gm');
  for (const { body, createdAt } of comments.slice(start + 1).reverse()) {
    const sha = [...(body ?? '').matchAll(pattern)].at(-1)?.[1];
    if (sha) return { sha, createdAt };
  }
  return undefined;
}

/** merge commit 主旨裡被合進來的分支：`Merge branch 'a'`、`Merge branches 'a' and 'b'`、`Merge remote-tracking branch 'origin/a'`、`Merge pull request #1 from owner/a`。 */
function mergedBranches(subject) {
  const pr = subject.match(/^Merge pull request #\d+ from [^/\s]+\/(\S+)/);
  if (pr) return [pr[1]];
  const merge = subject.match(/^Merge (?:remote-tracking )?branch(?:es)? (.*?)(?: into \S+)?$/);
  return merge ? [...merge[1].matchAll(/'([^']+)'/g)].map(([, branch]) => branch) : [];
}

/** 整合分支的 commit，新的先，每個是 [sha, 主旨]；查不到這個分支時丟 CliError。 */
function integrationLog(integration) {
  const result = spawnSync('git', ['log', '--format=%H%x09%s', integration, '--'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new CliError(`git log ${integration} 失敗：${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
}

/** sha 是否為整合分支的祖先（`git merge-base --is-ancestor`）；查不到的 sha 當不是。 */
function isAncestorOf(integration, sha) {
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, integration], { stdio: 'ignore' }).status === 0;
}

/** 「這張單是否已落地在整合分支」，pool 的 landed 桶與 blocked 行、claim 的 LANDED 共用，Probe 也可以引用（#352）：回傳 n => 落地的 sha｜undefined。
 * 落地是整合分支的歷史裡（新的先）有主旨含 `(#<n>)` 的 commit，或有 merge commit 的主旨把最後一段以 `<n>-` 開頭的分支合進來。
 * 只看主旨、不看分支 tip 是不是整合分支的祖先：剛開、還沒有 commit 的分支 tip 本來就是祖先。`log` 可注入，測試或別的來源用。
 * 回傳的函式另帶 `contains(sha)`：sha 是否為整合分支的祖先（#644，DONE 留言的 sha 要靠它才算落地）；`isAncestor` 可注入，風格同 `log`。 */
export function landedOn(integration, log = integrationLog, isAncestor = isAncestorOf) {
  const commits = log(integration);
  const landed = n => commits.find(([, subject]) => subject.includes(`(#${n})`) || mergedBranches(subject).some(branch => branchOfIssue(branch, n)))?.[0];
  landed.contains = sha => isAncestor(integration, sha);
  // 落地的 sha 是否已在 origin 的共用分支，與它的 committer date（ms）：重新細化的判斷用（#692）。
  landed.shared = sha => isAncestor(sharedBranch(), sha);
  landed.committedAt = sha => Date.parse(gitOut('log', '-1', '--format=%cI', sha) ?? '');
  return landed;
}

/** 已指派且最近一則認領之後有 `DONE` 結果行、但那個 sha 不在整合分支時的 sha（#644）；其餘 undefined。 */
const doneNotLanded = (n, { assigned, comments }, landed) => {
  const sha = assigned ? doneSha(comments, n) : undefined;
  return sha && !landed.contains?.(sha) ? sha : undefined;
};

/** 已落地的 sha：整合分支上的落地（landed 是 landedOn 的結果），或已指派且最近一則認領之後有 `DONE` 結果行、而且那個 sha 是整合分支的祖先（#644）；pool 的 landed 桶與 claim 的 LANDED 共用。
 * landed 沒有 contains（Probe 自己組的）時，DONE 的 sha 照舊當落地。 */
const landedSha = (n, { assigned, comments, editedAt }, landed) => {
  const sha = landed(n);
  if (sha && !reclaimedAfter(sha, { comments, editedAt }, landed)) return sha;
  return assigned && !doneNotLanded(n, { assigned, comments }, landed) ? doneSha(comments, n) : undefined;
};

/** 整合分支上的落地 commit 已在共用分支，而本文最後編輯（editedAt，pool 列表的 lastEditedAt）與最近一則認領都比它晚：claim 印過 LANDED_STALE 之後重做的單，
 * 不再算落地（#692 review r1）。只有認領比它晚不算：上 main 之後、Close 之前被單獨的 /issue-run 認領的單仍是落地（#352 的 #145，review r2）。
 * landed 沒有 shared（Probe 自己組的）、沒有 editedAt（claim 讀的 view、GitLab 列表）或沒有認領留言時為假；只改 label 的重新細化在 pool 照舊歸 landed。 */
function reclaimedAfter(sha, { comments, editedAt }, landed) {
  const claimed = comments.filter(({ body }) => claimerOf({ body: body ?? '' })).at(-1);
  if (!claimed || !editedAt || !landed.shared?.(sha)) return false;
  const at = landed.committedAt(sha);
  return Date.parse(claimed.createdAt) > at && Date.parse(editedAt) > at;
}

/** 每張 Issue 歸到一個桶，優先序見檔頭；landed 是 landedOn 的結果，沒給時沒有 landed 桶。 */
export function bucketOf(issue, { staleHours = 24, now = Date.now(), landed, skipLabels = [] } = {}) {
  const labels = labelsOf(issue);
  if (issue.subIssuesSummary.total > 0) return 'parent';
  if (labels.has('ready-for-human')) return 'human';
  if (labels.has('retro-candidates')) return 'retro-candidates';
  const skipped = skipLabels.find(name => labels.has(name));
  if (skipped) return skipped;
  if (issue.assignees.nodes.length) {
    if (landed && landedSha(issue.number, { assigned: true, comments: issue.comments.nodes, editedAt: issue.lastEditedAt }, landed)) return 'landed';
    return now - lastActivity(issue) > staleHours * 3600_000 ? 'stale' : 'claimed';
  }
  // `includeClosedPrs:false` 仍會回已合併的 PR（#281 的 PR #282 回 MERGED），所以要看 state。
  if (openNodes(issue.closedByPullRequestsReferences).length) return 'in-review';
  if (openNodes(issue.blockedBy).length) return 'blocked';
  if (labels.has('needs-info')) return 'needs-info';
  if (labels.has('needs-triage')) return 'needs-triage';
  if (labels.has('ready-for-agent')) return 'ready';
  return 'unlabeled';
}

const BUCKETS = ['ready', 'parent', 'human', 'retro-candidates', 'landed', 'stale', 'claimed', 'in-review', 'blocked', 'needs-info', 'needs-triage', 'unlabeled'];

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
  // --skip-labels 的桶不在 BUCKETS 裡：排在 retro-candidates 之後，彼此依 --skip-labels 的順序。
  const skipLabels = options.skipLabels ?? [];
  const rank = row => (BUCKETS.includes(row.bucket) ? BUCKETS.indexOf(row.bucket) : BUCKETS.indexOf('retro-candidates') + (1 + skipLabels.indexOf(row.bucket)) / (skipLabels.length + 1));
  return rows.sort((a, b) => rank(a) - rank(b)
    || (a.bucket === 'ready' && (b.retro - a.retro || b.priority - a.priority || b.blocks - a.blocks))
    || a.issue.number - b.issue.number);
}

/** triage 狀態 label，沒有時 'unlabeled'。 */
const triageState = issue => {
  const labels = labelsOf(issue);
  return TRIAGE_STATES.find(name => labels.has(name)) ?? 'unlabeled';
};

/** 開著的 blocker：本 repo 的 { number, landedSha（landed 的結果） }，別的 repo 的 { ref }。blocked 行與 blockerOpenScope 共用這一份（#359）。 */
const openBlockers = (issue, { repo, landed }) => openNodes(issue.blockedBy).map(({ number, repository: { nameWithOwner } }) =>
  (nameWithOwner !== repo ? { ref: `${nameWithOwner}#${number}` } : { number, landedSha: landed?.(number) }));

/** blocked 行號碼與標題之間的一段（格式見檔頭）。 */
function blockedDetail(issue, { repo, landed, integration }) {
  const blockers = openBlockers(issue, { repo, landed }).map(({ ref, number, landedSha }) => ref ?? `#${number}${landedSha ? ` (landed ${integration})` : ''}`);
  return `${triageState(issue)} by ${blockers.join(',')}`;
}

/** blocker 已落地、範圍卻還開著時的 triage label（#359，#338 第 2 項）。 */
const OPEN_SCOPE_STATES = ['ready-for-agent', 'needs-triage', 'ready-for-human'];

/** 最後一次指派的時間（ms），沒有指派事件時 0。 */
const lastAssigned = issue => Math.max(0, ...issue.timelineItems.nodes.map(({ createdAt }) => Date.parse(createdAt)));

/**
 * blocked 桶的單，本 repo 的開著的 blocker 已落地在整合分支（landedOn）、掛著 OPEN_SCOPE_STATES 之一，而且範圍還開著時，依號碼、blocker 順序各一個 `{ n, m, label }`：
 * 範圍還開著是 blocker 不在 landed 桶（沒指派：回到池子，或 `ready-for-human` 等人），或本文最後編輯（lastEditedAt，呼叫端的查詢要帶這個欄位）晚於最後一次指派。
 * 這張不算可派，blocker 的 `(landed …)` 只代表舊範圍做完（investing#379：#348 的 blocker #321 在 worker 開工後改寫範圍，#348 派出去 10 分鐘就 STOP decision）。
 * 已指派、做完而本文沒改過的 blocker（等關單）不算。blocker 資料與 blocked 行同一份；landed 沒給時是空的。
 */
export function blockerOpenScope(issues, { repo, landed, ...options }) {
  if (!landed) return [];
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const openScope = blocker => bucketOf(blocker, { ...options, landed }) !== 'landed' || Date.parse(blocker.lastEditedAt ?? '') > lastAssigned(blocker);
  return pool(issues, { repo, landed, ...options }).filter(({ bucket }) => bucket === 'blocked').map(({ issue }) => issue).sort((a, b) => a.number - b.number)
    .flatMap(issue => openBlockers(issue, { repo, landed }).flatMap(({ number, landedSha }) => {
      const blocker = byNumber.get(number);
      const label = blocker && triageState(blocker);
      return landedSha && OPEN_SCOPE_STATES.includes(label) && openScope(blocker) ? [{ n: issue.number, m: number, label }] : [];
    }));
}

/**
 * --pickable-blocked 的全部行（格式見檔頭，#501）：blocked 桶的單依號碼各一行，開著的 blocker 都已落地在整合分支（landedOn）、
 * 而且沒有一個命中 blockerOpenScope 時印 `PICKABLE <n>`，否則以第一個擋住的 blocker 印 `WAIT <n> <blocker>:<原因>`。
 * 只判 blocker；這張自己的 triage label 照 Pool 處理。blocker 資料與 blocked 行、blockerOpenScope 同一份。
 */
export function pickableBlocked(issues, { repo, landed, ...options }) {
  const openScope = new Set(blockerOpenScope(issues, { repo, landed, ...options }).map(({ n, m }) => `${n}#${m}`));
  const reason = (n, { ref, number, landedSha }) => ref ? `${ref}:other-repo`
    : !landedSha ? `${number}:not-integrated`
      : openScope.has(`${n}#${number}`) ? `${number}:open-scope` : undefined;
  return pool(issues, { repo, landed, ...options }).filter(({ bucket }) => bucket === 'blocked').map(({ issue }) => {
    const wait = openBlockers(issue, { repo, landed }).map(blocker => reason(issue.number, blocker)).find(Boolean);
    return wait ? `WAIT ${issue.number} ${wait}` : `PICKABLE ${issue.number}`;
  });
}

/** main 暫停旗標（#379）：`pilot-hold.mjs set-main` 寫的檔，相對於主 checkout；格式見 issue-pilot 的 PILOT-STORE.md。 */
export const MAIN_PAUSE_FILE = '.scratch/pilot/main-paused';
const pad = n => String(n).padStart(2, '0');
/** 本機時區的日期 `YYYY-MM-DD`。 */
export const localDate = (at = new Date()) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
/** `YYYY-MM-DD` 而且是存在的日期（2999-02-30 不算）。 */
export const isDate = text => /^\d{4}-\d\d-\d\d$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;

/**
 * main 是否依決定暫停推送（#379），Probe 的 MAIN_PAUSED 與這支的 LANDED_COUNT 共用：`<checkout>/.scratch/pilot/main-paused` 的一行 JSON
 * 有非空的 reason、until 是日期且不早於本機今天（當天仍有效）時回傳 { reason, until }；沒有檔、讀不懂或已過期時 undefined，照原輸出：
 * 收合會藏住待推的內容，讀不懂時寧可多印。
 */
export function mainPause(checkout, today = localDate()) {
  let value;
  try { value = JSON.parse(readFileSync(join(checkout, MAIN_PAUSE_FILE), 'utf8')); } catch { return undefined; }
  const { reason, until } = value ?? {};
  return typeof reason === 'string' && reason && typeof until === 'string' && isDate(until) && until >= today ? { reason, until } : undefined;
}

/** stdout 的全部行（格式見檔頭）：分桶行、PREREQ、NO_CATEGORY。landed、integration 只在帶 --integration 時給；
 * paused（main 暫停旗標有效，#379）時 landed 桶收成一行 `LANDED_COUNT <數量> <整合分支>`，放在 landed 桶的位置。 */
export function poolLines(issues, { repo, categories = DEFAULT_CATEGORIES, landed, integration, paused = false, listStale = false, worktreeChanges = [], ...options }) {
  const rows = pool(issues, { repo, landed, ...options });
  const detail = (issue, bucket) => bucket === 'blocked' ? `${blockedDetail(issue, { repo, landed, integration })} ` : bucket === 'ready' ? parentDetail(issue, repo) : '';
  const count = bucket => rows.filter(row => row.bucket === bucket).length;
  // 收成一行的桶：main 暫停時的 landed（#379）、沒帶 --stale 時的 stale（#550）；桶的第一張的位置印計數行。
  const folded = {
    ...(paused && landed ? { landed: `LANDED_COUNT ${count('landed')} ${integration}` } : {}),
    ...(listStale ? {} : { stale: `STALE ${count('stale')}` }),
  };
  const lines = rows.flatMap(({ issue, bucket }, i) => {
    if (!folded[bucket]) return [`${bucket} #${issue.number} ${detail(issue, bucket)}${issue.title}`];
    return rows[i - 1]?.bucket === bucket ? [] : [folded[bucket]];
  });
  for (const { issue } of rows.filter(({ bucket }) => bucket === 'ready')) {
    const prerequisite = prerequisiteOf(issue.body);
    // prerequisite 行優先；沒有或寫「無」時，本文有「為什麼是 needs-…」標題也印（#666）。
    const pending = prerequisite && !NO_PREREQUISITE.test(prerequisite) ? prerequisite : needsHeadingOf(issue.body);
    if (pending) lines.push(`PREREQ ${issue.number} ${pending}`);
  }
  lines.push(...pickOverlaps(rows.filter(({ bucket }) => bucket === 'ready').map(({ issue }) => issue), worktreeChanges));
  const missing = missingCategory(issues, categories, options.skipLabels);
  if (missing.length) lines.push(`NO_CATEGORY ${missing.join(' ')}`);
  return lines;
}

/** PICK_OVERLAP 只比 ready 桶的前這麼多張：一批派出的 worker 遠少於此（#591）。 */
export const PICK_TOP = 5;
// 本文裡的檔名：帶常見副檔名、可帶目錄；前面緊接 `/`、`.` 或字元的不算（URL 裡的路徑、`a.b.md` 的中段）。
const MENTIONED_FILE = /(?<![\w./-])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:mjs|cjs|js|jsx|ts|tsx|md|json|ya?ml|sh|py|java|kt|sql|patch|toml|txt|html|css|go|rb|xml|gradle|properties))(?![\w-])/g;
const MENTIONED_ENTRY = /\*\*([^*\n]+?)\.\*\*/g;

/** 本文提到的檔名（去掉開頭的 `./`）與 `**<條目>.**` 的條目名，各自去重。 */
export function mentions(body) {
  const text = body ?? '';
  return {
    files: [...new Set([...text.matchAll(MENTIONED_FILE)].map(([, path]) => path.replace(/^\.\//, '')))],
    entries: [...new Set([...text.matchAll(MENTIONED_ENTRY)].map(([, name]) => name.trim()))],
  };
}

/** 兩個路徑指同一個檔：相等，或較短的一邊是較長一邊以 `/` 切開的尾段（`pilot-probe.mjs` 對 `scripts/pilot-probe.mjs`）；傳回較長的一邊，對不上時 undefined。 */
function sameFile(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short === long || long.endsWith(`/${short}`) ? long : undefined;
}

/**
 * Pick 前的重疊提示（#591），不保證準：本文推測會漏（#355 本文沒提 `orca-session-send.mjs` 卻改了它），Probe 的 OVERLAP 仍是底線。
 * `ready` 是排好序的 ready 桶，只看前 PICK_TOP 張：前面的 n 對後面的 m，本文提到同一個檔印 `PICK_OVERLAP <n> <m> <檔>`、同一個條目印 `PICK_OVERLAP <n> <m> **<條目>.**`；
 * `changes`（[{ branch, path, entries }]，worktreeOverlaps 的 OVERLAP_WT）是各 worktree 的實際改動：n 的本文提到的檔被改到時印 `PICK_OVERLAP <n> <m> <改到的檔>`，
 * 本文提到的條目也在那個檔改到的條目裡時再接 ` **<條目>.**`。m 是分支最後一段 `<m>-` 的號碼，取不到時是分支名；n 自己的分支不算。
 */
export function pickOverlaps(ready, changes = []) {
  const top = ready.slice(0, PICK_TOP).map(issue => ({ n: issue.number, ...mentions(issue.body) }));
  const lines = [];
  top.forEach((a, i) => {
    for (const b of top.slice(i + 1)) {
      const files = new Set(a.files.flatMap(x => b.files.map(y => sameFile(x, y)).filter(Boolean)));
      for (const file of files) lines.push(`PICK_OVERLAP ${a.n} ${b.n} ${file}`);
      for (const entry of a.entries.filter(name => b.entries.includes(name))) lines.push(`PICK_OVERLAP ${a.n} ${b.n} **${entry}.**`);
    }
    for (const { branch, path, entries } of changes) {
      if (branchOfIssue(branch, a.n) || !a.files.some(file => sameFile(file, path))) continue;
      const m = branch.split('/').pop().match(/^(\d+)-/)?.[1] ?? branch;
      lines.push([`PICK_OVERLAP ${a.n} ${m} ${path}`, ...a.entries.filter(name => entries.includes(name)).map(name => `**${name}.**`)].join(' '));
    }
  });
  return lines;
}

/** triage 的五個狀態 label 與兩個分類 label 預設值（Matt 的 `/triage`：每張一個分類加一個狀態）。 */
export const TRIAGE_STATES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];
export const DEFAULT_CATEGORIES = ['bug', 'enhancement'];

/** 有 triage 狀態卻沒有分類的單，號碼小的先；母單、retro 候選清單與 skipLabels（--skip-labels）的單本來就不掛分類，不算。
 * 母單除了 parent 桶看的 sub-issue，也認 `parent` label：子單還沒建好、只掛了 label 的母單同樣不該被要求補分類。 */
export function missingCategory(issues, categories = DEFAULT_CATEGORIES, skipLabels = []) {
  return issues.filter(issue => {
    const labels = labelsOf(issue);
    if (issue.subIssuesSummary.total > 0 || labels.has('parent') || labels.has('retro-candidates') || skipLabels.some(name => labels.has(name))) return false;
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
/** 認領留言裡的機器名：ISSUE_POOL_HOSTNAME 有值時用它（測試的注入點，investing#481 第 3 項），否則 os.hostname()。 */
const machine = () => process.env.ISSUE_POOL_HOSTNAME || hostname();
const claimerName = session => `${machine()}／${session}`;

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處；不在 git repo 裡時是 undefined（claim 照舊 STOP，不像 pilot-dispatch 那樣丟錯）。 */
function mainCheckout() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.split('\n')[0].replace(/^worktree /, '') : undefined;
}

/** pid 的行程還在時為真（`kill -0`；EPERM 表示行程在、只是不屬於這個使用者）。 */
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** 擋下認領的是本機已交接出去、或已暫停（start 行的 pid 已不存在）的前任 coordinator，而 claim 的 session 是現任 coordinator（有 start 行、沒交接出去）時，傳回前任的 session；
 * 都照主 checkout 的 sessions.md（PILOT-STORE.md 的格式）判斷，讀不到時是 undefined。 */
function takeoverSession(claimer, session) {
  const [host, previous] = claimer.split('／');
  const main = host === machine() && previous ? mainCheckout() : undefined;
  if (!main) return undefined;
  let lines;
  try { lines = readFileSync(join(main, '.scratch/pilot/sessions.md'), 'utf8').split('\n'); } catch { return undefined; }
  const retired = id => lines.some(line => line.includes(`   handoff from-session ${id} `));
  const started = id => lines.some(line => line.includes(`   session ${id}   `) || (line.endsWith('  coordinator start') && line.includes(`  ${id}  `)));
  // 暫停沒交接的前任：只認帶 pid 的 start 行（舊格式沒有 pid，無從判斷）；pid 以前任自己那行為準，`coordinator` 檔此時記的是現任的 pid。
  const pid = lines.findLast(line => line.includes(`   session ${previous}   `))?.match(/   pid (\d+)\b/)?.[1];
  const suspended = pid !== undefined && !alive(Number(pid));
  return (retired(previous) || suspended) && previous !== session && started(session) && !retired(session) ? previous : undefined;
}

/** 本機認領者的 transcript 最後寫入時間（ms）；認領者在別台、或找不到它的 transcript 時是 undefined。 */
function transcriptActivity(claimer) {
  const [host, session] = claimer.split('／');
  if (host !== machine() || !session) return undefined;
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

/** origin 的預設分支（origin/HEAD），沒設時 origin/main；共用分支上的 commit 才算真的做完。 */
const sharedBranch = () => gitOut('rev-parse', '--abbrev-ref', 'origin/HEAD') ?? 'origin/main';

/**
 * 落地的 sha 之後這張單又重新細化過（#692：#507 先做完的一半已在 origin/main，本文改寫成新的範圍，claim 卻印 LANDED）：
 * sha 已在 origin 的共用分支（sharedBranch）、Issue 還開著，而且本文或 label 在落地之後有變動時為真。
 * 落地的時間是 sha 來自 DONE 留言時那則留言的時間，否則（整合分支的 `(#<n>)` 主旨或合入的分支）是那個 commit 的 committer date。
 * sha 不在共用分支時不查 tracker：還在等推上 main 的單本來就開著。
 */
function reworked(n, sha, comments, tracker, landed) {
  if (!landed.shared(sha)) return false;
  const done = lastDone(comments, n);
  const at = done?.sha === sha ? Date.parse(done.createdAt) : landed.committedAt(sha);
  const { open, changedAt } = tracker.revision(n);
  return open && Number.isFinite(at) && changedAt > at;
}

function claim(n, tracker, session, takeStale, landed) {
  const read = () => tracker.view(n);
  const stop = claimer => { console.log(`STOP ${n} claimed ${claimer}`); return 4; };
  const mine = claimerName(session);
  const before = read();
  const sha = landed && landedSha(n, { assigned: before.assignees.length > 0, comments: before.comments }, landed);
  if (sha && !reworked(n, sha, before.comments, tracker, landed)) { console.log(`LANDED ${n} ${sha}`); return 4; }
  if (sha) console.log(`LANDED_STALE ${n} ${sha}`);
  const unlanded = landed && doneNotLanded(n, { assigned: before.assignees.length > 0, comments: before.comments }, landed);
  if (unlanded) console.log(`DONE_NOT_LANDED ${n} ${unlanded}`);
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
  // 已指派、最近一則認領已是自己（沒被釋放）：不再留一則一樣的認領（#692：#632 留了 9 則），只重新指派，讓活動時間照 Dispatch 的規則更新。
  // takeover、stale 接手的最近一則認領是別人，不在此列。
  const renew = before.assignees.length > 0 && Boolean(last) && claimerOf(last) === mine;
  if (renew) tracker.reassign(n);
  else {
    // 先留言再指派：指派成功、留言失敗時，重跑會被自己沒有留言的指派擋住。
    tracker.comment(n, `認領：${claimant}`);
    tracker.assign(n);
  }
  const added = read().comments.slice(before.comments.length);
  const first = added.find(claimerOf);
  if (first && claimerOf(first) !== claimant) {
    // 只重新指派時沒有自己的留言可收回。
    if (renew) return stop(claimerOf(first));
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

/** 分支最後一段以 `<n>-` 開頭：issue/286-x 算，issue/2860-x、issue/1286-x 不算。 */
const branchOfIssue = (branch, n) => branch.split('/').pop().startsWith(`${n}-`);

function openWork(n, tracker) {
  const prs = openNodes({ nodes: tracker.closingPrs(tracker.repo(), n) });
  const lines = prs.map(pr => `OPEN_PR ${n} ${pr.number} ${pr.headRefName} ${pr.url}`);
  const local = (gitOut('for-each-ref', '--format=%(refname:short)', 'refs/heads') ?? '').split('\n').filter(Boolean);
  // ls-remote 不必先 fetch；沒有 origin 時 gitOut 回 undefined，只看本機。
  const remote = (gitOut('ls-remote', '--heads', 'origin') ?? '').split('\n').filter(Boolean).map(line => line.split('\t')[1].replace('refs/heads/', ''));
  for (const branch of local.filter(name => branchOfIssue(name, n))) lines.push(`BRANCH ${n} ${branch} local`);
  for (const branch of remote.filter(name => branchOfIssue(name, n))) lines.push(`BRANCH ${n} ${branch} origin`);
  console.log(lines.length ? lines.join('\n') : `NO_OPEN_WORK ${n}`);
  return 0;
}

/** 各 worktree 從與 `base` 的 merge-base 起的實際改動（worktree-overlap.mjs 的 OVERLAP_WT，基底過舊的 OVERLAP_STALE_BASE 不算）→ [{ branch, path, entries }]。
 * 只是 PICK_OVERLAP 的提示來源：查不了（例如沒有 `base` 這條分支）時 stderr 印 `PICK_OVERLAP_SKIP <原因>`、當作沒有改動，不讓 pool 失敗。 */
function changesInWorktrees(base) {
  try {
    return worktreeOverlaps(process.cwd(), [], { main: base }).flatMap(line => {
      const match = line.match(/^OVERLAP_WT (\S+) (\S+)(.*)$/);
      return match ? [{ branch: match[1], path: match[2], entries: [...match[3].matchAll(/\*\*(.+?)\.\*\*/g)].map(([, name]) => name) }] : [];
    });
  } catch (error) {
    console.error(`PICK_OVERLAP_SKIP ${error.message.split('\n')[0]}`);
    return [];
  }
}

function main(argv) {
  let repo, staleHours = 24, categories = DEFAULT_CATEGORIES, skipLabels = [], session = defaultSession(), takeStale = false, integration, pickable = false, listStale = false;
  const askPrefixes = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) repo = argv[++i];
    else if (argv[i] === '--stale-hours' && Number(argv[i + 1]) > 0) staleHours = Number(argv[++i]);
    else if (argv[i] === '--categories' && argv[i + 1]) categories = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--skip-labels' && argv[i + 1]) skipLabels = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--session' && argv[i + 1]) session = argv[++i];
    else if (argv[i] === '--take-stale') takeStale = true;
    else if (argv[i] === '--stale') listStale = true;
    else if (argv[i] === '--pickable-blocked') pickable = true;
    else if (argv[i] === '--integration' && argv[i + 1]) integration = argv[++i];
    else if (argv[i] === '--ask-prefix' && argv[i + 1]) askPrefixes.push(argv[++i]);
    else if (!argv[i].startsWith('-')) positional.push(argv[i]);
    else { console.error(USAGE); return 2; }
  }
  const [command, n] = positional;
  if ((pickable && command !== undefined) || command !== undefined && !(['claim', 'children', 'open-work'].includes(command) && /^\d+$/.test(n ?? '') && positional.length === 2)) { console.error(USAGE); return 2; }
  try {
    const tracker = trackerOf(repo);
    // --pickable-blocked 沒帶 --integration 時以目前分支（HEAD）當整合分支。
    const landed = pickable ? landedOn(integration ?? 'HEAD') : integration && ['claim', undefined].includes(command) ? landedOn(integration) : undefined;
    if (command === 'claim') return claim(n, tracker, session, takeStale, landed);
    if (command === 'children') return children(n, tracker, askPrefixes);
    if (command === 'open-work') return openWork(n, tracker);
    repo = tracker.repo();
    const issues = tracker.issues(repo);
    if (pickable) {
      for (const line of pickableBlocked(issues, { repo, staleHours, skipLabels, landed })) console.log(line);
      return 0;
    }
    const checkout = landed && mainCheckout();
    const paused = Boolean(checkout && mainPause(checkout));
    const worktreeChanges = changesInWorktrees(integration ?? 'main');
    for (const line of poolLines(issues, { repo, staleHours, categories, skipLabels, landed, integration, paused, listStale, worktreeChanges })) console.log(line);
    return 0;
  } catch (error) {
    if (!(error instanceof CliError) && !(error instanceof UsageError)) throw error;
    console.error(error.message);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
