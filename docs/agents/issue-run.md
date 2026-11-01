# issue-run adapter：ron-skills

沒寫到的段落都沿用 [ADAPTER.md](../../skills/engineering/issue-run/ADAPTER.md) 的預設值。

## Platforms

macOS, WSL2, Linux（母單 #82 決策 R1-Q1；原生 Windows 不支援）。本檔列的每條指令三種平台都要能跑；只為某個平台加的 workaround 寫明是哪個平台（例如 pilot-exceptions.md 的 Bare guard 是 WSL 專屬，其他平台跑了無害）。

## Tracker

[issue-tracker.md](issue-tracker.md)。讀 Issue 一律用 `--json`：`gh issue view <n> --comments` 在非 tty 環境不會輸出任何東西。

寫入目標是 https://github.com/ron03wlb/ron-skills ：`scripts/gh-tracker.mjs` 從這一段讀主機與 repo，段裡的 GitHub 專案網址只能指向這一個專案（多一個或少了它都 exit 2，#244）。

## Delivery

程式碼 host 是 `github`（`github.com`，`origin` 為 `ron03wlb/ron-skills`），CLI 是 `gh`，和 tracker 同一個 host。PR 的開、讀、等 CI、合併照 [HOSTS.md](../../skills/engineering/setup-workflow/HOSTS.md) 的 GitHub 欄（`gh pr create`、`gh pr view`、`gh pr checks --watch`、`gh pr merge --merge --match-head-commit <sha>`），平常不手打：交付指令是 `node scripts/land.mjs <branch> --body-file <file> --check-command 'bin/check --upstream'`，步驟與結果行見 [Evidence and closing](#evidence-and-closing)。CI 設定在 `.github/workflows/checks.yml`，跑 `bin/check --upstream`。

**CI 執行端**：預設是遠端（GitHub Actions）。只有遠端沒啟動時（帳務、沒有 runner：`land.mjs` 印 `STOP ci-not-started`）才改用本機：在要合併的 tip SHA、工作樹乾淨時跑 `node scripts/land.mjs <branch> --local-checks <sha> --check-command 'bin/check --upstream'`，它把 SHA 與結果行留言在 PR。遠端已經啟動而失敗的，不改用本機。

## Readiness

就緒狀態是 `ready-for-agent` label（[triage-labels.md](triage-labels.md)）。沒有 preflight。還沒就緒時用 `/triage <n>` 補齊。

驗收與做法用到的每份輸入（原始碼、樣本、憑證、checkout）都要能從本 repo、tracker 或公開來源取得。只存在於其他專案的 checkout 或某台機器本地路徑的，Issue 維持 `needs-info`，triage notes 寫明缺的是什麼、去哪裡拿；這是 `/triage` 標 `ready-for-agent` 前的判斷，不是 preflight 指令（#56 的驗收要逐檔比對只在別台機器上的 spay2，worker 開工就 `STOP prerequisite missing`，#116）。

## Worktrees and checkpoint

從 `main` 開 `issue/<n>-<slug>` 分支，一張 ticket 也開 worktree：主 checkout 有 `scripts/claude-hook-main-checkout.mjs` 擋寫入（#30）。設了 `ORCA_CLI_COMMAND` 時用 `node scripts/orca-worktree-create.mjs --name issue-<n> --base-branch main --branch issue/<n>-<slug>` 開（看最後一行 JSON 的 `path`），沒有 Orca 時用 `git worktree add`；多張 ticket 依 implement-spec 各開一個。checkpoint 放在 `.scratch/issue-run-<n>/state.md`，不 commit。

## Checks

只有一條：`bin/check`。開發中和寫 brief、驗收條件時都只引用這條，不要自己拼 `node --test …`。單一測試檔可以用 `node --test tests/<name>.test.mjs`。成功時最後一行是 `CHECK_PASS tests <a>+<b>+…`，失敗時是 `CHECK_FAIL <步驟> [<失敗的測試>｜…]`（步驟是 `docs-rules`（只讀文件與清單的規則，不到兩秒，排在整條測試之前）、`tests`、`template-tests`、`fake-orca-macos`，或測試之前失敗的那條指令）：只讀最後一行就知道哪裡壞，不要為了找測試名稱整條重跑存 log（#267）。行為不變的重構，以同一條 `bin/check` 在 base 上為綠當作 baseline。

`docs/agents/workflow-templates.json` 列出的 `scripts/` 檔是 setup-workflow 正本（`skills/engineering/setup-workflow/templates/`）的副本，不直接改，也不手動 `cp` 或手算 sha256：改正本、commit 後跑 `node skills/engineering/setup-workflow/scripts/copy-templates.mjs . --no-tests <名稱>`，它複製副本並更新清單裡的 sha256，再 commit 一次（#201：兩次 retro 都先 `cp`，第一次 `bin/check` 才在 `tests/template-copies.test.mjs` 報 sha256 不符，各多跑一輪）。

## Review

Skill `code-review`，比對基準是分支的 merge-base。不阻擋的 findings 列在 Issue 的證據留言。所有 `SKILL.md`、`ADAPTER.md` 和 `overlays/*.patch` 都會改變 agent 的行為，不算只改文字。

## Candidate and acceptance

candidate 是分支 tip。acceptance 是在 candidate SHA、工作樹乾淨時跑 `bin/check --upstream`：本機 `~/code/skills` 是會落後上游的 fork，只跑本機版本看不到 overlay 漂移。

## Evidence and closing

證據貼成 Issue 留言（candidate SHA、指令與 exit code、findings）。

單獨跑的 `/issue-run` 在 acceptance 通過、證據貼好之後自己落地，不等人：把 PR body（`/pr` 格式，每張 Issue 一行 `Closes #<n>`）寫進 scratchpad，用 Bash `timeout: 600000` 跑 `node scripts/land.mjs <candidate 所在分支> --title '<標題>' --body-file <檔> --check-command 'bin/check --upstream'`。它 push、開 PR、等 CI、以 merge commit 合併，再移除該分支的 worktree、刪本機與 `origin` 分支、讓主 checkout 的 `main` 跟上；多張 ticket 時，各 ticket 的 worktree 在 `LANDED` 之後另外移除（Orca 建的用 `"$ORCA_CLI_COMMAND" worktree rm --worktree path:<path>`，會一起刪掉分支；其餘用 `git worktree remove` 加 `git branch -d`）。讀最後一行：

- `LANDED <pr> <merge sha>`：對每張 Issue 留言 PR 與 merge SHA，還開著的再關閉。
- `RESTAMPED <pr> <sha>`（進度行，不是最後一行）：PR 和 `main` 衝突、衝突檔只有戳記檔（`scripts/restamp.mjs` 的 `STAMP_FILES`：`scripts/workflow-doc-sync.json`、`docs/agents/workflow-templates.json`），它已把 `origin/main` 合入分支、取目標分支版本重產站台並 restamp、commit、在新 tip 跑過 `--check-command` 並重新 push，接著照常等 CI、合併（衝突在等 CI 之前判斷，只等一輪；等 CI 期間 `main` 又前進而合併被拒時同樣合入、再驗一輪，合入沒有衝突時印 `MAIN_MERGED` 而不是 `RESTAMPED`；Bash 逾時被中斷時重跑同一條指令，分支已含 `origin/main` 就不再 restamp）；證據留言的 candidate SHA 補上這個新 tip（#173）。
- `STOP merge <pr> conflict <檔案…>`：還有戳記檔以外的衝突，已 `merge --abort`，分支停在原來的 tip；停下回報人。`STOP restamp-checks-failed <sha> exit <code> <log>`：restamp 後的檢查沒過，合併 commit 只留在本機分支、沒有 push；停下回報人，不要直接重跑（重跑會把這個沒過檢查的 commit 推上去，只剩 CI 把關）。
- `STOP checks-timeout`：重跑同一條指令。
- `STOP worktree-rm`：PR 已經合入，只剩收尾沒做完；照常留言、關單，再回報人處理 worktree。
- 其他 `STOP <原因>`（如 `ci-failed`、`merge`）或 exit 1：停下回報人，不硬合。

pilot 底下的 worker 不落地：push、開 PR、合併與關單都由 coordinator 照 [pilot-after-merge.md](pilot-after-merge.md) 的 Push gate 與 Close 做。

## 分頁狀態

[分頁狀態](../../GLOSSARY.md#分頁狀態)與整個標題的格式、何時改名、` ⏸`、worktree 顯示名稱照 [ADAPTER.md](../../skills/engineering/issue-run/ADAPTER.md) 的 Tab state 段預設值，本 repo 標題用繁體中文（[CLAUDE.md](../../CLAUDE.md) 的 Language），段裡的 `orca` 寫成 `"$ORCA_CLI_COMMAND"`；這裡寫本 repo 什麼時候轉換。只換狀態用 `node scripts/tab-state.mjs <狀態>`：它只換目前分頁標題的狀態前綴，其他文字（含階段與動作）不動；離開處理中要拿掉階段與動作時帶 `--topic` 重設整個標題。兩種寫法在沒有 `ORCA_TERMINAL_HANDLE` 或 Orca 失敗時 exit 0 不輸出。session 開頭改用 `node scripts/tab-state.mjs 處理中 --topic "<主題>"` 一次設定前綴與主題（`<主題>` 是標題格式裡狀態前綴之後的部分）：本機記錄的可能還是同一個 handle 上一個 session 的標題，只換前綴會帶出舊主題（#141）。`.claude/settings.json` 掛的 `scripts/claude-hook-tab-state.mjs` 自動做能用程式偵測的轉換，`Stop` 時標題沒有合法前綴就 exit 2 要求改名（只檢查格式）。

- **待 Retro.** 單獨跑的 `/issue-run` 在 `land.mjs` 印 `LANDED` 之後（hook 自動切；coordinator 以 `--keep-branch` 落地整合分支時它還在運作，不切）；pilot worker 寫出 `DONE <n> <sha>` 結果行時（hook 在 `Stop` 自動切，早於 coordinator 合入：worker 的交付到此為止）；coordinator 在 `pilot-handoff.mjs` 印 `HANDED_OFF`、交接退役之後（hook 自動切）；其他類別在使用者確認主題結束之後，自己跑 `tab-state 待 Retro`。只開 PR 不算。
- **待關閉.** `/retro` 採用的項目已合入或開成 Issue，或候選已交給收集流程之後，由 `/retro` 最後一步在該分頁自己跑 `tab-state 待關閉`（`overlays/retro.patch`）。每個分頁都先經過待 Retro；待關閉的分頁由使用者手動關。
- **擴充.** hook 的觸發條件要新增、覆寫或停用時，在本檔旁放 `docs/agents/tab-state.json`（格式見 `scripts/claude-hook-tab-state.mjs` 檔頭）；本 repo 目前沒有這個檔，用預設值。
- **讀不回標題.** Orca 讀不回 `terminal rename` 設的分頁標題，`tab-state` 以 handle 在本機記錄最後設定的標題（hook 也從 Bash 的 `orca terminal rename` 指令擷取）；不經 Bash 的改名（例如在 Orca 介面手動改）不會被記到，下次 `tab-state` 會以記錄的標題為準。

## Pilot

給 `/issue-pilot` coordinator 的設定在 [pilot.md](pilot.md)，每輪都整份讀；只在某些情況用到的條目拆在 [pilot-after-merge.md](pilot-after-merge.md)、[pilot-conflict.md](pilot-conflict.md)、[pilot-exceptions.md](pilot-exceptions.md)、[pilot-retro-collect.md](pilot-retro-collect.md)，pilot.md 的同名條目是一行 pointer，寫明什麼情況才讀（#166）。條目之間空一行，讓改不同條目的修改落在不同的 hunk（#45）；比對整合分支上的 adapter 時，這幾份都要一起比。條目都是單行（**Probe lines.** 約 10 KB），`head` 限行數擋不住單行長度：找某個詞用 `grep -o '.\{0,60\}<詞>.\{0,60\}'` 只取前後文，不要直接 `grep -n`（#274：三個 grep 印了 56 KB）。
