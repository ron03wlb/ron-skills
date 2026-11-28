#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// copy-templates: requires orca-worktree-create.mjs pilot-unbare.sh pilot-pr-body.mjs land.mjs
// setup-workflow 正本：/issue-pilot coordinator 的 Stage → Regression → hold 檢查 → Integrate，一個指令完成（adapter Pilot 段的 Stage、Regression、Integrate；
// 結果行與 checkpoint 格式見 skills/engineering/issue-pilot/PILOT-STORE.md 的 Canonical scripts）。專案值都從參數來：
//   --check-command <指令>  Regression 指令，在 stage worktree 以 sh 執行（預設 bin/check）；
//   --integration <分支>    整合分支（預設 pilot/integration）；stage 分支一律是 pilot/stage-<key>；
//   --main <分支>           sync-main 要跟上的 origin/<分支>（預設 main）；
//   --resolver <模組>       可選的專案衝突解法模組，相對本檔所在目錄的上一層（副本在 scripts/，就是 repo 根），或絕對路徑；不存在就是用法錯誤。
// 全部在 stage worktree 做（分支是整合分支或 pilot/stage-* 的那個 worktree；沒有就用 Orca 建 pilot-stage，再跑旁邊的 pilot-unbare.sh 當 Bare guard）：
//   running     成員列還有 running 時先用 Probe 的 workerState（pilot-probe.mjs）讀一次畫面（#361：pilot-watch 已印 DONE、checkpoint 還記 running）：
//               每個 running 成員都讀到結果行時印 `WORKER <n> DONE <sha>`／`WORKER <n> STOP <cause>`，照 probe --apply 寫回成員列（done 與 candidate、stop）再繼續；
//               terminal 已結束時與 Probe 一樣讀 worker checkpoint（只看預設路徑 `<worktree>/.scratch/issue-run-<n>/state.md`），讀到時印 `WORKER <n> DONE <sha> from-state`、照 DONE 寫回（#466）；
//               有一個還在工作、讀不到 terminal 或沒有 ORCA_CLI_COMMAND 時印 `STOP member <n> running (<WORKER 狀態>)，先跑 pilot-probe.mjs --apply`，成員列都不改。
//   先同步      要重新 stage（不是 RESUME）、主 checkout 有 origin remote 時，load 關卡之後先照 sync-main 讓整合分支包含 origin/<主分支>（#366）：
//               已包含不印任何行；落後或分叉時同步後印 `SYNCED <sha> ff|<CHECK_PASS 行>`，再從新的 tip stage；
//               同步失敗印 sync-main 的 STOP 行（`STOP conflict sync-main …`、`STOP regression sync-main <exit>`、`STOP drift`、`STOP load …`、`STOP git fetch …`），不 stage。
//   Stage       stage worktree 要乾淨；`switch -C pilot/stage-<key> <integration tip>`，依號碼 `merge --no-ff` 每個 done 成員。
//               衝突時，衝突檔先交給 resolver 的 resolveFile 解（沒有 resolver 就解不了），最後重算戳記檔：
//                 docs/agents/workflow-templates.json（copy-templates.mjs 的副本清單，每個導入 repo 都有）由本檔的 restampManifest 重算，
//                 resolver 的 STAMP_FILES 與 isGenerated 認得的產物交給它的 restamp(tree, files)；解法名稱是 resolver 加進 kinds 的名稱，戳記檔加 `restamp`，以 + 相連。
//               有一個檔解不了就 `merge --abort`，印 STOP conflict。解完的 `commit --no-edit` 帶 HEAVY_CHECK_TIMEOUT=0：
//               pre-commit 排 heavy-slot 時不設等待上限，別的 repo 一直忙也不會等滿 1800 秒就 STOP git commit（#637；Regression 的上限不變）。
//               staged SHA 與 stage 時的 integration tip 寫成 checkpoint 的 `current: staged <sha> onto <tip>`，同一次寫入留 land 存活標記
//               `regressing: <sha> pid <本行程 pid>`（#361：Probe 看到標記的 pid 還是 pilot-land 時印 REGRESSING，不印 RESTAGE … none）。
//   held 關卡   成員都 done 之後、load 關卡之前：<主 checkout>/.scratch/pilot/gates.md 開著的 gate 以 `- hold：#<n>` hold 住 done 成員 #n
//               （pilot-gate open --hold）時印 `STOP held <n> <gate id>`（依成員列順序取第一個），stage worktree、checkpoint 與整合分支都不動；
//               gate resolve 之後重跑同一行（#367：investing#320 等 G28 時仍可被 stage）。RESUME 也經過這一關。
//   operator-questions 關卡  held 關卡之後：done 成員 #n 的 issue-run checkpoint（成員列 worktree 下的 `.scratch/issue-run-<n>/state.md`）有
//               `[confirm]` ruling 行（行首，前面可有 `- `），而 gates.md 沒有任何 gate（開著或已 resolved）的 Issue 指向 #n 時，
//               印 `STOP operator-questions <n> <confirm 行數>`（依成員列順序取第一個），什麼都不動；開 gate（pilot-gate open）後重跑同一行
//               （#406：investing#432 帶著沒人答的 Operator 問題落地，下游 #434 照 Pool 規則派工後停在 STOP decision）。checkpoint 不在時不檢查。RESUME 也經過這一關。
//   load 關卡   要重新 stage（不是 RESUME）時，建 stage worktree 與 stage 之前先讀 1 分鐘 load（os.loadavg）；超過門檻時在腳本內每
//               $PILOT_LOAD_POLL_SECONDS（預設 15）秒重讀，降到門檻以下就照常繼續（#588：短暫尖峰不必等 coordinator 下一次喚醒）；
//               等滿 $PILOT_LOAD_WAIT_SECONDS（預設 480，0 是只讀一次）還高才印 `STOP load <load> <門檻>`（最後讀到的 load，取到小數兩位），
//               等待期間與 STOP 時 stage 分支、stage worktree、checkpoint 與整合分支都不動，下一輪重跑同一行就接著做
//               （ron-skills #178：同時跑 8 個 worker 時 load 約 90，檢查時間加倍，計時測試失敗）。
//               門檻依序取 --load-max <n>、$PILOT_LOAD_MAX，都沒有時 3 × os.availableParallelism()；$PILOT_LOAD_NOW 取代實測值（測試用；逗號分隔的序列依序取值）。
//   Regression  在 staged SHA 跑 Regression 指令，完整輸出寫到 <主 checkout>/.scratch/pilot/reg-<key>.log，
//               checkpoint 追加 `regression: <sha> exit <code>`（通過、而且輸出最後一行以 `CHECK_PASS ` 開頭時附上那一行），同一次寫入拿掉 regressing 標記。
//               指令經同目錄 heavy-slot.mjs 的全機共用 slot 執行（label `<主 checkout 目錄名>:regression`，排隊時 log 有 SLOT_WAIT 行）；
//               等 slot 逾時（exit 75）時 regression 行照記 `exit 75`，印 `STOP load slot-timeout <已等秒數>s`：負載關卡，下一輪重跑同一行，不是 Regression 沒過。
//               repo 的 heavy-slot 名額是 0（印 SLOT_DELEGATED、exit 76，CoS item 67）時不在本機跑，改交給同目錄的
//               `ci-run.mjs <staged sha> --ref pilot/stage-<key> --timeout $PILOT_CI_TIMEOUT_S`（預設 1800；輸出接在 reg-<key>.log 後面）：
//                 CI_PASS        regression 行記 `<sha> exit 0 CI_PASS <run url>`，照常往下；
//                 CI_FAIL        記 `<sha> exit 1 CI_FAIL <run url> <step>`，印 `STOP regression 1`（job 有跑、沒過：不退回本機）；
//                 CI_PENDING     記 `<sha> exit 75 CI_PENDING <run url>`，印 `STOP load ci-pending <run url>`：負載關卡；重跑時 tip、stage 分支與成員都沒變就
//                                不重新 stage，印 `RESUME <key> <sha> ci-pending`，接著等同一個 SHA 的 run；
//                 CI_UNAVAILABLE 以 `heavy-slot.mjs run --fallback` 在本機排隊重跑（結果照上面的本機 Regression 判讀）。
//               名額大於 0 或沒設名額的 repo 行為不變。sync-main 的 Regression 也一樣（ref 是 pilot/stage-sync-main）；它 CI_PENDING 之後的重跑，
//               本機 pilot/stage-sync-main 的 parent 還是同一對（整合分支 tip、origin/<主分支>）而且 reg-sync-main.log 最後一行是它的 CI_PENDING 時沿用那個合併 commit。
//   hold        <主 checkout>/.scratch/pilot/hold 存在就停。
//   Integrate   整合分支的 tip 要還是 stage 時記下的那個（不數 parent：ron-skills batch-40-51 用 `$SHA^1` 誤判兩個成員的 batch）；
//               `switch <整合分支>`、`merge --ff-only`、`branch -d` stage 分支，`current:` 寫成 `merged <sha>`。
// 重跑：`current:` 是 `staged <sha> onto <tip>`、tip 沒變、stage 分支還在那個 SHA、成員組合與各分支都沒變、最後一個 regression 行是它的 exit 0 時，
//   不重新 stage、不重跑 Regression，直接從 hold 檢查繼續；其他情況一律從 Stage 重來。已經 `merged <sha>` 時只再印一次 MERGED（之前照樣印 POSTLAND_PENDING，#502），
//   但有 done 成員的 candidate 不是 <sha> 的祖先（成員修好衝突後重報 DONE 的新候選，<sha> 不含它）時從 Stage 重來：疊到現在的整合分支 tip、
//   跑自己的 Regression（舊的 regression 行不算），印新的 STAGED、MERGED（#500：#504 重報 DONE 4d28b541 後只回舊的 MERGED be82eb7，要手改 checkpoint）。
// checkpoint 寫回之後再讀一次，沒寫進去就 STOP checkpoint，不會靜默失敗（ron-skills #74）。
// checkpoint 缺檔而存檔裡有 key 包含這些號碼的 batch（move 之後 key 不變）時，同一行附 ` hint: 用 key <原 key>`（#582）。
// 請求分支（沒有 Issue 的 `retro/<x>`）：`req-<n> --branch retro/<x>`（<n> 是 requests.md 的行號）在 batch-req-<n>.md 不存在時開出它，
//   唯一的成員列 Issue 欄是 `-`、state `done`、candidate 是分支 tip；已存在時成員要是同一個分支，否則 STOP checkpoint。之後與一般 batch 相同。
//   分支不存在印 `STOP branch <分支> …`，不開 checkpoint。成員列是 `-` 時，STOP、RESOLVED 行裡的 <n> 是分支名稱。
// sync-main（Push gate 的 STOP behind-main）：從主 checkout 的副本跑時先交給 stage worktree 的同名腳本（lib/pilot-store.mjs 的 runInStageWorktree，#239、#275）；讓整合分支包含 origin/<主分支>，同樣在 stage worktree 做（要乾淨）。先 `git fetch origin`；
//   已包含印 `SYNCED <tip> current`；整合分支是 origin/<主分支> 的祖先時 `merge --ff-only`，印 `SYNCED <sha> ff`（不跑 Regression）；
//   分叉時先過 load 關卡（同 batch：超過門檻印 `STOP load <load> <門檻>`，stage worktree 與分支都不動），
//   再 `switch -C pilot/stage-sync-main <tip>`、`merge --no-ff origin/<主分支>`，衝突照 Stage 的解法（`RESOLVED sync-main <解法> <檔案…>`），
//   解不了 abort 後印 `STOP conflict sync-main <檔>=main:<種類> …`（每個衝突檔一項，#589：來源欄固定是 `main`，合入的是 origin/<主分支>，
//   衝突就是它與整合分支都改過這個檔；種類同 Stage 的 code／other／entry <名稱>）；在合併 SHA 跑 Regression（reg-sync-main.log），沒過印 `STOP regression sync-main <exit>`；
//   通過且整合分支的 tip 沒變（變了 `STOP drift`）時，先對每個 `current: merged <sha>`（<sha> 在合併 SHA 裡，還沒推上 origin/<整合分支> 也不在 origin/<主分支>；已推的保留舊行，#523）的
//   batch 追加 `regression: <sha> exit 0 sync-main <CHECK_PASS 行>`（印 `RECORDED <key>`；Probe 才認得新的 tip、印 RESUME_PUSH，pilot-pr-body.mjs
//   認得 sync-main 標記、往前驗 staged SHA 那一行；寫不進去時 STOP checkpoint），再快轉整合分支、刪 stage 分支，
//   最後印 `SYNCED <sha> <CHECK_PASS 行>`（Regression 沒印 CHECK_PASS 時只有 `SYNCED <sha>`）。
//   STOP 時整合分支都不動，重跑同一行重新來過。exit 與 batch 相同（SYNCED 是 0）。
// push --title <標題>（Push gate 單一入口，#395）：同 sync-main 先交給 stage worktree 的同名腳本，再在主 checkout 依序
//   1. 跑旁邊的 pilot-pr-body.mjs <主 checkout> --out <主 checkout>/.scratch/pilot/pr-body.md，照印它的輸出；它 STOP 就以它的最後一行與 exit 結束，不 land；
//   2. 跑旁邊的 land.mjs <整合分支> --keep-branch --title <標題> --body-file <同一個檔> --check-command <Regression 指令>（有帶 --main 時也傳），照印它的輸出
//      （PR 已開著時 land.mjs 以 gh pr edit 換上新的標題與 body）；
//   3. land.mjs 印 `STOP behind-main …`（stage 之後 origin/<主分支> 才前進）時不照印那行，改印 `PUSH_BEHIND_MAIN <整合分支>`（不同於 Probe 的 `BEHIND_MAIN <落後數> <sha>`），跑同 sync-main 的步驟
//      （印 RECORDED、SYNCED；它的 STOP 就以那行結束，不 land），再從 1 重來一次；第二次還是 behind-main 就照印 land.mjs 的 STOP 行結束。
//   最後一行與 exit 是 land.mjs 的（`LANDED <pr> <merge sha>` exit 0，`STOP <原因>` exit 4）；pilot-pr-body.mjs 或 sync-main STOP 時是它們的 STOP 行（exit 4）。coordinator 以背景執行，
//   所以 land.mjs 等 CI 的期限不是它為 Bash 前景設的約 8 分鐘，而是經環境變數 LAND_CHECKS_TIMEOUT_MS 傳入的 $PILOT_CI_TIMEOUT_S（預設 1800 秒，同 ci-run；#665 第 4 項：
//   checks-macos 排隊常超過 600 秒，每批多一次 STOP checks-timeout 與重跑）。期限在每次等 CI 時起算：sync-main 的 Regression 不算在內，
//   sync-main 之後那輪 CI（第 3 步的第二次 land.mjs）有自己完整的期限。仍 `STOP checks-timeout <pr> → …` 時重跑同一行，PR 沿用、body 重產：land.mjs 經環境變數 LAND_RERUN_COMMAND
//   收到本檔這一行（`node <本檔相對 cwd 的路徑> push …`），箭頭後印的就是它，不是 land.mjs 自己的指令（retro spay2 1dce1925#2）。
// resolver 模組的契約（都可省略；ron-skills 的 scripts/pilot-resolve.mjs 是一例）：
//   resolveFile(tree, path, kinds)  合併中途、不是戳記檔的衝突檔：傳回合併後的全文（本檔寫回並 git add），解不了傳回 undefined；
//                                   用到的解法名稱加進 Set kinds，依加入順序出現在 RESOLVED 行。
//   conflictKind(tree, path)        STOP conflict 的種類欄；傳回 undefined 時本檔照預設判斷 code／other。
//   STAMP_FILES、restamp(tree, files)  專案自己的戳記檔：其他檔都解完、workflow-templates.json 重算之後呼叫，重算並 git add，解不了傳回 false。
//   isGenerated(path)               可重產的產物（例如由來源產出的靜態站）傳回 true：衝突時不交 resolveFile，與 STAMP_FILES 一起交給 restamp 重產（#589）；
//                                   省略時沒有任何檔算產物，restamp 只收到 STAMP_FILES。
//
// 用法：node scripts/pilot-land.mjs <batch key> [--branch retro/<x>] [<選項>…] | sync-main [<選項>…]（在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）
//   | push --title <標題> [<選項>…]
//   選項：--check-command <指令>、--integration <分支>、--main <分支>、--resolver <模組>、--load-max <n>
// stdout：最後一行是 `MERGED <key> <sha>`，或 `STOP regression <exit>`、`STOP hold`、`STOP held <n> <gate id>`、`STOP operator-questions <n> <數量>`、`STOP drift`（tip 變了，下一輪重新 stage）、
//   `STOP conflict <n> <檔>=<來源>:<種類> …`（已 abort，stage worktree 乾淨；每個衝突檔一項）：來源是 `member <m>`（本次 stage
//     依號碼先合入、自己的分支改過這個檔的成員）、`integration`（成員開分支之後整合分支改過），或以 + 相連的多個來源（`member 79+integration`、`member 1+member 3`），
//     都看不出來（不該發生）時是 `unknown`；種類是 resolver 的 conflictKind，沒有時 `code`（程式檔）或 `other`。
//     例：`STOP conflict 108 scripts/lib/hosts.mjs=member 79:code docs/notes.md=integration:other`。以及 `STOP checkpoint …`、`STOP member <n> <state>`、`STOP dirty <worktree>`、
//   `STOP no-stage-worktree`、`STOP create …`、`STOP merge <n> …`、`STOP git …`、`STOP load <load> <門檻>`、`STOP load slot-timeout <秒數>s`、`STOP load ci-pending <run url>`，
//   `STOP member <n> running (<WORKER 狀態>)，先跑 pilot-probe.mjs --apply`。之前的行：`WORKER <n> DONE <sha>`、`WORKER <n> STOP <cause>`（讀畫面寫回的 running 成員）、`STAGED <key> <sha> onto <tip>`、
//   `RESUME <key> <sha>`、`RESUME <key> <sha> ci-pending`、`RESOLVED <n> <解法> <檔案…>`，Bare guard 還原主 checkout 時的 `UNBARE <主 checkout>`；
//   MERGED 之前（已 merged 的重跑也印）對 checkpoint 每個 done 成員的每條 `postland: #<n> <command>` 印 `POSTLAND_PENDING <n> <command>`（#502，依成員號碼；沒有 postland 行時不印）。
// exit：0 MERGED；4 STOP；3 checkpoint 鎖等到逾時（印 `CHECKPOINT_LOCKED <lock> <持鎖內容>`，#345）；2 用法錯誤；1 其他失敗（程式錯誤，不印 STOP）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CI_PENDING_EXIT, CI_UNAVAILABLE_EXIT } from './ci-run.mjs';
import { slotCommand, slotDelegatedLine, slotTimeoutLine } from './heavy-slot.mjs';
import { batchMembers, CheckpointLocked, dropRegressing, exitIfLocked, gateIssues, heldIssues, openGates, postlandEntries, runInStageWorktree, updateCheckpoint } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-land.mjs <batch key> [--branch retro/<x>] [--check-command <指令>] [--integration <分支>] [--main <分支>] [--resolver <模組>] [--load-max <n>] | sync-main [同上選項，不含 --branch] | push --title <標題> [同 sync-main 的選項]（--branch 時 key 是 req-<n>；門檻預設 $PILOT_LOAD_MAX，再來 3 × 核心數；在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）';
const LOAD = /^\d+(\.\d+)?$/;
const MANIFEST = 'docs/agents/workflow-templates.json';
const here = dirname(fileURLToPath(import.meta.url));
// 從 pre-commit hook 或 worktree 呼叫時繼承的 GIT_DIR 等會讓 git -C 讀寫到別的 repo。
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));

