#!/usr/bin/env node
// 看板同步（#487）：把本 repo 每張開著的 Issue 依 scripts/issue-pool.mjs 的分桶放進 GitHub Project「ron-skills 進度」Status 欄的七欄之一，
// 並在 --apply 結束時寫一則整體進度的 Project status update。本 repo 專用，不是 setup-workflow 的共用範本；規則與三個檢視見 docs/agents/project-board.md。
// 用法：node scripts/project-sync.mjs [--dry-run | --apply] [--setup-status-field] [--owner <login> --project <number>] [--repo <owner>/<name>]
//   預設 --dry-run：不寫入，只印會做的事。--apply 以當下讀到的狀態寫入差異。
//   Project：預設取連結到本 repo 的那一個；沒有或多於一個時每個印一行 `PROJECT <owner>/<number> <title>`、exit 3。--owner 與 --project 一起給時改用指定的。
//   --setup-status-field：Status 選項不是 COLUMNS 那七個（依序）時改成那七個（GitHub 會清空每張卡的值，同一次同步補回）；沒帶而選項不符時印
//   `STATUS_FIELD_MISMATCH <現有選項,…>`、exit 3。
// 分欄（columnOf）：已關閉 → 完成；開著的照 bucketOf 的桶對 BUCKET_COLUMN；parent 桶加卡但不設 Status（已設的清掉）；
//   處理中的單，若它的分支（最後一段以 `<n>-` 開頭的本機或 origin 分支）自己的 commit（不在 main 的）都已在整合分支、至少一個 → 已合入·待上 main。
//   main 是 origin/main 與本機 main 中存在的，整合分支是本機與 origin 的 pilot/integration 中存在的（任一個含有就算）；兩者可用 --main、--integration 覆寫。
//   只動本 repo 的 Issue 卡：PR、draft、其他 repo 的單不動；已關閉而不在看板上的單不加卡。
// stdout，依序：
//   `STATUS_FIELD ok` 或 `STATUS_FIELD <舊選項,…> → <七個選項>`（帶 --setup-status-field 時）
//   每張要變的卡一行，號碼升冪：`#<n> <舊欄> → <新欄>`、缺的卡 `#<n> 新增 → <欄>`（沒有 Status 寫成「（無）」）
//   七欄各一行 `COLUMN <欄> <張數>`（同步後的狀態）
//   Status update 的六行內文（`STATUS_LINE <內文行>`），與 `STATUS_UPDATE skip|create|update <理由>`
//   最後一行 `PROJECT_SYNC dry-run|applied <owner>/<number> changes <n>`
// exit：0 完成；1 gh 或 git 失敗（stderr 印原因）；2 用法錯誤；3 Project 不能確定或 Status 選項不符。
// 測試用環境變數 PROJECT_SYNC_NOW（ISO 時間）取代現在時間，只影響 Status update 的「同一天」判斷與 stale 分桶。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bucketOf, POOL_FIELDS } from './issue-pool.mjs';

export const COLUMNS = ['Retro 候選', '待討論', '被擋', '可開工', '處理中', '已合入·待上 main', '完成'];
const [RETRO, DISCUSS, BLOCKED, READY, ACTIVE, MERGED, DONE] = COLUMNS;
const COLORS = ['PURPLE', 'GRAY', 'RED', 'BLUE', 'YELLOW', 'ORANGE', 'GREEN'];

/** issue-pool 的桶 → 看板欄；parent 不在表裡（不設 Status）。沒帶 --integration 與 --skip-labels，所以沒有 landed 與自訂桶。 */
export const BUCKET_COLUMN = {
  'retro-candidates': RETRO,
  'needs-triage': DISCUSS, 'needs-info': DISCUSS, unlabeled: DISCUSS,
  blocked: BLOCKED,
  ready: READY, human: READY,
  claimed: ACTIVE, stale: ACTIVE, 'in-review': ACTIVE,
};

const NONE = '（無）';
const TIME_ZONE = 'Asia/Taipei';

/** 一張 Issue 該在的欄；null 表示不設 Status（母單）。merged(n) 回報這張處理中的單是否已合入整合分支、還不在 main。 */
export function columnOf(issue, { merged = () => false, now = Date.now() } = {}) {
  if (issue.state === 'CLOSED') return DONE;
  const bucket = bucketOf(issue, { now });
  if (bucket === 'parent') return null;
  const column = BUCKET_COLUMN[bucket];
  if (!column) throw new Error(`#${issue.number} 的桶 ${bucket} 沒有對應的欄`);
  return column === ACTIVE && merged(issue.number) ? MERGED : column;
}

