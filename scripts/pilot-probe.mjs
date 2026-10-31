#!/usr/bin/env node
// setup-workflow 正本（#58）：pilot 的 Reconcile 用這一支對帳。主 checkout、`.scratch/pilot/` 的請求、gate、batch checkpoint、
// 每個 running 成員的 terminal 與 tracker 上的母單，各印一行狀態，不必再手動拼 `orca terminal read` 的 JSON（手拼時漏過 exited 卻沒有結果行的 worker）。
// 存檔格式照 issue-pilot 的 PILOT-STORE.md；專案不同的值由參數傳入。
//
// 用法：node scripts/pilot-probe.mjs <主 checkout> [--integration <分支>] [--main <分支>] [--apply] [--status] [--capacity <repo>]
//   --integration 整合分支，預設 pilot/integration；--main 主分支，預設 main。讀 running 成員要 ORCA_CLI_COMMAND，沒有時其他檢查照跑。
//   --apply：把這一輪讀到的 `WORKER <n> DONE <sha>`、`STOP <cause>` 寫回 batch checkpoint 的成員列（state `done` 與 candidate SHA、
//            state `stop`），只改那一列的這兩欄；`merged` 的 batch 印 IN_MAIN 時把 `current: merged` 改成 `pushed`（SHA 與附註不動）。
//            對不到唯一一列 running 的成員列時不寫檔，印 APPLY_MISS <key> <n> rows <列數>；寫回後再讀一次沒對上時印 APPLY_MISS <key> <n|current> verify
//            （檔案已經寫了，不還原）；有 APPLY_MISS 就 exit 1。
//            母單：PARENT_LABEL 補上 `parent` label、移除它掛著的 triage label，PARENT_REOPEN 重開母單；同目錄有專案自備的 gh-tracker.mjs
//            （`edit <n> --add-label …`、`reopen <n>`，參數同 `gh issue`）時經它寫，沒有就直接跑 `gh issue`，都在主 checkout 跑。
//            寫入失敗印 PARENT_APPLY_FAILED <n> <錯誤>，其他母單照修，exit 1。
//   --status：最後從 checkpoint、gates.md、requests.md、coordinator 與 git 重寫 `.scratch/pilot/status.md`（格式見 PILOT-STORE.md），不印任何行。
//   --capacity <repo>（#178）：把這一輪還在跑的成員數（各 batch 的 running 列，扣掉這一輪讀到 DONE、STOP 的）以 <repo> 寫進全機帳本
//            （同目錄 pilot-capacity.mjs 的 report：$PILOT_WORKERS_LEDGER，預設 ~/.local/state/pilot-workers.tsv）；所有 repo 的合計超過
//            $PILOT_MACHINE_WORKER_CAP（預設 4）時最後印 OVER_CAP <合計> <上限>。只回報，不改派工；沒帶時不碰帳本。
//            <repo> 空白或帶 tab、換行，或上限不是正整數時是用法錯誤（exit 2）。
//   --apply、--status 都不改其他輸出行，stdout 與不帶旗標時相同（APPLY_MISS、PARENT_APPLY_FAILED 除外）。
//   Bare guard：同目錄有 pilot-unbare.sh（專案自備，`<checkout> <時機>`，還原時印 UNBARE）時先跑它（時機 probe），沒有就略過。
// stdout 每行一項，沒事的項目不印（全部正常且沒有 batch 時不輸出）：
//   主 checkout：UNBARE <checkout>（Bare guard 剛還原 core.bare）｜NOT_MAIN <分支>｜HOLD｜DIRTY <git status --short 的一行>
//   adapter：ADAPTER_AHEAD <檔案> [<名稱>[,<名稱>…]]（整合分支上的 adapter 比主分支新：docs/agents/issue-run.md，以及它 `## Pilot` 段連到的同目錄 .md；
//            `.md` 的改動都在 `- **<名稱>.**` 條目裡時附改動的條目名稱，依名稱排序、以 `,` 分隔，名稱本身可能有空格（不能有 `,`）；刪掉或改名的條目也列（取改動前的名稱）；
//            有條目以外的改動或不是 `.md` 時省略名稱欄，表示要讀整份）
//   開著的列：REQUEST <requests.md 原文>｜GATE <id> <Issue> <question 或段落標題>｜GATE_MALFORMED <id> <把 resolved 寫進別的欄位的那一行>
//   Issue 依賴：DEPS_PROSE <n> #<m>（開著的 `ready-for-agent` Issue 內文以「依賴」或先後寫法（「排在 #m 之後」「以 #m 為 blocker」「等 #m 合入」）帶出 #m，#m 還開著，blocked_by 卻沒有它；Pool 只讀 blocked_by）｜
//               DEPS_PROSE <n> last（內文寫「最後做」卻沒號碼；要等哪些單由 coordinator 判斷）｜
//               DEPS_PROSE_FAILED <錯誤>（在主 checkout 跑 gh 失敗，其他檢查照跑；同一次查詢的 PARENT_* 也不印）
//   母單（#164）：PARENT_LABEL <n>（開著、或已關閉卻有開著子單的母單，沒有 `parent` label 或還掛 triage label）｜
//               PARENT_REOPEN <n>（開著的子單的母單 #n 在同一個 repo、已關閉）；各依號碼、每張一次
//   running 成員：WORKER <n> DONE <sha>｜WORKER <n> STOP <cause>｜WORKER <n> RUNNING <分鐘>｜
//                 WORKER <n> STUCK exited|stuck-after <分鐘>|orca <錯誤碼>|no-orca|checkpoint <欄位> <值>
//                 （terminal 已結束卻沒有結果行、超過 stuck-after、讀不到 terminal、沒有 ORCA_CLI_COMMAND、checkpoint 的時間欄位解析不了）
//   batch：dispatched 的 batch 沒有 running 成員時（這一輪剛讀到 DONE／STOP 的照結果算；moved（含 `moved batch-<n>`）的成員已移到別的 batch，不算）：
//          每個成員都 done 印 STAGEABLE <key>；有 done 也有 stop、parked 印 MOVE <key> <不是 done 的成員…>（先用 pilot-batch 移走）；
//          沒有 done 印 PARKED <key> <n…>（#163：只剩 stop 的 batch 照跑 pilot-land 只得到 STOP member）；
//          沒關的 batch 裡 `parked after #<m>` 的成員，在 #m 以 done 留在 `closed` 的 batch 之後印 UNPARK <n>；
//          current 是 merged／pushed 的 batch 在 git fetch 後比 origin/<主分支>，印 IN_MAIN <key>｜NOT_IN_MAIN <key>（no-sha：checkpoint 沒有 SHA）｜FETCH_FAILED <錯誤>；
//          還沒進 origin/<主分支> 的 merged batch 改印 RESUME_PUSH <key>（整合分支的 tip 等於最後一次 regression SHA），
//          不符合時印 NOT_IN_MAIN <key> no-regression（沒有 regression 行或 SHA 解析不到）｜NOT_IN_MAIN <key> tip <tip 前 7 碼或 none>
//   重疊：OVERLAP <n> <m|integration> <檔案數> files [**<條目>.**…]（開著的 batch 裡 running、done 的成員分支已 commit 的內容，相對於與整合分支的 merge-base：
//          兩個成員改到同一個檔，或整合分支自成員的 merge-base 以來也改了它改的檔；`.md` 檔的改動都在 `- **<名稱>.**` 條目裡時細到條目，
//          相接的行與同一處的插入也算，git 合併時會衝突；同一對只印一行，後面列重疊的條目名稱，#176：條目不帶檔名、不同檔的同名條目只列一次，
//          名稱可能有空格，以 `**`…`.**` 切分；數量固定寫 files，1 也是）
//   全機上限：OVER_CAP <合計> <上限>（帶 --capacity 時，見上）
// exit：0 印完；2 用法錯誤；1 其他失敗（Bare guard 或 git status 失敗、APPLY_MISS、PARENT_APPLY_FAILED 等）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gateLines, isOpenRequest, now, openGates, tableCells } from './lib/pilot-store.mjs';
import { orca } from './orca-session-send.mjs';
import { ledgerPath, machineCap, report, validRepo } from './pilot-capacity.mjs';