/** 專案值：命令列解析完填入。resolver 是載入後的模組（沒有時是空物件）；loadWait、loadPoll 是 load 關卡最多等幾秒、隔幾秒重讀（$PILOT_LOAD_WAIT_SECONDS、$PILOT_LOAD_POLL_SECONDS）。 */
const config = { check: 'bin/check', integration: 'pilot/integration', main: 'main', resolver: {}, loadWait: 480, loadPoll: 15, ciTimeout: '1800' };

/** 停下：訊息就是 `STOP ` 後面那段。 */
class Stop extends Error {}

/** 同步跑子行程；stdin 一律接 /dev/null（Orca CLI 會吃掉 stdin）。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, ...options });
  // stderr 照常顯示（同 pilot-close.mjs），只濾掉 WSL 上 Orca 每次都印的 crashpad 錯誤行（#73）。
  const stderr = (result.stderr ?? '').split('\n').filter(line => !line.includes('registration_protocol_win.cc')).join('\n');
  if (stderr.trim()) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  const reason = (result.stderr ?? '').trim().split('\n').pop() || (result.error?.message ?? `exit ${result.status}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', reason };
}

const gitIn = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

/** git 指令，exit 非 0 就 STOP git。 */
function must(cwd, ...args) {
  const result = gitIn(cwd, ...args);
  if (result.status !== 0) throw new Stop(`git ${args[0]} ${result.reason}`);
  return result.stdout.trim();
}

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) throw new Stop(`git worktree ${result.reason}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** stage worktree：分支是 pilot/integration 或 pilot/stage-* 的 worktree 路徑，主 checkout 不算（不在主 checkout 切分支，#21）；沒有傳回 undefined。 */
function stageWorktree(main) {
  return must(main, 'worktree', 'list', '--porcelain').split(/\n\n+/)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.path && w.path !== main && existsSync(w.path) && (w.branch === config.integration || w.branch?.startsWith('pilot/stage-')))?.path;
}

/** 用 Orca 建 stage worktree（orca-worktree-create.mjs 不重試、以 git worktree list 為準），接著跑 Bare guard。 */
function createStageWorktree(main, key) {
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!cli) throw new Stop('no-stage-worktree');
  const created = run('node', [join(here, 'orca-worktree-create.mjs'), '--name', 'pilot-stage', '--base-branch', config.integration, '--branch', `pilot/stage-${key}`],
    { cwd: main, env: { ...childEnv, ORCA_BIN: cli }, timeout: 300000 });
  const unbare = run(join(here, 'pilot-unbare.sh'), [main, `stage #${key}`]);
  if (unbare.stdout) process.stdout.write(unbare.stdout);
  if (unbare.status !== 0) throw new Stop(`create unbare ${unbare.reason}`);
  const tree = stageWorktree(main);
  if (!tree) {
    let detail = created.stdout.trim() || created.reason;
    try { detail = JSON.parse(detail).error ?? detail; } catch { /* 非 JSON 就原樣附上 */ }
    throw new Stop(`create ${detail}`);
  }
  return tree;
}