/** 分支名稱最後一段以 `<n>-` 開頭就是這張單的分支（與 issue-pool 的 open-work 同一條規則）。 */
const branchOfIssue = (ref, n) => ref.split('/').pop().startsWith(`${n}-`);

/**
 * 回傳 n => 是否「它分支自己的 commit 已全部在整合分支、還不在 main」。git(...args) 回 stdout（失敗丟錯）；
 * mains、integrations 是存在的 ref；refs 是本機與 origin 的分支（完整 refname）。
 */
export function mergedChecker({ git, refs, mains, integrations }) {
  const count = (...args) => Number(git('rev-list', '--count', ...args).trim());
  return n => {
    const branches = refs.filter(ref => !ref.endsWith('/HEAD') && branchOfIssue(ref, n));
    if (!branches.length || !integrations.length) return false;
    const own = branches.map(ref => count(ref, '--not', ...mains));
    if (!own.some(Boolean)) return false;
    return branches.every(ref => count(ref, '--not', ...mains, ...integrations) === 0);
  };
}

/** 看板上的卡（本 repo 的 Issue）與開著的 Issue → 要做的變更：{ n, from, to, add, itemId, contentId }，號碼升冪。 */
export function planChanges({ cards, openIssues, columnFor }) {
  const changes = [];
  const byNumber = new Map(cards.map(card => [card.number, card]));
  for (const issue of openIssues) {
    const to = columnFor(issue);
    const card = byNumber.get(issue.number);
    if (!card) changes.push({ n: issue.number, from: null, to, add: true, contentId: issue.id });
    else if (card.status !== to) changes.push({ n: issue.number, from: card.status, to, itemId: card.itemId });
  }
  const open = new Set(openIssues.map(({ number }) => number));
  for (const card of cards) {
    if (card.state === 'CLOSED' && card.status !== DONE && !open.has(card.number)) changes.push({ n: card.number, from: card.status, to: DONE, itemId: card.itemId });
  }
  return changes.sort((a, b) => a.n - b.n);
}

export const changeLine = ({ n, from, to, add }) => `#${n} ${add ? '新增' : from ?? NONE} → ${to ?? NONE}`;

const percent = (done, total) => (total ? `${Math.round((done / total) * 100)}%（${done}／${total}）` : `—（0／0）`);

/** 同步後每張卡 { column, isParent, isRetro, hasParent } → 七欄張數與 Status update 的六行。 */
export function summarize(finalCards) {
  const columns = Object.fromEntries(COLUMNS.map(name => [name, finalCards.filter(({ column }) => column === name).length]));
  const scope = finalCards.filter(card => !card.isParent && !card.isRetro);
  const isDone = ({ column }) => column === DONE || column === MERGED;
  const orphans = scope.filter(card => !card.hasParent);
  const done = scope.filter(isDone).length;
  const lines = [
    `整體進度：${percent(done, scope.length)}`,
    `無母單進度：${percent(orphans.filter(isDone).length, orphans.length)}`,
    `剩下：${scope.length - done} 張`,
    `${MERGED}：${columns[MERGED]} 張`,
    `被擋與待討論：${columns[BLOCKED] + columns[DISCUSS]} 張`,
    `Retro 候選：${columns[RETRO]} 張`,
  ];
  return { columns, lines };
}

export const STATUS_FOOTER = '由 `scripts/project-sync.mjs` 產生；欄位規則見 docs/agents/project-board.md。';
export const statusBody = lines => `${lines.join('\n')}\n\n${STATUS_FOOTER}`;

/** Asia/Taipei 的日期 YYYY-MM-DD。 */
export const taipeiDate = at => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

/** 最新一則 status update（{ id, body, createdAt } 或 undefined）與這次的六行 → { action: skip|create|update, reason }。只比六行數字，不比頁尾。 */
export function statusAction(latest, lines, now = Date.now()) {
  if (!latest) return { action: 'create', reason: '還沒有 status update' };
  const previous = (latest.body ?? '').split('\n').slice(0, lines.length).join('\n');
  if (previous === lines.join('\n')) return { action: 'skip', reason: '數字沒變' };
  return taipeiDate(latest.createdAt) === taipeiDate(now)
    ? { action: 'update', reason: `改寫 ${taipeiDate(now)} 那一筆` }
    : { action: 'create', reason: `${taipeiDate(now)} 第一筆` };
}

