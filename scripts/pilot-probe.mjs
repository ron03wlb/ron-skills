#!/usr/bin/env node
// setup-workflow 正本（#58）：pilot 的 Reconcile 用這一支對帳。主 checkout、`.scratch/pilot/` 的請求、gate、batch checkpoint、
// 每個 running 成員的 terminal 與 tracker 上的母單，各印一行狀態，不必再手動拼 `orca terminal read` 的 JSON（手拼時漏過 exited 卻沒有結果行的 worker）。
// 存檔格式照 issue-pilot 的 PILOT-STORE.md；專案不同的值由參數傳入。
//
// 用法：node scripts/pilot-probe.mjs <主 checkout> [--integration <分支>] [--main <分支>] [--apply] [--status] [--capacity <repo>] [--skip-labels <label>,...]
//   --integration 整合分支，預設 pilot/integration；--main 主分支，預設 main。讀 running 成員要 ORCA_CLI_COMMAND，沒有時其他檢查照跑。
//   --skip-labels：adapter 宣告的「不進分級的 label」（逗號分隔，同 issue-pool.mjs 的 --skip-labels，#326）：掛著的單與 retro-candidates 一樣，
//            不進 POOL_READY／POOL_TRIAGE／COUNTERPART_BARE 的 ready 桶，也不算 DEPS_PROSE「最後做」的新單。沒帶時只有內建的 retro-candidates、parent。
//   --apply：把這一輪讀到的 `WORKER <n> DONE <sha>`、`STOP <cause>` 寫回 batch checkpoint 的成員列（state `done` 與 candidate SHA、
//            state `stop`），只改那一列的這兩欄；`merged` 的 batch 印 IN_MAIN 時把 `current: merged` 改成 `pushed`（SHA 與附註不動）。
//            對不到唯一一列 running 的成員列時不寫檔，印 APPLY_MISS <key> <n> rows <列數>；寫回後再讀一次沒對上時印 APPLY_MISS <key> <n|current> verify
//            （檔案已經寫了，不還原）；有 APPLY_MISS 就 exit 1。
//            母單：PARENT_LABEL 補上 `parent` label、移除它掛著的 triage label，PARENT_REOPEN 重開母單；同目錄有 setup-workflow 的 gh-tracker.mjs 副本
//            （`edit <n> --add-label …`、`reopen <n>`，參數同 `gh issue`）時經它寫，沒有就直接跑 `gh issue`，都在主 checkout 跑。
//            寫入失敗印 PARENT_APPLY_FAILED <n> <錯誤>，其他母單照修，exit 1。
//   --status：最後從 checkpoint、gates.md、requests.md、coordinator 與 git 重寫 `.scratch/pilot/status.md`（格式見 PILOT-STORE.md），不印任何行；
//            batch 那行附最後一行 regression 的結果（`，regression <sha 前 7 碼> exit <code 或 none>`，staged 而沒有 regression 行時 `，regression none`）。
//   --capacity <repo>（#178）：把這一輪還在跑的成員數（各 batch 的 running 列，扣掉這一輪讀到 DONE、STOP 的）以 <repo> 寫進全機帳本
//            （同目錄 pilot-capacity.mjs 的 report：$PILOT_WORKERS_LEDGER，預設 ~/.local/state/pilot-workers.tsv）；所有 repo 的合計超過
//            $PILOT_MACHINE_WORKER_CAP（預設 4）時最後印 OVER_CAP <合計> <上限>。只回報，不改派工；沒帶時不碰帳本。
//            $PILOT_MACHINE_WORKER_CAP 空白時在這之前印 CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP，照預設 4 算（#396）。
//            <repo> 空白或帶 tab、換行，或上限不是正整數時是用法錯誤（exit 2）。
//   --tail <handle> [--lines <n>]（取代主 checkout 引數，只做這件事）：印那個 worker 分頁畫面的最後 n 行（預設 40），給 Watch 用，不必手拼 JSON 或依賴 jq（#295）；
//            沒有 ORCA_CLI_COMMAND 或讀不到時 stderr 說明、exit 1。
//   --apply、--status 都不改其他輸出行，stdout 與不帶旗標時相同（APPLY_MISS、PARENT_APPLY_FAILED 除外）。
//   Bare guard：同目錄有 pilot-unbare.sh（setup-workflow 正本，`<checkout> <時機>`，還原時印 UNBARE）時先跑它（時機 probe），沒有就略過。
// stdout 每行一項，沒事的項目不印（全部正常且沒有 batch 時只印池子那一行）：
//   主 checkout：UNBARE <checkout>（Bare guard 剛還原 core.bare）｜NOT_MAIN <分支>｜HOLD｜DIRTY <git status --short 的一行>
//   adapter：ADAPTER_AHEAD <檔案> [<名稱>[,<名稱>…]] ｜ mkdir -p <主 checkout>/.scratch/pilot/adapter && [git -C <主 checkout> fetch <remote> <分支> && ]
//            git -C <主 checkout> show <adapter ref>:<檔案> > <主 checkout>/.scratch/pilot/adapter/<檔名>（adapter ref 上的 adapter 比主分支新；
//            adapter ref 是主分支那份 adapter 的 Pilot 段與它連到的檔裡 `- **Adapter ref.**` 條目的第一個反引號值，沒有時是 --integration 的本機分支；
//            以已設定的 remote 名稱加 `/` 開頭時是遠端 ref：probe 先 `git fetch <remote> <分支>` 再比 refs/remotes/<ref>，失敗時印 FETCH_FAILED adapter-ref <錯誤>、照上次 fetch 的 ref 比，
//            指令也先 fetch（#333：本機 develop 落後 origin 9 個 commit）；SCRIPT_AHEAD 仍比本機整合分支（run-in 跑 stage worktree 的檔）：
//            docs/agents/issue-run.md 只在 `## Pilot` 段變動時算（#357：Review、Permissions 段的改動不影響 coordinator），不附名稱、只讀那一段；
//            它 `## Pilot` 段連到的同目錄 .md 整份都算，改動都在 `- **<名稱>.**` 條目裡時附改動的條目名稱，依名稱排序、以 `,` 分隔，名稱本身可能有空格
//            （不能有 `,` 或 `｜`）；刪掉或改名的條目也列（取改動前的名稱）；有條目以外的改動或不是 `.md` 時省略名稱欄，表示要讀整份。
//            ` ｜ ` 之後是把那份存進 scratch 檔的指令，跑完用 Read 讀存檔，不讀整份 diff，也不把 `git show` 直接印到輸出：35 KB、67 KB 會被存檔後再進 context 一次）
//   腳本（#358）：SCRIPT_AHEAD <scripts/路徑> run-in <stage worktree>｜SCRIPT_AHEAD <scripts/路徑> sync-main（有 ADAPTER_AHEAD 的那一輪，整合分支那份 adapter 的
//            Pilot 段與它連到的檔指名的 `scripts/*`（含 `.py`、`.sh`），主 checkout 工作樹缺檔或內容與整合分支不同，而且整合分支那份不比主分支舊；依路徑。
//            run-in 是分支為整合分支或 pilot/stage-* 的 worktree，在主 checkout 以 `<stage worktree>/scripts/…` 跑；那個 worktree 不存在或也沒有這個檔時是 sync-main）｜
//            HOOK_BEHIND <scripts/路徑>（主分支落後整合分支時，主分支 `.claude/settings.json` 的 hook 指令引用、整合分支內容不同而且不比主分支舊的檔；
//            依指令順序，每個檔一次：hook 跑的是主 checkout 的舊版）
//   開著的列：REQUEST <requests.md 原文>｜GATE <id> <Issue> <question 或段落標題>｜GATE_MALFORMED <id> <把 resolved 寫進別的欄位的那一行>
//   Issue 依賴：DEPS_PROSE <n> #<m>（開著的 `ready-for-agent` Issue 內文以「依賴」或先後寫法（「排在 #m 之後」「以 #m 為 blocker」「等 #m 合入」）帶出 #m，#m 還開著，blocked_by 卻沒有它；Pool 只讀 blocked_by）｜
//               DEPS_PROSE <n> last new #<m> [#<k>…]（內文寫「最後做」卻沒號碼，#m… 比 blocked_by 最新一張（空時比自己）還新、開著、不在 blocked_by，
//                 retro-candidates、母單與已在等 #n 的單不算；要等哪些由 coordinator 判斷）｜DEPS_PROSE <n> last ok（同上但沒有這種新單，不必處理）｜
//               DEPS_PROSE_FAILED <錯誤>（在主 checkout 跑 gh 失敗，其他檢查照跑；同一次查詢的 PARENT_* 也不印）
//   池子（#240，每次都印一行）：POOL_READY <n>...（ready 桶的單，照同目錄 issue-pool.mjs 的 pool() 分桶與排序，
//               略過已在開著的 batch checkpoint（current 不是 closed）成員列裡的 Issue）｜POOL_TRIAGE <n>...（沒有 ready 單、但有 needs-triage 桶的單，
//               同樣略過 batch 成員、照 pool() 的順序；#357：coordinator 要先 triage，不是閒置）｜POOL_EMPTY（兩者都沒有）｜
//               POOL_FAILED <錯誤>（同一次查詢 gh 失敗，與 DEPS_PROSE_FAILED 同一個錯誤）
//   裸對應單（#304）：COUNTERPART_BARE <n> <owner>/<repo>#<m>（主分支的 adapter 有 `Counterpart projects:` 行時，ready 桶與開著的 batch 成員裡
//               本文以 github.com 寫法（裸 ref 或 github.com 網址）寫了宣告專案的對應單：那個專案不在 github.com，Close 會 STOP counterpart；
//               判斷同 pilot-counterpart.mjs 的 --adapter，依號碼、同一張單照本文順序；沒有宣告、gh 失敗時不印）
//   等人的單（#327）：HUMAN_NO_GATE <n> <摘要>（`ready-for-human` 的單（pool() 的 human 桶）在 gates.md 沒有 Issue 欄是 #n 的開著的 gate：
//               coordinator 開 gate 問人；摘要是本文 `… prerequisite：` 那行冒號之後的文字，沒有這行時是標題；依號碼，gh 失敗時不印）｜
//               HUMAN_LANDED <n> <sha>（#358：同一個桶裡，整合分支已有它的落地 commit（issue-pool 的 landedOn）的單；依號碼，在 HUMAN_NO_GATE 之後；
//               沒有整合分支或 gh 失敗時不印）
//   blocker 範圍（#359）：BLOCKER_OPEN_SCOPE <n> #<m> <label>（blocked 桶的 #n，本 repo 開著的 blocker #m 已落地在整合分支（landedOn）、掛 ready-for-agent、
//               needs-triage 或 ready-for-human，而且 #m 不在 landed 桶（沒指派）或本文最後編輯晚於最後一次指派：#n 不算可派，`(landed …)` 只代表 #m 的舊範圍做完；
//               判斷是 issue-pool 的 blockerOpenScope，與 blocked 行同一份 blocker 資料；依 #n、blocker 順序，在 HUMAN_LANDED 之後；沒有整合分支或 gh 失敗時不印）
//   母單（#164）：PARENT_LABEL <n>（開著、或已關閉卻有開著子單的母單，沒有 `parent` label 或還掛 triage label）｜
//               PARENT_REOPEN <n>（開著的子單的母單 #n 在同一個 repo、已關閉）；各依號碼、每張一次
//   running 成員：WORKER <n> DONE <sha>｜WORKER <n> STOP <cause>｜WORKER <n> RUNNING <分鐘>｜
//                 WORKER <n> STUCK exited|stuck-after <分鐘>|orca <錯誤碼>|no-orca|checkpoint <欄位> <值>
//                 （terminal 已結束卻沒有結果行、超過 stuck-after、讀不到 terminal、沒有 ORCA_CLI_COMMAND、checkpoint 的時間欄位解析不了）
//   batch：dispatched 的 batch 沒有 running 成員時（這一輪剛讀到 DONE／STOP 的照結果算；moved（含 `moved batch-<n>`）的成員已移到別的 batch，不算）：
//          每個成員都 done 印 STAGEABLE <key>；有 done 也有 stop、parked 印 MOVE <key> <不是 done 的成員…>（先用 pilot-batch 移走）；
//          STAGEABLE 之後緊接 CONFLICT <key> <n> <m|integration> <檔…>（#376：done 成員的本機分支兩兩、再各自對整合分支（沒有時主分支）的 tip
//          以 lib/merge-tree.mjs 試合併，有衝突的每一對一行，號碼小的在前、檔依路徑排序；是 git 合併真的會衝突的檔，pilot-land 的解法
//          （restamp、--resolver）解不掉的就會 STOP conflict 在這些檔；
//          本機沒有分支的成員、git 低於 2.38 或判斷不了的一對不印）；
//          done 的成員被 gates.md 開著的 gate 以 `- hold：#<n>` hold 住（pilot-gate open --hold）時，每個先印 HELD <n> <gate id>（依成員列順序），
//          這時不印 STAGEABLE（pilot-land 會 STOP held）；MOVE 照印、排在 HELD 之後（PARKED 沒有 done 成員，不會有 HELD）；gate resolved 後恢復（#367）；
//          不是 done 的成員裡有 batch key 那張時（pilot-batch move 會 STOP same-batch，#357）改印 MOVE <key> <done 的成員…>；
//          開著的 batch 裡 stop 的成員（這一輪剛讀到 STOP 的也算）的 Issue 有 blocked_by、而且每張都已關閉時印 UNBLOCKED <key> <n>
//          （#357；gh 失敗或成員的 Issue 已關閉時不印）；
//          開著的 batch 裡 done 的成員（這一輪剛讀到 DONE 的也算）的 Issue 本文最後編輯（lastEditedAt）晚於列的 started 時印 SCOPE_CHANGED <key> <n> <edited at>
//          （#359：worker 交付的可能是開工前的範圍，Stage 前讀改了什麼；時間照 tracker 原樣，依成員列順序，在 UNBLOCKED 之後；gh 失敗、started 解析不了時不印）；
//          沒有 done 印 PARKED <key> <n…>（#163：只剩 stop 的 batch 照跑 pilot-land 只得到 STOP member）；
//          current 是 `staged <sha>` 的 batch，最後一行 regression 不是這個 staged SHA 的 exit 0 時印 RESTAGE <key> regression-failed <code 或 none>
//          （#191：Regression 沒過、batch 停在 staged，probe 卻什麼都不印；none 是沒有 regression 行、SHA 是先前那次 stage 的，或 SHA 後面沒緊接 exit <code>）；
//          其中這個 staged SHA 還沒有 regression 行、checkpoint 的 `regressing: <sha> pid <pid>` 是同一個 SHA、那個 pid 還是 pilot-land（ps 的命令列）時
//          改印 REGRESSING <key> <staged sha>（#361：land 還在跑 Regression，coordinator 等它，不重 stage）；
//          沒關的 batch 裡 `parked after #<m>` 的成員，在 #m 以 done 留在 `closed` 的 batch 之後印 UNPARK <n>；
//          current 是 merged／pushed 的 batch 在 git fetch 後比 origin/<主分支>，印 IN_MAIN <key>｜NOT_IN_MAIN <key>（no-sha：checkpoint 沒有 SHA）｜FETCH_FAILED <錯誤>；
//          還沒進 origin/<主分支> 的 merged batch 改印 RESUME_PUSH <key>（整合分支的 tip 等於最後一次 regression SHA，且那一行是 exit 0），
//          不符合時印 NOT_IN_MAIN <key> no-regression（沒有 regression 行或 SHA 解析不到）｜NOT_IN_MAIN <key> regression-failed <code 或 none>
//          （#130：最後一行 regression 的 exit 不是 0，或 SHA 後面沒緊接 exit <code>）｜NOT_IN_MAIN <key> tip <tip 前 7 碼或 none>
//          gates.md 有開著的 gate 的 parked 以 `all-push` 開頭（擋住所有 push）時，上面所有 NOT_IN_MAIN／RESUME_PUSH 合成一行
//          PUSH_PARKED <gate id> <batch 數> batches（多個這種 gate 取第一個：表格列先於 `## G<n>` 段落，各照檔案順序；IN_MAIN、FETCH_FAILED 照印；#136）；
//          沒有這種 gate、而 main 暫停旗標有效（`.scratch/pilot/main-paused`，`pilot-hold.mjs set-main <reason> --until <YYYY-MM-DD>` 寫，until 當天仍有效；
//          判斷是 issue-pool 的 mainPause，過期、讀不懂或沒有時照印各行）時，RESUME_PUSH、NOT_IN_MAIN <key>、NOT_IN_MAIN <key> tip … 合成一行
//          MAIN_PAUSED <reason> until <date> pending <key>...（依 batch 順序；no-sha、no-regression、regression-failed 照印；#379）
//   重疊：OVERLAP <n> <m|integration> <檔案數> files [**<條目>.**…]（開著的 batch 裡 running、done 的成員分支已 commit 的內容，相對於與整合分支的 merge-base：
//          兩個成員改到同一個檔，或整合分支自成員的 merge-base 以來也改了它改的檔；`.md` 檔的改動都在 `- **<名稱>.**` 條目裡時細到條目，
//          相接的行與同一處的插入也算，git 合併時會衝突；同一對只印一行，後面列重疊的條目名稱，#176：條目不帶檔名、不同檔的同名條目只列一次，
//          名稱可能有空格，以 `**`…`.**` 切分；數量固定寫 files，1 也是）
//   預算：BUDGET <檔案> <合計> <上限> <成員…>（#398：整合分支（沒有時主分支）上 scripts/adapter-size-budget.json 列的檔，整合分支的大小加上
//          同一批成員已 commit 的增量超過上限時印，列出讓它變大的成員；沒有預算表不印，表不是 { 路徑: 正整數 } 時 exit 1）
//   落後主分支：BEHIND_MAIN <落後數> <origin/主分支 SHA>（整合分支沒有包含 origin/<主分支>，例如 retro 直接合進主分支之後；
//          比的是本機最後一次 fetch 的 origin ref，有 merged／pushed 的 batch 時在這一輪的 fetch 之後比；兩個 ref 有一個不存在時不印。
//          #268：沒有這一行時 coordinator 要自己算 rev-list 才知道要 sync-main，漏掉就在舊 tip 上 stage，到 Push gate 才 STOP behind-main）
//   Memory audit（#347）：MEMORY_AUDIT_DUE <天數|?>d last=<YYYY-MM-DD|none> → node scripts/memory-audit.mjs --run（主分支的 adapter 或它 Pilot 段連到的檔
//          宣告 `Memory audit days: <n>`，而 .scratch/pilot/memory-audit.md 最後一筆距今 n 天以上或沒有紀錄；判斷是同目錄 memory-audit.mjs 的 memoryAuditLine；
//          沒宣告時不印；在 BEHIND_MAIN 之後）
//   全機上限：CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP、OVER_CAP <合計> <上限>（帶 --capacity 時，見上）
// exit：0 印完；2 用法錯誤；3 `--apply` 的 checkpoint 鎖等到逾時（印 `CHECKPOINT_LOCKED <lock> <持鎖內容>`，該 batch 沒寫、其他行照印，#345）；1 其他失敗（Bare guard 或 git status 失敗、APPLY_MISS、PARENT_APPLY_FAILED 等）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changedUnits } from './lib/changed-units.mjs';
import { mergeConflicts } from './lib/merge-tree.mjs';
import { CheckpointLocked, gateLines, heldIssues, isOpenRequest, landAlive, now, openGates, parksAllPush, regressingMark, tableCells, updateCheckpoint } from './lib/pilot-store.mjs';
import { orca } from './orca-session-send.mjs';
import { envMissingLines, ledgerPath, machineCap, report, validRepo } from './pilot-capacity.mjs';
import { POOL_FIELDS, blockerOpenScope, landedOn, mainPause, pool, prerequisiteOf } from './issue-pool.mjs';
import { counterparts, declaredProjects } from './pilot-counterpart.mjs';
import { MEMORY_AUDIT_FILE, declaredDays, memoryAuditLine } from './memory-audit.mjs';