/**
 * batch checkpoint：`current:` 的值、成員 `{ n, branch, state }`（欄位見 PILOT-STORE.md）與最後一個 `regression:` 行的值。欄位前後的空格不影響。
 * Issue 欄是 `-` 的請求分支成員以分支名稱當 n，排在 Issue 成員之後、照表格順序。
 */
const order = ({ n }) => (/^\d+$/.test(n) ? Number(n) : Number.MAX_SAFE_INTEGER);

/** batch-<key>.md 的 key 只由號碼組成時的號碼陣列，其他（req-<n>、sync-main）undefined。 */
const keyNumbers = name => name.match(/^batch-(\d+(?:-\d+)*)\.md$/)?.[1].split('-');

/**
 * checkpoint 缺檔時的提示（#582 第 2 項）：同一個存檔目錄裡 key 包含要找的每個號碼的 batch（`pilot-batch.mjs move 555-556 556` 之後 key 仍是 555-556，
 * 用 `555` 當 key 就缺檔），有時傳回 ` hint: 用 key <原 key>`（多個以「或」相連），沒有時空字串。
 */
function keyHint(file) {
  const wanted = keyNumbers(basename(file));
  const dir = dirname(file);
  if (!wanted || !existsSync(dir)) return '';
  const keys = readdirSync(dir).map(keyNumbers).filter(parts => parts && wanted.every(n => parts.includes(n))).map(parts => parts.join('-')).sort();
  return keys.length ? ` hint: 用 key ${keys.join(' 或 ')}` : '';
}

export function readCheckpoint(file) {
  if (!existsSync(file)) throw new Stop(`checkpoint 缺 ${file}${keyHint(file)}`);
  const text = readFileSync(file, 'utf8');
  const current = text.match(/^current:[ \t]*(.*)$/m)?.[1].trim();
  if (current === undefined) throw new Stop(`checkpoint ${file} 沒有 current: 行`);
  // 成員列與 pilot-probe 的 parseBatch 共用 lib/pilot-store.mjs 的解析，n 一律是字串（#453 第 1 項）；這裡另收請求分支列，依號碼排序。
  const members = batchMembers(text, { requests: true }).sort((a, b) => order(a) - order(b));
  const regression = [...text.matchAll(/^regression:[ \t]*(.*)$/gm)].pop()?.[1].trim();
  return { current, members, regression };
}

