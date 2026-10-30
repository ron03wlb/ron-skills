# pilot 存檔的格式契約跟著 issue-pilot skill 走，批次 checkpoint 採用 ron-skills 的版本

依 ADR 0001，pilot script 預設是**正本**。正本 script 要在不同專案讀寫同一套 **pilot 存檔**，所以存檔格式必須是一份共同契約。我們決定契約寫在 `skills/engineering/issue-pilot/PILOT-STORE.md`，和 skill 一起帶到每個專案；adapter 只寫各專案不同的值（整合分支、檢查指令、來源清單），不再描述檔案格式。批次 checkpoint 採用 ron-skills 的格式：`.scratch/pilot/batch-<key>.md`，`current:` 只能是 dispatched、staged `<sha>`、merged `<sha>`、pushed、closed 這幾個固定值。`hold` 改成一行 JSON `{since,reason,session}`，`sessions.md` 採用 spay2 的欄位並保留 `<name>`；舊的空 `hold` 檔視為「有 hold、沒有原因」。

## 被否決的做法

- **checkpoint 採用 spay2 的格式**（`.scratch/batch-<key>/state.md`、`current:` 是自由文字、wave、`agents.md`）。spay2 的 Probe（`pilot-status.mjs`）和 Dispatch（`batch-dispatch.mjs`）綁著 `feature-ron` 命名、wave、`queue-regression`，改成正本就得把 spay2 專屬的概念一起帶進去；自由文字的 `current:` 也讓 script 只能靠字首猜狀態。
- **契約不管 checkpoint，Probe 和 Dispatch 兩邊各自保留。** 等於放棄 ADR 0001，ron-skills 會再一支一支複製出新的分歧，#22 的 `pilot-handoff.mjs` 已經是這樣。
- **契約寫在 adapter 的 Pilot 段。** 每個專案各寫一份，正本 script 讀的格式就又分歧了。

## 後果

spay2 的 Probe 和 Dispatch 暫時由專案保留，正本出來後再評估遷移。`batch-watch`、`retro-collect`、`issue-transcripts` 寫死 spay2 的命名，同樣專案保留，ron-skills 繼續用手動指令。ron-skills 的 `pilot-probe`、`pilot-dispatch` 在決定前已經寫進 `scripts/`，先在那裡完成，再搬成正本（#58）。決定經過記在 #32。
