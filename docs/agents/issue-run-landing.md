# issue-run 落地：ron-skills

[issue-run.md](issue-run.md) 的必讀核心（14000 bytes，`scripts/adapter-size-budget.json`）放不下、只在落地時才用到的段落（#344）。用 `node scripts/adapter-line.mjs '<標題>'` 只取需要的一節。

## CI 執行端

只有遠端（GitHub Actions）。`main` 開了 branch protection（#402：required checks `checks`、`checks-macos`，含 administrators），這兩個 check 沒綠的 PR `gh pr merge` 一律拒絕，所以 `land.mjs --local-checks` 在本 repo 合不進去（本機檢查過了也停在 `STOP merge`）。`land.mjs` 印 `STOP ci-not-started`（帳務、沒有 runner）時停下回報人，由人恢復 CI 並重跑那個 run（`gh run rerun <run>`），再重跑同一條 land 指令；不改用本機、不關保護、不直推 `main` 繞過。

## land.mjs 結果行

`node scripts/land.mjs` 的最後一行：

- `LANDED <pr> <merge sha>`：對每張 Issue 留言 PR 與 merge SHA，還開著的再關閉。
- `PR_UPDATED <pr>`（進度行）：PR 已開著，帶的 `--title`、`--body-file` 已更新上去；接手別人開的 PR 時也一樣（#300）。`STOP pr-edit <pr> <原因>`：更新失敗，沒有合併；停下回報人。
- `RESTAMPED <pr> <sha>`（進度行，不是最後一行）：PR 和 `main` 衝突、衝突檔只有戳記檔（`scripts/restamp.mjs` 的 `STAMP_FILES`：`scripts/workflow-doc-sync.json`、`docs/agents/workflow-templates.json`），它已把 `origin/main` 合入分支、取目標分支版本重產站台並 restamp、commit、在新 tip 跑過 `--check-command` 並重新 push，接著照常等 CI、合併（衝突在等 CI 之前判斷，只等一輪；等 CI 期間 `main` 又前進而合併被拒時同樣合入、再驗一輪，合入沒有衝突時印 `MAIN_MERGED` 而不是 `RESTAMPED`；Bash 逾時被中斷時重跑同一條指令，分支已含 `origin/main` 就不再 restamp）；證據留言的 candidate SHA 補上這個新 tip（#173）。
- `STOP merge <pr> conflict <檔案…>`：還有戳記檔以外的衝突，已 `merge --abort`，分支停在原來的 tip；停下回報人。`STOP restamp-checks-failed <sha> exit <code> <log>`：restamp 後的檢查沒過，合併 commit 只留在本機分支、沒有 push；停下回報人，不要直接重跑（重跑會把這個沒過檢查的 commit 推上去，只剩 CI 把關）。`STOP restamp-checks-timeout <sha> <log>`：檢查跑到 `LAND_LOCAL_CHECKS_TIMEOUT_MS`（預設 420 秒）被中止，結果未知，不是沒過：在該 SHA 的 worktree 跑過 `--check-command`，通過才重跑 land 指令（重跑不會再驗這個 commit，直接 push），沒過就停下回報人（#297）。`STOP local-checks-timeout <sha> <log>`：本 repo 不用 `--local-checks`（見 `## CI 執行端`），停下回報人。`STOP slot-timeout <sha> <秒數>s`：restamp 後的 `--check-command` 經全機共用的重型檢查 slot（`scripts/heavy-slot.mjs`）跑，排了 `LAND_SLOT_TIMEOUT_S`（預設 120 秒）還拿不到，檢查沒跑、沒 push：負載關卡，`node scripts/heavy-slot.mjs status` 看誰拿著，稍後重跑同一行。
- `STOP merge <pr> <gh 的最後一行>`（沒有 `conflict`）：GitHub 拒絕合併，多半是 branch protection 的 required check（`checks`、`checks-macos`）沒綠，例如帶了 `--local-checks`（#402）；停下回報人，不關保護、不直推 `main`。
- `STOP checks-timeout`：重跑同一條指令。
- `WARN main-not-synced <原因>` 接 `WARN skills-not-updated <merge sha>`（進度行）：PR 已合入，但主 checkout 沒跟上，也沒跑 `bin/sync-skills`，已安裝的 skill 還是舊版。原因是 `快轉會刪掉被保護的路徑 <檔…>` 或提到 `Protected paths:` 時不要自己快轉：那些檔在 adapter 的 `Protected paths:` 宣告裡（[ADAPTER.md](../../skills/engineering/issue-run/ADAPTER.md) 的 Delivery 段），把檔案和這行交給人（#303）；其他原因時，主 checkout 清乾淨後自己 `git merge --ff-only origin/main` 再跑 `bin/sync-skills`（#297）；本機 `main` 有別的 session 還沒 push 的 commit、和 `origin/main` 分岔時，快轉一定失敗：不要 reset、rebase 主 checkout，回報那幾個 commit（`git log --oneline origin/main..main`），由提交它們的 session rebase 後落地（#306）。
- `STOP worktree-rm`：PR 已經合入，只剩收尾沒做完；照常留言、關單，再回報人處理 worktree。
- 其他 `STOP <原因>`（如 `ci-failed`、`merge`）或 exit 1：停下回報人，不硬合。

## Worker result

- **Worker result.** pilot 底下的 worker（`/issue-run <n> --worker <checkpoint>`）畫面最後一行是結果行 `DONE <n> <完整 candidate SHA>` 或 `STOP <n> <原因>`（格式與各種原因在 `skills/engineering/issue-pilot/PILOT-STORE.md`；coordinator 由 **Watch.**／Probe 從分頁尾段讀它）。證據留言的最後一行也寫同一個 `DONE` 結果行：`issue-pool.mjs --integration` 以「最近一則認領留言之後有 `DONE <n> <sha>` 行」把單歸 `landed`，只寫在畫面上時，單要等 stage 合入整合分支才離開 `claimed`（#411）。rulings 檔是 worker checkpoint `.scratch/issue-run-<n>/state.md` 的 `## Rulings` 段；本 repo 沒有 confirm gate，`confirm` ruling 照 issue-run SKILL 的 Decisions 以 `STOP <n> decision <摘要>` 結束；範圍外的改動與觀察寫進 `DONE` 報告內文與證據留言的「觀察」段（#440）。