/** 請求分支的 batch：checkpoint 不在就開出來（成員列 Issue 欄 `-`），在的話成員要是同一個分支。 */
function openRequest(key, branch, loadMax) {
  const main = mainCheckout();
  const file = join(main, `.scratch/pilot/batch-${key}.md`);
  if (existsSync(file)) {
    const others = readCheckpoint(file).members.map(m => m.branch);
    if (others.length !== 1 || others[0] !== branch) throw new Stop(`checkpoint ${file} 的成員是 ${others.join(' ') || '（沒有）'}，不是 ${branch}`);
    return;
  }
  // 新開的請求 batch 一定要 stage，load 關卡排在寫 checkpoint 之前（#178：STOP load 時 checkpoint 也不動）。
  loadGate(loadMax);
  const candidate = gitIn(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`).stdout.trim();
  if (!candidate) throw new Stop(`branch ${branch} 不存在`);
  const worktree = must(main, 'worktree', 'list', '--porcelain').split(/\n\n+/)
    .find(block => block.split('\n').includes(`branch refs/heads/${branch}`))?.match(/^worktree (.*)$/m)?.[1] ?? '';
  const now = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# batch ${key}\ncurrent: dispatched ${now}\nintegration: ${config.integration} @ ${must(main, 'rev-parse', config.integration)}\n\n`
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
    + `| - | ${branch} | ${worktree} | | ${now} | | done | ${candidate} |\n`);
  const { members } = readCheckpoint(file);
  if (members.length !== 1 || members[0].branch !== branch || members[0].state !== 'done') throw new Stop(`checkpoint ${file} 的成員列沒寫成 ${branch}`);
}

/** 改寫 `current:` 行；寫完再讀一次，不是這個值就 STOP（多一個空格就靜默不中的 sed 正是 #74 的起因）。 */
function setCurrent(file, value) {
  updateCheckpoint(file, text => text.replace(/^current:.*$/m, `current: ${value}`));
  if (readCheckpoint(file).current !== value) throw new Stop(`checkpoint ${file} 的 current: 沒寫成 ${value}`);
}

/**
 * 寫 `current: staged <sha> onto <tip>`，同一次寫入把 land 存活標記換成 `regressing: <sha> pid <本行程>`（#361：Probe 據此印 REGRESSING，
 * 不把還在跑的 Regression 印成 RESTAGE … none）；寫完再讀一次，兩行有一行不對就 STOP。
 */
function markStaged(file, sha, tip) {
  const value = `staged ${sha} onto ${tip}`;
  const mark = `regressing: ${sha} pid ${process.pid}`;
  updateCheckpoint(file, text => {
    const rest = dropRegressing(text).replace(/^current:.*$/m, `current: ${value}`);
    return `${rest}${rest.endsWith('\n') ? '' : '\n'}${mark}\n`;
  });
  const after = readFileSync(file, 'utf8');
  if (readCheckpoint(file).current !== value || !after.split('\n').includes(mark)) throw new Stop(`checkpoint ${file} 的 current: 沒寫成 ${value}`);
}

/** 追加 `regression:` 行，同一次寫入拿掉 land 存活標記；寫完再讀一次，最後一個 regression 行不是它就 STOP。 */
function appendRegression(file, value) {
  updateCheckpoint(file, text => {
    const rest = dropRegressing(text);
    return `${rest}${rest.endsWith('\n') ? '' : '\n'}regression: ${value}\n`;
  });
  if (readCheckpoint(file).regression !== value) throw new Stop(`checkpoint ${file} 的 regression: 沒寫成 ${value}`);
}

/**
 * index 裡的一個 blob 解成 UTF-8 文字；不存在或不是合法 UTF-8 時傳回 undefined。
 * 以位元組讀再嚴格解碼：用 utf8 讀會把無效位元組換成 U+FFFD。
 */
function blob(tree, spec) {
  // stderr 不顯示：缺 stage（add/add、一邊刪掉）時 git show 的錯誤是預期中的。
  const result = spawnSync('git', ['-C', tree, 'show', spec], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv });
  if (result.status !== 0) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout);
  } catch {
    return undefined;
  }
}

/** 程式檔的副檔名；副檔名不在清單裡時看 ours 那一版開頭是不是 shebang。 */
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cc|cpp)$/;

/** 這個檔在 from..to 之間有改動（新增、刪除也算）。 */
const touches = (tree, from, to, path) => gitIn(tree, 'diff', '--quiet', from, to, '--', path).status === 1;

/**
 * STOP conflict 的來源欄（#192）：本次 stage 先合入、自己的分支改過這個檔的成員是 `member <m>`，成員開分支之後整合分支改過的是
 * `integration`；兩者都有時以 + 連接（`member 79+integration`）。都看不出來（不該發生）時是 `unknown`。
 */
function conflictSource(tree, path, tip, branch, earlier) {
  const since = ref => must(tree, 'merge-base', tip, ref);
  const sources = earlier.filter(m => touches(tree, since(m.branch), m.branch, path)).map(m => `member ${m.n}`);
  if (touches(tree, since(branch), tip, path)) sources.push('integration');
  return sources.join('+') || 'unknown';
}

/** STOP conflict 的種類欄：resolver 的 conflictKind 優先；沒有時程式檔是 `code`（副檔名不在清單裡時看 ours 那一版開頭是不是 shebang），其他是 `other`。 */
function conflictKind(tree, path) {
  const kind = path === MANIFEST || stampFiles().includes(path) || generated(path) ? undefined : config.resolver.conflictKind?.(tree, path);
  if (kind) return kind;
  if (CODE.test(path)) return 'code';
  return blob(tree, `:2:${path}`)?.startsWith('#!') ? 'code' : 'other';
}

/** resolver 宣告的專案戳記檔。 */
const stampFiles = () => config.resolver.STAMP_FILES ?? [];

/** resolver 認得的可重產產物（isGenerated）；沒有這個 export 的 resolver 一個也不認（#589）。 */
const generated = path => config.resolver.isGenerated?.(path) === true;

/** 合併中途某一邊（2 ours、3 theirs）的副本清單；那一邊沒有這個檔或讀不懂時 copies 是空的。 */
function manifestAt(tree, stage) {
  const shown = gitIn(tree, 'show', `:${stage}:${MANIFEST}`);
  try {
    return { copies: {}, ...(shown.status === 0 ? JSON.parse(shown.stdout) : {}) };
  } catch {
    return { copies: {} };
  }
}

/**
 * 合併中途重算 docs/agents/workflow-templates.json 並 git add（land.mjs 的專案 restamp.mjs 也可以拿來用）：兩邊 copies 的聯集，依路徑排序
 * （同 copy-templates.mjs）；每個條目取 sha256 等於合併後副本的那一邊，兩邊都不等（副本兩邊都改、合併出新內容）時 sha256 依檔案重算、
 * commit 取兩邊歷史裡最後一個改正本的 commit；副本已不在的條目拿掉。其他欄位取 theirs 那邊的。傳回是否成功。
 */
export function restampManifest(tree) {
  const ours = manifestAt(tree, 2);
  const theirs = manifestAt(tree, 3);
  const copies = {};
  for (const path of [...new Set([...Object.keys(theirs.copies), ...Object.keys(ours.copies)])].sort((a, b) => a.localeCompare(b))) {
    const file = join(tree, path);
    if (!existsSync(file)) continue;
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    const sides = [theirs.copies[path], ours.copies[path]].filter(Boolean);
    const match = sides.find(side => side.sha256 === actual);
    if (match) {
      copies[path] = match;
      continue;
    }
    const { template } = sides[0];
    const commit = gitIn(tree, 'log', '-1', '--format=%H', 'HEAD', 'MERGE_HEAD', '--', template).stdout.trim() || sides[0].commit;
    copies[path] = { template, commit, sha256: actual };
  }
  writeFileSync(join(tree, MANIFEST), `${JSON.stringify({ ...ours, ...theirs, copies }, null, 2)}\n`);
  return gitIn(tree, 'add', MANIFEST).status === 0;
}