class UsageError extends Error {}
class ConfigError extends Error {}

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} 失敗：${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

/** gh api graphql：query 與 variables 一律經 stdin 的 JSON 送出（陣列變數也能帶）。 */
function graphql(query, variables = {}) {
  const out = JSON.parse(run('gh', ['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })));
  if (out.errors?.length) throw new Error(`gh api graphql 失敗：${out.errors.map(({ message }) => message).join('；')}`);
  return out.data;
}

const ISSUES_QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{id state ${POOL_FIELDS}}}}}`;
const LINKED_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:20){nodes{number title owner{... on User{login} ... on Organization{login}}}}}}`;
const PROJECT_FIELDS = `id number title owner{... on User{login} ... on Organization{login}} field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}} statusUpdates(first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{id body createdAt}}`;
const PROJECT_QUERY = `query($owner:String!,$number:Int!){repositoryOwner(login:$owner){... on ProjectV2Owner{projectV2(number:$number){${PROJECT_FIELDS}}}}}`;
const ITEMS_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{items(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}} content{__typename ... on Issue{number state repository{nameWithOwner} labels(first:50){nodes{name}} subIssuesSummary{total} parent{number}}}}}}}}`;

function paginate(fetchPage) {
  const nodes = [];
  for (let cursor = null, more = true; more;) {
    const page = fetchPage(cursor);
    nodes.push(...page.nodes);
    ({ hasNextPage: more, endCursor: cursor } = page.pageInfo);
  }
  return nodes;
}

function loadProject({ owner, number }) {
  const project = graphql(PROJECT_QUERY, { owner, number }).repositoryOwner?.projectV2;
  if (!project) throw new ConfigError(`找不到 Project ${owner}/${number}`);
  if (!project.field?.id) throw new ConfigError(`Project ${owner}/${number} 沒有單選的 Status 欄位`);
  return project;
}

function loadCards(project, repo) {
  const items = paginate(cursor => graphql(ITEMS_QUERY, { id: project.id, cursor }).node.items);
  return items.filter(({ content }) => content?.__typename === 'Issue' && content.repository?.nameWithOwner === repo).map(({ id, fieldValueByName, content }) => ({
    itemId: id, number: content.number, state: content.state, status: fieldValueByName?.name ?? null,
    isParent: content.subIssuesSummary.total > 0, isRetro: content.labels.nodes.some(({ name }) => name === 'retro-candidates'), hasParent: Boolean(content.parent),
  }));
}

function existingRefs(names) {
  return names.filter(name => spawnSync('git', ['rev-parse', '--verify', '-q', `${name}^{commit}`], { stdio: 'ignore' }).status === 0);
}

function parseArgs(argv) {
  const options = { apply: false, setup: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new UsageError(`${arg} 少了值`); return argv[++i]; };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--setup-status-field') options.setup = true;
    else if (arg === '--owner') options.owner = value();
    else if (arg === '--project') options.number = Number(value());
    else if (arg === '--repo') options.repo = value();
    else if (arg === '--main') (options.mains ??= []).push(value());
    else if (arg === '--integration') (options.integrations ??= []).push(value());
    else throw new UsageError(`不認得的參數：${arg}`);
  }
  if (Boolean(options.owner) !== Boolean(options.number)) throw new UsageError('--owner 與 --project 要一起給');
  if (options.number !== undefined && !Number.isInteger(options.number)) throw new UsageError('--project 要是數字');
  if (options.repo && !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new UsageError('--repo 要是 <owner>/<name>');
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const now = process.env.PROJECT_SYNC_NOW ? Date.parse(process.env.PROJECT_SYNC_NOW) : Date.now();
  const repo = options.repo ?? run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const [repoOwner, repoName] = repo.split('/');

  let target = options.owner ? { owner: options.owner, number: options.number } : null;
  if (!target) {
    const linked = graphql(LINKED_QUERY, { owner: repoOwner, name: repoName }).repository.projectsV2.nodes;
    if (linked.length !== 1) {
      for (const { owner, number, title } of linked) console.log(`PROJECT ${owner.login}/${number} ${title}`);
      throw new ConfigError(`連結到 ${repo} 的 Project 有 ${linked.length} 個，用 --owner <login> --project <number> 指定`);
    }
    target = { owner: linked[0].owner.login, number: linked[0].number };
  }
  let project = loadProject(target);
  const label = `${target.owner}/${target.number}`;

  const current = project.field.options.map(({ name }) => name);
  const fieldOk = current.join('\n') === COLUMNS.join('\n');
  if (!fieldOk && !options.setup) {
    console.log(`STATUS_FIELD_MISMATCH ${current.join(',')}`);
    throw new ConfigError(`Project ${label} 的 Status 選項不是 ${COLUMNS.join(',')}：先跑 --setup-status-field --apply`);
  }
  let cards = loadCards(project, repo);
  if (options.setup) {
    console.log(fieldOk ? 'STATUS_FIELD ok' : `STATUS_FIELD ${current.join(',')} → ${COLUMNS.join(',')}`);
    if (!fieldOk) {
      if (options.apply) {
        graphql('mutation($field:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]){updateProjectV2Field(input:{fieldId:$field,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',
          { field: project.field.id, options: COLUMNS.map((name, i) => ({ name, color: COLORS[i], description: '' })) });
        project = loadProject(target);
        cards = loadCards(project, repo);
      } else {
        cards = cards.map(card => ({ ...card, status: null }));
      }
    }
  }

  const openIssues = paginate(cursor => graphql(ISSUES_QUERY, { owner: repoOwner, name: repoName, cursor }).repository.issues);
  const git = (...args) => run('git', args);
  const refs = git('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin').split('\n').filter(Boolean);
  const mains = existingRefs(options.mains ?? ['origin/main', 'main']);
  if (!mains.length) throw new Error(`找不到 main（${(options.mains ?? ['origin/main', 'main']).join('、')}）`);
  const integrations = existingRefs(options.integrations ?? ['pilot/integration', 'origin/pilot/integration']);
  if (!integrations.length) console.error('project-sync: 找不到整合分支，沒有單會歸到「已合入·待上 main」');
  const merged = mergedChecker({ git, refs, mains, integrations });
  const columnFor = issue => columnOf(issue, { merged, now });

  const changes = planChanges({ cards, openIssues, columnFor });
  for (const change of changes) console.log(changeLine(change));

  const optionId = Object.fromEntries(project.field.options.map(({ id, name }) => [name, id]));
  if (options.apply) {
    for (const change of changes) {
      let itemId = change.itemId;
      if (change.add) itemId = graphql('mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}', { project: project.id, content: change.contentId }).addProjectV2ItemById.item.id;
      if (change.to) graphql('mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}',
        { project: project.id, item: itemId, field: project.field.id, option: optionId[change.to] });
      else if (!change.add) graphql('mutation($project:ID!,$item:ID!,$field:ID!){clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}){projectV2Item{id}}}',
        { project: project.id, item: itemId, field: project.field.id });
    }
  }

  // 同步後的看板：既有的卡照變更改欄，新增的卡補上。
  const byNumber = new Map(openIssues.map(issue => [issue.number, issue]));
  const moved = new Map(changes.map(({ n, to }) => [n, to]));
  const finalCards = [
    ...cards.map(card => ({ ...card, column: moved.has(card.number) ? moved.get(card.number) : card.status })),
    ...changes.filter(({ add }) => add).map(({ n, to }) => {
      const issue = byNumber.get(n);
      return { number: n, column: to, isParent: issue.subIssuesSummary.total > 0, isRetro: issue.labels.nodes.some(({ name }) => name === 'retro-candidates'), hasParent: Boolean(issue.parent) };
    }),
  ];
  // 開著的卡以這次讀到的 Issue 為準（母單、Retro 候選、有沒有母單）。
  for (const card of finalCards) {
    const issue = byNumber.get(card.number);
    if (issue) Object.assign(card, { isParent: issue.subIssuesSummary.total > 0, isRetro: issue.labels.nodes.some(({ name }) => name === 'retro-candidates'), hasParent: Boolean(issue.parent) });
  }
  const { columns, lines } = summarize(finalCards);
  for (const name of COLUMNS) console.log(`COLUMN ${name} ${columns[name]}`);
  for (const line of lines) console.log(`STATUS_LINE ${line}`);
  const latest = project.statusUpdates.nodes[0];
  const { action, reason } = statusAction(latest, lines, now);
  console.log(`STATUS_UPDATE ${action} ${reason}`);
  if (options.apply && action === 'create') graphql('mutation($project:ID!,$body:String!){createProjectV2StatusUpdate(input:{projectId:$project,body:$body}){statusUpdate{id}}}', { project: project.id, body: statusBody(lines) });
  if (options.apply && action === 'update') graphql('mutation($id:ID!,$body:String!){updateProjectV2StatusUpdate(input:{statusUpdateId:$id,body:$body}){statusUpdate{id}}}', { id: latest.id, body: statusBody(lines) });
  console.log(`PROJECT_SYNC ${options.apply ? 'applied' : 'dry-run'} ${label} changes ${changes.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`project-sync: ${error.message}`);
    process.exit(error instanceof UsageError ? 2 : error instanceof ConfigError ? 3 : 1);
  }
}
