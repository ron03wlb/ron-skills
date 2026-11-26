#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（#58）：/issue-pilot coordinator 的 Dispatch，一個指令把 batch 的每個成員派給一個 `/issue-run <n> --worker <checkpoint>` worker。
// batch checkpoint 的格式照 issue-pilot 的 PILOT-STORE.md；專案不同的值（整合分支、stuck-after）由參數傳入。
// 每個成員依序：orca-worktree-create → Bare guard → 確認 worktree → Env sync（adapter 有宣告時）→ terminal create → orca-session-send。
// Bare guard 是同目錄的 pilot-unbare.sh（setup-workflow 正本；`<checkout> <時機>`，時機 `dispatch #<n>`；Orca 從 WSL 建 worktree 會把主 checkout 設成 bare），沒有就略過。
// 派每個成員之前先讀 Issue 最近一則認領留言（同目錄 issue-pool.mjs 的格式與判斷，含 claim 的前任 coordinator 接手）：不是這個 session
// （$CLAUDE_CODE_SESSION_ID，其次 $ORCA_TERMINAL_HANDLE）的就印 `STOP <n> not-claimed`，不開 worktree、不開分頁（#165：claim 印 STOP 後照樣派出）。
// 讀留言用 gh，所以只支援 GitHub tracker。
// blocker（investing#486）：同一次 `gh issue view` 也讀 blockedBy；認領檢查與 running 檢查之後、動手之前（--fresh 不做），每個開著、同 repo（url 與成員相同前綴）的 blocker <m>
// 有本機分支 `issue/<m>-*`（`-prior`、`-prior2`… 不算）的 commit 不在整合分支時，印 `HOLD <n> blocker <m>[,<m>…] unstaged`，不建 worktree、不開分頁、不改成員列、
// 不放掉認領：blocker 的最新候選還沒 stage，worker 開工就得自己 merge 它（#436 的 blocker #434 照 G69 修完多 5 個 commit）；下一輪 stage 之後用同一個 key 只帶它重跑。
// 重疊（#174）：認領檢查之後、動手之前，成員分支（本機已有時；--fresh 是要另存成 prior 的那個）和 `.scratch/pilot/` 開著的 batch 裡其他 running、done 成員
// 照 pilot-probe.mjs 的 OVERLAP 同一套比法（同一個檔，或 `.md` 的同一個 `- **<名稱>.**` 條目）比對，有重疊就印 `STOP <n> overlap <m> <檔案>[:<條目>]…`
// （戳記檔不算，#460：主 checkout 有 scripts/restamp.mjs 時取它匯出的 STAMP_FILES，land.mjs 認的同一份清單；Stage 遇到它們會自己取聯集再 restamp。
// 只差戳記檔的成員不列、不 STOP；載入失敗時 stderr 印 `WARN stamp-files <原因>`，照舊全比）
// （多個成員時以 `, <m> …` 接著列），什麼都不動、成員列也不改寫；`--allow-overlap` 才照派。還沒派過、本機沒有分支的成員沒有東西可比。
// 比對本身失敗（git）時印 `STOP <n> overlap-check <錯誤>`：一般派工的成員記 stop，--fresh 什麼都不動。
// worktree 已存在（重跑）時，開新分頁前先關掉 worktree 裡每個 terminal，同 --fresh；那一列還是 running、它的分頁也還開著時
// 印 `STOP <n> running <handle>`，不關分頁、不改寫成員列（只看這次 key 的 checkpoint）；列不出分頁時 `STOP <n> terminal-close …`，成員列也不動。
// worktree 有沒有建好只看目錄存在、`git worktree list` 裡有這個分支，不信 create 回傳的 ok（曾經建好卻回 "ok": false）。
// create 之前（#353）：`git worktree list` 裡已有目錄名是 `issue-<n>`、分支卻不是成員分支的 worktree（舊流程留下的），交給 Orca 只會去重出 `issue-<n>-2`：
// 印 `STOP <n> worktree-branch <路徑> <分支>`（detached 時分支寫 `(detached)`），不呼叫 create、不開分頁，成員列記 stop。--fresh 不 create，不受影響。
// Orca 可用（#394）：容量檢查之後、寫 checkpoint 與動任何成員之前（一般派工與帶 --note 的 --fresh；草稿不用 Orca）先跑一次 `worktree list --json`，
// 失敗（exit 非 0 或 ok 不是 true）就只印 `STOP orca-unavailable <訊息第一個非空行>`、exit 4：什麼都不建、不寫 checkpoint，認領也保留（下一輪原樣重跑）。
// 登記（#394）：worktree 確認建好之後、`terminal create` 之前，輪詢 `worktree list --json` 直到列出這個路徑（WSL 上 Orca 回 `\\wsl.localhost\<distro>\…` 的 UNC 路徑，
// 反斜線換成斜線後比尾段），最多 PILOT_DISPATCH_REGISTER_MS（預設 60000）、間隔 PILOT_DISPATCH_REGISTER_POLL_MS（預設 2000）；到上限沒列出時 stderr 印 `WARN orca-register <路徑>`，仍照樣 `terminal create`。
// Env sync（#363）：主 checkout 的 adapter（docs/agents/issue-run.md）的 `## Pilot` 段或它連到的檔（同 pilot-probe.mjs 的 pilotFiles）有一行 `Env sync: `<指令>``
// （或 Pilot 條目格式的 `- **Env sync.** `<指令>``；前面可以有 `- ` 或 `* `，指令是該行第一個反引號裡的字）時，worktree 確認建好之後、關舊分頁與 `terminal create` 之前，以 `sh -c` 在 worktree 裡跑它，
// 重派既有 worktree 也跑（同步指令應該可以重跑）；指令的 stdout、stderr 轉到 dispatch 的 stderr。exit 非 0 印 `STOP sync <n> exit <code>`，不開分頁、成員記 stop；
// 被總預算或信號中止時同其他步驟記 `STOP <n> timeout|signal …`。沒宣告時不跑。宣告寫錯（沒有反引號裡的指令、合計宣告超過一次）時 exit 2，什麼都不動。
// 剛建好的 worktree Orca 可能還在背景登記，`terminal create` 回 `selector_not_found`：再輪詢一次後重試一次，仍失敗才 `STOP <n> terminal …`。
// 所有子行程的 stdin 都接 /dev/null：Orca CLI 會吃掉 stdin，`while read` 迴圈因此只派到第一個成員。
// 總時間有上限（比照 pilot-handoff.mjs）：Bash 工具最多等 600 秒，被殺就來不及寫 checkpoint，所以預算到了（timeout）或收到 SIGTERM、SIGINT（signal <名稱>）
// 都中止進行中的步驟，進行中與還沒派的成員都 STOP 並寫進 checkpoint。預設預算 510 秒，加上收尾的 git 與寫檔，在 540 秒內結束。
//
// --fresh（#124）把一個成員重派成 fresh worker（Stage 的同一條目衝突之後），worktree 與分支名稱不變，舊分支就地另存：
//   工作樹有未提交改動（#625）→ 先備份：staged、未 staged、未追蹤的改動存成 `<主 checkout>/.scratch/pilot/backup/issue-<n>-dirty.patch`（已有時接 -2…）並 stash；備份或 stash 失敗才 `STOP <n> backup <原因>`（改動留原處）；關掉 worktree 裡每個 terminal（checkpoint 可能只記了其中一個）；
//   `branch -m <分支> <分支>-prior`；`switch -c <分支> <整合分支>`；worker 的 `.scratch/issue-run-<n>` 改名成 `issue-run-<n>-prior`（fresh worker 才不讀到舊 checkpoint）；
//   在 Issue 留言 --note 的內容加一行 `prior: <prior 分支> @ <sha>`（gh）；把成員拆到自己的 batch（原 batch 那列記 `moved batch-<n>`，成員因此全是 moved 時原 batch 的 `current:` 寫成 `closed moved`，#205；batch-<n>.md 是表頭加一列；
//   原 batch 就是 `<n>` 時就地改寫 `current:` 與 `integration:`）；最後照一般 Dispatch 開分頁、送出 `/issue-run <n> --worker <batch-<n>.md>`。
//   不刪 worktree、不 `branch -D`（auto mode 擋 reset --hard 這類指令，就地改名也不必重建 worktree 與分頁），不刪 prior 分支。
//   每一步先看做過沒有：已有 prior、分支還沒有自己的 commit（相對整合分支）時是同一次重派中斷了，同一行指令接著做；留言已含 `prior:` 行就不再留。
//   batch-<n>.md 那列已是 running、它的分頁還開在這個 worktree 時，這次重派已經做完、fresh worker 正在跑：印 `STOP <n> running <handle>`，不關分頁。
//   留言用 gh，所以 --fresh 只支援 GitHub tracker。
//   prior 依序找 `-prior`、`-prior2`…：手動重派留下的 `-prior` 也算，那張 Issue 第一次跑 --fresh 就是 refresh-twice。
//   prior 已在、分支又有了 commit 就是第二次重派：印 `STOP refresh-twice <n>`，由 coordinator 開 gate；gate 選了再重派時帶 --again，另存成 `-prior2`（依序編號）。
//   認領不在這裡做：coordinator 照 Dispatch 先跑 claim；這裡只在動手前同樣檢查認領，不是這個 session 的就 `STOP <n> not-claimed`，什麼都不動。
//   沒帶 --note（#227）時只寫 `<主 checkout>/.scratch/pilot/fresh-<n>.md` 草稿、印 `NOTE_DRAFT <path>`，不派工：唯讀（只有 gh 讀 Issue 標題），
//   不檢查認領、不需要 ORCA_CLI_COMMAND，不改名分支、不開關分頁、不留言；帶派工才用的 --again、--capacity、--no-capacity、--repo-cap、--stuck-after 是用法錯誤（exit 2）。
//   寫草稿前先做帶 --note 時同一套重疊檢查（#425：coordinator 補完整併範圍帶 --note 重跑才撞上 `STOP <n> overlap`，那份範圍要等 #m 合入後重寫）：
//   有重疊印 `STOP <n> overlap <m> …`（比對失敗是 `STOP <n> overlap-check …`），不寫草稿；--allow-overlap 照寫。
//   成員分支不在時印 `STOP <n> git 沒有分支 <分支>`；batch-<key>.md 有這個成員的列、分支不同時（slug 打錯）行尾再接 `；checkpoint batch-<key>.md 的分支是 <分支>`（#469，帶 --note 的 --fresh 同）。
//   帶 --note 的 --fresh 印 DISPATCHED 之後，草稿（不論 --note 指哪個檔）改名成第一個空號的 `fresh-<n>-r<k>.md`（k 從 1 起），印 `DRAFT_ARCHIVED <n> <path>`（#437：
//   下一輪的草稿撞上前一輪已填的 fresh-<n>.md，只能手動 mv）；STOP 時不歸檔。
//   草稿已在時覆寫，但它的「怎麼整併」已經有內容（coordinator 補過、漏帶 --note 重跑）時印 `STOP <n> draft-filled <path>`，不動它。內容：原 Issue 號碼與標題；
//   prior 分支與 SHA（batch-<key>.md 那列的 candidate，空的取分支 tip）與 `git merge-base <分支> <整合分支>`；成員（prior SHA）與整合分支
//   自 merge-base 以來共同改過的檔，各附兩邊的 `git diff --stat` 那一行，`.md` 再附兩邊改到的 `- **<名稱>.**` 條目（pilot-probe 的 changedUnits；有條目外的改動時另註明），不印完整 diff；
//   每檔另附一行 worker 可逐檔取用 prior 改動的指令（#484：整批 diff 撞輸出上限）：`.md` 是 `git diff <merge-base> <prior> --word-diff=porcelain -- <檔> | grep '^+[^+]'`（只取新增字詞），
//   其他檔是 `git diff <merge-base> <prior> -- <檔>`；非 `.md` 的共同檔另列兩邊 `git diff -U0` 的 hunk 標頭（`@@ … @@ <所在函式>`）都出現的函式行
//   （`- 兩邊都改過的函式：…`，沒有交集時不印；#551：#502 與 #537 都改 pilot-watch 的 watch()，機械式兩邊都留、測試全綠，交會路徑卻漏記 POSTLAND）；
//   「沿用 prior 的 patch」一行整份套用指令 `git diff <merge-base> <prior> -- . ':!<路徑>'… | git apply -3`（#572），排除 prior 改過的戳記檔（STAMP_FILES 與副本清單本身）、
//   主 checkout 有 scripts/build-workflow-site.mjs 時的 docs/workflow/site（重產的流程站），與副本清單 docs/agents/workflow-templates.json 登記的副本：
//   副本只由 copy-templates 從正本產生，worker 不必判斷 copy-templates 的 CONFIRM_OVERWRITE 該不該加 --yes（fresh-502 套了 prior 的副本改動，exit 3 重跑）；
//   worker checkpoint（`<worktree>/.scratch/issue-run-<n>/state.md`）最後一個含 `review-only` 的行（如 `final review-only round`）到結果行（`DONE|STOP <n>`）的原文，
//   沒有結果行時到下一個 `#`／`##` 標題（不含）或檔尾（worker 的 checkpoint 沒有固定寫法），
//   沒有這段時改抄 worker 分頁尾段（#261）：batch-<key>.md 那列有 handle、設了 ORCA_CLI_COMMAND 時讀 pilot.md 的 Watch 同一個來源
//   `terminal read --screen --json` 的 `.result.terminal.tail`（整段，不只 Watch 看的最後 40 行），從最後一個以「Review」開頭的行到結果行，註明來源是分頁尾段；
//   讀不到（沒有 handle、分頁已關、沒有 ORCA_CLI_COMMAND、找不到起訖行）時才寫明要補 worker 分頁尾段；
//   「怎麼整併」之前是固定的「整併注意」段（#551，investing retro 1123c：note 寫「先 merge prior 再 merge 整合分支」，worktree 已在整合分支 tip，
//   第二個 merge 只回 unmerged files；「兩邊測試都保留」讓整合分支新增的測試呼叫 prior 已改掉的舊簽章）：只 merge prior、
//   兩邊測試都保留但改到 prior 的新簽章並以測試為準、兩邊都改過的函式要查交會路徑並補測試。
//   「整併注意」另固定印 scripts/entry-survival.mjs（存在時，#618）、scripts/port-entries.mjs 與 scripts/merge-line-inserts.mjs（存在時，#557）的指令；
//   草稿這一步若發現 prior 工作樹有未提交改動（#625），同樣備份並 stash，並在「怎麼整併」前加「prior 未提交的改動」段：patch 路徑、改到的檔、
//   `.scratch/issue-run-<n>*/wip/*.patch`，`.claude/settings.json`（受保護、owner 手改）單獨一行（段不放進「怎麼整併」，免得重跑草稿撞上 draft-filled）。
//   最後一段空白的「怎麼整併」給 coordinator 補，補完再帶 --note 重跑。
//
// 容量檢查是派工路徑（一般派工與帶 --note 的 --fresh）的預設（#534：從草稿切到派工時只加 --note，漏了 --capacity --repo-cap 4 就無聲派出）：
//   沒帶旗標時同帶 `--capacity --repo-cap 4`；--capacity 照舊可帶（無作用），--repo-cap <n> 換掉 repo 上限；只有顯式 --no-capacity 才兩項都略過、不讀也不寫帳本
//   （--no-capacity 和 --capacity、--repo-cap 一起帶是用法錯誤）。下面寫「帶 --capacity」「帶 --repo-cap」的段落都是指這個預設。
// 全機上限（#178）：帶 --capacity 時，動手前先以同目錄 pilot-capacity.mjs 的 check 合計全機帳本、加上這次要派的人數（--fresh 是 1）：
//   超過 $PILOT_MACHINE_WORKER_CAP 就只印 `STOP capacity <合計>/<上限> [<repo>=<n>...] +<人數>`（計入的列，#408）、exit 4，不寫 checkpoint、不建 worktree、不開分頁；沒超過先印 `CAPACITY ok <合計>/<上限>`。
//   $PILOT_MACHINE_WORKER_CAP 空白時先印 `CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP default 4 → 告訴人：設在 ~/.claude/settings.json 的 env`，照預設 4 比（#396、#494）。
//   --no-capacity 時不讀帳本。帳本的本 repo 那一列由 pilot-probe.mjs --capacity 每輪更新，所以派工前要先跑過這一輪的 probe。
//   有成員 DISPATCHED 時（#353），最後以帳本本 repo 那一列的現值加上派出人數改寫那一列（pilot-capacity 的 report，讀寫在同一把鎖裡），
//   印 `REPORTED <repo> <running> <合計>/<上限>`：同一輪連續兩次 dispatch，第二次的合計就含第一次的成員。<repo> 是主 checkout 的目錄名，
//   Probe 的 `--capacity <repo>` 要用同一個名稱。寫不進帳本時 stderr 印 `WARN capacity-report <原因>`，exit 不變。
// 單一 repo 上限（#353）：帶 --repo-cap <n> 時，動手前先數本 repo `.scratch/pilot/` 開著（current 不是 closed）的 batch checkpoint 的 running 列
//   （這次要派的成員自己的列不算，免得重跑時重複計），加上這次要派的人數：超過 <n> 就只印 `STOP capacity repo <合計>/<n>`、exit 4，什麼都不動；
//   沒超過先印 `CAPACITY ok repo <合計>/<n>`。只讀 checkpoint（pilot-probe.mjs 的 parseBatch）。兩個旗標都帶時先比 repo、再比全機。
// 放掉認領（#353）：印 `STOP capacity …`（全機或 repo）之後，逐一讀成員最近一則認領留言，屬這個 session 的就以同目錄 gh-tracker.mjs
//   `edit <n> --remove-assignee @me` 放掉指派、印 `RELEASED <n>`；別人的認領不動。讀不到留言時 stderr 印 `WARN release <n> claim-check …`（或 `timeout`，認領者不明，不放），
//   放掉失敗時印 `WARN release <n> edit <原因>`；exit 都仍是 4。
//
// 用法：node scripts/pilot-dispatch.mjs <batch key> <n>:<slug>... [--allow-overlap] [--capacity] [--repo-cap <n>|--no-capacity] [--integration <分支>] [--stuck-after <分鐘>m]（在主 checkout 跑，需要 ORCA_CLI_COMMAND）
//       node scripts/pilot-dispatch.mjs <batch key> --fresh <n>:<slug> --note <檔> [--again] [--allow-overlap] [--capacity] [--repo-cap <n>|--no-capacity] [--integration <分支>] [--stuck-after <分鐘>m]
//       node scripts/pilot-dispatch.mjs <batch key> --fresh <n>:<slug> [--allow-overlap] [--integration <分支>]（草稿，不需要 ORCA_CLI_COMMAND）
//   --integration worktree 的 base 與表頭的整合分支，預設 pilot/integration；--stuck-after 成員行的 stuck-after，預設 90m；--repo-cap 預設 4（見上）。
// stdout：容量行（CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP default 4 → …、CAPACITY ok repo …、CAPACITY ok …，或 STOP capacity repo …、STOP capacity … 接 RELEASED <n>）、Orca 不能用時唯一的成員外 STOP orca-unavailable <第一行>（見上）、最後的 REPORTED <repo> …（見上）；
//   stderr 另有 WARN release …、WARN capacity-report …、WARN orca-register …、WARN stamp-files …。每個成員一行 DISPATCHED <n> <terminal handle> 或 STOP <n> <原因>（not-claimed、claim-check（讀不到留言）、running、overlap、overlap-check、worktree-branch、create、unbare、terminal、tui-timeout、send、orca、timeout、signal），Env sync 失敗是 `STOP sync <n> exit <code>`（見上）；
//   Bare guard 還原主 checkout 時另有一行 UNBARE <主 checkout>。成員行同時寫進 <主 checkout>/.scratch/pilot/batch-<key>.md，
//   state 只寫 running 或 stop（pilot-probe.mjs 只認 PILOT-STORE.md 的 running／done／stop；running、overlap 的 STOP 不改寫那一列；
//   send 的 STOP 記 running：worker 可能其實已在跑，交給 Probe 判定，#354），STOP 原因只在 stdout。
//   每個成員的 STOP 行（含 --fresh 與草稿的）最後一欄是 ` row=<kept|stop|running>`：這一行之後成員列沒動（kept），或寫成 stop、running（investing#481：
//   哪些 STOP 改寫成員列以前只能讀程式碼）。HOLD 行不改成員列。不屬於成員的 STOP capacity、STOP orca-unavailable 不寫任何列，也沒有這一欄。
//   --fresh 帶 --note 時 prior 有未提交改動、已備份就先印 `DIRTY_BACKUP <n> <patch>`；成功時 DISPATCHED 之後再印 `PRIOR <n> <prior 分支> <sha>`，有草稿時再印 `DRAFT_ARCHIVED <n> <path>`；草稿只印 `NOTE_DRAFT <path>`（exit 0）或 `STOP <n> git …`、`STOP <n> overlap …`、`STOP <n> overlap-check …`、`STOP <n> title …`、`STOP <n> draft-filled <path>`（exit 4）；另有 `STOP <n> backup <原因>`、`STOP refresh-twice <n>`、`STOP <n> running <handle>`、`STOP <n> worktree …`、`STOP <n> git …`、`STOP <n> terminal-close …`、`STOP <n> comment …`。
// exit：0 全部派出（草稿：寫好）；4 有成員 STOP 或 HOLD（或 STOP capacity、STOP orca-unavailable）；3 checkpoint 鎖等到逾時（印 `CHECKPOINT_LOCKED <lock> <持鎖內容>`，#345）；2 用法錯誤（含草稿帶了派工旗標、Env sync 宣告寫錯）或派工時沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimedBy, defaultSession } from './issue-pool.mjs';
import { orca, sendToSession } from './orca-session-send.mjs';
import { closeIfAllMoved, exitIfLocked, updateCheckpoint } from './lib/pilot-store.mjs';
import { ADAPTER, changedUnits, memberOverlaps, parseBatch, pilotFiles, pilotSection } from './pilot-probe.mjs';
import { envMissingLines, check as capacityCheck, ledgerPath, machineCap, report as capacityReport, stopLine as capacityStopLine } from './pilot-capacity.mjs';
import { recordTitle, withState } from './tab-state.mjs';