const TRACKER_QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{number body labels(first:50){nodes{name}} blockedBy(first:50){nodes{number repository{nameWithOwner}}} subIssuesSummary{total} parent{number state repository{nameWithOwner} labels(first:50){nodes{name}}}}}}}`;
const USAGE = '用法：node scripts/pilot-probe.mjs <主 checkout> [--integration <分支>] [--main <分支>] [--apply] [--status] [--capacity <repo>]';
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'pilot-unbare.sh');
const TRACKER = join(dirname(fileURLToPath(import.meta.url)), 'gh-tracker.mjs');

/**
 * 在主 checkout 跑 git；stdin 一律不給（逐一呼叫外部指令時被吃掉 stdin 會讓後面的步驟讀不到）。
 * 清掉繼承的 GIT_DIR 等，否則從 pre-commit hook 或 worktree 呼叫時會讀到別的 repo（見 pilot-unbare.sh）。
 */
function git(checkout, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
  return spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Bare guard：同目錄有專案自備的 pilot-unbare.sh 才跑（Orca 從 WSL 操作 worktree 會把主 checkout 設成 bare），傳回它印的行。 */
function bareGuard(checkout, when) {
  if (!existsSync(GUARD)) return [];
  const unbare = spawnSync(GUARD, [checkout, when], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (unbare.status !== 0) throw new Error(`pilot-unbare.sh ${(unbare.stderr ?? '').trim() ? `exit ${unbare.status}：${unbare.stderr.trim()}` : `exit ${unbare.status ?? unbare.error?.code}`}`);
  return unbare.stdout.split('\n').filter(Boolean);
}

/** 主 checkout 的狀態行：Bare guard（時機 probe）、不在主分支、hold 檔、`git status --short` 的每一行。 */
export function checkoutState(checkout, main = 'main') {
  const out = bareGuard(checkout, 'probe');
  const current = git(checkout, 'branch', '--show-current');
  if (current.status !== 0) throw new Error(`git branch --show-current exit ${current.status}：${current.stderr.trim()}`);
  const branch = current.stdout.trim();
  if (branch !== main) out.push(`NOT_MAIN ${branch || '(detached)'}`);
  if (existsSync(join(checkout, '.scratch/pilot/hold'))) out.push('HOLD');
  const status = git(checkout, 'status', '--short');
  if (status.status !== 0) throw new Error(`git status exit ${status.status}：${status.stderr.trim()}`);
  for (const line of status.stdout.split('\n').filter(Boolean)) out.push(`DIRTY ${line}`);
  return out;
}

/** 下一批在整合分支上 stage，主 checkout 的 adapter 卻是主分支的版本。 */
const ADAPTER = 'docs/agents/issue-run.md';

/**
 * adapter 的 `## Pilot` 段連到的同目錄 `.md`（Pilot 段指向自己的檔案時，那份也是 adapter，見 issue-pilot SKILL 的 Sources）。
 * 其他目錄的連結（skill、契約）與其他段落的連結都不算。
 */