// 池子摘要要的欄位取 issue-pool 的 POOL_FIELDS（#240）；同名的 blockedBy 在 GraphQL 裡合併成一份選取。
const TRACKER_QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{${POOL_FIELDS} body createdAt lastEditedAt blockedBy(first:50){nodes{createdAt}} parent{number state repository{nameWithOwner} labels(first:50){nodes{name}}}}}}}`;
const USAGE = '用法：node scripts/pilot-probe.mjs <主 checkout> [--integration <分支>] [--main <分支>] [--apply] [--status] [--capacity <repo>] [--skip-labels <label>,...]｜node scripts/pilot-probe.mjs --tail <handle> [--lines <n>]';
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

/** Bare guard：同目錄有 pilot-unbare.sh（setup-workflow 正本）才跑（Orca 從 WSL 操作 worktree 會把主 checkout 設成 bare），傳回它印的行。 */
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
export const ADAPTER = 'docs/agents/issue-run.md';

/** adapter 的 `## Pilot` 段（標題之後到下一個 `## ` 標題或檔尾）；沒有這一段時是空字串。coordinator 只讀這一段與它連到的檔（#357）。 */
export const pilotSection = text => text.match(/^## Pilot[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';

/**
 * adapter 的 `## Pilot` 段連到的同目錄 `.md`（Pilot 段指向自己的檔案時，那份也是 adapter，見 issue-pilot SKILL 的 Sources）。
 * 其他目錄的連結（skill、契約）與其他段落的連結都不算。
 */
export function pilotFiles(text) {
  const section = pilotSection(text);
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
 * 整合分支那份 `path` 不比主分支舊：主分支最後一次改它的 commit 已經在整合分支裡（主分支從沒有這個檔也算）。
 * 主分支自己改過、整合分支還沒跟上，或兩邊都改過（歷史分岔、分不出誰新）時是 false。`ahead`、`base` 是完整的 ref。
 */
function integrationNewer(checkout, ahead, base, path) {
  const touched = git(checkout, 'log', '-1', '--format=%H', base, '--', path);
  if (touched.status !== 0) throw new Error(`git log ${base} -- ${path} exit ${touched.status}：${touched.stderr.trim()}`);
  const last = touched.stdout.trim();
  if (!last) return true;
  const ancestor = git(checkout, 'merge-base', '--is-ancestor', last, ahead);
  if (ancestor.status > 1) throw new Error(`git merge-base --is-ancestor exit ${ancestor.status}：${ancestor.stderr.trim()}`);
  return ancestor.status === 0;
}

/**
 * coordinator 讀 adapter 的 ref（#333）：主分支那份 adapter 的 Pilot 段與它連到的檔裡，`- **Adapter ref.**` 條目的第一個反引號值；
 * 沒有這個條目時是整合分支（本機）。以已設定的 remote 名稱加 `/` 開頭時是遠端 ref：`ahead` 是 refs/remotes/<ref>，`fetchArgs` 是 `<remote> <分支>`；
 * 這時先 fetch（別台機器 push 之後追蹤 ref 還是舊的），失敗時 `fetchError` 是錯誤訊息，照上次 fetch 的 ref 比。
 */
export function adapterRef(checkout, base, integration) {
  const adapter = show(checkout, base, ADAPTER);
  const text = [pilotSection(adapter), ...pilotFiles(adapter).map(path => show(checkout, base, path))].join('\n');
  const ref = text.match(/^- \*\*Adapter ref\.\*\*[^`\n]*`([^`\s]+)`/m)?.[1];
  if (!ref) return { ref: integration, ahead: `refs/heads/${integration}` };
  const remotes = git(checkout, 'remote');
  if (remotes.status !== 0) throw new Error(`git remote exit ${remotes.status}：${remotes.stderr.trim()}`);
  const remote = remotes.stdout.split('\n').find(name => name && ref.startsWith(`${name}/`));
  if (!remote) return { ref, ahead: `refs/heads/${ref}` };
  const branch = ref.slice(remote.length + 1);
  const fetched = git(checkout, 'fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${ref}`);
  const fetchError = fetched.status === 0 ? undefined : (fetched.stderr.trim().split('\n').pop() || `exit ${fetched.status}`);
  return { ref, ahead: `refs/remotes/${ref}`, fetchArgs: `${remote} ${branch}`, fetchError };
}

/**
 * 整合分支上比主分支新的 adapter 檔：整合分支有這個檔、內容與主分支不同，而且主分支最後一次改它的 commit
 * 已經在整合分支裡（主分支從沒有這個檔也算）。主分支自己改過、整合分支還沒跟上時，整合分支那份比較舊，不印；
 * 兩邊都改過（歷史分岔）時分不出誰新，也不印。整合分支刪掉的檔讀不到，不印。沒有整合分支或主分支時不比。
 * 比的檔案是 adapter 本身，加上兩邊任一版 adapter 的 Pilot 段連到的檔案（新連上的檔只在整合分支那邊）。
 * 改動都在條目裡時附條目名稱（同 OVERLAP 的 changedUnits，不算相鄰的條目），讓 coordinator 只讀那幾條、不讀整份 diff（#144）。
 * adapter 本身只在 `## Pilot` 段變動時算、不附名稱；每行在 ` ｜ ` 之後附讀整合分支那份的 `git -C <checkout> show` 指令（#357：investing 用整檔 diff 讀，51 KB）。
 */
export function adapterAhead(checkout, { integration = 'pilot/integration', main = 'main', source } = {}) {
  const base = `refs/heads/${main}`;
  const { ref, ahead, fetchArgs } = source ?? adapterRef(checkout, base, integration);
  if (!rev(checkout, ahead) || !rev(checkout, base)) return [];
  const files = [...new Set([ADAPTER, ...[ahead, base].flatMap(ref => pilotFiles(show(checkout, ref, ADAPTER)))])];
  return files.filter(path => {
    const blob = rev(checkout, `${ahead}:${path}`);
    if (!blob || blob === rev(checkout, `${base}:${path}`)) return false;
    // adapter 本身只看 Pilot 段：Review、Permissions 等段落的改動不影響 coordinator（#357）。
    if (path === ADAPTER && pilotSection(show(checkout, ahead, path)) === pilotSection(show(checkout, base, path))) return false;
    return integrationNewer(checkout, ahead, base, path);
  }).map(path => {
    const unit = path === ADAPTER ? undefined : changedUnits(checkout, base, ahead, { paths: [path], adjacent: false }).get(path);
    const names = unit && !unit.whole && unit.entries.size ? ` ${[...unit.entries].sort().join(',')}` : '';
    const dir = join(checkout, '.scratch/pilot/adapter');
    const pull = fetchArgs ? `git -C ${checkout} fetch ${fetchArgs} && ` : '';
    return `ADAPTER_AHEAD ${path}${names} ｜ mkdir -p ${dir} && ${pull}git -C ${checkout} show ${ref}:${path} > ${join(dir, basename(path))}`;
  });
}

// adapter 指名的腳本：`scripts/<路徑>.<副檔名>`，前面不能是路徑字元（`skills/…/scripts/x.mjs` 是正本、`<stage worktree>/scripts/<x>.mjs` 是寫法說明，都不算）。
const SCRIPT_PATH = String.raw`scripts\/[\w./-]+?\.(?:mjs|cjs|js|py|sh)\b`;
const ADAPTER_SCRIPT = new RegExp(String.raw`(?<![\w./<>-])` + SCRIPT_PATH, 'g');
// hook 指令裡的腳本：`$CLAUDE_PROJECT_DIR/scripts/x` 前面是 `/`，所以只排除檔名字元。
const HOOK_SCRIPT = new RegExp(String.raw`(?<![\w.-])` + SCRIPT_PATH, 'g');
const scriptRefs = (text, pattern) => [...new Set([...text.matchAll(pattern)].map(([path]) => path))];

/** stage worktree（分支是整合分支或 `pilot/stage-*` 的 linked worktree，同 lib/pilot-store.mjs 的 runInStageWorktree）的路徑；沒有時 undefined。 */
function stageWorktree(checkout, integration) {
  const list = git(checkout, 'worktree', 'list', '--porcelain');
  if (list.status !== 0) throw new Error(`git worktree list exit ${list.status}：${list.stderr.trim()}`);
  return list.stdout.split(/\n\n+/).slice(1)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(({ path, branch }) => path && existsSync(path) && (branch === integration || branch?.startsWith('pilot/stage-')))?.path;
}

/**
 * `ADAPTER_AHEAD` 那一輪（`adapterLines` 是 adapterAhead 印的行，空時不比），coordinator 照整合分支的 adapter 跑主 checkout 的腳本（#358，#324 第 5 項、#338 第 5 項）：
 * 整合分支那份 adapter 的 Pilot 段與它連到的檔指名的 `scripts/*`（含 `.py`、`.sh`），整合分支有這個檔、主 checkout 工作樹缺檔或內容不同、
 * 而且整合分支那份不比主分支舊（integrationNewer）時，依路徑印 `SCRIPT_AHEAD <path> run-in <stage worktree>`；stage worktree 不存在或也沒有這個檔時
 * 印 `SCRIPT_AHEAD <path> sync-main`（先跑 pilot-land.mjs sync-main 建好、跟上 stage worktree）。缺檔會 MODULE_NOT_FOUND，舊版會靜默做錯（`pilot-watch.mjs`）。
 */
export function scriptsAhead(checkout, adapterLines, { integration = 'pilot/integration', main = 'main' } = {}) {
  if (!adapterLines.length) return [];
  // 比本機整合分支，不比 Adapter ref：run-in 跑的是 stage worktree（本機整合分支）的檔，比遠端 ref 會指向 stage 裡的舊版（#333 review）。
  const [tip, base] = [`refs/heads/${integration}`, `refs/heads/${main}`];
  const adapter = show(checkout, tip, ADAPTER);
  const text = [pilotSection(adapter), ...pilotFiles(adapter).map(path => show(checkout, tip, path))].join('\n');
  const stale = scriptRefs(text, ADAPTER_SCRIPT).sort().filter(path => {
    if (!rev(checkout, `${tip}:${path}`)) return false;
    const disk = join(checkout, path);
    if (existsSync(disk) && readFileSync(disk, 'utf8') === show(checkout, tip, path)) return false;
    return integrationNewer(checkout, tip, base, path);
  });
  if (!stale.length) return [];
  const stage = stageWorktree(checkout, integration);
  return stale.map(path => `SCRIPT_AHEAD ${path} ${stage && existsSync(join(stage, path)) ? `run-in ${stage}` : 'sync-main'}`);
}

/**
 * 主分支落後整合分支（整合分支有主分支沒有的 commit）時，主分支 `.claude/settings.json` 的 hook 指令引用的 `scripts/` 檔，
 * 整合分支那份內容不同、而且不比主分支舊時，依指令出現順序印 `HOOK_BEHIND <path>`（#358，#340 第 1 項）：hook 跑的是主 checkout 的舊版，
 * 已在整合分支修好的 hook 問題不要再回報（investing#407、#424）。settings.json 不存在或解析不了時不印。
 */
export function hookBehind(checkout, { integration = 'pilot/integration', main = 'main' } = {}) {
  const [tip, base] = [`refs/heads/${integration}`, `refs/heads/${main}`];
  if (!rev(checkout, tip) || !rev(checkout, base)) return [];
  const count = git(checkout, 'rev-list', '--count', `${base}..${tip}`);
  if (count.status !== 0) throw new Error(`git rev-list exit ${count.status}：${count.stderr.trim()}`);
  if (count.stdout.trim() === '0') return [];
  let settings;
  try { settings = JSON.parse(show(checkout, base, '.claude/settings.json')); } catch { return []; }
  const commands = Object.values(settings?.hooks ?? {}).flat().flatMap(group => group?.hooks ?? []).map(hook => hook?.command).filter(command => typeof command === 'string');
  return scriptRefs(commands.join('\n'), HOOK_SCRIPT).filter(path => {
    const blob = rev(checkout, `${tip}:${path}`);
    return blob && blob !== rev(checkout, `${base}:${path}`) && integrationNewer(checkout, tip, base, path);
  }).map(path => `HOOK_BEHIND ${path}`);
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

// 不算「最後做」要考慮的新單的 label：retro 候選與母單本身不會被實作（#228）；adapter 以 --skip-labels 再加（#326）。
const NOT_NEW_LABELS = ['retro-candidates', 'parent'];
const hasLabel = (issue, names) => issue.labels.nodes.some(({ name }) => names.includes(name));

/**
 * 依賴只寫在內文、沒建 blocked_by 的 ready Issue（`issues` 是本 repo 開著的 Issue，GraphQL 節點）：每個還開著、
 * 卻不在 blocked_by（同一個 repo）裡的依賴印一行 `DEPS_PROSE <n> #<m>`。寫「最後做」卻沒號碼時再印一行：比 blocked_by（同一個 repo）
 * 最新（createdAt 最晚）一張還新、開著、不在 blocked_by 的其他單（不含 retro-candidates、母單與 blocked_by 已有 #n 的單，後者再加會成環；
 * blocked_by 空時以自己的 createdAt 為基準）
 * 依號碼印 `DEPS_PROSE <n> last new #<m> [#<k>…]`，沒有就印 `DEPS_PROSE <n> last ok`（#228：判斷過之後又開的新單沒人發現）。
 */
export function depsProse(issues, repo, skipLabels = []) {
  const notNew = [...NOT_NEW_LABELS, ...skipLabels];
  const waitsOn = (other, n) => other.blockedBy.nodes.some(({ number, repository }) => number === n && repository.nameWithOwner === repo);
  const open = new Set(issues.map(({ number }) => number));
  const out = [];
  for (const issue of issues) {
    if (!hasLabel(issue, ['ready-for-agent'])) continue;
    const sameRepo = issue.blockedBy.nodes.filter(({ repository }) => repository.nameWithOwner === repo);
    const blocked = new Set(sameRepo.map(({ number }) => number));
    for (const m of proseDeps(issue.body)) if (m !== issue.number && open.has(m) && !blocked.has(m)) out.push(`DEPS_PROSE ${issue.number} #${m}`);
    if (!proseLast(issue.body)) continue;
    const since = Math.max(...(sameRepo.length ? sameRepo : [issue]).map(({ createdAt }) => Date.parse(createdAt)));
    const fresh = issues
      .filter(other => other.number !== issue.number && !blocked.has(other.number) && !hasLabel(other, notNew) && !waitsOn(other, issue.number) && Date.parse(other.createdAt) > since)
      .map(({ number }) => number)
      .sort((a, b) => a - b);
    out.push(`DEPS_PROSE ${issue.number} last ${fresh.length ? `new ${fresh.map(m => `#${m}`).join(' ')}` : 'ok'}`);
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
 * `--apply` 的 tracker 寫入：同目錄有 gh-tracker.mjs（setup-workflow 正本的副本，auto mode 只放行它的 tracker 寫入）就經它，沒有就直接 `gh issue`；
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
 * 池子摘要（#240）：ready 桶裡不在 `batched`（開著的 batch checkpoint 的成員）的 Issue，照 issue-pool 的排序印 `POOL_READY <n>...`；
 * 一張都沒有時印 needs-triage 桶的 `POOL_TRIAGE <n>...`（#357），也沒有才 `POOL_EMPTY`。分桶與排序只用 issue-pool.mjs 的 pool()，不另寫一份。
 */
export function poolLine(issues, repo, batched = new Set(), skipLabels = []) {
  const rows = pool(issues, { repo, skipLabels }).filter(({ issue }) => !batched.has(String(issue.number)));
  const bucket = name => rows.filter(row => row.bucket === name).map(({ issue }) => issue.number);
  const [ready, triage] = [bucket('ready'), bucket('needs-triage')];
  if (ready.length) return `POOL_READY ${ready.join(' ')}`;
  return triage.length ? `POOL_TRIAGE ${triage.join(' ')}` : 'POOL_EMPTY';
}

/**
 * 派工前的裸對應單（#304）：ready 桶或 `batched`（開著的 batch checkpoint 的成員）裡的 Issue，本文的 github.com 對應單命中 adapter 宣告的
 * 對應專案（`projects`，pilot-counterpart.mjs 的 declaredProjects）時印 `COUNTERPART_BARE <n> <ref>`，依號碼；`projects` 空的時候不印。
 */
export function counterpartLines(issues, repo, batched = new Set(), projects = new Set(), skipLabels = []) {
  if (!projects.size) return [];
  const ready = new Set(pool(issues, { repo, skipLabels }).filter(({ bucket }) => bucket === 'ready').map(({ issue }) => issue.number));
  return issues.filter(issue => ready.has(issue.number) || batched.has(String(issue.number)))
    .sort((a, b) => a.number - b.number)
    .flatMap(issue => counterparts(issue.body, projects).filter(({ bare }) => bare).map(({ ref }) => `COUNTERPART_BARE ${issue.number} ${ref}`));
}

/**
 * 等人的單沒人問（#327 第 2 項）：pool() 的 human 桶（`ready-for-human`）裡，`gates`（openGates 的結果）沒有一個開著的 gate 的 Issue 欄是 `#<n>` 的，
 * 依號碼印 `HUMAN_NO_GATE <n> <摘要>`；摘要取本文第一行 `… prerequisite：` 冒號之後的文字（issue-pool 的 prerequisiteOf，與 PREREQ 共用），沒有這行就取標題。
 */
export function humanNoGateLines(issues, repo, gates = []) {
  const gated = new Set(gates.flatMap(({ issue }) => refs(String(issue))));
  return pool(issues, { repo }).filter(({ bucket, issue }) => bucket === 'human' && !gated.has(issue.number))
    .map(({ issue }) => issue).sort((a, b) => a.number - b.number)
    .map(issue => `HUMAN_NO_GATE ${issue.number} ${prerequisiteOf(issue.body) ?? issue.title ?? ''}`.trimEnd());
}

/**
 * 等人的單其實已落地（#358，#338 第 8 項）：pool() 的 human 桶（`ready-for-human`）裡，整合分支已有它的落地 commit（issue-pool 的 landedOn：主旨含 `(#<n>)`，
 * 或 merge commit 合進 `<n>-` 開頭的分支）的，依號碼印 `HUMAN_LANDED <n> <sha>`。`landed` 是 landedOn 的結果，沒給時不印。
 * investing#353：#316 的 Operator 腳本早已在整合分支，下一個 session 又請 Operator 跑一次。
 */
export function humanLandedLines(issues, repo, landed) {
  if (!landed) return [];
  return pool(issues, { repo }).filter(({ bucket, issue }) => bucket === 'human' && landed(issue.number))
    .map(({ issue }) => issue.number).sort((a, b) => a - b)
    .map(n => `HUMAN_LANDED ${n} ${landed(n)}`);
}

/**
 * blocker 已落地、範圍卻還開著（#359，#338 第 2 項）：issue-pool 的 blockerOpenScope 每一筆印 `BLOCKER_OPEN_SCOPE <n> #<m> <label>`，
 * 依號碼、blocker 順序；`landed` 是 landedOn 的結果，沒給時不印。
 */
export function blockerOpenScopeLines(issues, repo, landed, skipLabels = []) {
  return blockerOpenScope(issues, { repo, landed, skipLabels }).map(({ n, m, label }) => `BLOCKER_OPEN_SCOPE ${n} #${m} ${label}`);
}

/** 整合分支的 commit（新的先，每個是 [sha, 主旨]），給 landedOn；分支不存在時 undefined。 */
function integrationLanded(checkout, integration) {
  if (!rev(checkout, `refs/heads/${integration}`)) return undefined;
  return landedOn(integration, ref => {
    const result = git(checkout, 'log', '--format=%H%x09%s', `refs/heads/${ref}`, '--');
    if (result.status !== 0) throw new Error(`git log ${ref} exit ${result.status}：${result.stderr.trim()}`);
    return result.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
  });
}

/**
 * 主 checkout 所在 repo 開著的 Issue 的 DEPS_PROSE、COUNTERPART_BARE、HUMAN_NO_GATE、HUMAN_LANDED、PARENT_* 與池子摘要行（同一次查詢），以及 PARENT_* 對應的 tracker 寫入（不在這裡寫）；
 * `gates` 是 gates.md 開著的 gate（openGates），`landed` 是整合分支的 landedOn（沒有時不印 HUMAN_LANDED）。gh 失敗時只有 DEPS_PROSE_FAILED 與 POOL_FAILED 兩行，不中斷其他檢查。
 */
export function trackerLines(checkout, batched = new Set(), projects = new Set(), gates = [], landed, skipLabels = []) {
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
    return { lines: [...depsProse(issues, repo, skipLabels), ...counterpartLines(issues, repo, batched, projects, skipLabels), ...humanNoGateLines(issues, repo, gates), ...humanLandedLines(issues, repo, landed), ...blockerOpenScopeLines(issues, repo, landed, skipLabels), ...lines, poolLine(issues, repo, batched, skipLabels)], fixes, issues };
  } catch (error) {
    return { lines: [`DEPS_PROSE_FAILED ${error.message}`, `POOL_FAILED ${error.message}`], fixes: [], issues: [] };
  }
}

/**
 * 解析 batch checkpoint：`current:`、成員表格、最後一行 `regression: <sha> exit <code>` 的 SHA 與 exit（SHA 後面不是 `exit <code>` 時 undefined），
 * 與合入的 SHA（`current: merged|pushed <sha>`，沒有就取 regression 的 SHA），以及 pilot-land 的存活標記 `regressing`（`{ sha, pid }`，#361）。
 */
export function parseBatch(text) {
  const current = text.match(/^current:\s*(.*)$/m)?.[1].trim() ?? '';
  // exit 要緊接在 SHA 之後（PILOT-STORE.md 的格式，pilot-pr-body.mjs 也這樣認），寫在別處的 `exit N` 不算。
  const lastRegression = [...text.matchAll(/^regression: ([0-9a-f]{7,40})\b(?: exit (\d+)\b)?/gm)].at(-1);
  const regression = lastRegression?.[1];
  const regressionExit = lastRegression?.[2];
  const sha = current.match(/^(?:merged|pushed) ([0-9a-f]{7,40})\b/)?.[1] ?? regression;
  const members = [];
  for (const line of text.split('\n')) {
    const cells = tableCells(line);
    if (cells.length < 8 || !/^\d+$/.test(cells[0])) continue;
    const [n, branch, worktree, handle, started, stuckAfter, state, candidate] = cells;
    members.push({ n, branch, worktree, handle, started, stuckAfter, state, candidate });
  }
  // pilot-batch resume 記下的那一行（#356）：每個成員取最後一行 `resumed: #<n> <time> <結果行|->`。
  for (const [, n, line] of text.matchAll(/^resumed: #(\d+) \S+ (.*)$/gm)) {
    for (const member of members) if (member.n === n) member.resumed = line === '-' ? undefined : line;
  }
  return { current, members, regression, regressionExit, sha, regressing: regressingMark(text) };
}

/** Claude Code 輸入框下方的提示列（`✻ …`、`❯ …`、`⏵⏵ …`）：使用者打字或提示文字可能長得像結果行，不算。 */
const PROMPT_CHROME = /^[\s│]*(?:✻|❯|⏵⏵)/;

/** Orca 的 tail → 一行一個字串：tail 可能是單一字串，元素裡也可能帶換行（investing 的 parseTerminal）；缺省時是空陣列。 */
export const screenLines = tail => (tail === undefined || tail === null ? [] : Array.isArray(tail) ? tail : [tail]).flatMap(line => String(line).split('\n'));

/**
 * terminal 畫面裡最後一個結果行 `DONE <n> <sha>` 或 `STOP <n> <cause>`（Probe 的 WORKER 與 pilot-watch.mjs 共用這一份，#355）。
 * `n` 缺省時任何號碼都算。TUI 畫框線時行首、行尾會帶 `│` 與空白，行首也可能是縮排或 Claude Code 的 bullet（`●`、`⏺`、`⎿`），比對前先去掉；
 * 提示列略過，tail 先經 screenLines 攤平，行內的控制字元換成空白。傳回 { line（去掉框線後的整行）, kind（DONE｜STOP）, n, value（sha 或 cause） }，沒有時 null。
 */
export function resultMatch(tail, n) {
  const number = n === undefined ? '(\\d+)' : `(${n})`;
  const done = new RegExp(`^DONE ${number} ([0-9a-f]{7,40})$`);
  const stop = new RegExp(`^STOP ${number} (.+)$`);
  for (const raw of screenLines(tail).reverse()) {
    if (PROMPT_CHROME.test(raw)) continue;
    const line = raw.replace(/^[\s│●⏺⎿]+|[\s│]+$/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ');
    const match = line.match(done) ?? line.match(stop);
    if (match) return { line, kind: line.startsWith('DONE') ? 'DONE' : 'STOP', n: match[1], value: match[2] };
  }
  return null;
}

/** 這個 worker 的結果行，去掉號碼：`DONE <sha>`、`STOP <cause>`，沒有時、或最後一個結果行（去框線後的整行）就是 `ignore` 時 null。 */
export function resultLine(tail, n, ignore) {
  const match = resultMatch(tail, n);
  return match && match.line !== ignore ? `${match.kind} ${match.value}` : null;
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
  // resume 當下畫面最後一個結果行（成員的 resumed，#356）還是最後一個時不算：那是 resume 前的舊結果。
  const result = resultLine(terminal.tail ?? [], member.n, member.resumed);
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
 * 符合時 coordinator 從 Push gate 第 1 步接著做；Integrate 之後又有 commit、沒有 regression 行，
 * 或最後一行 regression 的 exit 不是 0、沒寫 exit 時（#130：exit 1 被誤判為通過、ff 進了整合分支），直接推會送出沒驗過的內容。
 */
function mergedNotInMain(checkout, integration, key, regression, regressionExit) {
  const regressionSha = regression && rev(checkout, `${regression}^{commit}`);
  if (!regressionSha) return `NOT_IN_MAIN ${key} no-regression`;
  if (regressionExit !== '0') return `NOT_IN_MAIN ${key} regression-failed ${regressionExit ?? 'none'}`;
  const tip = rev(checkout, `refs/heads/${integration}`);
  return tip === regressionSha ? `RESUME_PUSH ${key}` : `NOT_IN_MAIN ${key} tip ${tip.slice(0, 7) || 'none'}`;
}

/**
 * `--apply`：把這一輪讀到的結果寫回成員列。重讀檔案，只認號碼相同、state 還是 running 的那一列，
 * 以 `|` 切開後只換 state 與 candidate 兩格（其他格與其他行的 byte 都不動）；DONE 寫 `done` 與 SHA，STOP 寫 `stop`、candidate 不動。
 * 寫完再讀一次比對，傳回沒寫進去的 APPLY_MISS 行（手寫 sed 對不到列時沒有輸出也沒報錯，coordinator 的 retro）。
 * 讀改寫在 checkpoint 鎖內（#345）；等到逾時傳回 `CHECKPOINT_LOCKED …` 一行，不寫檔。
 */
export function applyResults(file, key, results) {
  const misses = [];
  const written = [];
  const locked = lockedLine(() => updateCheckpoint(file, text => {
    const lines = text.split('\n');
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
    return written.length ? lines.join('\n') : undefined;
  }));
  if (locked) return locked;
  if (!written.length) return misses;
  const { members } = parseBatch(readFileSync(file, 'utf8'));
  for (const { n, state, sha } of written) {
    if (!members.some(m => m.n === n && m.state === state && (!sha || m.candidate === sha))) misses.push(`APPLY_MISS ${key} ${n} verify`);
  }
  return misses;
}

/** 成員這一輪的 state：還記成 running 的列以這一輪剛讀到的 DONE／STOP（`results`）為準。 */
const stateNow = (m, results) => (m.state === 'running' && results.find(r => r.n === m.n)?.state) || m.state;

/**
 * dispatched batch 的 stage 判斷（#163）。`active` 是沒有 moved 的成員，`results` 是這一輪剛讀到的 DONE／STOP（還記成 running 的列以它為準）。
 * 還有 running 時不印；每個成員都 done 印 STAGEABLE；有 done 也有其他狀態（stop、parked）印 MOVE <key> <其他成員…>，先移走它們才 stage；
 * 其他成員裡有 batch key 那張時改列 done 的成員（pilot-batch 不能把 key 移出自己的 batch，#357）；
 * 沒有 done 印 PARKED <key> <n…>（pilot-land 對它只會 STOP member）。
 * `held`（heldIssues 的結果，#367）裡的 done 成員各先印 `HELD <n> <gate id>`，有 HELD 時不印 STAGEABLE；MOVE 照印（PARKED 沒有 done 成員，不會有 HELD）。
 */
export function stageLines(key, active, results, held = new Map()) {
  const states = active.map(m => ({ n: m.n, state: stateNow(m, results) }));
  if (!states.length || states.some(m => m.state === 'running')) return [];
  const heldLines = states.filter(m => m.state === 'done' && held.has(m.n)).map(m => `HELD ${m.n} ${held.get(m.n)}`);
  const others = states.filter(m => m.state !== 'done').map(m => m.n);
  if (!others.length) return heldLines.length ? heldLines : [`STAGEABLE ${key}`];
  if (others.length === states.length) return [`PARKED ${key} ${others.join(' ')}`];
  // pilot-batch.mjs 不能把 batch key 那張移出自己的 batch（same-batch，#357）：它沒 done 時改列可以移走的 done 成員。
  const movable = others.includes(key) ? states.filter(m => m.state === 'done').map(m => m.n) : others;
  return [...heldLines, `MOVE ${key} ${movable.join(' ')}`];
}

/**
 * stop 成員的 blocker 全關了（#357）：開著的 batch 裡 stop 的成員（這一輪剛讀到 STOP 的也算），它的 Issue 有 blocked_by、而且每張（不分 repo）都已關閉時
 * 印 `UNBLOCKED <key> <n>`，依成員列的順序。`issues` 是 tracker 上開著的 Issue（GraphQL 節點）；gh 失敗時是空的，不印。
 */
export function unblockedLines(key, active, results, issues) {
  const byNumber = new Map(issues.map(issue => [String(issue.number), issue]));
  return active.filter(m => stateNow(m, results) === 'stop')
    .filter(m => {
      const blockers = byNumber.get(m.n)?.blockedBy?.nodes ?? [];
      return blockers.length && blockers.every(({ state }) => state === 'CLOSED');
    })
    .map(m => `UNBLOCKED ${key} ${m.n}`);
}

/**
 * 開工後改了範圍（#359，#338 第 3 項）：開著的 batch 裡 done 的成員（這一輪剛讀到 DONE 的也算），它的 Issue 本文最後編輯時間（GitHub 的 lastEditedAt）
 * 晚於成員列的 started 時印 `SCOPE_CHANGED <key> <n> <edited at>`（時間照 tracker 原樣），依成員列的順序：worker 交付的可能是舊範圍，Stage 前要讀改了什麼。
 * started 解析不了、沒編輯過、gh 失敗（`issues` 空）時不印。
 */
export function scopeChangedLines(key, active, results, issues) {
  const byNumber = new Map(issues.map(issue => [String(issue.number), issue]));
  return active.filter(m => stateNow(m, results) === 'done')
    .map(m => ({ n: m.n, started: Date.parse(m.started), edited: byNumber.get(m.n)?.lastEditedAt }))
    .filter(({ started, edited }) => edited && !Number.isNaN(started) && Date.parse(edited) > started)
    .map(({ n, edited }) => `SCOPE_CHANGED ${key} ${n} ${edited}`);
}

/**
 * staged batch 的 Regression 判斷（#191）：最後一行 regression 是這個 staged SHA 的 exit 0 才算過（pilot-land 接著做 Integrate，或 hold 擋著），
 * 其他情況（exit 不是 0、沒寫 exit、SHA 是先前那次 stage 的、沒有 regression 行）印 RESTAGE，coordinator 讀 reg-<key>.log 後重跑 pilot-land。
 * SHA 兩邊都可能是縮寫，以前綴比對。
 * `liveLandSha` 是還活著的 pilot-land 留的 `regressing:` 標記 SHA（#361）：這個 staged SHA 還沒有 regression 行、標記是同一個 SHA 時
 * Regression 還在跑，改印 `REGRESSING <key> <staged sha>`（coordinator 等，不重 stage）。
 */
export function restageLines(key, current, regression, regressionExit, liveLandSha) {
  const staged = current.match(/^staged ([0-9a-f]{7,40})\b/)?.[1];
  if (!staged) return [];
  const sameAsStaged = sha => sha && (sha.startsWith(staged) || staged.startsWith(sha));
  const same = sameAsStaged(regression);
  if (same && regressionExit === '0') return [];
  if (!same && sameAsStaged(liveLandSha)) return [`REGRESSING ${key} ${staged}`];
  return [`RESTAGE ${key} regression-failed ${(same && regressionExit) || 'none'}`];
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

/** 跑 fn；checkpoint 鎖等到逾時時傳回 `[CHECKPOINT_LOCKED …]`，其他錯誤照丟（#345：其他 probe 行照印，exit 3）。 */
function lockedLine(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof CheckpointLocked) return [error.message];
    throw error;
  }
}

/** `--apply`：已進 origin/<主分支> 的 `merged` batch 改成 `pushed`，SHA 與附註照留（Push gate 印 LANDED 之後沒人寫，coordinator 的 retro）。 */
function applyPushed(file, key) {
  const locked = lockedLine(() => updateCheckpoint(file, text => text.replace(/^(current:[ \t]*)merged\b/m, '$1pushed')));
  if (locked) return locked;
  return /^pushed\b/.test(parseBatch(readFileSync(file, 'utf8')).current) ? [] : [`APPLY_MISS ${key} current verify`];
}

export { changedUnits };

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

/** 本機分支的 tip 與它和 `onto` 的 merge-base：`{ tip, base }`；本機沒有這個分支或沒有共同祖先時傳回 undefined，git 失敗時 throw。 */
function branchBase(checkout, onto, branch) {
  const tip = branch && rev(checkout, `refs/heads/${branch}`);
  if (!tip) return undefined;
  const base = git(checkout, 'merge-base', tip, onto);
  if (base.status > 1) throw new Error(`git merge-base ${branch} exit ${base.status}：${base.stderr.trim()}`);
  return base.status ? undefined : { tip, base: base.stdout.trim() };
}

/** 分支已 commit 的內容相對於與 `onto` 的 merge-base 改了哪些檔或條目：`{ base, units }`；本機沒有這個分支或沒有共同祖先時傳回 undefined。 */
function branchUnits(checkout, onto, branch) {
  const found = branchBase(checkout, onto, branch);
  return found && { base: found.base, units: changedUnits(checkout, found.base, found.tip) };
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

const BUDGET_FILE = 'scripts/adapter-size-budget.json';

/** `ref` 上 `path` 的 bytes；沒有這個檔時 0。 */
function blobSize(checkout, ref, path) {
  const result = git(checkout, 'cat-file', '-s', `${ref}:${path}`);
  return result.status === 0 ? Number(result.stdout.trim()) : 0;
}

/**
 * 同時進行的成員共用的檔案大小預算（#398）：預算表是整合分支（沒有時主分支）上的 `scripts/adapter-size-budget.json`
 * （`{ 路徑: bytes }`，check-adapter-size 讀的同一份）。表上每個檔，整合分支的大小加上開著的 batch 裡 running、done 成員各自相對於
 * 與整合分支的 merge-base 的增量（只看已 commit 的內容，縮小的成員也算進去），超過上限時印 `BUDGET <檔案> <合計> <上限> <成員…>`，
 * 成員是讓檔案變大的那些（依號碼排序）。沒有成員改這個檔、沒有預算表、本機沒有成員分支時不印；預算表不是物件或上限不是正整數時 throw。
 */
export function budgetLines(checkout, batches, options = {}) {
  const onto = overlapOnto(checkout, options);
  const text = onto && show(checkout, onto, BUDGET_FILE);
  if (!text) return [];
  const table = JSON.parse(text);
  if (!table || typeof table !== 'object' || Array.isArray(table) || !Object.values(table).every(limit => Number.isInteger(limit) && limit > 0)) {
    throw new Error(`${BUDGET_FILE} 不是 { 路徑: bytes } 物件（上限要是正整數）`);
  }
  const members = activeMembers(batches).map(m => ({ n: m.n, ...branchBase(checkout, onto, m.branch) })).filter(m => m.tip);
  const out = [];
  for (const [path, limit] of Object.entries(table)) {
    let total = blobSize(checkout, onto, path);
    const grew = [];
    let touched = false;
    for (const { n, tip, base } of members) {
      const delta = blobSize(checkout, tip, path) - blobSize(checkout, base, path);
      if (!delta) continue;
      touched = true;
      total += delta;
      if (delta > 0) grew.push(n);
    }
    if (touched && total > limit) out.push(['BUDGET', path, total, limit, ...grew].join(' '));
  }
  return out;
}

/**
 * STAGEABLE batch 的試合併（#376，#338 第 4 項）：done 成員（`active` 的順序，依號碼）的本機分支 tip 兩兩以 lib/merge-tree.mjs 試合併，
 * 有衝突印 `CONFLICT <key> <n> <m> <檔…>`（號碼小的在前）；再拿每個成員試合併整合分支（沒有時主分支）的 tip，有衝突印
 * `CONFLICT <key> <n> integration <檔…>`。檔依路徑排序。本機沒有分支的成員、git 判斷不了（低於 2.38、沒有共同祖先）的那一對略過。
 * 只在印了 STAGEABLE 時呼叫，所以成員都是 done、tip 都已 commit。
 */
export function conflictLines(checkout, key, active, options = {}) {
  const onto = overlapOnto(checkout, options);
  const members = [...active].sort((a, b) => Number(a.n) - Number(b.n))
    .map(m => ({ n: m.n, tip: m.branch && rev(checkout, `refs/heads/${m.branch}`) })).filter(m => m.tip);
  const line = (n, m, files) => (files?.length ? [['CONFLICT', key, n, m, ...files].join(' ')] : []);
  const out = [];
  members.forEach((a, i) => {
    for (const b of members.slice(i + 1)) out.push(...line(a.n, b.n, mergeConflicts(checkout, a.tip, b.tip)));
  });
  if (onto) for (const m of members) out.push(...line(m.n, 'integration', mergeConflicts(checkout, m.tip, onto)));
  return out;
}

/** 經過的時間：`<h>h<m>m` 或 `<m>m`；時間解析不了時 `?`。 */
function age(time, at) {
  const minutes = Math.floor((at - Date.parse(time)) / 60000);
  if (Number.isNaN(minutes)) return '?';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

/** 整合分支沒有包含 origin/<主分支> 時的 `BEHIND_MAIN <落後數> <SHA>`（#268）；任一個 ref 不存在或沒有落後時回空陣列。 */
export function behindMain(checkout, { integration = 'pilot/integration', main = 'main' } = {}) {
  const [tip, upstream] = [rev(checkout, `refs/heads/${integration}`), rev(checkout, `refs/remotes/origin/${main}`)];
  if (!tip || !upstream || git(checkout, 'merge-base', '--is-ancestor', upstream, tip).status === 0) return [];
  const count = git(checkout, 'rev-list', '--count', `${tip}..${upstream}`);
  if (count.status !== 0) throw new Error(`git rev-list exit ${count.status}：${count.stderr.trim()}`);
  return [`BEHIND_MAIN ${count.stdout.trim()} ${upstream}`];
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
    const { current, members, regression, regressionExit } = parseBatch(readFileSync(join(pilot, file), 'utf8'));
    if (/^closed\b/.test(current)) continue;
    open++;
    // #191：只寫 `staged <sha>` 看不出 Regression 沒過。
    const result = regression ? `，regression ${regression.slice(0, 7)} exit ${regressionExit ?? 'none'}` : /^staged\b/.test(current) ? '，regression none' : '';
    out.push(`- batch ${file.slice('batch-'.length, -'.md'.length)}：${current || '(沒有 current:)'}${result}`);
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

/** `--tail`：worker 分頁畫面的最後 `lines` 行。 */
export async function workerTail(ctx, handle, lines = 40) {
  const { terminal } = await orca(ctx, 'terminal', 'read', '--terminal', handle, '--screen');
  return (terminal?.tail ?? []).slice(-lines);
}

export async function probe(ctx, checkout, { integration = 'pilot/integration', main = 'main', apply = false, status = false, capacity, skipLabels = [] } = {}) {
  const pilot = join(checkout, '.scratch/pilot');
  // 開著的 batch checkpoint 的成員：Pool 不再挑它們，池子摘要也略過。
  const batched = new Set(batchFiles(pilot).map(file => parseBatch(readFileSync(join(pilot, file), 'utf8')))
    .filter(({ current }) => !/^closed\b/.test(current)).flatMap(({ members }) => members.map(({ n }) => n)));
  // 對應專案的宣告取主分支的 adapter（主 checkout 平常就在主分支；整合分支上較新的版本由 ADAPTER_AHEAD 提醒）。
  const projects = declaredProjects(show(checkout, `refs/heads/${main}`, ADAPTER));
  const gates = openGates(readStore(pilot, 'gates.md'));
  const held = heldIssues(gates);
  const tracker = trackerLines(checkout, batched, projects, gates, integrationLanded(checkout, integration), skipLabels);
  const source = adapterRef(checkout, `refs/heads/${main}`, integration);
  const ahead = adapterAhead(checkout, { integration, main, source });
  const out = [...checkoutState(checkout, main), ...(source.fetchError ? [`FETCH_FAILED adapter-ref ${source.fetchError}`] : []), ...ahead, ...scriptsAhead(checkout, ahead, { integration, main }), ...hookBehind(checkout, { integration, main }), ...openRows(pilot), ...tracker.lines];
  if (apply) out.push(...applyParentFixes(checkout, tracker.fixes));
  const landing = [];
  const batches = [];
  let running = 0;
  for (const file of batchFiles(pilot)) {
    const key = file.slice('batch-'.length, -'.md'.length);
    const { current, members, regression, regressionExit, sha, regressing } = parseBatch(readFileSync(join(pilot, file), 'utf8'));
    batches.push({ key, current, members });
    const active = members.filter(m => !/^moved\b/.test(m.state));
    const results = [];
    // 已 closed 的 batch 沒有在跑的 worker：殘留的 running 列不讀 terminal、不算容量（#295：batch-53-55 的兩列印 STUCK orca terminal_handle_stale，帳本記 2）。
    for (const member of /^closed\b/.test(current) ? [] : members.filter(m => m.state === 'running')) {
      const state = await workerState(ctx, member);
      const [, kind, value] = state.match(/^(DONE|STOP) (.+)$/) ?? [];
      if (kind) results.push({ n: member.n, state: kind === 'DONE' ? 'done' : 'stop', sha: kind === 'DONE' ? value : undefined });
      else running++;
      out.push(`WORKER ${member.n} ${state}`);
    }
    if (apply && results.length) out.push(...applyResults(join(pilot, file), key, results));
    if (/^dispatched\b/.test(current)) {
      const stage = stageLines(key, active, results, held);
      out.push(...stage);
      if (stage.includes(`STAGEABLE ${key}`)) out.push(...conflictLines(checkout, key, active, { integration, main }));
    }
    if (!/^closed\b/.test(current)) out.push(...unblockedLines(key, active, results, tracker.issues), ...scopeChangedLines(key, active, results, tracker.issues));
    // 只有 staged 而且留了標記的 batch 才查行程（ps），其他 batch 不多花一次 spawn。
    const liveLandSha = /^staged\b/.test(current) && regressing && landAlive(regressing.pid) ? regressing.sha : undefined;
    out.push(...restageLines(key, current, regression, regressionExit, liveLandSha));
    if (/^(merged|pushed)\b/.test(current)) landing.push({ key, sha, regression, regressionExit, merged: /^merged\b/.test(current) });
  }
  out.push(...unparkLines(batches));
  out.push(...overlapLines(checkout, batches, { integration, main }));
  out.push(...budgetLines(checkout, batches, { integration, main }));
  if (landing.length) {
    const fetch = git(checkout, 'fetch', '-q', 'origin');
    if (fetch.status !== 0) out.push(`FETCH_FAILED ${fetch.stderr.trim().split('\n').find(line => line.startsWith('fatal:')) ?? fetch.stderr.trim().split('\n')[0]}`);
    else {
      // 開著的 gate 擋住所有 push 時，每個沒進主分支的 batch 都在等它，NOT_IN_MAIN／RESUME_PUSH 合成一行（#136）；
      // 沒有這種 gate、而 main 依決定暫停推送（pilot-hold set-main 的旗標有效）時，暫停期間預期的待推行（RESUME_PUSH、NOT_IN_MAIN <key>、
      // NOT_IN_MAIN <key> tip …）合成 MAIN_PAUSED 一行（#379）；no-sha、no-regression、regression-failed 是要人處理的異常，main 暫停不會有人來看，照印。
      const parking = openGates(readStore(pilot, 'gates.md')).find(parksAllPush);
      const pause = !parking && mainPause(checkout);
      const pending = [];
      const expected = line => /^(RESUME_PUSH \S+|NOT_IN_MAIN \S+( tip \S+)?)$/.test(line);
      const unpushed = (key, line) => (parking || (pause && expected(line)) ? pending.push(key) : out.push(line));
      for (const { key, sha, regression, regressionExit, merged } of landing) {
        if (!sha) unpushed(key, `NOT_IN_MAIN ${key} no-sha`);
        else if (git(checkout, 'merge-base', '--is-ancestor', sha, `origin/${main}`).status === 0) {
          out.push(`IN_MAIN ${key}`);
          if (apply && merged) out.push(...applyPushed(join(pilot, `batch-${key}.md`), key));
        } else unpushed(key, merged ? mergedNotInMain(checkout, integration, key, regression, regressionExit) : `NOT_IN_MAIN ${key}`);
      }
      if (pending.length) out.push(parking ? `PUSH_PARKED ${parking.id} ${pending.length} batches` : `MAIN_PAUSED ${pause.reason} until ${pause.until} pending ${pending.join(' ')}`);
    }
  }
  out.push(...behindMain(checkout, { integration, main }));
  // Memory audit（#347）：間隔取主分支的 adapter 與它 Pilot 段連到的檔裡的 `Memory audit days: <n>`，沒宣告不印
  const adapter = show(checkout, `refs/heads/${main}`, ADAPTER);
  const days = declaredDays([adapter, ...pilotFiles(adapter).map(path => show(checkout, `refs/heads/${main}`, path))].join('\n'));
  const record = join(checkout, MEMORY_AUDIT_FILE);
  const memoryAudit = memoryAuditLine(existsSync(record) ? readFileSync(record, 'utf8') : null, days);
  if (memoryAudit) out.push(memoryAudit);
  if (capacity) {
    out.push(...envMissingLines());
    const { total, cap } = report(ledgerPath(), capacity, running);
    if (total > cap) out.push(`OVER_CAP ${total} ${cap}`);
  }
  if (status) {
    mkdirSync(pilot, { recursive: true });
    writeFileSync(join(pilot, 'status.md'), statusReport(checkout, { integration, main }));
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const cli = process.env.ORCA_CLI_COMMAND;
  if (args[0] === '--tail') {
    const lines = args[2] === '--lines' ? Number(args[3]) : 40;
    if (!args[1] || args[1].startsWith('--') || args.length !== (args[2] === '--lines' ? 4 : 2) || !Number.isInteger(lines) || lines < 1) {
      console.error(USAGE);
      process.exit(2);
    }
    if (!cli) {
      console.error('沒有 ORCA_CLI_COMMAND，讀不到 terminal');
      process.exit(1);
    }
    try {
      for (const line of await workerTail({ cli }, args[1], lines)) console.log(line);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    process.exit(0);
  }
  const positional = [];
  const options = {};
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const flag = new Map(Object.entries({ '--apply': 'apply', '--status': 'status' })).get(args[i]);
    if (flag) {
      if (flag in options) bad = true;
      options[flag] = true;
      continue;
    }
    const name = new Map(Object.entries({ '--integration': 'integration', '--main': 'main', '--capacity': 'capacity', '--skip-labels': 'skipLabels' })).get(args[i]);
    const value = args[++i];
    if (!name || !value || value.startsWith('--') || name in options) bad = true;
    else options[name] = value;
  }
  const [checkout] = positional;
  if ('skipLabels' in options) options.skipLabels = options.skipLabels.split(',').filter(Boolean);
  if (bad || positional.length !== 1 || ('capacity' in options && (!validRepo(options.capacity) || machineCap() === undefined))) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const out = await probe({ cli }, checkout, options);
    for (const line of out) console.log(line);
    if (out.some(line => line.startsWith('CHECKPOINT_LOCKED '))) process.exit(3);
    if (out.some(line => /^(APPLY_MISS|PARENT_APPLY_FAILED) /.test(line))) process.exit(1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