const USAGE = '用法：node scripts/pilot-dispatch.mjs <batch key> <n>:<slug>... [--allow-overlap] [--capacity] [--repo-cap <n>|--no-capacity] [--integration <分支>] [--stuck-after <分鐘>m]（需要 ORCA_CLI_COMMAND；容量檢查預設做，--repo-cap 預設 4）\n'
  + '      node scripts/pilot-dispatch.mjs <batch key> --fresh <n>:<slug> --note <檔> [--again] [--allow-overlap] [--capacity] [--repo-cap <n>|--no-capacity] [--integration <分支>] [--stuck-after <分鐘>m]\n'
  + '      node scripts/pilot-dispatch.mjs <batch key> --fresh <n>:<slug> [--allow-overlap] [--integration <分支>]（只寫 fresh-<n>.md 草稿、不派工）';
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'pilot-unbare.sh');
const WORKTREE_CREATE = fileURLToPath(new URL('./orca-worktree-create.mjs', import.meta.url));
const TRACKER = fileURLToPath(new URL('./gh-tracker.mjs', import.meta.url));
const BUDGET_MS = Number(process.env.PILOT_DISPATCH_BUDGET_MS || 510000);
const DEADLINE = Date.now() + BUDGET_MS;
// 上限用 ??：0 是合法值（只查一次，測試用），間隔與預算的 || 則把 0 當成沒設。
const REGISTER_MS = Number(process.env.PILOT_DISPATCH_REGISTER_MS ?? 60000);
const REGISTER_POLL_MS = Number(process.env.PILOT_DISPATCH_REGISTER_POLL_MS || 2000);
/** 派工路徑預設的單一 repo 上限（#534：沒帶 --repo-cap 時用它，--no-capacity 才略過）。 */
const DEFAULT_REPO_CAP = 4;
/** 副本清單（copy-templates.mjs 的同一份）：草稿的 patch 指令排除它登記的副本（#572）。 */
const MANIFEST = 'docs/agents/workflow-templates.json';
/** 戳記檔（#460）：main 開頭由 stampFilesOf 載入，overlapStop 比對時略過。 */
let stampFiles = [];

