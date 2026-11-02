# tracker 是唯一的跨機器共享狀態

同一個帳號會在好幾台機器（WSL、macOS）上各跑 pilot 或 `/issue-run`，三條底線之一是不會有兩個 session 同時處理同一張單（#102）。我們決定**認領**、進度和 retro 候選都寫在 tracker：認領是先留一則「認領：<機器>／<session>」留言，再把 Issue 指派給自己（`scripts/issue-pool.mjs claim`）；進度與證據是 Issue 留言；retro 候選是掛 `retro-candidates` label 的 Issue（一個 session 一張，`/retro-collect` 收集）。tracker 是唯一的跨機器共享狀態；本機的 `.scratch/pilot/` 和 Claude auto-memory 只算單機狀態，另一台機器讀不到。

兩份 ADR 分工：ADR 0002 管單機的 pilot 存檔格式（批次 checkpoint、`decisions.md`、`hold`、`sessions.md`），本 ADR 管跨機器的狀態。認領以 session 為單位，同一台機器的兩個 session 也靠它分開；batch checkpoint 只是 coordinator 自己不重派的單機記錄。

## 被否決的做法

- **本機收集模式**：各機器把認領與 retro 候選記在自己的 `.scratch/` 或 auto-memory，再定期彙整。彙整之前另一台機器看不到，兩台照樣會撿到同一張單。
- **用 git 分支存狀態**（例如推一個 `state` 分支或用分支名當鎖）：要 push 才看得到，push 本身是人管的關卡（pilot 的 Push gate）；分支名當鎖也沒有過期與擁有者資訊，失效的鎖只能手動清。

## 例外：專案自選本機 retro 名單

spay2 決定 retro 候選留在本機檔案（#293）。專案可在 Retro collect 條目宣告 `Roster command:`、`Collect command:`、`Close command:`，`/retro` 與 `/retro-collect` 就改用宣告的指令，不開也不收 `retro-candidates` Issue。代價由該專案承擔：候選留在單機，另一台機器看不到，也沒有認領，兩台機器可能各收各的。這個例外只涵蓋 retro 候選，認領與進度仍寫在 tracker；沒有宣告的專案，預設仍是 tracker。

## 後果

認領過期（預設 24 小時沒有新留言或新指派，adapter 可用 `--stale-hours` 覆寫）只歸到 `stale` 桶，不自動釋放：釋放等於把別人可能還在做的單交出去，由人決定。指派只認得帳號，認不得機器，所以同一帳號的兩個 session 靠認領留言裡的「<機器>／<session>」區分；兩邊同時認領時，寫入後重讀、留言較早的一方勝出，輸的一方收回留言。
