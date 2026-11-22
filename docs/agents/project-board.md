# 看板：GitHub Project「ron-skills 進度」

[看板](../../GLOSSARY.md)是 https://github.com/users/ron03wlb/projects/7 ，已連結本 repo。它把每張開著的 Issue 依 `scripts/issue-pool.mjs` 的分桶放進 Status 欄的七欄之一，再寫一則整體進度的 Status update（#487）。分桶才是準，看板只是鏡像：**不要在網頁上手動拖卡或改 Status**，下一次同步會改回來；要改欄就改 Issue 本身（label、認領、blocked-by）。

## 同步

```sh
node scripts/project-sync.mjs            # dry-run：只印會變的卡與數字
node scripts/project-sync.mjs --apply    # 寫入
```

- 寫入目標固定（#538）：repo 讀 [issue-run.md](issue-run.md) 的 `## Tracker` 段（github.com 的 `ron03wlb/ron-skills`），每次 gh 都帶 `--hostname github.com`，`GH_HOST`、`GH_REPO`、remote 與 gh 的預設主機都改不了它；Project 是連結到這個 repo 的那一個。所以 `.claude/settings.json` 放行 `Bash(node scripts/project-sync.mjs:*)`，auto mode 下的 agent 與排程跑 `--apply` 不會被擋。
- 其他旗標：`--setup-status-field`（見下）；`--repo <owner>/<name>`、`--owner <login> --project <number>` 只在 dry-run 改讀別的 repo 或 Project，和 `--apply` 一起給時 exit 2、不呼叫 gh；`--main <ref>`、`--integration <ref>`（可重複）覆寫判斷「已合入·待上 main」用的本機 ref。
- 測試用環境變數 `PROJECT_SYNC_NOW`（ISO 時間）取代現在時間，只影響 Status update 的「同一天」判斷與 stale 分桶。

- 沒有 hook：`gh-tracker.mjs` 是共用範本的副本，不掛同步。由 AI 工作流 bot 每晚 20:00 Git 同步後跑 `--apply`，需要時手動跑。
- 要先 `git fetch`：「已合入·待上 main」讀本機與 `origin` 的分支、`main`、`pilot/integration`。
- gh 的 token 要有 `project` scope（`gh auth refresh -s project`）。
- Project 取連結到本 repo 的那一個；沒有或多於一個時 exit 3 並列出：`--apply` 不能另外指定，先在 GitHub 上把多的取消連結（dry-run 可用 `--owner`、`--project` 看指定的那一個）。
- Status 選項不是下表七個（依序）時 exit 3、印 `STATUS_FIELD_MISMATCH`：跑 `node scripts/project-sync.mjs --setup-status-field --apply`。GitHub 改選項會清空每張卡的 Status，同一次同步會補回。
- 輸出格式與 exit code 寫在腳本開頭。

## 七欄

| Status | 卡片（issue-pool 的桶） |
|---|---|
| Retro 候選 | `retro-candidates` |
| 待討論 | `needs-triage`、`needs-info`、`unlabeled` |
| 被擋 | `blocked` |
| 可開工 | `ready`、`human` |
| 處理中 | `claimed`、`stale`、`in-review`，且不符合下一欄 |
| 已合入·待上 main | 處理中的單，而且它的分支（最後一段以 `<n>-` 開頭）自己的 commit 已全部在 `pilot/integration`、還不在 `main` |
| 完成 | 已關閉 |

- 母單（`parent` 桶）加卡但不設 Status。
- PR、draft 卡、其他 repo 的單不動；已關閉卻不在看板上的單不加卡。
- 本 repo 沒有 `in-progress` label，處理中靠認領與開著的 PR 判斷。

## Status update

`--apply` 結束時寫一則 Project status update，六項數字：

- 整體進度 %：完成＝已關閉或「已合入·待上 main」；範圍是看板上本 repo 的 Issue 卡，不含母單與 Retro 候選。
- 無母單進度 %：同一個範圍裡沒有母單的卡。
- 剩下還要做的張數：範圍內還沒完成的。
- 已合入·待上 main 張數。
- 被擋與待討論張數。
- Retro 候選張數（開著的）。

頻率：六項數字和最新一則一樣就不寫；不一樣時，最新一則是今天（Asia/Taipei）寫的就改寫那一則，否則新增一則。一天最多一筆。

## 三個檢視（Operator 在網頁上建立）

GitHub API 不能設定檢視的篩選，所以由 Operator 在 Project 頁面建立一次：

1. 開 https://github.com/users/ron03wlb/projects/7 。
2. 「看板」：點既有檢視分頁旁的 **New view** → **Board**，分頁改名「看板」。右上 **⋯ → Column by** 選 `Status`；篩選列輸入 `-label:parent`；**⋯ → Group by** 選 `Parent issue`。按 **Save**。
3. 「總體進度」：**New view** → **Table**，改名「總體進度」。篩選列輸入 `label:parent`；**⋯ → Fields** 勾選 `Sub-issues progress`。按 **Save**。
4. 「無母單」：**New view** → **Table**，改名「無母單」。篩選列輸入 `no:parent-issue -label:parent -label:retro-candidates`；**⋯ → Group by** 選 `Status`。按 **Save**。
5. 舊的預設檢視（View 1）用不到可以刪掉（分頁上的 **⋯ → Delete view**）。
