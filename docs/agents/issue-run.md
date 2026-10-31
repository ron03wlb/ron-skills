# issue-run adapter：ron-skills

沒寫到的段落都沿用 [ADAPTER.md](../../skills/engineering/issue-run/ADAPTER.md) 的預設值。

## Tracker

[issue-tracker.md](issue-tracker.md)。讀 Issue 一律用 `--json`：`gh issue view <n> --comments` 在非 tty 環境不會輸出任何東西。

## Readiness

就緒狀態是 `ready-for-agent` label（[triage-labels.md](triage-labels.md)）。沒有 preflight。還沒就緒時用 `/triage <n>` 補齊。

驗收與做法用到的每份輸入（原始碼、樣本、憑證、checkout）都要能從本 repo、tracker 或公開來源取得。只存在於其他專案的 checkout 或某台機器本地路徑的，Issue 維持 `needs-info`，triage notes 寫明缺的是什麼、去哪裡拿；這是 `/triage` 標 `ready-for-agent` 前的判斷，不是 preflight 指令（#56 的驗收要逐檔比對只在別台機器上的 spay2，worker 開工就 `STOP prerequisite missing`，#116）。

## Worktrees and checkpoint

從 `main` 開 `issue/<n>-<slug>` 分支，一張 ticket 也開 worktree：主 checkout 有 `scripts/claude-hook-main-checkout.mjs` 擋寫入（#30）。設了 `ORCA_CLI_COMMAND` 時用 `node scripts/orca-worktree-create.mjs --name issue-<n> --base-branch main --branch issue/<n>-<slug>` 開（看最後一行 JSON 的 `path`），沒有 Orca 時用 `git worktree add`；多張 ticket 依 implement-spec 各開一個。checkpoint 放在 `.scratch/issue-run-<n>/state.md`，不 commit。

## Checks

只有一條：`bin/check`。開發中和寫 brief、驗收條件時都只引用這條，不要自己拼 `node --test …`。單一測試檔可以用 `node --test tests/<name>.test.mjs`。行為不變的重構，以同一條 `bin/check` 在 base 上為綠當作 baseline。

## Review

Skill `code-review`，比對基準是分支的 merge-base。不阻擋的 findings 列在 Issue 的證據留言。所有 `SKILL.md`、`ADAPTER.md` 和 `overlays/*.patch` 都會改變 agent 的行為，不算只改文字。

## Candidate and acceptance

candidate 是分支 tip。acceptance 是在 candidate SHA、工作樹乾淨時跑 `bin/check --upstream`：本機 `~/code/skills` 是會落後上游的 fork，只跑本機版本看不到 overlay 漂移。

## Evidence and closing

證據貼成 Issue 留言（candidate SHA、指令與 exit code、findings）。

單獨跑的 `/issue-run` 在 acceptance 通過、證據貼好之後自己落地，不等人：把 PR body（`/pr` 格式，每張 Issue 一行 `Closes #<n>`）寫進 scratchpad，用 Bash `timeout: 600000` 跑 `node scripts/land.mjs <candidate 所在分支> --title '<標題>' --body-file <檔>`。它 push、開 PR、等 CI、以 merge commit 合併，再移除該分支的 worktree、刪本機與 `origin` 分支、讓主 checkout 的 `main` 跟上；多張 ticket 時，各 ticket 的 worktree 在 `LANDED` 之後另外移除（Orca 建的用 `"$ORCA_CLI_COMMAND" worktree rm --worktree path:<path>`，會一起刪掉分支；其餘用 `git worktree remove` 加 `git branch -d`）。讀最後一行：

- `LANDED <pr> <merge sha>`：對每張 Issue 留言 PR 與 merge SHA，還開著的再關閉。
- `STOP checks-timeout`：重跑同一條指令。
- `STOP worktree-rm`：PR 已經合入，只剩收尾沒做完；照常留言、關單，再回報人處理 worktree。
- 其他 `STOP <原因>`（如 `ci-failed`、`merge`）或 exit 1：停下回報人，不硬合。

pilot 底下的 worker 不落地：push、開 PR、合併與關單都由 coordinator 照 [pilot.md](pilot.md) 的 Push gate 與 Close 做。

## 分頁狀態

[分頁狀態](../../GLOSSARY.md#分頁狀態)的前綴格式寫在全域 `~/.claude/CLAUDE.md` 的 Orca session titles；這裡寫本 repo 什麼時候轉換。切換一律用 `node scripts/tab-state.mjs <狀態>`：它只換目前分頁標題的狀態前綴，其他文字不動，沒有 `ORCA_TERMINAL_HANDLE` 或 Orca 失敗時 exit 0 不輸出。`.claude/settings.json` 掛的 `scripts/claude-hook-tab-state.mjs` 自動做能用程式偵測的轉換，`Stop` 時標題沒有合法前綴就 exit 2 要求改名（只檢查格式）。

- **待 Retro.** 單獨跑的 `/issue-run` 在 `land.mjs` 印 `LANDED` 之後（hook 自動切；coordinator 以 `--keep-branch` 落地整合分支時它還在運作，不切）；pilot worker 寫出 `DONE <n> <sha>` 結果行時（hook 在 `Stop` 自動切，早於 coordinator 合入：worker 的交付到此為止）；coordinator 在 `pilot-handoff.mjs` 印 `HANDED_OFF`、交接退役之後（hook 自動切）；其他類別在使用者確認主題結束之後，自己跑 `tab-state 待 Retro`。只開 PR 不算。
- **待關閉.** `/retro` 採用的項目已合入或開成 Issue，或候選已交給收集流程之後，由 `/retro` 最後一步在該分頁自己跑 `tab-state 待關閉`（`overlays/retro.patch`）。每個分頁都先經過待 Retro；待關閉的分頁由使用者手動關。
- **擴充.** hook 的觸發條件要新增、覆寫或停用時，在本檔旁放 `docs/agents/tab-state.json`（格式見 `scripts/claude-hook-tab-state.mjs` 檔頭）；本 repo 目前沒有這個檔，用預設值。
- **讀不回標題.** Orca 讀不回 `terminal rename` 設的分頁標題，`tab-state` 以 handle 在本機記錄最後設定的標題（hook 也從 Bash 的 `orca terminal rename` 指令擷取）；不經 Bash 的改名（例如在 Orca 介面手動改）不會被記到，下次 `tab-state` 會以記錄的標題為準。

## Pilot

給 `/issue-pilot` coordinator 的設定整份在 [pilot.md](pilot.md)，條目之間空一行，讓改不同條目的修改落在不同的 hunk（#45）；比對整合分支上的 adapter 時，`docs/agents/pilot.md` 也要一起比。