/**
 * 解掉進行中 merge 的衝突並 add：一般檔交給 resolver 的 resolveFile，之後重算 workflow-templates.json、再交 resolver 的戳記檔與可重產產物給它的 restamp。
 * 傳回解法名稱（resolver 的 KINDS 有列時照它排序，否則照加入順序；restamp 最後），解不了傳回 undefined（呼叫端 abort）。
 */
function resolveConflicts(tree, files) {
  const projectStamps = stampFiles();
  const stamps = files.filter(path => projectStamps.includes(path) || generated(path));
  const others = files.filter(path => path !== MANIFEST && !stamps.includes(path));
  const kinds = new Set();
  const resolveFile = config.resolver.resolveFile ?? (() => undefined);
  const resolved = others.map(path => resolveFile(tree, path, kinds));
  if (resolved.includes(undefined)) return undefined;
  others.forEach((path, i) => writeFileSync(join(tree, path), resolved[i]));
  if (others.length) must(tree, 'add', '--', ...others);
  // 戳記檔最後重算：讀的是其他檔解完之後的來源；副本清單先，專案戳記（可能依副本重產）後。
  if (files.includes(MANIFEST)) {
    if (!restampManifest(tree)) return undefined;
    kinds.add('restamp');
  }
  if (stamps.length) {
    if (!config.resolver.restamp || config.resolver.restamp(tree, stamps) === false) return undefined;
    kinds.add('restamp');
  }
  const order = config.resolver.KINDS;
  const names = [...kinds].filter(kind => kind !== 'restamp');
  if (order) names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...names, ...(kinds.has('restamp') ? ['restamp'] : [])].join('+');
}

/**
 * 在 stage worktree `merge --no-ff` 一個 ref，衝突照 resolveConflicts 解並印 `RESOLVED <label> <解法> <檔案…>`。
 * 解不了時先以 `describe(衝突檔)` 取得 STOP 訊息（要讀 index 的三個 stage，在 abort 之前），再 `merge --abort`。
 */