export function pilotFiles(text) {
  const section = text.match(/^## Pilot[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
  const dir = ADAPTER.slice(0, ADAPTER.lastIndexOf('/') + 1);
  return [...new Set([...section.matchAll(/\]\((?:\.\/)?([^)/#\s]+\.md)(?:#[^)\s]*)?\)/g)].map(m => `${dir}${m[1]}`))];
}

/** `rev-parse --verify -q`：不存在時回空字串（exit 1、沒有 stderr），其他失敗 throw。 */
function rev(checkout, ref) {
  const result = git(checkout, 'rev-parse', '--verify', '-q', ref);
  if (result.status !== 0 && result.status !== 1) throw new Error(`git rev-parse ${ref} exit ${result.status}：${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** 分支上的檔案內容；沒有這個檔時回空字串。 */
function show(checkout, ref, path) {
  const result = git(checkout, 'show', `${ref}:${path}`);
  return result.status === 0 ? result.stdout : '';
}

/**
 * 整合分支上比主分支新的 adapter 檔：整合分支有這個檔、內容與主分支不同，而且主分支最後一次改它的 commit
 * 已經在整合分支裡（主分支從沒有這個檔也算）。主分支自己改過、整合分支還沒跟上時，整合分支那份比較舊，不印；
 * 兩邊都改過（歷史分岔）時分不出誰新，也不印。整合分支刪掉的檔讀不到，不印。沒有整合分支或主分支時不比。
 * 比的檔案是 adapter 本身，加上兩邊任一版 adapter 的 Pilot 段連到的檔案（新連上的檔只在整合分支那邊）。
 * 改動都在條目裡時附條目名稱（同 OVERLAP 的 changedUnits，不算相鄰的條目），讓 coordinator 只讀那幾條、不讀整份 diff（#144）。
 */
export function adapterAhead(checkout, { integration = 'pilot/integration', main = 'main' } = {}) {
  const [ahead, base] = [`refs/heads/${integration}`, `refs/heads/${main}`];
  if (!rev(checkout, ahead) || !rev(checkout, base)) return [];
  const files = [...new Set([ADAPTER, ...[ahead, base].flatMap(ref => pilotFiles(show(checkout, ref, ADAPTER)))])];
  return files.filter(path => {
    const blob = rev(checkout, `${ahead}:${path}`);
    if (!blob || blob === rev(checkout, `${base}:${path}`)) return false;
    const touched = git(checkout, 'log', '-1', '--format=%H', base, '--', path);
    if (touched.status !== 0) throw new Error(`git log ${main} -- ${path} exit ${touched.status}：${touched.stderr.trim()}`);
    const last = touched.stdout.trim();
    if (!last) return true;
    const ancestor = git(checkout, 'merge-base', '--is-ancestor', last, ahead);
    if (ancestor.status > 1) throw new Error(`git merge-base --is-ancestor exit ${ancestor.status}：${ancestor.stderr.trim()}`);
    return ancestor.status === 0;
  }).map(path => {
    const unit = changedUnits(checkout, base, ahead, { paths: [path], adjacent: false }).get(path);
    return unit && !unit.whole && unit.entries.size ? `ADAPTER_AHEAD ${path} ${[...unit.entries].sort().join(',')}` : `ADAPTER_AHEAD ${path}`;
  });
}

/** `.scratch/pilot/` 裡的 batch checkpoint 檔名，依名稱排序。 */
const batchFiles = pilot => (existsSync(pilot) ? readdirSync(pilot) : []).filter(file => /^batch-.+\.md$/.test(file)).sort();

const readStore = (pilot, name) => (existsSync(join(pilot, name)) ? readFileSync(join(pilot, name), 'utf8') : '');

/** requests.md 還開著的行（原文去掉首尾空白）：最後一個 `source` 欄之後沒標 `applied`／`declined`（請求內文提到這兩個字或 source 都不算）。 */
const openRequests = pilot => readStore(pilot, 'requests.md').split('\n').filter(isOpenRequest).map(line => line.trim());

/** requests.md 與 gates.md 還開著的列。 */
export function openRows(pilot) {
  const out = openRequests(pilot).map(line => `REQUEST ${line}`);
  out.push(...gateLines(readStore(pilot, 'gates.md')));
  return out;
}

const ISSUE_REF = /(?<![\w/.-])#(\d+)\b/g;
/** 文字裡同 repo 的 Issue 號碼，依出現順序（`owner/repo#m` 是別的 repo，不算）。 */
const refs = text => [...text.matchAll(ISSUE_REF)].map(([, m]) => Number(m));

/**
 * 內文以「依賴」或先後寫法帶出的 Issue 號碼，依出現順序、不重複。
 * 「依賴」：從 `依賴` 到句末（`。`、`；`、`;`、`，`、`,` 或換行）之間的每個 `#m`。實際寫法有「依賴：#58、#77」「依賴 #58（註解）、#77」
 * 「依賴 ①（#103）」，所以不要求 #m 緊接在後；「不依賴」「無依賴」是否定，不算。括號裡的逗號不斷句（「依賴 #77（同一支腳本，接在它之後改）」）。
 * 先後寫法見 orderDeps。
 */
export function proseDeps(body) {
  const deps = new Set();
  for (const [clause] of (body ?? '').matchAll(/(?<![不無])依賴(?:（[^）\n]*）|[^。；;，,\n])*/g)) for (const m of refs(clause)) deps.add(m);
  for (const m of orderDeps(body)) deps.add(m);
  return [...deps];
}

// 回指同一句前面號碼的複數代名詞。單數的「它」不回指：#176「正被 #94 改，排在它之後」的驗收是不印（#206），
// 「#81 改 probe，#82 排在它之後」回指整句也會把主詞自己算進去。
const PLURAL = ['它們', '這些', '上述'];
// 號碼清單（「#63、#64（同一條目）和 #65」）或複數代名詞。
const TARGET = String.raw`((?:#\d+\b|（[^）\n]*）|[、和與及\s])+|${PLURAL.join('|')})`;
// 「不必等」「不用排在」「無須以…為 blocker」是否定，同「不依賴」。
const NOT = String.raw`(?<!不必?|不用|無[須需])`;
const ORDER = [
  new RegExp(String.raw`${NOT}[排接]在\s*${TARGET}\s*(?:之後|後面)`, 'g'),
  new RegExp(String.raw`${NOT}以\s*${TARGET}\s*為\s*blocker`, 'gi'),
  new RegExp(String.raw`${NOT}等\s*${TARGET}\s*都?(?:合入|合併|關閉)`, 'g'),
];

/**
 * 內文以先後寫法帶出的 Issue 號碼：「排在 #m 之後」「以 #m、#n 為 blocker」「等 #m 合入」裡的每個 #m；寫成「它們」「這些」「上述」時
 * 指同一句（到 `。`、`；`、`;` 或換行）前面出現的號碼（#166「…#94 修改，拆檔會和它們全部衝突：以它們為 blocker」）。
 */
export function orderDeps(body) {
  const deps = new Set();
  for (const [sentence] of (body ?? '').matchAll(/[^。；;\n]+/g)) {
    for (const pattern of ORDER) {
      for (const match of sentence.matchAll(pattern)) {
        for (const m of refs(PLURAL.includes(match[1]) ? sentence.slice(0, match.index) : match[1])) deps.add(m);
      }
    }
  }
  return [...deps];
}

/** 內文寫「最後做」、那一小句（到 `，`、`,` 或句末）沒有號碼（「不必／不要／不用／無須最後做」不算）：要等哪些單交給 coordinator 判斷。 */
export function proseLast(body) {
  for (const [clause] of (body ?? '').matchAll(/(?:（[^）\n]*）|[^。；;，,\n])+/g)) {
    if (/(?<!不[必要用]?|無[須需])最後做/.test(clause) && !refs(clause).length) return true;
  }
  return false;
}

/**
 * 依賴只寫在內文、沒建 blocked_by 的 ready Issue（`issues` 是本 repo 開著的 Issue，GraphQL 節點）：每個還開著、
 * 卻不在 blocked_by（同一個 repo）裡的依賴印一行 `DEPS_PROSE <n> #<m>`；寫「最後做」卻沒號碼時再印一行 `DEPS_PROSE <n> last`。
 */
export function depsProse(issues, repo) {
  const open = new Set(issues.map(({ number }) => number));
  const out = [];
  for (const issue of issues) {
    if (!issue.labels.nodes.some(({ name }) => name === 'ready-for-agent')) continue;
    const blocked = new Set(issue.blockedBy.nodes.filter(({ repository }) => repository.nameWithOwner === repo).map(({ number }) => number));
    for (const m of proseDeps(issue.body)) if (m !== issue.number && open.has(m) && !blocked.has(m)) out.push(`DEPS_PROSE ${issue.number} #${m}`);
    if (proseLast(issue.body)) out.push(`DEPS_PROSE ${issue.number} last`);
  }
  return out;
}

// 與 issue-pool.mjs 的 TRIAGE_STATES 相同（測試比對兩者）：母單不掛這些 label。
export const TRIAGE_STATES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

/**
 * 母單的整理（#164）：有 sub-issue 卻沒有 `parent` label 或還掛 triage label 的母單印 `PARENT_LABEL <n>`；
 * 開著的子單指向已關閉的（同一個 repo 的）母單時，對那張母單印 `PARENT_REOPEN <n>`。查詢只列開著的單，已關閉的母單從子單的 `parent`
 * 讀 label，所以它同時缺 label 時一起印 PARENT_LABEL，一次 `--apply` 修完。各依號碼、每張一次。
 * 傳回 `{ lines, fixes }`，`fixes` 是每行對應的 tracker 寫入（給 `--apply`，參數形式同 `gh issue`）。
 */
export function parentFixes(issues, repo) {
  const label = new Map();
  const reopen = new Map();
  const checkLabels = (n, labels) => {
    const names = labels.nodes.map(({ name }) => name);
    const triage = TRIAGE_STATES.filter(name => names.includes(name));
    if (!names.includes('parent') || triage.length) label.set(n, { n, args: ['edit', String(n), '--add-label', 'parent', ...triage.flatMap(name => ['--remove-label', name])] });
  };
  for (const issue of issues) {
    if (issue.subIssuesSummary?.total > 0) checkLabels(issue.number, issue.labels);
    const { parent } = issue;
    if (parent?.state !== 'CLOSED' || parent.repository?.nameWithOwner !== repo) continue;
    reopen.set(parent.number, { n: parent.number, args: ['reopen', String(parent.number)] });
    if (parent.labels) checkLabels(parent.number, parent.labels);
  }
  const sorted = (kind, items) => [...items.values()].sort((a, b) => a.n - b.n).map(item => ({ ...item, line: `${kind} ${item.n}` }));
  const all = [...sorted('PARENT_LABEL', label), ...sorted('PARENT_REOPEN', reopen)];
  return { lines: all.map(({ line }) => line), fixes: all };
}

/** 在主 checkout 跑 gh（repo 由它的 remote 決定）；stdin 一律不給。 */
function gh(checkout, ...args) {
  const result = spawnSync('gh', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} 失敗：${(result.stderr || result.error?.message || '').trim().split('\n')[0]}`);
  return result.stdout;
}

/**
 * `--apply` 的 tracker 寫入：同目錄有專案自備的 gh-tracker.mjs（auto mode 只放行它的 tracker 寫入）就經它，沒有就直接 `gh issue`；
 * 兩者參數形式相同（`edit <n> --add-label …`、`reopen <n>`），都在主 checkout 跑。失敗時傳回錯誤訊息的第一行。
 */
function trackerWrite(checkout, args) {
  const [cmd, cmdArgs] = existsSync(TRACKER) ? ['node', [TRACKER, ...args]] : ['gh', ['issue', ...args]];
  const result = spawnSync(cmd, cmdArgs, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return null;
  return `${cmd === 'node' ? 'gh-tracker' : 'gh issue'} ${args[0]} exit ${result.status ?? result.error?.code}：${(result.stderr || '').trim().split('\n')[0]}`;
}

/** `--apply`：照 PARENT_* 修正 tracker，寫入失敗的每張印 `PARENT_APPLY_FAILED <n> <錯誤>`，其他照修。 */
function applyParentFixes(checkout, fixes) {
  return fixes.flatMap(({ n, args }) => {
    const error = trackerWrite(checkout, args);
    return error ? [`PARENT_APPLY_FAILED ${n} ${error}`] : [];
  });
}

/**
 * 主 checkout 所在 repo 開著的 Issue 的 DEPS_PROSE 與 PARENT_* 行（同一次查詢），以及 PARENT_* 對應的 tracker 寫入（不在這裡寫）；
 * gh 失敗時只有一行 DEPS_PROSE_FAILED，不中斷其他檢查。
 */
export function trackerLines(checkout) {
  try {
    const repo = gh(checkout, 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
    const [owner, name] = repo.split('/');
    const issues = [];
    for (let cursor = null, more = true; more;) {
      const page = JSON.parse(gh(checkout, 'api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, ...(cursor ? ['-f', `cursor=${cursor}`] : []), '-f', `query=${TRACKER_QUERY}`)).data.repository.issues;
      issues.push(...page.nodes);
      ({ hasNextPage: more, endCursor: cursor } = page.pageInfo);
    }
    const { lines, fixes } = parentFixes(issues, repo);
    return { lines: [...depsProse(issues, repo), ...lines], fixes };
  } catch (error) {
    return { lines: [`DEPS_PROSE_FAILED ${error.message}`], fixes: [] };
  }
}

/**
 * 解析 batch checkpoint：`current:`、成員表格、最後一行 `regression: <sha>` 的 SHA，
 * 與合入的 SHA（`current: merged|pushed <sha>`，沒有就取 regression 的 SHA）。
 */
export function parseBatch(text) {
  const current = text.match(/^current:\s*(.*)$/m)?.[1].trim() ?? '';
  const regression = [...text.matchAll(/^regression: ([0-9a-f]{7,40})\b/gm)].at(-1)?.[1];
  const sha = current.match(/^(?:merged|pushed) ([0-9a-f]{7,40})\b/)?.[1] ?? regression;
  const members = [];
  for (const line of text.split('\n')) {
    const cells = tableCells(line);
    if (cells.length < 8 || !/^\d+$/.test(cells[0])) continue;
    const [n, branch, worktree, handle, started, stuckAfter, state, candidate] = cells;
    members.push({ n, branch, worktree, handle, started, stuckAfter, state, candidate });
  }
  return { current, members, regression, sha };
}

/**
 * terminal 畫面裡這個 worker 的結果行：取最後一行 `DONE <n> <sha>` 或 `STOP <n> <cause>`。
 * TUI 畫框線時行首、行尾會帶 `│` 與空白，行首也可能是 Claude Code 的 bullet（`●`、`⏺`、`⎿`），比對前先去掉。
 */
export function resultLine(tail, n) {
  for (const raw of [...tail].reverse()) {
    const line = raw.replace(/^[\s│●⏺⎿]+|[\s│]+$/g, '');
    const done = line.match(new RegExp(`^DONE ${n} ([0-9a-f]{7,40})$`));
    if (done) return `DONE ${done[1]}`;
    const stop = line.match(new RegExp(`^STOP ${n} (.+)$`));
    if (stop) return `STOP ${stop[1]}`;
  }
  return null;
}

/** 一個 running 成員的狀態行（不含 `WORKER <n> ` 前綴）。`ctx.cli` 缺省時（沒有 ORCA_CLI_COMMAND）讀不到 terminal。 */
export async function workerState(ctx, member, now = Date.now()) {
  if (!ctx.cli) return 'STUCK no-orca';
  let terminal;
  try {
    terminal = (await orca(ctx, 'terminal', 'read', '--terminal', member.handle, '--screen')).terminal ?? {};
  } catch (error) {
    return `STUCK orca ${error.message}`;
  }
  const result = resultLine(terminal.tail ?? [], member.n);
  if (result) return result;
  if (terminal.status === 'exited') return 'STUCK exited';
  const started = Date.parse(member.started);
  if (Number.isNaN(started)) return `STUCK checkpoint started ${member.started}`;
  const limit = member.stuckAfter.match(/^(\d+)m$/)?.[1];
  if (!limit) return `STUCK checkpoint stuck-after ${member.stuckAfter}`;
  const minutes = Math.floor((now - started) / 60000);
  return minutes > Number(limit) ? `STUCK stuck-after ${minutes}` : `RUNNING ${minutes}`;
}

/**
 * 還沒進 origin/<主分支> 的 `merged` batch：Push gate 的前提是整合分支的 tip 等於最後一次 Regression SHA。
 * 符合時 coordinator 從 Push gate 第 1 步接著做；Integrate 之後又有 commit、或沒有 regression 行時，直接推會送出沒驗過的內容。
 */
function mergedNotInMain(checkout, integration, key, regression) {
  const passed = regression && rev(checkout, `${regression}^{commit}`);
  if (!passed) return `NOT_IN_MAIN ${key} no-regression`;
  const tip = rev(checkout, `refs/heads/${integration}`);
  return tip === passed ? `RESUME_PUSH ${key}` : `NOT_IN_MAIN ${key} tip ${tip.slice(0, 7) || 'none'}`;
}

/**
 * `--apply`：把這一輪讀到的結果寫回成員列。重讀檔案，只認號碼相同、state 還是 running 的那一列，
 * 以 `|` 切開後只換 state 與 candidate 兩格（其他格與其他行的 byte 都不動）；DONE 寫 `done` 與 SHA，STOP 寫 `stop`、candidate 不動。
 * 寫完再讀一次比對，傳回沒寫進去的 APPLY_MISS 行（手寫 sed 對不到列時沒有輸出也沒報錯，coordinator 的 retro）。
 */
export function applyResults(file, key, results) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const misses = [];
  const written = [];
  for (const { n, state, sha } of results) {
    const rows = lines.flatMap((line, i) => {
      const cells = tableCells(line);
      return cells.length >= 8 && cells[0] === n && cells[6] === 'running' ? [i] : [];
    });
    if (rows.length !== 1) { misses.push(`APPLY_MISS ${key} ${n} rows ${rows.length}`); continue; }
    // `split('|')` 的第 0 段是行首 `|` 之前的空字串，所以 tableCells 的第 6、7 格（state、candidate）在這裡是第 7、8 段。
    const parts = lines[rows[0]].split('|');
    parts[7] = ` ${state} `;
    if (sha) parts[8] = ` ${sha} `;
    lines[rows[0]] = parts.join('|');
    written.push({ n, state, sha });
  }
  if (!written.length) return misses;
  writeFileSync(file, lines.join('\n'));
  const { members } = parseBatch(readFileSync(file, 'utf8'));
  for (const { n, state, sha } of written) {
    if (!members.some(m => m.n === n && m.state === state && (!sha || m.candidate === sha))) misses.push(`APPLY_MISS ${key} ${n} verify`);
  }
  return misses;
}

/**
 * dispatched batch 的 stage 判斷（#163）。`active` 是沒有 moved 的成員，`results` 是這一輪剛讀到的 DONE／STOP（還記成 running 的列以它為準）。
 * 還有 running 時不印；每個成員都 done 印 STAGEABLE；有 done 也有其他狀態（stop、parked）印 MOVE <key> <其他成員…>，先移走它們才 stage；
 * 沒有 done 印 PARKED <key> <n…>（pilot-land 對它只會 STOP member）。
 */
export function stageLines(key, active, results) {
  const states = active.map(m => ({ n: m.n, state: (m.state === 'running' && results.find(r => r.n === m.n)?.state) || m.state }));
  if (!states.length || states.some(m => m.state === 'running')) return [];
  const others = states.filter(m => m.state !== 'done').map(m => m.n);
  if (!others.length) return [`STAGEABLE ${key}`];
  return others.length < states.length ? [`MOVE ${key} ${others.join(' ')}`] : [`PARKED ${key} ${others.join(' ')}`];
}

/**
 * 沒關的 batch 裡 `parked after #<m>` 的成員：#m 以 done 留在已經 `closed`（合入並收尾）的 batch 時印 UNPARK <n>（#163）。
 * #m 被移走的舊 batch（`closed moved`）裡那一列是 moved、batch 關了卻沒合入的那一列是 stop，都不算。
 */
export function unparkLines(batches) {
  const closedMembers = new Set(batches.filter(b => /^closed\b/.test(b.current))
    .flatMap(b => b.members.filter(m => m.state === 'done').map(m => m.n)));
  return batches.filter(b => !/^closed\b/.test(b.current)).flatMap(b => b.members)
    .filter(m => closedMembers.has(m.state.match(/^parked after #(\d+)\b/)?.[1]))
    .map(m => `UNPARK ${m.n}`);
}

/** `--apply`：已進 origin/<主分支> 的 `merged` batch 改成 `pushed`，SHA 與附註照留（Push gate 印 LANDED 之後沒人寫，coordinator 的 retro）。 */
function applyPushed(file, key) {
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^(current:[ \t]*)merged\b/m, '$1pushed'));
  return /^pushed\b/.test(parseBatch(readFileSync(file, 'utf8')).current) ? [] : [`APPLY_MISS ${key} current verify`];
}

/** 一行一個 `- **<名稱>.**` 的條目（adapter 的 Pilot 設定就是這種格式）。 */
const ENTRY = /^- \*\*(.+?)\.\*\*/;

/**
 * 第 `i` 行（0 起算）所在的條目名稱：往上找到 `- **<名稱>.**` 那一行為止，中間只能是空行或縮排的續行；
 * 先碰到其他不縮排的行（標題、段落、別的 bullet）或檔頭時回 null。
 */
function entryAt(lines, i) {
  for (let j = Math.min(i, lines.length - 1); j >= 0; j--) {
    const name = lines[j].match(ENTRY)?.[1];
    if (name) return name;
    if (lines[j].trim() && !/^\s/.test(lines[j])) return null;
  }
  return null;
}

/**
 * `from..to` 改了哪些檔：Map<檔案, { whole, entries }>。`.md` 檔的改動行（空行不算）都落在條目裡時只記條目名稱
 * （刪掉的行看 from 的版本、加上的行看 to 的版本），有任何一行不在條目裡，或不是 `.md`，就記整個檔（whole）。
 * `to` 是 null 時比 `checkout` 的工作樹（含暫存區與未追蹤、沒被 ignore 的新檔；worktree-overlap 用，#194）。
 * `paths` 只比這些檔；`adjacent`（預設開）把緊鄰改動、git 合併時會一起衝突的條目也算進去，只想知道改了哪些條目時關掉。
 */
export function changedUnits(checkout, from, to, { paths = [], adjacent = true } = {}) {
  const run = (...args) => {
    const result = git(checkout, ...args);
    if (result.status !== 0) throw new Error(`git ${args[0]} exit ${result.status}：${result.stderr.trim()}`);
    return result.stdout;
  };
  const refs = to === null ? [from] : [from, to];
  const names = text => text.split('\0').filter(Boolean);
  const untracked = new Set(to === null ? names(run('ls-files', '-z', '--others', '--exclude-standard', '--', ...paths)) : []);
  const after = path => {
    if (to !== null) return show(checkout, to, path);
    const file = join(checkout, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const units = new Map();
  const changed = names(run('diff', '--name-only', '-z', '--no-renames', ...refs, '--', ...paths));
  for (const path of untracked.size ? [...changed, ...untracked].sort() : changed) {
    const unit = { whole: !path.endsWith('.md'), entries: new Set() };
    units.set(path, unit);
    if (unit.whole) continue;
    const versions = { '-': show(checkout, from, path).split('\n'), '+': after(path).split('\n') };
    // 未追蹤的新檔沒有 diff 可讀，整份都是加上的行。
    const hunks = untracked.has(path) ? `@@ -0,0 +1,${versions['+'].length} @@`
      : run('diff', '-U0', '--no-color', '--no-renames', '--diff-algorithm=histogram', ...refs, '--', path);
    for (const [, oldStart, oldCount = '1', newStart, newCount = '1'] of hunks.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      for (const [side, start, count] of [['-', oldStart, oldCount], ['+', newStart, newCount]]) {
        for (let i = Number(start) - 1; i < Number(start) - 1 + Number(count); i++) {
          if (!versions[side][i]?.trim()) continue;
          const name = entryAt(versions[side], i);
          if (name) unit.entries.add(name);
          else unit.whole = true;
        }
      }
      if (!adjacent) continue;
      // git 照位置合併：改到相接的行、或在同一處插入也會衝突，所以 from 那邊緊鄰 hunk 前後的行所在的條目也算。
      // 空行不算（中間隔著沒人改的空行就不會衝突）；純插入的前後都是空行或檔尾時，才往上找插入點所在的條目，同一處的插入才對得上。
      const old = versions['-'];
      const [start, count] = [Number(oldStart), Number(oldCount)];
      // `-<行>,<n>` 的 hunk 佔 0 起算的 start-1 到 start+n-2；n 是 0 時是插在第 start 行之後。
      const around = count ? [start - 2, start + count - 1] : [start - 1, start];
      const anchors = around.filter(i => i >= 0 && old[i]?.trim()).map(i => entryAt(old, i));
      if (!count && !anchors.length && around[0] >= 0) anchors.push(entryAt(old, around[0]));
      for (const name of anchors) if (name) unit.entries.add(name);
    }
  }
  return units;
}

/** 兩組改動重疊的地方：`[{ path, entries }]`；同一個檔有一邊改了整個檔時 entries 是空的，否則是兩邊都改的條目（沒有就不算重疊）。 */
function overlapUnits(a, b) {
  const out = [];
  for (const [path, unit] of a) {
    const other = b.get(path);
    if (!other) continue;
    const entries = unit.whole || other.whole ? [] : [...unit.entries].filter(name => other.entries.has(name));
    if (unit.whole || other.whole || entries.length) out.push({ path, entries });
  }
  return out;
}

/** 重疊的地方一處一筆：同一個檔有一邊改了整個檔時是檔名，否則是兩邊都改的每個條目 `<檔案>:<條目>`（pilot-dispatch 的 STOP overlap 用）。 */
const overlaps = (a, b) => overlapUnits(a, b).flatMap(({ path, entries }) => entries.length ? entries.map(name => `${path}:${name}`) : [path]);

/** 一對的 OVERLAP 行（#176）：`OVERLAP <n> <m|integration> <檔案數> files [**<條目>.**…]`，沒有重疊時 undefined。 */
function overlapLine(n, m, a, b) {
  const found = overlapUnits(a, b);
  if (!found.length) return undefined;
  const entries = [...new Set(found.flatMap(({ entries }) => entries))].map(name => `**${name}.**`);
  return ['OVERLAP', n, m, found.length, 'files', ...entries].join(' ');
}

/** 重疊比對的 base：整合分支，沒有時主分支；兩個都沒有傳回 undefined。 */
const overlapOnto = (checkout, { integration = 'pilot/integration', main = 'main' } = {}) =>
  [`refs/heads/${integration}`, `refs/heads/${main}`].find(ref => rev(checkout, ref));

/** 分支已 commit 的內容相對於與 `onto` 的 merge-base 改了哪些檔或條目：`{ base, units }`；本機沒有這個分支或沒有共同祖先時傳回 undefined。 */
function branchUnits(checkout, onto, branch) {
  const tip = branch && rev(checkout, `refs/heads/${branch}`);
  if (!tip) return undefined;
  const base = git(checkout, 'merge-base', tip, onto);
  if (base.status > 1) throw new Error(`git merge-base ${branch} exit ${base.status}：${base.stderr.trim()}`);
  if (base.status) return undefined;
  return { base: base.stdout.trim(), units: changedUnits(checkout, base.stdout.trim(), tip) };
}

/** 開著的 batch（current 不是 closed）裡 running 或 done 的成員列，同一個 Issue 只取第一列。 */
function activeMembers(batches) {
  const seen = new Map();
  for (const { current, members: rows } of batches) {
    if (/^closed\b/.test(current)) continue;
    for (const m of rows) if (['running', 'done'].includes(m.state) && !seen.has(m.n)) seen.set(m.n, m);
  }
  return [...seen.values()].sort((a, b) => Number(a.n) - Number(b.n));
}

/**
 * 開著的 batch（current 不是 closed）裡 running 或 done 的成員分支（只看已 commit 的內容），各自相對於與整合分支的 merge-base 改了哪些檔或條目：
 * 兩個成員改到同一處印 `OVERLAP <n> <m> <檔案數> files [**<條目>.**…]`（號碼小的在前），成員改的地方整合分支自那個 merge-base 以來也改過印
 * `OVERLAP <n> integration <檔案數> files [**<條目>.**…]`。同一對只印一行（#176）：檔案數算兩邊都改的檔，後面列重疊細到條目的那些條目名稱
 * （去重、依出現順序）；本機沒有那個分支的成員略過；沒有整合分支時改用主分支當 base，兩個都沒有就不比。
 */
export function overlapLines(checkout, batches, options = {}) {
  const onto = overlapOnto(checkout, options);
  if (!onto) return [];
  const sorted = activeMembers(batches).map(m => [m.n, branchUnits(checkout, onto, m.branch)]).filter(([, units]) => units);
  const out = [];
  sorted.forEach(([n, a], i) => {
    for (const [m, b] of sorted.slice(i + 1)) out.push(overlapLine(n, m, a.units, b.units));
  });
  const integrationUnits = new Map();
  for (const [n, { base, units }] of sorted) {
    if (!integrationUnits.has(base)) integrationUnits.set(base, changedUnits(checkout, base, onto));
    out.push(overlapLine(n, 'integration', units, integrationUnits.get(base)));
  }
  return out.filter(Boolean);
}

/**
 * 派工前的重疊（pilot-dispatch.mjs，#174）：成員 `n` 的分支 `branch` 和 `<checkout>/.scratch/pilot/` 開著的 batch 裡其他 running、done 成員，
 * 照 overlapLines 的同一套比法兩兩比對。傳回 `[{ m, where: [<檔案>[:<條目>]…] }]`，依號碼排序；本機沒有 `branch`（還沒派過）時是空的。
 */
export function memberOverlaps(checkout, n, branch, options = {}) {
  const onto = overlapOnto(checkout, options);
  const mine = onto && branchUnits(checkout, onto, branch);
  if (!mine) return [];
  const pilot = join(checkout, '.scratch/pilot');
  const batches = batchFiles(pilot).map(file => parseBatch(readFileSync(join(pilot, file), 'utf8')));
  const out = [];
  for (const m of activeMembers(batches)) {
    if (m.n === String(n)) continue;
    const other = branchUnits(checkout, onto, m.branch);
    const where = other ? overlaps(mine.units, other.units) : [];
    if (where.length) out.push({ m: m.n, where });
  }
  return out;
}

/** 經過的時間：`<h>h<m>m` 或 `<m>m`；時間解析不了時 `?`。 */
function age(time, at) {
  const minutes = Math.floor((at - Date.parse(time)) / 60000);
  if (Number.isNaN(minutes)) return '?';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

/**
 * `--status`：status.md 的內容（PILOT-STORE.md）。沒關的 batch 與成員、開著的 gate（id、Issue、開了多久）、開著的 request、
 * origin/<主分支>、<主分支>、<整合分支> 的 SHA（本機的 ref，origin 是最後一次 fetch 的結果）。
 */
export function statusReport(checkout, { integration = 'pilot/integration', main = 'main' } = {}, at = new Date()) {
  const pilot = join(checkout, '.scratch/pilot');
  const coordinator = readStore(pilot, 'coordinator').match(/^pid \d+\b.*\bname (.+)$/m)?.[1].trim() ?? '(none)';
  const out = [`# pilot status（${now(at)}，coordinator ${coordinator}）`, ''];
  let open = 0;
  for (const file of batchFiles(pilot)) {
    const { current, members } = parseBatch(readFileSync(join(pilot, file), 'utf8'));
    if (/^closed\b/.test(current)) continue;
    open++;
    out.push(`- batch ${file.slice('batch-'.length, -'.md'.length)}：${current || '(沒有 current:)'}`);
    for (const m of members) out.push(`  - #${m.n} ${m.state}${m.candidate ? ` ${/^[0-9a-f]{7,40}$/.test(m.candidate) ? m.candidate.slice(0, 7) : m.candidate}` : ''}`);
  }
  if (!open) out.push('- 沒有開著的 batch');
  const gates = openGates(readStore(pilot, 'gates.md'));
  for (const gate of gates) {
    const title = gate.issue && !gate.title.startsWith(gate.issue) ? `${gate.issue} ${gate.title}` : gate.title;
    out.push(`- gate ${gate.id} ${title}（開了 ${age(gate.opened, at)}）`);
  }
  if (!gates.length) out.push('- 沒有開著的 gate');
  const requests = openRequests(pilot);
  for (const line of requests) out.push(`- request ${line}`);
  if (!requests.length) out.push('- 沒有開著的 request');
  for (const [name, ref] of [[`origin/${main}`, `refs/remotes/origin/${main}`], [main, `refs/heads/${main}`], [integration, `refs/heads/${integration}`]]) {
    out.push(`- ${name} ${rev(checkout, ref).slice(0, 7) || 'none'}`);
  }
  return `${out.join('\n')}\n`;
}

export async function probe(ctx, checkout, { integration = 'pilot/integration', main = 'main', apply = false, status = false, capacity } = {}) {
  const pilot = join(checkout, '.scratch/pilot');
  const tracker = trackerLines(checkout);
  const out = [...checkoutState(checkout, main), ...adapterAhead(checkout, { integration, main }), ...openRows(pilot), ...tracker.lines];
  if (apply) out.push(...applyParentFixes(checkout, tracker.fixes));
  const landing = [];
  const batches = [];
  let running = 0;
  for (const file of batchFiles(pilot)) {
    const key = file.slice('batch-'.length, -'.md'.length);
    const { current, members, regression, sha } = parseBatch(readFileSync(join(pilot, file), 'utf8'));
    batches.push({ key, current, members });
    const active = members.filter(m => !/^moved\b/.test(m.state));
    const results = [];
    for (const member of members.filter(m => m.state === 'running')) {
      const state = await workerState(ctx, member);
      const [, kind, value] = state.match(/^(DONE|STOP) (.+)$/) ?? [];
      if (kind) results.push({ n: member.n, state: kind === 'DONE' ? 'done' : 'stop', sha: kind === 'DONE' ? value : undefined });
      else running++;
      out.push(`WORKER ${member.n} ${state}`);
    }
    if (apply && results.length) out.push(...applyResults(join(pilot, file), key, results));
    if (/^dispatched\b/.test(current)) out.push(...stageLines(key, active, results));
    if (/^(merged|pushed)\b/.test(current)) landing.push({ key, sha, regression, merged: /^merged\b/.test(current) });
  }
  out.push(...unparkLines(batches));
  out.push(...overlapLines(checkout, batches, { integration, main }));
  if (landing.length) {
    const fetch = git(checkout, 'fetch', '-q', 'origin');
    if (fetch.status !== 0) out.push(`FETCH_FAILED ${fetch.stderr.trim().split('\n').find(line => line.startsWith('fatal:')) ?? fetch.stderr.trim().split('\n')[0]}`);
    else for (const { key, sha, regression, merged } of landing) {
      if (!sha) out.push(`NOT_IN_MAIN ${key} no-sha`);
      else if (git(checkout, 'merge-base', '--is-ancestor', sha, `origin/${main}`).status === 0) {
        out.push(`IN_MAIN ${key}`);
        if (apply && merged) out.push(...applyPushed(join(pilot, `batch-${key}.md`), key));
      } else out.push(merged ? mergedNotInMain(checkout, integration, key, regression) : `NOT_IN_MAIN ${key}`);
    }
  }
  if (capacity) {
    const { total, cap } = report(ledgerPath(), capacity, running);
    if (total > cap) out.push(`OVER_CAP ${total} ${cap}`);
  }
  if (status) {
    mkdirSync(pilot, { recursive: true });
    writeFileSync(join(pilot, 'status.md'), statusReport(checkout, { integration, main }));
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const cli = process.env.ORCA_CLI_COMMAND;
  const positional = [];
  const options = {};
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const flag = { '--apply': 'apply', '--status': 'status' }[args[i]];
    if (flag) {
      if (flag in options) bad = true;
      options[flag] = true;
      continue;
    }
    const name = { '--integration': 'integration', '--main': 'main', '--capacity': 'capacity' }[args[i]];
    const value = args[++i];
    if (!name || !value || value.startsWith('--') || name in options) bad = true;
    else options[name] = value;
  }
  const [checkout] = positional;
  if (bad || positional.length !== 1 || ('capacity' in options && (!validRepo(options.capacity) || machineCap() === undefined))) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const out = await probe({ cli }, checkout, options);
    for (const line of out) console.log(line);
    if (out.some(line => /^(APPLY_MISS|PARENT_APPLY_FAILED) /.test(line))) process.exit(1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
