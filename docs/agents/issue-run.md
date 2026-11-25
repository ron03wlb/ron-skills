# issue-run adapter：ron-skills

沒寫到的段落都沿用 [ADAPTER.md](../../skills/engineering/issue-run/ADAPTER.md) 的預設值。

## Platforms

macOS, WSL2, Linux（母單 #82 決策 R1-Q1；原生 Windows 不支援）。本檔列的每條指令三種平台都要能跑；只為某個平台加的 workaround 寫明是哪個平台（例如 pilot-exceptions.md 的 Bare guard 是 WSL 專屬，其他平台跑了無害）。

## Tracker

[issue-tracker.md](issue-tracker.md)。讀 Issue 一律用 `--json`：`gh issue view <n> --comments` 在非 tty 環境只印 metadata 與留言、沒有 body（#428，`claude-hook-bash-pitfalls.mjs` 會擋）。

寫入目標是 https://github.com/ron03wlb/ron-skills ：`scripts/gh-tracker.mjs` 從這一段讀主機與 repo，段裡的 GitHub 專案網址只能指向這一個專案（多一個或少了它都 exit 2，#244）。

開單或排 `blocked-by` 前的重疊檢查（grilling、`/retro` 的 Tracker duplicates 說的「adapter 指名的 pre-creation overlap check」）：`node scripts/worktree-overlap.mjs <檔案>…` 找正在改這些檔的 worktree，`gh issue list --state open --search "<檔名> in:title,body"` 找開著的單；印 `TEMPLATE_COPY <副本> <正本>` 時要改的是 `skills/engineering/setup-workflow/templates/` 的正本，正本也要一起查（#383）。

## Delivery