function mergeResolving(tree, ref, label, describe) {
  const merge = gitIn(tree, 'merge', '--no-ff', '--no-edit', ref);
  if (merge.status === 0) return;
  // core.quotePath=false：非 ASCII 路徑不加引號與跳脫，resolver 的路徑判斷與 STOP 行的種類欄才讀得到原檔名；
  // 換行等控制字元照舊由 git 跳脫，結果行不會被拆開（#589 review）。
  const conflicted = must(tree, '-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  // 解的途中失敗（restamp、add、commit 被 hook 擋）也先 abort，stage worktree 不停在 merge 中途。
  try {
    const how = conflicted.length ? resolveConflicts(tree, conflicted) : undefined;
    if (how) {
      // pre-commit 排全機 heavy-slot：別的 repo 一直忙時等滿上限就 STOP git commit、下一輪又排到隊尾，所以這次不設上限（#637）。
      const commit = run('git', ['-C', tree, 'commit', '--no-edit'], { env: { ...childEnv, HEAVY_CHECK_TIMEOUT: '0' } });
      if (commit.status !== 0) throw new Stop(`git commit ${commit.reason}`);
      console.log(`RESOLVED ${label} ${how} ${conflicted.join(' ')}`);
      return;
    }
    if (!conflicted.length) throw new Stop(`merge ${label} ${merge.reason}`);
    throw new Stop(describe(conflicted));
  } catch (error) {
    if (gitIn(tree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) must(tree, 'merge', '--abort');
    throw error;
  }
}

/** Stage：從 `tip` 重開 stage 分支、依號碼合入成員；傳回 staged SHA。 */
function stage(tree, key, members, tip) {
  must(tree, 'switch', '-q', '-C', `pilot/stage-${key}`, tip);
  for (const [index, { n, branch }] of members.entries()) {
    mergeResolving(tree, branch, n, conflicted => `conflict ${n} ${conflicted
      .map(path => `${path}=${conflictSource(tree, path, tip, branch, members.slice(0, index))}:${conflictKind(tree, path)}`).join(' ')}`);
  }
  return must(tree, 'rev-parse', 'HEAD');
}

/** 讀過幾次 load：$PILOT_LOAD_NOW 的序列依序取值。 */
let loadReads = 0;

/** 讀一次 1 分鐘 load，取到小數兩位；$PILOT_LOAD_NOW（測試用，逗號分隔的序列依序取值、取完停在最後一個）取代實測值。 */
function readLoad() {
  const fake = process.env.PILOT_LOAD_NOW?.split(',');
  const index = Math.min(loadReads++, (fake?.length ?? 1) - 1);
  return Math.round((fake?.every(value => LOAD.test(value)) ? Number(fake[index]) : loadavg()[0]) * 100) / 100;
}

/**
 * load 關卡：1 分鐘 load 超過門檻時在腳本內每 config.loadPoll 秒重讀，降到門檻以下就繼續；等滿 config.loadWait 秒還高才 STOP load（印最後讀到的 load），什麼都還沒動
 * （#588：短暫尖峰就退出時，coordinator 要等下一次喚醒才重跑，batch 555-556 連三次 STOP load 多等約 40 分鐘）。
 * 一次執行裡的各次關卡共用同一個期限（第一次呼叫時起算），合計最多等 config.loadWait 秒。傳回這次有沒有等過：等過的呼叫端要重讀等待前讀的狀態。
 */
let loadDeadline;
function loadGate(max) {
  loadDeadline ??= Date.now() + config.loadWait * 1000;
  let load = readLoad();
  if (load <= max) return false;
  if (config.loadWait > 0) process.stderr.write(`pilot-land: load ${load} > ${max}，最多等 ${config.loadWait} 秒\n`);
  for (; load > max; load = readLoad()) {
    const left = loadDeadline - Date.now();
    if (left <= 0) throw new Stop(`load ${load} ${max}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(config.loadPoll * 1000, left));
  }
  return true;
}

/**
 * Regression：在 stage worktree 以 sh 跑 Regression 指令（--check-command），輸出寫到 reg-<key>.log；傳回 exit code、通過時的結果（`pass`）與 regression 行的值 `line`。
 * 指令經同目錄 heavy-slot.mjs 的全機 slot 執行（label `<主 checkout 目錄名>:regression`）；等 slot 逾時（exit 75 與 SLOT_TIMEOUT 行）時 `slotTimeout` 是那一行。
 * repo 名額 0（heavy-slot 印 SLOT_DELEGATED、exit 76，CoS item 67）時改交給同目錄的 ci-run.mjs（`<sha> --ref pilot/stage-<key>`），見 ciRegression。
 * ciOnly 是 CI_PENDING 之後的重跑：不經 slot，直接再呼叫 ci-run 接著等同一個 run。
 */
function regression(main, tree, key, sha, { ciOnly = false } = {}) {
  const log = join(main, `.scratch/pilot/reg-${key}.log`);
  mkdirSync(dirname(log), { recursive: true });
  const label = `${basename(main)}:regression`;
  /** 跑一步、輸出接到 log 後面（第一步覆寫）；傳回 exit code。 */
  const step = ([command, args], flags) => {
    const fd = openSync(log, flags);
    const result = spawnSync(command, args, { cwd: tree, env: childEnv, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    return result.status ?? 1;
  };
  const local = code => {
    const output = readFileSync(log, 'utf8');
    const last = output.trimEnd().split('\n').pop() ?? '';
    const pass = code === 0 && last.startsWith('CHECK_PASS ') ? last : '';
    return { code, pass, line: `${sha} exit ${code}${pass ? ` ${pass}` : ''}`, slotTimeout: slotTimeoutLine(code, output) };
  };
  if (!ciOnly) {
    const code = step(slotCommand(label, ['sh', '-c', config.check]), 'w');
    if (!slotDelegatedLine(code, readFileSync(log, 'utf8'))) return local(code);
  }
  const ci = ciRegression(sha, () => step([process.execPath, [join(here, 'ci-run.mjs'), sha, '--ref', `pilot/stage-${key}`, '--timeout', config.ciTimeout]], 'a'), log);
  // CI 不可用：以 --fallback 回到本機排隊（排在名額大於 0 的 repo 後面），結果照本機 Regression 判讀。
  return ci ?? local(step(slotCommand(label, ['sh', '-c', config.check], { fallback: true }), 'a'));
}

/**
 * Regression 交給 CI：跑 ci-run（輸出接在 log 後面），以它的 exit 與最後一行判讀；CI 不可用（CI_UNAVAILABLE）傳回 undefined，呼叫端退回本機。
 *   CI_PASS     `<sha> exit 0 CI_PASS <run url>`；
 *   CI_FAIL     `<sha> exit 1 CI_FAIL <run url> <失敗的 step>`（job 有跑、沒過：不退回本機重跑）；
 *   CI_PENDING  `<sha> exit 75 CI_PENDING <run url>`，`ciPending` 是 run url：呼叫端 STOP load ci-pending，重跑時接著等同一個 run（land 的 ciResume）；
 *   其他（ci-run 的用法錯誤、程式錯誤）照它的 exit 記，當成沒過。
 */
function ciRegression(sha, runCi, log) {
  const code = runCi();
  const [verdict, , ...rest] = (readFileSync(log, 'utf8').trimEnd().split('\n').pop() ?? '').split(' ');
  const detail = rest.join(' ');
  if (code === 0 && verdict === 'CI_PASS') return { code: 0, pass: `CI_PASS ${rest[0]}`, line: `${sha} exit 0 CI_PASS ${rest[0]}` };
  if (code === CI_UNAVAILABLE_EXIT && verdict === 'CI_UNAVAILABLE') return undefined;
  if (code === CI_PENDING_EXIT && verdict === 'CI_PENDING') return { code, ciPending: rest[0], line: `${sha} exit ${code} CI_PENDING ${rest[0]}` };
  if (verdict === 'CI_FAIL') return { code: 1, line: `${sha} exit 1 CI_FAIL ${detail}` };
  const failed = code === 0 ? 1 : code;
  return { code: failed, line: `${sha} exit ${failed}` };
}

/** 等 slot 逾時是負載關卡，不是 Regression 沒過：`STOP load slot-timeout <已等秒數>s`。 */
const slotStop = slotTimeout => new Stop(`load slot-timeout ${slotTimeout.split(' ')[2]}`);

/** Regression 的負載關卡：等 slot 逾時、CI 在時限內沒跑完（`STOP load ci-pending <run url>`，重跑接著等同一個 run），都不是沒過。 */
function regressionLoadStop({ slotTimeout, ciPending }) {
  if (slotTimeout) return slotStop(slotTimeout);
  if (ciPending) return new Stop(`load ci-pending ${ciPending}`);
  return undefined;
}

/**
 * staged SHA 合的還是現在這組成員：每個 done 成員的分支都在裡面，其他成員（如 hold 期間 `moved` 的）的分支沒有被這次 stage 合進來。
 * 成員分支在 stage 之後多了 commit 也不算，否則 RESUME 會把沒驗過的組合當成通過。
 */
function sameMembers(main, members, staged, tip) {
  const within = (branch, sha) => gitIn(main, 'merge-base', '--is-ancestor', branch, sha).status === 0;
  return members.every(({ branch, state }) => (state === 'done' ? within(branch, staged) : !within(branch, staged) || within(branch, tip)));
}

/**
 * running 成員先讀一次畫面（#361：pilot-watch 已印 DONE，checkpoint 卻要等下一輪 probe --apply 才改）：用 Probe 的 workerState 讀，
 * 每個 running 成員都讀到結果行時印 `WORKER <n> DONE <sha>`／`WORKER <n> STOP <cause>`，照 probe --apply 寫回成員列；
 * 有一個還在工作或讀不到就 `STOP member <n> running (<worker 狀態>)，先跑 pilot-probe.mjs --apply`，成員列都不改。
 */
async function readRunning(file, key) {
  // 用到時才載入：restamp.mjs 等只 import restampManifest 的腳本不必帶上 pilot-probe.mjs 與它的整串相依（land-restamp 測試只複製部分腳本）。
  const { applyResults, parseBatch, workerResult, workerState } = await import('./pilot-probe.mjs');
  const running = parseBatch(readFileSync(file, 'utf8')).members.filter(m => m.state === 'running');
  if (!running.length) return;
  const results = [];
  for (const member of running) {
    const state = await workerState({ cli: process.env.ORCA_CLI_COMMAND }, member);
    const { kind, sha } = workerResult(state);
    if (!kind) throw new Stop(`member ${member.n} running (${state})，先跑 pilot-probe.mjs --apply`);
    // 帶讀取的 handle：列已換成重派的預留列或新分頁時不寫（#590，applyResults）。
    results.push({ n: member.n, state: kind === 'DONE' ? 'done' : 'stop', sha, handle: member.handle, line: `WORKER ${member.n} ${state}` });
  }
  for (const { line } of results) console.log(line);
  const misses = applyResults(file, key, results);
  const locked = misses.find(line => line.startsWith('CHECKPOINT_LOCKED '));
  if (locked) throw new CheckpointLocked(locked);
  if (misses.length) throw new Stop(`checkpoint ${misses.join(' ')}`);
}

/** issue-run checkpoint 裡 `[confirm]` ruling 的行數（行首，前面可有 `- `／`* `）；checkpoint 讀不到時 0。 */
const confirmRulings = text => (text.match(/^[ \t]*(?:[-*][ \t]+)?\[confirm\]/gm) ?? []).length;

/**
 * operator-questions 關卡（#406）：第一個有 `[confirm]` ruling、gates.md 卻沒有 gate 指向它的 done 成員 `{ n, count }`，沒有時 undefined。
 * 請求分支（n 不是號碼）沒有 issue-run checkpoint，不檢查。
 */
function operatorQuestions(members, gated) {
  for (const m of members) {
    if (!/^\d+$/.test(String(m.n)) || gated.has(String(m.n)) || !m.worktree) continue;
    const file = join(m.worktree, `.scratch/issue-run-${m.n}/state.md`);
    const count = existsSync(file) ? confirmRulings(readFileSync(file, 'utf8')) : 0;
    if (count) return { n: m.n, count };
  }
  return undefined;
}

/** 整個流程；傳回 MERGED 的 SHA，其他結果丟 Stop。 */
async function land(key, loadMax) {
  const main = mainCheckout();
  const file = join(main, `.scratch/pilot/batch-${key}.md`);
  const first = readCheckpoint(file);
  const branch = `pilot/stage-${key}`;
  const merged = first.current.match(/^merged ([0-9a-f]{40})\b/)?.[1];
  // #500：merged 之後有 done 成員重報 DONE 的新候選（不在 merged 裡）就重新 stage；candidate 不是 SHA 或讀不到時照舊。
  const within = sha => gitIn(main, 'merge-base', '--is-ancestor', sha, merged).status === 0;
  const restage = merged && first.members.some(m => m.state === 'done' && /^[0-9a-f]{7,40}$/.test(m.candidate ?? '')
    && gitIn(main, 'cat-file', '-e', `${m.candidate}^{commit}`).status === 0 && !within(m.candidate));
  if (merged && !restage && gitIn(main, 'merge-base', '--is-ancestor', merged, config.integration).status === 0) return merged;
  if (!restage && !/^(dispatched|staged)\b/.test(first.current)) throw new Stop(`checkpoint current: ${first.current}`);
  await readRunning(file, key);
  // readRunning 可能剛把 running 列寫回 done／stop：之後一律看重讀的這一份。
  const checkpoint = readCheckpoint(file);
  const pending = checkpoint.members.find(m => m.state !== 'done' && !m.state?.startsWith('moved'));
  if (pending) throw new Stop(`member ${pending.n} ${pending.state}`);
  const members = checkpoint.members.filter(m => m.state === 'done');
  if (!members.length) throw new Stop(`checkpoint ${file} 沒有 done 成員`);
  const gatesFile = join(main, '.scratch/pilot/gates.md');
  const gatesText = existsSync(gatesFile) ? readFileSync(gatesFile, 'utf8') : '';
  const held = heldIssues(openGates(gatesText));
  // 成員列的 n 是數字（請求分支是分支名稱），heldIssues 的 key 是號碼字串。
  const blocked = members.find(m => held.has(String(m.n)));
  if (blocked) throw new Stop(`held ${blocked.n} ${held.get(String(blocked.n))}`);
  const unasked = operatorQuestions(members, gateIssues(gatesText));
  if (unasked) throw new Stop(`operator-questions ${unasked.n} ${unasked.count}`);

  let tip = must(main, 'rev-parse', config.integration);
  const [, staged, onto] = checkpoint.current.match(/^staged ([0-9a-f]{40}) onto ([0-9a-f]{40})\b/) ?? [];
  const unchanged = staged && onto === tip
    && gitIn(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`).stdout.trim() === staged
    && sameMembers(main, checkpoint.members, staged, tip);
  const resume = unchanged && checkpoint.regression?.startsWith(`${staged} exit 0`);
  // CoS item 67：上一輪 CI 在時限內沒跑完（STOP load ci-pending）時不重新 stage（新的合併 SHA 會是另一個 run），接著等同一個 SHA 的 run。
  const ciResume = unchanged && checkpoint.regression?.startsWith(`${staged} exit ${CI_PENDING_EXIT} CI_PENDING `);
  const getTree = () => stageWorktree(main) ?? createStageWorktree(main, key);
  if (!resume && !ciResume) {
    // 等過 load 之後從頭再走一次（#588 review）：等待前讀的成員（期間被 move）、gates（期間開了 hold）與整合分支 tip 都可能已變。
    if (loadGate(loadMax)) return land(key, loadMax);
    // #366：要 stage 時先讓整合分支包含 origin/<主分支>（同 sync-main），否則 Push gate 才 STOP behind-main、Regression 再跑一次（investing#313）。
    // RESUME 不同步：staged SHA 已驗過，落後時照舊交給 Push gate 的 sync-main。沒有 origin remote 時沒有可落後的對象。
    if (gitIn(main, 'remote', 'get-url', 'origin').status === 0) {
      const synced = syncMain(loadMax, main, getTree);
      if (synced.moved) {
        console.log(`SYNCED ${synced.value}`);
        tip = must(main, 'rev-parse', config.integration);
      }
    }
  }
  const tree = getTree();
  if (must(tree, 'status', '--porcelain')) throw new Stop(`dirty ${tree}`);
  let sha;
  if (resume) {
    sha = staged;
    console.log(`RESUME ${key} ${sha}`);
  } else {
    if (ciResume) {
      sha = staged;
      markStaged(file, sha, tip);
      console.log(`RESUME ${key} ${sha} ci-pending`);
    } else {
      sha = stage(tree, key, members, tip);
      markStaged(file, sha, tip);
      console.log(`STAGED ${key} ${sha} onto ${tip}`);
    }
    const result = regression(main, tree, key, sha, { ciOnly: ciResume });
    appendRegression(file, result.line);
    const load = regressionLoadStop(result);
    if (load) throw load;
    if (result.code !== 0) throw new Stop(`regression ${result.code}`);
  }

  if (existsSync(join(main, '.scratch/pilot/hold'))) throw new Stop('hold');
  if (must(main, 'rev-parse', config.integration) !== tip) throw new Stop('drift');
  must(tree, 'switch', '-q', config.integration);
  must(tree, 'merge', '--ff-only', '-q', branch);
  must(tree, 'branch', '-d', branch);
  setCurrent(file, `merged ${sha}`);
  return sha;
}

/**
 * #502：checkpoint 的 `postland: #<n> <command>` 行（pilot-watch 從 worker 的 POSTLAND 行記下）中屬於 done 成員的，依成員號碼、同一成員依檔案順序，
 * 各一行 `POSTLAND_PENDING <n> <command>`；沒有時空陣列，輸出與以前相同。
 */
function postlandPending(key) {
  const file = join(mainCheckout(), `.scratch/pilot/batch-${key}.md`);
  const entries = postlandEntries(readFileSync(file, 'utf8'));
  return readCheckpoint(file).members.filter(m => m.state === 'done')
    .flatMap(m => entries.filter(entry => entry.n === String(m.n)).map(entry => `POSTLAND_PENDING ${entry.n} ${entry.command}`));
}

const SYNC_BRANCH = 'pilot/stage-sync-main';

/** 子腳本（旁邊的 pilot-pr-body.mjs、land.mjs）在主 checkout 跑：stdout 照印，傳回 exit code 與最後一行。stderr 直接顯示。 */
function runScript(main, name, args, { hide, env = {} } = {}) {
  const result = spawnSync(process.execPath, [join(here, name), ...args], { cwd: main, encoding: 'utf8', env: { ...childEnv, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = (result.stdout ?? '').trimEnd().split('\n').filter(Boolean);
  const last = lines.at(-1) ?? '';
  const shown = hide?.(last) ? lines.slice(0, -1) : lines;
  if (shown.length) process.stdout.write(`${shown.join('\n')}\n`);
  return { code: result.status ?? 1, last };
}

/** 重跑本檔同一行的指令（land.mjs 的 STOP checks-timeout 箭頭後印它）：`node <本檔相對 cwd 的路徑> <原參數>`，參數照 shell 加引號。 */
function rerunSelf() {
  const quote = arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
  const self = relative(process.cwd(), process.argv[1]);
  return ['node', self.startsWith('..') ? process.argv[1] : self, ...process.argv.slice(2)].map(quote).join(' ');
}

/**
 * push：Push gate 單一入口（#395）。pr-body → land；land 印 STOP behind-main 時 sync-main、重產 body、再 land 一次。
 * 傳回要結束的 exit code；最後一行已印出（land.mjs 或 pilot-pr-body.mjs 的）。sync-main 的 STOP 丟 Stop。
 */
function push(title, loadMax, mainOption) {
  const main = mainCheckout();
  const body = join(main, '.scratch/pilot/pr-body.md');
  mkdirSync(dirname(body), { recursive: true });
  const behind = line => line.startsWith('STOP behind-main ');
  // #665 第 4 項：push 由 coordinator 以背景執行，不受 Bash 前景 600 秒限制；land.mjs 的等 CI 改以 $PILOT_CI_TIMEOUT_S 為期限（同 ci-run），
  // 不用它為前景設的預設 480 秒。期限在每次等 CI 時起算，sync-main 之後那輪 CI 由第二次 land.mjs 從頭計。
  const checksTimeout = String(Math.round(Number(config.ciTimeout) * 1000));
  for (let attempt = 0; ; attempt++) {
    const prBody = runScript(main, 'pilot-pr-body.mjs', [main, '--out', body]);
    if (prBody.code !== 0) return prBody.code;
    const landed = runScript(main, 'land.mjs', [config.integration, '--keep-branch', '--title', title, '--body-file', body, '--check-command', config.check,
      ...(mainOption ? ['--main', mainOption] : [])], { hide: line => attempt === 0 && behind(line), env: { LAND_RERUN_COMMAND: rerunSelf(), LAND_CHECKS_TIMEOUT_MS: checksTimeout } });
    if (attempt > 0 || !behind(landed.last)) return landed.code;
    console.log(`PUSH_BEHIND_MAIN ${config.integration}`);
    console.log(`SYNCED ${syncMain(loadMax, main).value}`);
  }
}

/**
 * sync-main：讓整合分支包含 origin/<主分支>（Push gate 的 STOP behind-main，#193；batch 要 stage 前也呼叫，#366）。
 * 傳回 `{ value, moved }`：value 是 SYNCED 行 `<sha> <說明>`，moved 是整合分支有沒有前進；其他結果丟 Stop。
 * getTree 取 stage worktree（沒有時建立），只在要動整合分支時才呼叫。
 */
function syncMain(loadMax, main = mainCheckout(), getTree = () => stageWorktree(main) ?? createStageWorktree(main, 'sync-main')) {
  must(main, 'fetch', '-q', 'origin');
  const tip = must(main, 'rev-parse', config.integration);
  const upstream = must(main, 'rev-parse', `origin/${config.main}`);
  const ancestor = (a, b) => gitIn(main, 'merge-base', '--is-ancestor', a, b).status === 0;
  if (ancestor(upstream, tip)) return { value: `${tip} current`, moved: false };
  const behind = ancestor(tip, upstream);
  // 分叉時要跑 Regression：和 batch 的 Stage 一樣，建 stage worktree、切分支之前先過 load 關卡（#178），STOP load 時什麼都不動。
  if (!behind) loadGate(loadMax);
  const tree = getTree();
  if (must(tree, 'status', '--porcelain')) throw new Stop(`dirty ${tree}`);
  // 只是落後（retro 直接落地進 main）：快轉到 CI 已驗過的 origin/main，不必再跑 Regression；merged batch 這時都已在 origin/main。
  if (behind) {
    must(tree, 'switch', '-q', config.integration);
    must(tree, 'merge', '--ff-only', '-q', upstream);
    return { value: `${upstream} ff`, moved: true };
  }
  const pending = pendingSync(main, tip, upstream);
  if (pending) {
    // CoS item 67：上一次 sync-main 的 CI 在時限內沒跑完：沿用同一個合併 commit，接著等同一個 run。
    must(tree, 'switch', '-q', SYNC_BRANCH);
  } else {
    must(tree, 'switch', '-q', '-C', SYNC_BRANCH, tip);
    // 合入先記下的 SHA，不是 ref：上面的祖先判斷用的是它，期間別處 fetch 讓 origin/main 前進也合同一個。
    mergeResolving(tree, upstream, 'sync-main', conflicted => `conflict sync-main ${conflicted.map(path => `${path}=main:${conflictKind(tree, path)}`).join(' ')}`);
  }
  const sha = must(tree, 'rev-parse', 'HEAD');
  const result = regression(main, tree, 'sync-main', sha, { ciOnly: Boolean(pending) });
  const load = regressionLoadStop(result);
  if (load) throw load;
  const { code, pass } = result;
  if (code !== 0) throw new Stop(`regression sync-main ${code}`);
  if (must(main, 'rev-parse', config.integration) !== tip) throw new Stop('drift');
  // 先寫 checkpoint 再快轉：寫到一半失敗時整合分支還沒動，重跑會重新合併、再寫一次（最後一行為準）；
  // 反過來的話重跑只看到「已包含」，補不回 regression 行，Probe 又印 NOT_IN_MAIN（#193 review）。
  recordSync(main, sha, `${sha} exit 0 sync-main${pass ? ` ${pass}` : ''}`, upstream);
  must(tree, 'switch', '-q', config.integration);
  must(tree, 'merge', '--ff-only', '-q', SYNC_BRANCH);
  must(tree, 'branch', '-d', SYNC_BRANCH);
  return { value: pass ? `${sha} ${pass}` : sha, moved: true };
}

/**
 * 上一次 sync-main 停在 CI_PENDING 的合併 commit：本機 pilot/stage-sync-main 的 parent 正好是 <tip> 與 <upstream>，
 * 而 reg-sync-main.log 的最後一行是它的 `CI_PENDING <sha> …`（ci-run 的結果行）。是的話傳回那個 SHA，否則 undefined（照常重新合併）。
 */
function pendingSync(main, tip, upstream) {
  const sha = gitIn(main, 'rev-parse', '-q', '--verify', `refs/heads/${SYNC_BRANCH}`).stdout.trim();
  if (!sha) return undefined;
  const parents = gitIn(main, 'rev-list', '--parents', '-n', '1', sha).stdout.trim().split(' ').slice(1);
  if (parents.length !== 2 || parents[0] !== tip || parents[1] !== upstream) return undefined;
  const log = join(main, '.scratch/pilot/reg-sync-main.log');
  const last = existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n').pop() : '';
  return last.startsWith(`CI_PENDING ${sha} `) ? sha : undefined;
}

/**
 * sync-main 通過後、快轉之前，每個 `current: merged <sha>`、<sha> 在合併 SHA 裡、而且還沒推上 `origin/<整合分支>` 也不在 `origin/<主分支>`（upstream）的 batch
 * 追加同一個 `<sync sha> exit 0 sync-main …` 行並印 `RECORDED <key>`：
 * Probe 以最後一個 regression 行比對整合分支的 tip，沒有這行就把已驗過的 tip 印成 `NOT_IN_MAIN <key> tip …`；
 * `sync-main` 標記讓 pilot-pr-body.mjs 往前找 staged SHA 那一行來驗（#193）。
 * 已推的 batch 保留舊 regression 行（#523 方案 C）：否則每次 sync 都讓停在 `merged` 的歷史 batch 在 Probe 印成 `RESUME_PUSH`（investing 一次約 200 行）。
 */
function recordSync(main, sha, value, upstream) {
  const dir = join(main, '.scratch/pilot');
  const files = existsSync(dir) ? readdirSync(dir).filter(name => /^batch-.+\.md$/.test(name)).sort() : [];
  const ancestor = (a, b) => gitIn(main, 'merge-base', '--is-ancestor', a, b).status === 0;
  // 遠端整合分支不存在（從沒推過或已刪）時只比 upstream。
  const remote = `refs/remotes/origin/${config.integration}`;
  const pushedRefs = [upstream, ...(gitIn(main, 'rev-parse', '-q', '--verify', `${remote}^{commit}`).status === 0 ? [remote] : [])];
  for (const name of files) {
    const file = join(dir, name);
    const merged = readFileSync(file, 'utf8').match(/^current:[ \t]*merged ([0-9a-f]{7,40})\b/m)?.[1];
    if (!merged || !ancestor(merged, sha) || pushedRefs.some(ref => ancestor(merged, ref))) continue;
    // 寫入本身失敗（唯讀、磁碟滿）也是 STOP checkpoint，不是程式錯誤：檔頭與 pilot-after-merge.md 的 Push gate 都這樣承諾，整合分支這時還沒動。
    try {
      appendRegression(file, value);
    } catch (error) {
      if (error instanceof Stop || !error?.code) throw error;
      throw new Stop(`checkpoint ${file} 寫不進去：${error.code}`);
    }
    console.log(`RECORDED ${name.slice('batch-'.length, -'.md'.length)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [key, ...rest] = process.argv.slice(2);
  const options = {};
  let bad = false;
  for (let i = 0; i < rest.length; i += 2) {
    const name = new Map(Object.entries({ '--branch': 'request', '--title': 'title', '--load-max': 'loadMax', '--check-command': 'check', '--integration': 'integration', '--main': 'main', '--resolver': 'resolver' })).get(rest[i]);
    if (!name || name in options || rest[i + 1] === undefined) bad = true;
    else options[name] = rest[i + 1];
  }
  const { request, title, check = config.check, integration = config.integration, main = config.main, resolver } = options;
  // --title 只給 push，push 一定要有。
  if ((key === 'push') !== (title !== undefined) || (title !== undefined && !title.trim())) bad = true;
  if ((key === 'sync-main' || key === 'push') && !bad) runInStageWorktree(import.meta.url, process.argv.slice(2), { integration });
  // 本檔所在 checkout 的根：副本在 <root>/scripts/，正本在 <root>/skills/engineering/setup-workflow/templates/，都以 scripts/ 的上一層為準。
  const resolverPath = resolver === undefined ? undefined : resolve(here, '..', resolver);
  const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  const loadMax = options.loadMax ?? (process.env.PILOT_LOAD_MAX || String(3 * availableParallelism()));
  const loadWait = process.env.PILOT_LOAD_WAIT_SECONDS || String(config.loadWait);
  const loadPoll = process.env.PILOT_LOAD_POLL_SECONDS || String(config.loadPoll);
  const ciTimeout = process.env.PILOT_CI_TIMEOUT_S || config.ciTimeout;
  if (bad || !/^[a-z0-9][a-z0-9-]*$/.test(key ?? '') || !LOAD.test(loadMax) || !LOAD.test(loadWait) || !LOAD.test(loadPoll) || !LOAD.test(ciTimeout) || !check.trim()
    || !branchName.test(integration) || integration.startsWith('pilot/stage-') || !branchName.test(main)
    || (resolverPath !== undefined && !existsSync(resolverPath))
    || (request !== undefined && !(/^req-\d+$/.test(key) && /^retro\/[a-z0-9][a-z0-9-]*$/.test(request)))) {
    console.error(USAGE);
    process.exit(2);
  }
  Object.assign(config, { check, integration, main, loadWait: Number(loadWait), loadPoll: Number(loadPoll), ciTimeout: ciTimeout });
  if (resolverPath) config.resolver = await import(pathToFileURL(resolverPath).href);
  try {
    // `sync-main --branch …`、`push --branch …` 已被上面 req-<n> 的檢查擋成用法錯誤。
    if (key === 'push') process.exit(push(title, Number(loadMax), options.main));
    if (key === 'sync-main') {
      console.log(`SYNCED ${syncMain(Number(loadMax)).value}`);
      process.exit(0);
    }
    if (request) openRequest(key, request, Number(loadMax));
    const sha = await land(key, Number(loadMax));
    for (const line of postlandPending(key)) console.log(line);
    console.log(`MERGED ${key} ${sha}`);
  } catch (error) {
    if (!(error instanceof Stop)) {
      exitIfLocked(error);
      throw error;
    }
    console.log(`STOP ${error.message}`);
    process.exit(4);
  }
}