/** Orca 還沒登記 worktree 時 `terminal create` 的 error code（orca-session-send 的 orca() 以它當錯誤訊息）。 */
const SELECTOR_NOT_FOUND = 'selector_not_found';

/** adapter 裡 Env sync 宣告行的寫法（#363）：`Env sync:` 開頭的行，或 Pilot 條目格式的 `- **Env sync.**`。 */
const ENV_SYNC = /^(?:[-*]\s+)?(?:Env sync:|\*\*Env sync\.\*\*)(.*)$/;

/** adapter 各檔的 `{ file, text }` → Env sync 宣告的指令；沒有宣告傳回 undefined，宣告寫錯（沒有反引號指令、超過一次）時丟錯。 */
function declaredEnvSync(sources) {
  const declarations = sources.flatMap(({ file, text }) => String(text ?? '').split('\n').map(line => line.trim())
    .map(line => ({ file, line, rest: ENV_SYNC.exec(line)?.[1] })).filter(({ rest }) => rest !== undefined));
  if (declarations.length > 1) throw new Error(`Env sync 宣告了 ${declarations.length} 次，只能有一行：${declarations.map(({ file, line }) => `${file}：${line}`).join('；')}`);
  if (!declarations.length) return undefined;
  const [{ file, line, rest }] = declarations;
  const command = rest.match(/`([^`]+)`/)?.[1].trim();
  if (!command) throw new Error(`${file} 的 Env sync 行沒有指令（寫成 Env sync: \`<指令>\`）：${line}`);
  return command;
}

/** 主 checkout 的 adapter 的 Pilot 段與它連到的檔（pilot-probe.mjs 的 pilotFiles）宣告的 Env sync 指令；檔案不在就當沒宣告。 */
function envSyncCommand(main) {
  const read = file => (existsSync(join(main, file)) ? readFileSync(join(main, file), 'utf8') : '');
  const adapter = read(ADAPTER);
  return declaredEnvSync([{ file: ADAPTER, text: pilotSection(adapter) }, ...pilotFiles(adapter).map(file => ({ file, text: read(file) }))]);
}

/** 在 worktree 裡以 `sh -c` 跑 Env sync 指令，輸出轉到 stderr；傳回 exit code（被信號殺掉時是信號名稱）。`signal` 中止時丟錯。 */
async function runEnvSync(command, worktree, signal) {
  const child = spawn('sh', ['-c', command], { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'], signal });
  child.stdout.pipe(process.stderr, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, killed) => resolve(code ?? killed));
  });
}

/** 成員的 STOP 行：Env sync 失敗照 #363 指定的 `STOP sync <n> …`（同 `STOP dirty <n>` 的語序），其他是 `STOP <n> <原因>`；最後接 ` row=<row>`（見檔頭）。 */
function stopLine(n, stop, row) {
  return `${stop.startsWith('sync ') ? `STOP sync ${n} ${stop.slice(5)}` : `STOP ${n} ${stop}`} row=${row}`;
}