程式碼 host 是 `github`（`github.com`，`origin` 為 `ron03wlb/ron-skills`），CLI 是 `gh`，和 tracker 同一個 host。PR 的開、讀、等 CI、合併照 [HOSTS.md](../../skills/engineering/setup-workflow/HOSTS.md) 的 GitHub 欄（`gh pr create`、`gh pr view`、`gh pr checks --watch`、`gh pr merge --merge --match-head-commit <sha>`），平常不手打：交付指令是 `node scripts/land.mjs <branch> --body-file <file> --check-command 'bin/check --upstream'`，步驟與結果行見 [Evidence and closing](#evidence-and-closing)。CI 設定在 `.github/workflows/checks.yml`，跑 `bin/check --upstream`。

**CI 執行端**：只有遠端（GitHub Actions），`main` 有 branch protection（#402）；`land.mjs` 印 `STOP ci-not-started` 時照 [issue-run-landing.md](issue-run-landing.md) 的 `## CI 執行端` 處理。

## Readiness

就緒狀態是 `ready-for-agent` label（[triage-labels.md](triage-labels.md)）。沒有 preflight。還沒就緒時用 `/triage <n>` 補齊。

跨 repo 對應單指向 GitLab 或 GitHub Enterprise 專案時，本文寫 issue 網址，不寫裸的 `<owner>/<repo>#<m>`：裸 ref 一律當成 github.com，要到 Close 才 `STOP <n> counterpart`（#289、#291 的 `spay/spay2#692`，#295）。已知不在 github.com 的對應專案宣告在下一行（spay2 在自架 GitLab，專案網址 http://192.168.200.202/spay/spay2），`pilot-counterpart.mjs --adapter docs/agents/issue-run.md` 對命中的裸 ref 多印 `COUNTERPART_BARE`，Probe 對 ready 單與開著的 batch 成員印 `COUNTERPART_BARE <n> <ref>`（處理見 [pilot-exceptions.md](pilot-exceptions.md) 的 **Probe lines.**，#304）。`/triage` 標 `ready-for-agent` 前帶 `--adapter` 看 `pilot-counterpart.mjs` 的輸出。

Counterpart projects: `spay/spay2`

驗收與做法用到的每份輸入（原始碼、樣本、憑證、checkout）都要能從本 repo、tracker 或公開來源取得。只存在於其他專案的 checkout 或某台機器本地路徑的，Issue 維持 `needs-info`，triage notes 寫明缺的是什麼、去哪裡拿；這是 `/triage` 標 `ready-for-agent` 前的判斷，不是 preflight 指令（#56 的驗收要逐檔比對只在別台機器上的 spay2，worker 開工就 `STOP prerequisite missing`，#116）。

## Claim

`node scripts/issue-pool.mjs claim <n>`：單獨跑的 `/issue-run <n>` 開工前也要跑，印 `CLAIMED <n>` 才繼續，`STOP <n> claimed …` 表示別的 session 在做（#297：有別的 session 同時動 `main`，靠 agent 記得才沒撞）。pilot worker（`--worker`）不跑：coordinator Dispatch 時已用自己的 session 認領，worker 跑會印 `STOP <n> claimed <coordinator>`（exit 4），那不是停下的理由（#446）。

## Worktrees and checkpoint

從 `main` 開 `issue/<n>-<slug>` 分支，一張 ticket 也開 worktree：主 checkout 有 `scripts/claude-hook-main-checkout.mjs` 擋寫入（#30）。設了 `ORCA_CLI_COMMAND` 時用 `node scripts/orca-worktree-create.mjs --name issue-<n> --base-branch main --branch issue/<n>-<slug>` 開（看最後一行 JSON 的 `path`），沒有 Orca 時用 `git worktree add`；多張 ticket 依 implement-spec 各開一個。接手已有遠端分支的單（`node scripts/issue-pool.mjs open-work <n>` 印 `OPEN_PR` 或 `BRANCH … origin`）時 `--base-branch origin/<分支> --branch <分支>`；Orca 可能給 `<分支>-2`，腳本在 stderr 印 `BRANCH_RENAMED <拿到的> <要求的>`、JSON 多帶 `requestedBranch`，這時在新 worktree 跑 `git branch -m <要求的>` 與 `git branch -u origin/<要求的>`，否則 `land.mjs` 會另開一個 PR（#300）。checkpoint 放在 `.scratch/issue-run-<n>/state.md`，不 commit；SKILL Decisions 說的 rulings file 是它的 `## rulings` 段。本 repo 沒有 confirm gate：`confirm` ruling 照 SKILL 停下，worker 印 `STOP <n> decision <摘要>`。pilot worker 的結果（Worker result）照 SKILL 的 Worker mode，最後一行 `DONE <n> <sha>` 或 `STOP <n> <cause>`（`pilot-watch.mjs` 只讀這兩種，與 `DONE` 前的 `POSTLAND <n> <指令>`，#502）；Autonomous decisions 與範圍外的 observation 寫在結果行之前的報告裡（#414）；證據留言末行也寫 `DONE` 行（#411）。

## Checks

只有一條：`bin/check`。開發中和寫 brief、驗收條件時都只引用這條，不要自己拼 `node --test …`。單一測試檔可以用 `node --test tests/<name>.test.mjs`：整份輸出導到 `.scratch/` 下的新檔，只讀最後的 `ℹ pass <n>`／`ℹ fail <n>`，失敗再讀那個檔；預設 reporter 沒有 TAP 的 `# pass` 行，`grep '^# (pass|fail)'` 一定撲空（#418）。開假 Orca 與暫存 git repo 的範本測試（`pilot-probe.test.mjs`、`pilot-dispatch.test.mjs` 等）單檔就要數分鐘，整檔用 `run_in_background`，只驗一兩個測試時加 `--test-name-pattern`（#474）。`bin/check` 成功時最後一行是 `CHECK_PASS tests <a>+<b>+…`，失敗時是 `CHECK_FAIL <步驟> [<失敗的測試>｜…]`（步驟是 `docs-rules`（只讀文件與清單的規則，不到兩秒，排在整條測試之前）、`tests`、`template-tests`、`fake-orca-macos`，或測試之前失敗的那條指令）：只讀最後一行就知道哪裡壞，不要為了找測試名稱整條重跑存 log（#267）。`bin/check`、`git commit`（pre-commit 跑 `bin/check`）、`land.mjs` 一律用 Bash 的 `run_in_background`，高負載時二十幾分鐘（#297）；完整 `bin/check` 自己先排全機 heavy-slot，exit 75 就稍後重跑（item 138）。`bin/check` 通過後記下工作樹的 tree hash，pre-commit 遇到同一棵樹就跳過（`scripts/check-stamp.mjs`），所以先跑 `bin/check` 再 commit 只跑一次；要 review 的改動等 review 全部修完才跑（或直接 commit 讓 pre-commit 跑），不和 review 並行，修正一改樹，先跑的那次就作廢（#419：同一張單跑三次只有最後一次算），背景跑的每一次各寫一個新 log 檔，寫成 `bin/check > <log> 2>&1; echo exit=$?; tail -1 <log>`，不接 `| tail`（exit 是 tail 的，hook 會擋）；通知完成、log 最後一行卻不是 `CHECK_PASS`／`CHECK_FAIL`／`CHECK_STAMP_FRESH` 時，`node scripts/check-stamp.mjs fresh "$(node scripts/check-stamp.mjs tree)"` exit 0 即已通過，否則重跑，前一份還在跑時只印 `CHECK_BUSY <pid>`（#479）；檢查途中改檔安全，那棵樹不會被記下，不必中止（#412）；acceptance、`land.mjs`、CI 永遠真的跑。行為不變的重構，以同一條 `bin/check` 在 base 上為綠當作 baseline。

`docs/agents/workflow-templates.json` 列出的 `scripts/` 檔是 setup-workflow 正本（`skills/engineering/setup-workflow/templates/`）的副本，不直接改，也不手動 `cp` 或手算 sha256：改正本、`git add` 後跑 `node skills/engineering/setup-workflow/scripts/copy-templates.mjs . --staged --no-tests <名稱>`，它複製副本並更新清單裡的 sha256，同一個 commit 一起交（只改正本的 commit 過不了 pre-commit 的 `tests/template-copies.test.mjs`，retro spay2 b949589b#3）。兩份測試、改結果行格式、改 import、編輯腳本與 review 判斷題的細則見 [issue-run-checks.md](issue-run-checks.md)。

## Review

Skill `code-review`，比對基準是分支的 merge-base。不阻擋的 findings 列在 Issue 的證據留言。所有 `SKILL.md`、`ADAPTER.md` 和 `overlays/*.patch` 都會改變 agent 的行為，不算只改文字。diff 改了這些檔時，Spec reviewer 要照順序走過每個分支，回報有沒有動作排在會阻止它的句子之前：文字契約測試只驗句子在不在，驗不到順序（#293：「只宣告一部分就停」寫在開單的條件之後，照順序讀會先開單才停，`bin/check` 全綠）。判斷題見 [issue-run-checks.md](issue-run-checks.md)。review agent 只跑相關的單一測試檔（`node --test tests/<name>.test.mjs`），`bin/check` 由 acceptance 負責，派工 prompt 要寫明（#300：Spec agent 自己跑 `bin/check`，load 40–60 時一輪 30 分鐘；第二輪明寫不要跑，同軸只花 5.5 分鐘）；單檔測試在前景跑（Bash `timeout: 600000`），同一個檔只跑一次，不開背景、不重開，`pilot-probe.test.mjs` 這類數分鐘的檔加 `--test-name-pattern` 只跑相關的測試（#418、#474：verifier 背景測試沒跑完就回報，或同一檔開兩份）。safety-fact 類別（SKILL 的 **Safety fact.**）除預設外，還有 `.claude/settings.json` 放行的寫入 wrapper（`gh-tracker.mjs`、`land.mjs`、`pilot-close.mjs`，見 [pilot-exceptions.md](pilot-exceptions.md) 的 **Permissions.**）：review 點名寫入目標固定、參數白名單封閉兩項事實，並對每個從檔案（批次檔、狀態檔、checkpoint）進到 gh argv 的值試偽造的內容（#451：手改 `created` 可把 `../`、網址或 `-R` 送進 gh，`bin/check` 全綠）。

## Candidate and acceptance

candidate 是分支 tip。acceptance 是在 candidate SHA、工作樹乾淨時跑 `bin/check --upstream`：本機 `~/code/skills` 是會落後上游的 fork，只跑本機版本看不到 overlay 漂移。

## Evidence and closing

證據貼成 Issue 留言（candidate SHA、指令與 exit code、findings）。內文用 Write 寫進 scratchpad 再交給 `--body-file`：沒加引號的 `<<EOF` 會把內文的行內碼當命令執行（#444，同一支 hook 會擋）。

單獨跑的 `/issue-run` 在 acceptance 通過、證據貼好之後自己落地，不等人：把 PR body（`/pr` 格式，每張 Issue 一行 `Closes #<n>`）寫進 scratchpad，用 Bash `timeout: 600000` 跑 `node scripts/land.mjs <candidate 所在分支> --title '<標題>' --body-file <檔> --check-command 'bin/check --upstream'`。它 push、開 PR、等 CI、以 merge commit 合併，再移除該分支的 worktree、刪本機與 `origin` 分支、讓主 checkout 的 `main` 跟上；多張 ticket 時，各 ticket 的 worktree 在 `LANDED` 之後另外移除（Orca 建的用 `"$ORCA_CLI_COMMAND" worktree rm --worktree path:<path>`，會一起刪掉分支；其餘用 `git worktree remove` 加 `git branch -d`）。讀最後一行，每種結果行怎麼處理在 [issue-run-landing.md](issue-run-landing.md) 的 `## land.mjs 結果行`，用 `node scripts/adapter-line.mjs 'land.mjs 結果行'` 只取那一節；`LANDED <pr> <merge sha>` 是落地完成，其他 `STOP` 照該節處理或停下回報人，不硬合。

pilot 底下的 worker 印 `DONE` 前在 checkpoint 末尾寫 `State: done, candidate <完整 SHA>`（分頁先結束時 probe 讀它，#529），不落地：push、開 PR、合併與關單都由 coordinator 照 [pilot-after-merge.md](pilot-after-merge.md) 的 Push gate 與 Close 做。

## 分頁狀態

session 開頭用 `node scripts/tab-state.mjs 處理中 --topic "<主題>"` 設整個標題，之後只換狀態用 `node scripts/tab-state.mjs <狀態>`；`.claude/settings.json` 掛的 `scripts/claude-hook-tab-state.mjs` 自動做能偵測的轉換。何時切到 **待 Retro.**、**待關閉.**、兩種寫法的輸出（`TAB_STATE_FAILED`、`TAB_STATE_SKIP split`）、hook 擴充與讀不回標題在 [issue-run-tab-state.md](issue-run-tab-state.md)：要自己切狀態或 hook exit 2 要求改名時讀，用 `node scripts/adapter-line.mjs '待 Retro'` 這類條目名只取一條。

## Pilot

給 `/issue-pilot` coordinator 的設定在 [pilot.md](pilot.md)，每輪都整份讀（必讀核心）；每輪步驟的整條在 [pilot-round.md](pilot-round.md)，只在某些情況用到的條目拆在 [pilot-after-merge.md](pilot-after-merge.md)、[pilot-conflict.md](pilot-conflict.md)、[pilot-exceptions.md](pilot-exceptions.md)、[pilot-retro-collect.md](pilot-retro-collect.md)，pilot.md 的同名條目是一行 pointer，寫明哪一步或什麼情況才讀，用 `node scripts/adapter-line.mjs '<條目名>'` 只取那一條（#166、#344）。條目之間空一行，讓改不同條目的修改落在不同的 hunk（#45）；比對整合分支上的 adapter 時，這幾份都要一起比。條目都是單行（**Probe lines.** 約 10 KB），`head` 限行數擋不住單行長度：找某個詞用 `node scripts/doc-excerpt.mjs '<regex>' <檔案>...` 只取前後文（預設約 60 字，要讀整句處理規則時加 `--width 600`，#449；例如 Probe 印的 `BEHIND_MAIN` 怎麼處理，不必整條讀 **Probe lines.**），不要直接 `grep -n`（#274：三個 grep 印了 56 KB），`grep -o '.\{0,60\}…'` 在 ugrep 會報 `exceeds complexity limits`（#295）。分支與 worktree 的整體狀態用 `node scripts/branch-audit.mjs`（唯讀，#287）。