/** 同步跑子行程；stdin 一律接 /dev/null。 */
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) throw new Error(`git worktree list 失敗：${result.stderr.trim()}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** `git worktree list` 裡分支是 `branch`、目錄也存在的 worktree 路徑；沒有傳回 undefined。 */
function worktreeOf(main, branch) {
  const result = run('git', ['-C', main, 'worktree', 'list', '--porcelain']);
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\n\n+/)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.branch === branch && w.path && existsSync(w.path))?.path;
}

/** `git worktree list` 裡目錄名是 `name`、目錄也存在的 worktree `{ path, branch }`（detached 時 branch 是 undefined）；主 checkout 不算。 */
function worktreeNamed(main, name) {
  const result = run('git', ['-C', main, 'worktree', 'list', '--porcelain']);
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\n\n+/).slice(1)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.path && basename(w.path) === name && existsSync(w.path));
}

/**
 * Orca 能不能用（#394）：跑一次 `worktree list --json`，能用傳回 undefined，不能用傳回訊息的第一個非空行（Orca 的 error code，或 stderr、stdout）。
 * spawnSync 期間總預算的計時器不會觸發，所以自己限時（60 秒與剩餘預算取小）。
 */
function orcaUnavailable(cli) {
  const listed = run(cli, ['worktree', 'list', '--json'], { timeout: Math.max(1, Math.min(60000, DEADLINE - Date.now())) });
  let body;
  try { body = JSON.parse(listed.stdout); } catch { body = undefined; }
  if (listed.status === 0 && body?.ok === true) return undefined;
  const text = body?.ok === false ? `${body.error?.code ?? body.error?.message ?? ''}` : `${listed.stderr ?? ''}\n${listed.stdout ?? ''}`;
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? `exit ${listed.status ?? listed.error?.code}`;
}

/** Orca 回的 worktree 路徑是不是 `path`：WSL 上是 `\\wsl.localhost\<distro>\…` 的 UNC，反斜線換成斜線後比尾段。 */
function sameWorktreePath(orcaPath, path) {
  const posix = String(orcaPath ?? '').replace(/\\/g, '/');
  return posix === path || (posix.startsWith('//') && path.startsWith('/') && posix.endsWith(path));
}

/** 輪詢 Orca `worktree list` 直到列出 `worktree`，最多 REGISTER_MS；列出傳回 true，到上限時 stderr 印 `WARN orca-register <路徑>` 並傳回 false。Orca 一時失敗當作還沒列出；`signal` 中止時丟錯。 */
async function awaitRegistered(ctx, worktree) {
  const until = Date.now() + REGISTER_MS;
  for (;;) {
    try {
      if ((await orca(ctx, 'worktree', 'list')).worktrees?.some(({ path }) => sameWorktreePath(path, worktree))) return true;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
    }
    if (Date.now() + REGISTER_POLL_MS > until) {
      console.error(`WARN orca-register ${worktree}`);
      return false;
    }
    await sleep(REGISTER_POLL_MS, undefined, { signal: ctx.signal });
  }
}

/** 本 repo 開著（current 不是 closed）的 batch checkpoint 裡 running 的列數；`skip` 裡的 Issue（這次要派的成員）不算。只讀。 */
function repoRunning(main, skip) {
  const pilot = join(main, '.scratch/pilot');
  if (!existsSync(pilot)) return 0;
  return readdirSync(pilot).filter(file => /^batch-.+\.md$/.test(file))
    .map(file => parseBatch(readFileSync(join(pilot, file), 'utf8')))
    .filter(({ current }) => !/^closed\b/.test(current))
    .flatMap(({ members }) => members)
    .filter(({ n, state }) => state === 'running' && !skip.has(n)).length;
}

/** STOP capacity 之後放掉這個 session 認領的成員（#353）：放掉的印 `RELEASED <n>`，讀不到留言或放掉失敗時 stderr 印 WARN；別人的認領不動。 */
function releaseClaims(members) {
  for (const { n } of members) {
    const stop = claimStop(n);
    if (stop === 'not-claimed') continue;
    if (stop) { console.error(`WARN release ${n} ${stop}`); continue; }
    const left = DEADLINE - Date.now();
    const edited = left > 0 ? run('node', [TRACKER, 'edit', n, '--remove-assignee', '@me'], { timeout: Math.min(60000, left) }) : { status: null, stderr: 'timeout' };
    if (edited.status === 0) console.log(`RELEASED ${n}`);
    else console.error(`WARN release ${n} edit ${(edited.stderr ?? '').trim().replace(/\s*\n\s*/g, ' ') || `exit ${edited.status ?? edited.error?.code}`}`);
  }
}

/** 本地時區的 ISO 時間到秒（同 `date -Iseconds`），例如 2026-10-30T17:31:36+08:00。 */
function now() {
  const date = new Date();
  const offset = -date.getTimezoneOffset();
  const pad = value => String(Math.floor(Math.abs(value))).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19);
  return `${local}${offset < 0 ? '-' : '+'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** 沒有 batch checkpoint 時寫表頭（格式見 skills/engineering/issue-pilot/PILOT-STORE.md）；已有時不動，重跑同一個 batch 只換成員行。 */
function writeHeader(main, checkpoint, key, integration) {
  if (existsSync(checkpoint)) return;
  const sha = run('git', ['-C', main, 'rev-parse', '--short', integration]).stdout.trim();
  mkdirSync(dirname(checkpoint), { recursive: true });
  writeFileSync(checkpoint, `# batch ${key}\ncurrent: dispatched ${now()}\nintegration: ${integration} @ ${sha}\n\n`
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n');
}

/** --fresh 拆出的 batch：沒有就照 writeHeader 寫；已有（中斷後重跑、原 batch 就是 `<n>`）時改寫 `current:` 與 `integration:`。 */
function freshHeader(main, checkpoint, key, integration) {
  if (!existsSync(checkpoint)) return writeHeader(main, checkpoint, key, integration);
  const sha = run('git', ['-C', main, 'rev-parse', '--short', integration]).stdout.trim();
  updateCheckpoint(checkpoint, text => text
    .replace(/^current:.*$/m, `current: dispatched ${now()}`).replace(/^integration:.*$/m, `integration: ${integration} @ ${sha}`));
}

/**
 * 成員列的 state：派出或 `STOP send` 記 running，其他 STOP 記 stop。
 * `STOP send` 時 worker 可能其實已收下 prompt 在跑（#354），記成 stop 會讓 coordinator 重派、把 `/issue-run` 再排進佇列；
 * 記 running 交給 pilot-probe.mjs 判定，重跑 dispatch 時分頁還開著就 `STOP <n> running`、不再送。
 */
function rowState(stop) {
  return !stop || stop.startsWith('send ') ? 'running' : 'stop';
}

/** 把成員行的 state 欄改成 `state`；沒有這一行就不動。改完成員全是 moved 時 `current:` 寫成 `closed moved`（同 pilot-batch，#205）。 */
function setRowState(checkpoint, n, state) {
  if (!existsSync(checkpoint)) return;
  updateCheckpoint(checkpoint, text => {
    const lines = text.split('\n');
    const i = lines.findIndex(line => line.startsWith(`| ${n} |`));
    if (i < 0) return undefined;
    const cells = lines[i].split('|');
    cells[7] = ` ${state} `;
    lines[i] = cells.join('|');
    closeIfAllMoved(lines);
    return lines.join('\n');
  });
}

/** 成員行是在 worker 派出之後才寫的，等鎖的預設上限放寬到 120 秒（`PILOT_STORE_LOCK_TIMEOUT_MS` 照樣優先）：逾時時重跑會重複派工（#345）。 */
const ROW_LOCK_TIMEOUT_MS = 120000;

/** 寫入成員行：同一個 Issue 已有一行就就地換掉，否則接在最後。 */
function writeRow(checkpoint, n, cells) {
  const row = `| ${n} | ${cells.join(' | ')} | |`;
  updateCheckpoint(checkpoint, text => {
    const lines = text.replace(/\n$/, '').split('\n');
    const i = lines.findIndex(line => line.startsWith(`| ${n} |`));
    if (i >= 0) lines[i] = row; else lines.push(row);
    return `${lines.join('\n')}\n`;
  }, { timeout: Number(process.env.PILOT_STORE_LOCK_TIMEOUT_MS) || ROW_LOCK_TIMEOUT_MS });
}

/**
 * 認領檢查：這個 session 的認領傳回 undefined，否則傳回 STOP 原因（不含 `STOP <n> ` 前綴）。
 * spawnSync 期間總預算的計時器不會觸發，所以 gh 自己限時（60 秒與剩餘預算取小），預算用完就是 `timeout`；原因壓成一行，stdout 才維持每個成員一行。
 */
function claimStop(n) {
  return issueCheck(n, false).stop;
}

/**
 * 認領檢查（claimStop）；`withBlockers` 時同一次 `gh issue view` 多讀 blockedBy 與 url，傳回開著、同 repo（url 去掉號碼後相同）的 blocker 號碼：
 * `{ stop }` 或 `{ blockers }`。舊版 gh 不認得 blockedBy（`Unknown JSON field`）時只讀留言，blockers 是空的。
 */
function issueCheck(n, withBlockers) {
  const view = fields => {
    const left = DEADLINE - Date.now();
    return left <= 0 ? undefined : run('gh', ['issue', 'view', n, '--json', fields], { timeout: Math.min(60000, left) });
  };
  let viewed = view(withBlockers ? 'comments,blockedBy,url' : 'comments');
  if (withBlockers && viewed && viewed.status !== 0 && /Unknown JSON field/i.test(viewed.stderr ?? '')) viewed = view('comments');
  if (!viewed || Date.now() >= DEADLINE) return { stop: 'timeout' };
  const detail = (viewed.stderr ?? '').trim().replace(/\s*\n\s*/g, ' ');
  if (viewed.status !== 0) return { stop: `claim-check ${detail || `exit ${viewed.status ?? viewed.error?.code}`}` };
  let issue;
  try { issue = JSON.parse(viewed.stdout); } catch { return { stop: 'claim-check gh issue view 的輸出不是 JSON' }; }
  if (!claimedBy(issue.comments, defaultSession())) return { stop: 'not-claimed' };
  const project = url => String(url ?? '').replace(/\/\d+$/, '');
  const blockers = (issue.blockedBy?.nodes ?? [])
    .filter(({ number, state, url }) => Number.isInteger(number) && state === 'OPEN' && issue.url && project(url) === project(issue.url))
    .map(({ number }) => String(number));
  return { blockers };
}

/** `blockers` 裡本機分支 `issue/<m>-*`（不含 -prior 另存）有 commit 不在整合分支的號碼，依原順序。git 失敗的分支不算。 */
function unstagedBlockers(main, integration, blockers) {
  return blockers.filter(m => {
    const refs = run('git', ['-C', main, 'for-each-ref', '--format=%(refname:short)', `refs/heads/issue/${m}-*`]);
    return refs.status === 0 && refs.stdout.split('\n').filter(branch => branch && !/-prior\d*$/.test(branch))
      .some(branch => Number(run('git', ['-C', main, 'rev-list', '--count', `${integration}..${branch}`]).stdout.trim()) > 0);
  });
}

/**
 * 主 checkout 的戳記檔（#460）：有 scripts/restamp.mjs 時取它匯出的 STAMP_FILES（land.mjs 的 restampConflicts 讀的同一份，不另抄），沒有時空陣列。
 * 載入失敗時 stderr 印 `WARN stamp-files <原因>`，傳回空陣列（照舊全比，寧可多擋）。
 */
async function stampFilesOf(main) {
  const script = join(main, 'scripts/restamp.mjs');
  if (!existsSync(script)) return [];
  try {
    const { STAMP_FILES = [] } = await import(pathToFileURL(script).href);
    return Array.isArray(STAMP_FILES) ? STAMP_FILES : [];
  } catch (error) {
    console.error(`WARN stamp-files ${error.message.replace(/\s*\n\s*/g, ' ')}`);
    return [];
  }
}

/** 重疊的一處（`<檔案>` 或 `<檔案>:<條目>`）是不是戳記檔。 */
const isStamp = where => stampFiles.some(file => where === file || where.startsWith(`${file}:`));

/** 重疊檢查：`branch` 和開著的 batch 裡其他 running、done 成員有重疊（戳記檔不算，#460）時傳回 STOP 原因（不含 `STOP <n> ` 前綴），否則 undefined。 */
function overlapStop(main, n, branch, integration) {
  let found;
  try {
    found = memberOverlaps(main, n, branch, { integration })
      .map(({ m, where }) => ({ m, where: where.filter(place => !isStamp(place)) })).filter(({ where }) => where.length);
  } catch (error) {
    return `overlap-check ${error.message.replace(/\s*\n\s*/g, ' ')}`;
  }
  return found.length ? `overlap ${found.map(({ m, where }) => `${m} ${where.join(' ')}`).join(', ')}` : undefined;
}

/** worktree 裡開著的 terminal handle；失敗時丟錯。 */
async function openTerminals(ctx, worktree) {
  return (await orca(ctx, 'terminal', 'list', '--worktree', `path:${worktree}`)).terminals.map(({ handle }) => handle);
}

/** checkpoint 裡成員 `n` 那一列的各欄（去掉前後空白，[1] 是 Issue、[4] 是 handle、[7] 是 state）；沒有檔或沒有這一列傳回 undefined。 */
function rowOf(checkpoint, n) {
  if (!existsSync(checkpoint)) return undefined;
  return readFileSync(checkpoint, 'utf8').split('\n').find(line => line.startsWith(`| ${n} |`))?.split('|').map(cell => cell.trim());
}

/** 非同步跑子行程（stdin 接 /dev/null），傳回 stdout；`signal` 中止時殺掉它。 */
async function spawnText(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return stdout;
}

/**
 * 派一個成員；傳回 `{ worktree?, handle }`、`{ worktree?, handle?, stop, keep? }`（不含 `STOP <n> ` 前綴；`keep` 時什麼都沒動，成員列也不改寫），
 * 或 `{ hold, keep: true }`（不含 `HOLD <n> ` 前綴；`checkBlockers` 為真時才檢查，--fresh 不檢查）。
 * `envSync` 是 adapter 宣告的 Env sync 指令（沒宣告時 undefined），worktree 確認建好之後、開分頁之前在裡面跑。
 * worktree 已存在（重跑 STOP 的成員）時不再 create：再呼叫一次，Orca 會去重出 `issue-<n>-2`。
 * `signal` 中止時（reason 為 `timeout` 或 `signal <名稱>`）進行中的步驟丟錯，STOP 原因改用 reason；create 被中止時仍跑 Bare guard。
 */
async function dispatchMember(cli, main, checkpoint, integration, { n, branch }, signal, allowOverlap, envSync, checkBlockers = false) {
  if (signal.aborted) return { stop: signal.reason };
  const checked = issueCheck(n, checkBlockers);
  if (checked.stop) return { stop: checked.stop };
  let created = '';
  const existed = worktreeOf(main, branch);
  const ctx = { cli, signal };
  if (existed) {
    // 同 --fresh：那一列還是 running、它的分頁也還開著，就是 worker 正在跑，不關它（整批重跑時只該重派 STOP 的成員）。
    let open;
    try {
      open = await openTerminals(ctx, existed);
    } catch (error) {
      // 還沒動任何東西：成員列照舊，running 的 worker 下次重跑仍擋得住。
      return { stop: signal.aborted ? signal.reason : `terminal-close ${error.message}`, keep: true };
    }
    const row = rowOf(checkpoint, n);
    if (row?.[7] === 'running' && open.includes(row[4])) return { stop: `running ${row[4]}`, keep: true };
  }
  const unstaged = checkBlockers ? unstagedBlockers(main, integration, checked.blockers) : [];
  if (unstaged.length) return { hold: `blocker ${unstaged.join(',')} unstaged`, keep: true };
  const overlap = !allowOverlap && overlapStop(main, n, branch, integration);
  if (overlap) return { worktree: existed, stop: overlap, keep: !overlap.startsWith('overlap-check ') };
  if (!existed) {
    const taken = worktreeNamed(main, `issue-${n}`);
    if (taken) return { stop: `worktree-branch ${taken.path} ${taken.branch ?? '(detached)'}` };
    try {
      created = await spawnText('node', [WORKTREE_CREATE, '--name', `issue-${n}`, '--base-branch', integration, '--branch', branch, '--issue', n],
        { cwd: main, env: { ...process.env, ORCA_BIN: cli }, signal });
    } catch (error) {
      created = error.message;
    }
  }
  if (existsSync(GUARD)) {
    const unbare = run(GUARD, [main, `dispatch #${n}`]);
    if (unbare.stdout) process.stdout.write(unbare.stdout);
    if (unbare.status !== 0) return { stop: `unbare ${(unbare.stderr ?? '').trim() || `exit ${unbare.status ?? unbare.error?.code}`}` };
  }
  const worktree = worktreeOf(main, branch);
  if (signal.aborted) return { worktree, stop: signal.reason };
  if (!worktree) {
    let detail = created.trim();
    try { detail = JSON.parse(detail).error ?? detail; } catch { /* 非 JSON 就原樣附上 */ }
    return { stop: `create ${detail}` };
  }
  if (envSync) {
    let code;
    try {
      code = await runEnvSync(envSync, worktree, signal);
    } catch (error) {
      return { worktree, stop: signal.aborted ? signal.reason : `sync ${error.message}` };
    }
    if (signal.aborted) return { worktree, stop: signal.reason };
    if (code !== 0) return { worktree, stop: `sync exit ${code}` };
  }
  if (existed) {
    try {
      for (const handle of await openTerminals(ctx, worktree)) await orca(ctx, 'terminal', 'close', '--terminal', handle);
    } catch (error) {
      return { worktree, stop: signal.aborted ? signal.reason : `terminal-close ${error.message}` };
    }
  }
  const title = withState(`#${n}`, '處理中');
  let handle;
  const createTerminal = () => orca(ctx, 'terminal', 'create', '--worktree', `path:${worktree}`, '--title', title, '--command', 'claude');
  try {
    await awaitRegistered(ctx, worktree);
    let opened;
    try {
      opened = await createTerminal();
    } catch (error) {
      // Orca 還在背景登記剛建好的 worktree（#394）：等它列出來再試一次。
      if (signal.aborted || error.message !== SELECTOR_NOT_FOUND) throw error;
      await awaitRegistered(ctx, worktree);
      opened = await createTerminal();
    }
    handle = opened.terminal.handle;
    // Orca 讀不回 create 設的標題，worker 的 tab-state 靠這份記錄（scripts/tab-state.mjs）。
    recordTitle(handle, title);
  } catch (error) {
    // 殺掉 create 時 Orca 可能已開好分頁卻沒回 handle。
    if (signal.aborted) return { worktree, stop: `${signal.reason}（請確認有沒有留下標題 ${title} 的分頁）` };
    return { worktree, stop: `terminal ${error.message}` };
  }
  const sent = await sendToSession(ctx, handle, `/issue-run ${n} --worker ${checkpoint}`);
  return { worktree, handle, ...(sent.stop && signal.aborted ? { stop: signal.reason } : sent) };
}

/** 成員分支不在時的 STOP 原因（不含 `STOP `，#469）：batch-<key>.md 有這個成員的列、分支不同（slug 打錯）時附上 checkpoint 的分支。 */
function missingBranch(main, key, { n, branch }) {
  const listed = rowOf(join(main, `.scratch/pilot/batch-${key}.md`), n)?.[2];
  return `${n} git 沒有分支 ${branch}${listed && listed !== branch ? `；checkpoint batch-${key}.md 的分支是 ${listed}` : ''}`;
}

const priorName = (branch, k) => `${branch}-prior${k > 1 ? k : ''}`;
const hasBranch = (main, branch) => run('git', ['-C', main, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0;

/**
 * --fresh 的重派前置：做到「worktree 停在從整合分支新開的分支、batch-<n>.md 準備好」為止（步驟見檔頭）。
 * 傳回 `{ checkpoint, prior, sha, worktree }`，或 `{ stop }`（整段 STOP 字串，不含 `STOP `）。
 */
async function refresh(cli, main, key, integration, { n, branch }, note, again, allowOverlap, signal) {
  const unclaimed = claimStop(n);
  if (unclaimed) return { stop: `${n} ${unclaimed}` };
  const priors = [];
  while (hasBranch(main, priorName(branch, priors.length + 1))) priors.push(priorName(branch, priors.length + 1));
  const latest = priors.at(-1);
  // 同一次重派中斷了：prior 已在，分支還沒開或還沒有 fresh worker 的 commit。
  const resuming = latest && (!hasBranch(main, branch)
    || run('git', ['-C', main, 'rev-list', '--count', `${integration}..${branch}`]).stdout.trim() === '0');
  if (latest && !resuming && !again) return { stop: `refresh-twice ${n}` };
  if (!latest && !hasBranch(main, branch)) return { stop: missingBranch(main, key, { n, branch }) };
  // fresh worker 要重做的是 prior 那份改動：比對它（中斷後續做時是已另存的 prior）。
  const overlap = !allowOverlap && overlapStop(main, n, resuming ? latest : branch, integration);
  if (overlap) return { stop: `${n} ${overlap}` };
  const prior = resuming ? latest : priorName(branch, priors.length + 1);
  const worktree = worktreeOf(main, branch) ?? (resuming ? worktreeOf(main, prior) : undefined);
  if (!worktree) return { stop: `${n} worktree 找不到 ${branch} 的 worktree` };
  const checkpoint = join(main, `.scratch/pilot/batch-${n}.md`);
  const ctx = { cli, signal };
  let open;
  try {
    open = await openTerminals(ctx, worktree);
  } catch (error) {
    return { stop: signal.aborted ? `${n} ${signal.reason}` : `${n} terminal-close ${error.message}` };
  }
  const row = resuming ? rowOf(checkpoint, n) : undefined;
  if (row?.[7] === 'running' && open.includes(row[4])) return { stop: `${n} running ${row[4]}` };
  const git = (...args) => run('git', ['-C', worktree, ...args]);
  const status = git('status', '--porcelain');
  if (status.status !== 0) return { stop: `${n} git status ${status.stderr.trim()}` };
  if (status.stdout.trim()) {
    // #625：prior 工作樹有未提交改動不再 STOP dirty：備份成 patch、stash，草稿的「prior 未提交的改動」段列出；備份本身失敗才 STOP。
    const saved = backupDirty(main, worktree, n);
    if (saved.error) return { stop: `${n} backup ${saved.error}` };
    if (saved.patch) console.log(`DIRTY_BACKUP ${n} ${saved.patch}`);
  }

  try {
    for (const handle of open) await orca(ctx, 'terminal', 'close', '--terminal', handle);
  } catch (error) {
    return { stop: signal.aborted ? `${n} ${signal.reason}` : `${n} terminal-close ${error.message}` };
  }
  for (const [check, args] of [
    [() => hasBranch(main, prior), ['branch', '-m', branch, prior]],
    [() => hasBranch(main, branch), ['switch', '-q', '-c', branch, integration]],
    [() => git('branch', '--show-current').stdout.trim() === branch, ['switch', '-q', branch]],
  ]) {
    if (check()) continue;
    const result = git(...args);
    if (result.status !== 0) return { stop: `${n} git ${args[0]} ${result.stderr.trim()}` };
  }
  const sha = run('git', ['-C', main, 'rev-parse', prior]).stdout.trim();
  const suffix = prior.slice(branch.length);
  const [oldState, priorState] = [`issue-run-${n}`, `issue-run-${n}${suffix}`].map(name => join(worktree, '.scratch', name));
  if (existsSync(oldState) && !existsSync(priorState)) renameSync(oldState, priorState);

  const marker = `prior: ${prior} @ ${sha}`;
  const gh = (...args) => run('gh', args);
  const viewed = gh('issue', 'view', n, '--json', 'comments');
  if (viewed.status !== 0) return { stop: `${n} comment ${viewed.stderr.trim()}` };
  let comments;
  try { comments = JSON.parse(viewed.stdout).comments; } catch { return { stop: `${n} comment gh issue view 的輸出不是 JSON` }; }
  if (!comments.some(({ body }) => body.includes(marker))) {
    const posted = gh('issue', 'comment', n, '--body', `${note.replace(/\s+$/, '')}\n\n${marker}`);
    if (posted.status !== 0) return { stop: `${n} comment ${posted.stderr.trim()}` };
  }

  if (key !== n) setRowState(join(main, `.scratch/pilot/batch-${key}.md`), n, `moved batch-${n}`);
  freshHeader(main, checkpoint, n, integration);
  return { checkpoint, prior, sha, worktree };
}

/**
 * prior 工作樹有未提交的改動時（#625）：staged、未 staged 與未追蹤的檔（`.scratch/` 除外）存成 `<主 checkout>/.scratch/pilot/backup/issue-<n>-dirty.patch`
 * （已有時接 -2、-3…，不覆寫），再 stash（含未追蹤）讓工作樹乾淨。傳回 `{ patch, files }`，沒有改動時 `{}`，備份或 stash 失敗時 `{ error }`（改動留在原處）。
 */
function backupDirty(main, worktree, n) {
  const git = (...args) => run('git', ['-C', worktree, ...args]);
  const status = git('status', '--porcelain');
  if (status.status !== 0) return { error: `git status ${status.stderr.trim()}` };
  if (!status.stdout.trim()) return {};
  const tracked = git('diff', 'HEAD');
  const untracked = git('ls-files', '-o', '--exclude-standard', '-z');
  if (tracked.status !== 0 || untracked.status !== 0) return { error: `git diff ${(tracked.stderr + untracked.stderr).trim()}` };
  const added = untracked.stdout.split('\0').filter(file => file && !file.startsWith('.scratch/')).map(file => git('diff', '--no-index', '--', '/dev/null', file).stdout);
  const body = [tracked.stdout, ...added].join('');
  if (!body.trim()) return {};
  const dir = join(main, '.scratch/pilot/backup');
  let patch = join(dir, `issue-${n}-dirty.patch`);
  for (let k = 2; existsSync(patch); k++) patch = join(dir, `issue-${n}-dirty-${k}.patch`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(patch, body);
  } catch (error) {
    return { error: `寫入 ${patch} 失敗：${error.message}` };
  }
  // .scratch/ 沒被 ignore 時要排除（worker 的 checkpoint 不能被 stash 走）；被 ignore 時給 pathspec 反而讓 git 報錯。
  const keep = git('check-ignore', '-q', '.scratch/x').status === 0 ? [] : ['--', '.', ':!.scratch'];
  const stash = git('stash', 'push', '-u', '-m', `pilot-dispatch issue-${n} dirty backup`, ...keep);
  if (stash.status !== 0) return { error: `git stash ${stash.stderr.trim()}（patch 已存 ${patch}，工作樹沒動）` };
  return { patch, files: patchFiles(body) };
}

/** patch 文字裡 `diff --git a/<檔> b/<檔>` 標頭的檔名（依出現順序、去重）。 */
function patchFiles(body) {
  return [...new Set([...body.matchAll(/^diff --git a\/(.+) b\/.+$/gm)].map(match => match[1]))];
}

/**
 * 草稿的「prior 未提交的改動」段（#625）：`.scratch/pilot/backup/issue-<n>-dirty*.patch` 的路徑與改到的檔、worktree 裡
 * `.scratch/issue-run-<n>-*` 下 wip/ 的 `.patch`；`.claude/settings.json`（受保護、owner 手改）單獨一行。都沒有時傳回空陣列。
 */
function dirtySection(main, worktree, n) {
  const dir = join(main, '.scratch/pilot/backup');
  const backups = existsSync(dir) ? readdirSync(dir).filter(file => new RegExp(`^issue-${n}-dirty(-\\d+)?\\.patch$`).test(file)).sort() : [];
  const scratch = worktree && join(worktree, '.scratch');
  const wip = scratch && existsSync(scratch)
    ? readdirSync(scratch).filter(name => new RegExp(`^issue-run-${n}(-prior\\d*)?$`).test(name)).sort()
      .flatMap(name => existsSync(join(scratch, name, 'wip')) ? readdirSync(join(scratch, name, 'wip')).filter(file => file.endsWith('.patch')).sort().map(file => join(scratch, name, 'wip', file)) : [])
    : [];
  if (!backups.length && !wip.length) return [];
  const out = ['## prior 未提交的改動', ''];
  let protectedFile = false;
  for (const file of backups) {
    const patch = join(dir, file);
    const files = patchFiles(readFileSync(patch, 'utf8'));
    protectedFile ||= files.includes('.claude/settings.json');
    out.push(`- prior worktree 的 staged、未 staged 與未追蹤改動已存成 \`${patch}\`（已 stash，工作樹乾淨）；套用：\`git apply -3 ${patch}\`。改到的檔：${files.length ? files.map(f => `\`${f}\``).join('、') : '（讀不到檔名）'}`);
  }
  for (const patch of wip) out.push(`- 舊 worker 的 wip patch：\`${patch}\`（prior 的 commit 不含它；由 worker 決定要不要套）`);
  if (protectedFile) out.push('- `.claude/settings.json` 是受保護、owner 手改的檔，prior 的未提交改動動到了它：fresh worker 不能自己改，缺的權限規則要請 owner 補，或停下回報。');
  out.push('- 哪些要沿用由「怎麼整併」決定；沒寫就視為不沿用。', '');
  return out;
}

/**
 * worker 分頁尾段（#261）：讀 pilot.md 的 Watch 同一個來源 `terminal read --screen --json` 的 `.result.terminal.tail`（整段，不只 Watch 看的最後 40 行），
 * 取最後一個結果行（`DONE|STOP <n>`）與它之前最後一個以「Review」開頭的行（行首空白與 TUI 的 ⏺ 不算），去掉共同縮排。
 * 沒有 handle、沒有 ORCA_CLI_COMMAND、Orca 失敗（分頁已關）或找不到起訖行時傳回 undefined。
 */
function screenTail(n, handle) {
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!cli || !handle) return undefined;
  const read = run(cli, ['terminal', 'read', '--terminal', handle, '--screen', '--json'], { timeout: 30000 });
  let tail;
  try { tail = JSON.parse(read.stdout).result?.terminal?.tail; } catch { return undefined; }
  if (read.status !== 0 || !Array.isArray(tail)) return undefined;
  const to = tail.findLastIndex(line => new RegExp(`^\\s*(DONE|STOP) ${n}\\b`).test(line));
  const from = to < 0 ? -1 : tail.findLastIndex((line, i) => i < to && /^\s*(⏺\s*)?Review/.test(line));
  if (from < 0) return undefined;
  const picked = tail.slice(from, to + 1).map(line => line.trimEnd());
  const indent = Math.min(...picked.filter(Boolean).map(line => line.match(/^ */)[0].length));
  return { handle, text: picked.map(line => line.slice(indent)).join('\n') };
}

/** `git diff -U0` 輸出裡 hunk 標頭（`@@ -a,b +c,d @@ <所在函式>`）的函式行（去掉頭尾空白）；標頭沒有文字的 hunk 不算（#551）。 */
export function hunkFunctions(diff) {
  return new Set([...diff.matchAll(/^@@ [^@]* @@(.*)$/gm)].map(match => match[1].trim()).filter(Boolean));
}

/**
 * 沒帶 --note 的 --fresh：寫 fresh-<n>.md 草稿（內容見檔頭），傳回 `{ path }` 或 `{ stop }`（不含 `STOP `）。只讀 git、gh 與檔案；唯一例外是 prior 工作樹有未提交改動時的備份與 stash（#625）。
 */
function freshDraft(main, key, integration, { n, branch }, allowOverlap) {
  if (!hasBranch(main, branch)) return { stop: missingBranch(main, key, { n, branch }) };
  // 同帶 --note 時的檢查（#425）：重疊就不寫草稿，免得 coordinator 寫完整併範圍才撞上 STOP。
  const overlap = !allowOverlap && overlapStop(main, n, branch, integration);
  if (overlap) return { stop: `${n} ${overlap}` };
  const path = join(main, `.scratch/pilot/fresh-${n}.md`);
  const merge = existsSync(path) ? readFileSync(path, 'utf8').split(/^## 怎麼整併$/m)[1] : undefined;
  if (merge?.trim()) return { stop: `${n} draft-filled ${path}` };
  const git = (...args) => run('git', ['-C', main, ...args]);
  const priorTree = worktreeOf(main, branch);
  // #625：prior 工作樹有未提交改動時，草稿這一步就備份並 stash（之後的 --note 重派才不會 STOP dirty）。
  const saved = priorTree ? backupDirty(main, priorTree, n) : {};
  if (saved.error) return { stop: `${n} backup ${saved.error}` };
  const viewed = run('gh', ['issue', 'view', n, '--json', 'title']);
  let title;
  try { title = viewed.status === 0 && JSON.parse(viewed.stdout).title; } catch { title = undefined; }
  if (!title) return { stop: `${n} title ${(viewed.stderr ?? '').trim().replace(/\s*\n\s*/g, ' ') || 'gh issue view 讀不到標題'}` };
  const row = rowOf(join(main, `.scratch/pilot/batch-${key}.md`), n);
  const candidate = row?.[8];
  const prior = candidate || git('rev-parse', branch).stdout.trim();
  const merged = git('merge-base', branch, integration);
  if (merged.status !== 0) return { stop: `${n} git merge-base ${merged.stderr.trim()}` };
  const base = merged.stdout.trim();
  let member, other;
  try {
    [member, other] = [prior, integration].map(ref => changedUnits(main, base, ref, { adjacent: false }));
  } catch (error) {
    return { stop: `${n} git ${error.message}` };
  }
  const stat = (ref, path) => {
    const result = git('diff', '--stat=200', base, ref, '--', path);
    if (result.status !== 0) throw new Error(`diff --stat ${result.stderr.trim()}`);
    return result.stdout.split('\n')[0].trim();
  };
  // `.md` 的 whole 只表示有條目外的改動，條目照樣列出（coordinator 只讀列出的條目）。
  const entries = (path, unit) => !path.endsWith('.md') ? ''
    : (unit.entries.size ? `；條目：${[...unit.entries].sort().join('、')}` : '') + (unit.whole ? '；另有條目外的改動' : '');
  const side = (label, ref, unit, path) => `- ${label}：\`${stat(ref, path)}\`${entries(path, unit)}`;
  // 逐檔取 prior 改動的指令（#484）：`.md` 常有整段單行的條目，一般 diff 一個字就整行印兩次，只取新增的字詞。
  const fetch = path => (path.endsWith('.md')
    ? `- 逐檔取 prior 新增的字詞：\`git diff ${base} ${prior} --word-diff=porcelain -- ${path} | grep '^+[^+]'\``
    : `- 逐檔取 prior 的 diff：\`git diff ${base} ${prior} -- ${path}\``);
  // 兩邊都改過的函式（#551）：只看程式檔，`.md` 已有條目。
  const functions = ref => path => {
    const result = git('diff', '-U0', base, ref, '--', path);
    if (result.status !== 0) throw new Error(`diff -U0 ${result.stderr.trim()}`);
    return hunkFunctions(result.stdout);
  };
  const shared = path => {
    if (path.endsWith('.md')) return [];
    const theirs = functions(integration)(path);
    const both = [...functions(prior)(path)].filter(line => theirs.has(line));
    return both.length ? [`- 兩邊都改過的函式：${both.map(line => `\`${line}\``).join('、')}`] : [];
  };
  let common;
  try {
    common = [...member.keys()].filter(path => other.has(path)).sort()
      .map(path => [`### ${path}`, '', side('成員', prior, member.get(path), path), side('整合分支', integration, other.get(path), path), ...shared(path), fetch(path)].join('\n'));
  } catch (error) {
    return { stop: `${n} git ${error.message}` };
  }
  const patch = `git diff ${base} ${prior} -- . ${patchExcludes(main, [...member.keys()]).map(path => `':!${path}'`).join(' ')} | git apply -3`.replace('.  |', '. |');
  const worktree = worktreeOf(main, branch);
  const state = worktree && join(worktree, `.scratch/issue-run-${n}/state.md`);
  const lines = state && existsSync(state) ? readFileSync(state, 'utf8').split('\n') : [];
  const from = lines.findLastIndex(line => /review-only/i.test(line));
  const result = lines.findIndex((line, i) => i > from && new RegExp(`\\b(DONE|STOP) ${n}\\b`).test(line));
  const heading = lines.findIndex((line, i) => i > from && /^#{1,2} /.test(line));
  const to = result >= 0 ? result + 1 : heading >= 0 ? heading : undefined;
  const tail = from < 0 ? screenTail(n, row?.[4]) : undefined;
  const review = from >= 0 ? lines.slice(from, to).join('\n').trim() : tail?.text ?? 'checkpoint 沒有 review-only 段，補 worker 分頁尾段。';
  const source = tail ? `worker 分頁尾段（${tail.handle}）` : state ?? `找不到 ${branch} 的 worktree`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    `# fresh-${n}：#${n} ${title}`,
    '',
    '## 原 Issue 與 prior',
    '',
    `- 原 Issue：#${n} ${title}`,
    `- prior：${branch} @ ${prior}（${candidate ? `batch-${key}.md 的 candidate` : '分支 tip'}）`,
    `- merge-base ${branch} ${integration}：${base}`,
    '',
    '## 共同改過的檔',
    '',
    common.length ? common.join('\n\n') : '沒有。',
    '',
    '## 沿用 prior 的 patch',
    '',
    `\`${patch}\``,
    '',
    '## 最後一輪 review-only',
    '',
    `來源：${source}`,
    '',
    review,
    '',
    '## 整併注意',
    '',
    `- fresh worktree 的 ${branch} 已從 ${integration} 的 tip 開出：只 \`git merge --no-ff ${prior}\`，不要再 merge ${integration}（已經含著；衝突沒解完時第二個 merge 只回 \`Merging is not possible because you have unmerged files\`）。`,
    '- 兩邊的測試都保留，但改到符合 prior 的新簽章與新行為；解完以測試結果為準，不以衝突標記清乾淨為準。',
    '- 列了「兩邊都改過的函式」的檔：檢查一邊的新路徑會不會餵給另一邊的新讀取，並為交會的那條路徑補一個測試；「怎麼整併」不要只寫兩邊沒有設計取捨。',
    ...entrySurvivalLines(main, integration),
    '',
    ...dirtySection(main, priorTree, n),
    '## 怎麼整併',
    '',
  ].join('\n'));
  return { path };
}

/** 草稿「整併注意」的 entry-survival、port-entries 與 merge-line-inserts 行（#618、#557）：對應的 scripts/ 檔在 repo 裡才印。 */
function entrySurvivalLines(main, integration) {
  const lines = [];
  if (existsSync(join(main, 'scripts/entry-survival.mjs'))) lines.push(`- 整併後跑 \`node scripts/entry-survival.mjs $(git merge-base HEAD ${integration})\`，把印出的每行 \`ENTRY_LOST\`／\`ENTRY_CHANGED\` 抄進 checkpoint notes、逐條註明是 prior 有意改寫還是被蓋掉（判讀見 \`node scripts/adapter-line.mjs 'Entry survival'\`）；review-only verifier 會自己再跑一次。`);
  if (existsSync(join(main, 'scripts/port-entries.mjs'))) lines.push('- prior 改到的條目已搬到別的檔、`git apply -3` 衝突時，跑 `node scripts/port-entries.mjs <base> <prior> <檔> [<目標檔>]`，再手動處理印出的 `NO_MATCH`／`AMBIGUOUS`。');
  if (existsSync(join(main, 'scripts/merge-line-inserts.mjs'))) lines.push('- 一整行的列或條目（用法表的列、`- **Probe.**` 這類單行條目）兩邊各改一處、`git apply -3` 整列衝突時，先跑 `node scripts/merge-line-inserts.mjs <檔>...` 自動合併（只改工作樹），只手動處理它印的 `LINE_CONFLICT <檔> <行>`，不再手寫合併腳本。');
  return lines;
}

/**
 * 草稿 patch 指令要排除的路徑（#572）：`changed`（prior 改過的檔）裡的戳記檔與副本清單、清單登記的副本，以及有 scripts/build-workflow-site.mjs 時
 * docs/workflow/site 底下的檔（整個目錄只列一次）；依路徑排序。副本清單讀不到或不是 JSON 時不排除副本（照舊套）。
 */
function patchExcludes(main, changed) {
  let copies = [];
  try {
    copies = Object.keys(JSON.parse(readFileSync(join(main, MANIFEST), 'utf8')).copies ?? {});
  } catch { copies = []; }
  const site = existsSync(join(main, 'scripts/build-workflow-site.mjs')) ? 'docs/workflow/site' : undefined;
  const skip = new Set([...stampFiles, MANIFEST, ...copies]);
  return [...new Set(changed.map(path => (site && path.startsWith(`${site}/`) ? site : path)).filter(path => path === site || skip.has(path)))].sort();
}

/**
 * --fresh 派出後（#437）：這一輪用過的 fresh-<n>.md 改名成第一個空號的 fresh-<n>-r<k>.md（k 從 1 起），下一輪草稿才不撞上 draft-filled。
 * 傳回歸檔後的路徑，沒有草稿時 undefined。
 */
function archiveDraft(main, n) {
  const draft = join(main, `.scratch/pilot/fresh-${n}.md`);
  if (!existsSync(draft)) return undefined;
  let k = 1;
  while (existsSync(join(main, `.scratch/pilot/fresh-${n}-r${k}.md`))) k++;
  const archived = join(main, `.scratch/pilot/fresh-${n}-r${k}.md`);
  renameSync(draft, archived);
  return archived;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const positional = [];
  const given = {};
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    if (args[i] === '--again') { bad ||= 'again' in given; given.again = true; continue; }
    if (args[i] === '--allow-overlap') { bad ||= 'allowOverlap' in given; given.allowOverlap = true; continue; }
    if (args[i] === '--capacity') { bad ||= 'capacity' in given; given.capacity = true; continue; }
    if (args[i] === '--no-capacity') { bad ||= 'noCapacity' in given; given.noCapacity = true; continue; }
    const name = new Map(Object.entries({ '--integration': 'integration', '--stuck-after': 'stuckAfter', '--fresh': 'fresh', '--note': 'note', '--repo-cap': 'repoCap' })).get(args[i]);
    const value = args[++i];
    if (!name || !value || value.startsWith('--') || name in given) bad = true;
    else given[name] = value;
  }
  const options = { integration: 'pilot/integration', stuckAfter: '90m', ...given };
  if (!/^\d+m$/.test(options.stuckAfter) || ('repoCap' in given && !/^[1-9]\d*$/.test(given.repoCap))) bad = true;
  const [key, ...specs] = positional;
  const fresh = 'fresh' in given;
  // --fresh 只帶一個成員；沒帶 --note 是草稿（#227），不能再帶派工才用的旗標；--note 與 --again 只跟 --fresh 一起用。
  const draft = fresh && !('note' in given);
  if (draft ? given.again || given.capacity || given.noCapacity || 'repoCap' in given || 'stuckAfter' in given : 'note' in given && !existsSync(given.note)) bad = true;
  // 派工路徑預設做容量檢查（#534）；--no-capacity 是唯一的略過方式，和要求檢查的旗標一起帶是矛盾。
  if (given.noCapacity && (given.capacity || 'repoCap' in given)) bad = true;
  const capacity = !draft && !given.noCapacity;
  if (fresh ? specs.length : 'note' in given || given.again) bad = true;
  const members = (fresh ? [given.fresh] : specs).map(spec => spec.match(/^(\d+):([a-z0-9][a-z0-9-]*)$/)).map(m => m && { n: m[1], branch: `issue/${m[1]}-${m[2]}` });
  const cli = process.env.ORCA_CLI_COMMAND;
  if (bad || !key || !members.length || members.some(m => !m) || (!cli && !draft) || (capacity && machineCap() === undefined)) {
    console.error(USAGE);
    process.exit(2);
  }
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort('timeout'), BUDGET_MS);
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => controller.abort(`signal ${name}`));
  try {
    const main = mainCheckout();
    // 打錯的整合分支會寫出沒有 SHA 的表頭（PILOT-STORE 要 `<branch> @ <sha>`），表頭已存在時重跑也不改寫。
    if (run('git', ['-C', main, 'rev-parse', '--verify', '-q', `refs/heads/${options.integration}`]).status !== 0) {
      console.error(`整合分支 ${options.integration} 不存在\n${USAGE}`);
      process.exit(2);
    }
    stampFiles = await stampFilesOf(main);
    if (draft) {
      const written = freshDraft(main, key, options.integration, members[0], Boolean(given.allowOverlap));
      console.log(written.stop ? `STOP ${written.stop} row=kept` : `NOTE_DRAFT ${written.path}`);
      clearTimeout(budget);
      process.exit(written.stop ? 4 : 0);
    }
    let envSync;
    try {
      envSync = envSyncCommand(main);
    } catch (error) {
      console.error(`${error.message}\n${USAGE}`);
      process.exit(2);
    }
    const stopCapacity = line => {
      console.log(line);
      releaseClaims(members);
      clearTimeout(budget);
      process.exit(4);
    };
    if (capacity) {
      const total = repoRunning(main, new Set(members.map(({ n }) => n))) + members.length;
      const repoCap = Number(given.repoCap ?? DEFAULT_REPO_CAP);
      if (total > repoCap) stopCapacity(`STOP capacity repo ${total}/${repoCap}`);
      console.log(`CAPACITY ok repo ${total}/${repoCap}`);
    }
    if (capacity) {
      for (const line of envMissingLines()) console.log(line);
      const result = capacityCheck(ledgerPath(), members.length);
      const { ok, total, cap } = result;
      if (!ok) stopCapacity(capacityStopLine(result));
      console.log(`CAPACITY ok ${total}/${cap}`);
    }
    // Orca 整個不能用（#394）：什麼都不建，認領保留給下一輪原樣重跑。
    const unavailable = orcaUnavailable(cli);
    if (unavailable) {
      console.log(`STOP orca-unavailable ${unavailable}`);
      clearTimeout(budget);
      process.exit(4);
    }
    // 派出後把派出人數加進帳本本 repo 那一列（#353）；寫不進去只警告。
    const reportDispatched = count => {
      if (!capacity || !count) return;
      try {
        const { running, total, cap } = capacityReport(ledgerPath(), basename(main), count, { add: true });
        console.log(`REPORTED ${basename(main)} ${running} ${total}/${cap}`);
      } catch (error) {
        console.error(`WARN capacity-report ${error.message}`);
      }
    };
    if (fresh) {
      const [member] = members;
      const started = now();
      const ready = await refresh(cli, main, key, options.integration, member, readFileSync(given.note, 'utf8'), Boolean(given.again), Boolean(given.allowOverlap), controller.signal);
      if (ready.stop) {
        console.log(`STOP ${ready.stop} row=kept`);
        clearTimeout(budget);
        process.exit(4);
      }
      // 重疊已在 refresh 比對過；這時的分支是剛從整合分支開的，沒有改動可比。
      const result = await dispatchMember(cli, main, ready.checkpoint, options.integration, member, controller.signal, true, envSync);
      // 結果行先印：成員行等鎖逾時（exit 3）時，coordinator 仍看得到 worker 已經派出（#345）。
      // --fresh 一律寫成員列（keep 也寫），所以 row 照 rowState。
      console.log(result.stop ? stopLine(member.n, result.stop, rowState(result.stop)) : `DISPATCHED ${member.n} ${result.handle}\nPRIOR ${member.n} ${ready.prior} ${ready.sha}`);
      writeRow(ready.checkpoint, member.n, [member.branch, result.worktree ?? ready.worktree, result.handle ?? '', started, options.stuckAfter, rowState(result.stop)]);
      if (!result.stop) {
        const archived = archiveDraft(main, member.n);
        if (archived) console.log(`DRAFT_ARCHIVED ${member.n} ${archived}`);
      }
      reportDispatched(result.stop ? 0 : 1);
      clearTimeout(budget);
      process.exit(result.stop ? 4 : 0);
    }
    const checkpoint = join(main, `.scratch/pilot/batch-${key}.md`);
    writeHeader(main, checkpoint, key, options.integration);
    let stopped = false;
    let dispatched = 0;
    for (const member of members) {
      const started = now();
      const result = await dispatchMember(cli, main, checkpoint, options.integration, member, controller.signal, Boolean(given.allowOverlap), envSync, true);
      stopped ||= Boolean(result.stop || result.hold);
      console.log(result.hold ? `HOLD ${member.n} ${result.hold}`
        : result.stop ? stopLine(member.n, result.stop, result.keep ? 'kept' : rowState(result.stop)) : `DISPATCHED ${member.n} ${result.handle}`);
      if (!result.keep) writeRow(checkpoint, member.n, [member.branch, result.worktree ?? '', result.handle ?? '', started, options.stuckAfter, rowState(result.stop)]);
      if (!result.stop && !result.hold) dispatched++;
    }
    reportDispatched(dispatched);
    clearTimeout(budget);
    process.exit(stopped ? 4 : 0);
  } catch (error) {
    exitIfLocked(error);
    console.error(error.message);
    process.exit(1);
  }
}
