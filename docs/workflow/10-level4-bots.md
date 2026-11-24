# 10 L4 bot 調度層（可選）

L4 疊在 L3 之上，**可選，不是必經的一級**：L3 的 coordinator 已經能無人值守地交付一個 repo；L4 再加一層常駐的 Orca bot，讓 owner 同時管好幾個 repo 時，只面對一個決策介面。沒有多個專案、或不想讓 bot 代答 gate 的人，停在 L3 就夠了。`/setup-workflow` 不裝這一層：bot home 由 owner 在 Orca 建，本章是照著建的範本。

L4 不改 L1–L3 的任何契約：coordinator、worker、adapter、檢查入口都照舊，bot 只是坐在 owner 與各 repo 的 coordinator 之間。

## 分工

在 Orca 上開兩種 bot，每個 bot 有自己的 home（工作目錄）、`SOUL.md` 與記憶，彼此隔離：

| bot | 負責 | 不做 |
| --- | --- | --- |
| **總調度 bot**（一個） | 跨專案路由：把進來的工作交給對應的專案 bot；owner 的決策介面：把真正需要 owner 的事撈出來、送到 owner 面前、拿到答案回灌；全局彙整：定期把各專案收斂成一份回報 | 不親自實作，也不下去寫專案的碼 |
| **專案 bot**（每個專案一個） | 自己 repo 的 Issue 與 PR（細化、跟進 CI 與 review）；回答該 repo coordinator 的提問與 gate；自己的例行排程（例如每隔幾小時細化 queue） | 不越過決策分級替 owner 拍板；不改別的專案 |

工作照「owner → 總調度 bot → 專案 bot → coordinator（`/loop /issue-pilot`）→ worker」往下走；問題照反方向往上，每一層能依決策分級回答的就在那一層回答，只有 B 級才到 owner。

追蹤用 Orca 的 items 當共用狀態層：一個交付或一個決策一個 item。專案 bot 的進度回寫到對應 item 的留言，owner 打開 item 就看到全過程；總調度 bot 只彙整，不重抄。

## bot home 的結構

```text
<bot home>/
├── SOUL.md                    身分、怎麼做事、Never
├── MEMORY.md                  一行一事、標日期；細節放 memory/<topic>.md
├── decision-framework.md      A／A2／B 決策分級與收斂回報欄位
├── RETRO.md                   這個 bot 的輕量 retro 規則
├── runbooks/                  可重複的操作清單，例如 WSL 重啟後的接續清單
├── memory/
│   ├── <topic>.md             MEMORY.md 單行放不下的細節
│   └── session-handoff.md     換 chat 時的交接快照（見下方「session 交接」）
└── .scratch/retro/            每個對話一則 retro；收斂後搬到 done/<YYYY-MM-DD>/
```

- **`SOUL.md`**：新 chat 自動讀的兩份檔之一，只放不會常改的東西。三段：開頭一句身分（負責哪幾個 repo、由誰調派）；`## How I work`（Watches、Does、Reports，加上「開新 chat 先讀快照」那一行）；`## Never`（動作前先依 `decision-framework.md` 分級、拿不準一律當 B）。SOUL 由 owner 改，bot 自己不改；bot 覺得該改時列成 item 問 owner。
- **`MEMORY.md`**：另一份自動讀的檔。每條一行、標日期、新的在上；一行放不下的細節寫進 `memory/<topic>.md`，MEMORY 只留一行指標。owner 的偏好、進行中的約束放這裡；repo 或 git 已經記錄的事不放。
- **`decision-framework.md`**：動作前查的分級表，見下一節。
- **`runbooks/`**：會再做第二次的操作寫成清單，例如機器重啟前把每個分頁的 worktree、做到哪、重啟時送什麼指令列成表，並註明哪些由 coordinator 自己重派、不要手動開（手動開會讓兩個 worker 跑同一張單）。
- **`RETRO.md` 與 `.scratch/retro/`**：見下方「retro」。

## 決策分級：A／A2／B

每個 bot 動作前先分級，分級寫在自己的 `decision-framework.md`。三級的意思固定，各 bot 只換具體項目：

- **A 自己做**：可逆、不改對外行為、owner 事後一句話就能推翻的。做完不另外通知，在週期彙整列出，owner 可事後否決。
- **A2 做完通知**：owner 已經授權同類動作，但可逆性存疑或會動到共用環境的。先做唯讀的 readback，確認無誤再執行，做完在 item 附原始輸出通知 owner。
- **B 先問 owner**：開 item 設成需要 owner（Needs you），等答案再動。
- **拿不準、或分級沒涵蓋的，一律當 B。**

下面的骨架可以直接複製成 `decision-framework.md`，再把「例：」換成自己專案的項目：

```markdown
# <bot 名稱> 決策分級

依 owner 授權整理（<YYYY-MM-DD>）。動作前先分級；拿不準或沒涵蓋的一律當 **B**。

## A. 自己做（不另通知，週期彙整可見）
- 細化、派工、追蹤本專案的 Issue 與 worker；排序、triage。
- 回覆 coordinator 的 gate／提問，限可回頭類：照規格或已確認的決策走、可逆的裁定。
- 唯讀查詢、盤點、診斷。
- 可逆的小改動與清理（例：刪已合入的 worktree）。

## A2. 代做，做完通知 owner（在 item 留言，附原始輸出）
- <owner 已授權的同類動作>（例：測試環境的資料修正：先 readback、確認無誤再執行，結案附執行的 exit code 與前後兩次 readback）。
- retro 收斂結果裡可逆的候選。

## B. 一定先問 owner（開 item 設 Needs you，附總調度的 item 編號）
- 需要 owner 本人動作的（建帳號、改權限或 settings 規則、只有 owner 知道的值）。
- 正式環境或不可逆的動作。
- 業務核准、產品規則。
- 收緊既有 gate、會多擋既有 Issue 的。
- 新方向或架構；push 或合併主線；超出授權或要外部協調的。

## 回報與證據
- 宣稱「已接手／已完成／已恢復」前要有實測證據（實際輸出、對方回覆的 message id），寫在 item 上。
- bot 間訊息帶總調度的 item 編號、完成標準、決策等級；整件交辦（handoff）一律經總調度。

## C. 收斂回報欄位（每期給總調度彙整）
| 欄位 | 內容 |
| --- | --- |
| adopted 候選數 | 本期 retro 採用的候選數 |
| 關閉 Issue | 本期關閉的 Issue |
| PR | 本期開、合、等待中的 PR |
| 已替 owner 做的可逆決策 | A 類清單，可事後否決 |
| 需 owner 決策項 | B 類待拍板，每項一行，附背景與建議 |
| 卡住 | 停點、被擋的單、CI 紅 |
| 風險 | 高嚴重度未處理、上游升級相容性、gate 誤擋 |
| 漂移 | 本檔、MEMORY 與實際狀態（排程、items、誰在問 owner）不符之處 |
```

總調度 bot 的分級多一條：路由、優先序、相依阻塞的追蹤是 A；「實作」不在它的任何一級裡，一律交給專案 bot。

## bot 間溝通

- **question／status 可以直送**：專案 bot 之間可以直接互傳 `question` 與 `status`，不必繞總調度。
- **信封要齊**：每則 bot 間訊息都附總調度的 item 編號、完成標準、決策等級（A／A2／B）。內文要自足：沒有對話脈絡的 bot 只看這一則就能開工。
- **handoff 一律經總調度**：整件交辦、換負責人，都由總調度 bot 發，item 才對得上誰在負責。
- **例行排程歸負責的 bot**：專案的例行工作掛在那個專案 bot 底下，由它自己開需要 owner 的 item；總調度只收攏與彙整。要搬移時先在專案 bot 建好、跑成功一次，再停掉原本的。
- **需要 owner、但不擋進度的事每天集中送一次**：擋住進度的照樣即時通知；其餘併進每天固定時間的「今天要你決定或動手的」清單。
- **宣稱完成前要有實測證據**：說「已接手／已完成／已恢復」或關閉 A2、B 級 item 前，附實際的指令輸出或對方回覆的 message id。可以再請一個不帶對話脈絡的 subagent 只看 item 與證據判斷是否成立，不成立就不宣稱。

## coordinator 的 gate 怎麼送到專案 bot

L3 的 coordinator 遇到需要判斷的 gate 時，本來是等 owner 回到它的分頁回答。L4 用一條 standing order 改道：在 coordinator 的 `.scratch/pilot/preferences.md` 加一條，讓提問與 gate 確認改送專案 bot：

```bash
orca-ide orchestration send --to bot:<專案 bot> --from <coordinator 分頁的 handle> \
  --type question --subject "<gate 編號與主題>" --body-file <主 checkout 的 .scratch/ 下的檔>
```

- `--from` 帶 coordinator 自己分頁的 terminal handle，回覆才回得到這個分頁。
- 指令寫字面的 `orca-ide orchestration send …`：允許規則比對字面前綴，用變數展開的指令對不上。`--body-file` 放在主 checkout 的 `.scratch/` 下（Claude 的 scratchpad 路徑 Orca 讀不到），或改用 `--body <文字>`。
- 同一條 preference 寫明 bot 的代答範圍（照專案 bot 的 A／A2），以及保留給 owner 本人的項目（照 B）。
- 專案 bot 收到後照自己的決策分級回答：A、A2 直接回 coordinator；**只有 B 級才轉給 owner**，開 item 附 gate 編號等答案。
- 送 bot 的指令被 auto mode 分類器擋下時，coordinator 只記 gate，不重試、不換通道繞路。

**權限分類器的限制**：Claude Code 的 auto mode 分類器會拒絕「依轉達來的 owner 決定去寫入」的動作，例如 bot 轉述 owner 同意放寬某條權限、或轉述一份 SQL 執行結果，coordinator 據此改 gate 或結案。這類 owner 的決定不能經 bot 轉達後寫入，**要 owner 本人在 coordinator 的分頁確認**。專案 bot 在自己 A 級範圍內的裁定不受影響，因為那是 bot 的決定、不是轉述。所以把 gate 分給 bot 時，凡是 B 級的，bot 要提醒 owner 去 coordinator 分頁回答，而不是自己代為轉達。

## session 交接

Orca bot 的新 chat 只自動讀 `SOUL.md` 與 `MEMORY.md`，對話裡的「現在做到哪」換 chat 就沒了。ron-skills 的 `session-handoff` skill 處理這件事（[`SKILL.md`](../../skills/productivity/session-handoff/SKILL.md)）：

1. 掃一遍對話裡仍在進行的狀態：進行中的交辦與 worker、需 owner 的未決決策、owner 新給的偏好、未完成的 items、下一步、在等誰回覆。
2. 會比這個 chat 活得久的事實寫進 `MEMORY.md`、`memory/<topic>.md` 或 items。
3. 把「現在的位置」寫成固定位置的快照 `memory/session-handoff.md`，狀態標「接續中」。
4. 給 owner 一段交接摘要；新 chat 由 owner 開（`orca bot new-chat` 只有 owner 能執行）。

新 chat 要接得上，`SOUL.md` 的 `## How I work` 要有這一行（由 owner 手動加，skill 不寫 SOUL）：

```text
- 開新 chat 先讀 memory/session-handoff.md（沒有就略過）：狀態是「接續中」就照「下一步」接續，接完把狀態改成「已接續」。
```

對話變長、或一段工作告一段落時，bot 可以自己先跑交接，不必先問。

## retro

bot 與 coordinator 各有一套 retro，並存、互不取代：

- **bot 端的輕量 retro**：每個有實質內容的對話結束時，bot 在自己 home 的 `.scratch/retro/<對話 id 前 8 碼>.md` 寫一則（格式同 `/retro`：類別、嚴重度、證據、原因、提議，並標明提議屬於 MEMORY、repo 的 Issue，還是要問 owner）。bot home 的 Stop hook 數 `.scratch/retro/` 第一層的檔，滿門檻（例如 5 則）時以 `decision:block` 要 bot 當下收斂。收斂只做可逆的部分：篩掉噪音；bot 自己行為的教訓蒸餾成 `MEMORY.md` 的一行；repo 或 skill 的改進開成那個 repo 的 `retro` Issue 交給它的 coordinator 實作；運作原則或架構層級的列成 item 問 owner；收斂完的檔搬到 `.scratch/retro/done/<YYYY-MM-DD>/`，不刪。規則寫在 bot home 的 `RETRO.md`。
- **pilot 端的自動 `/retro-collect`**：adapter 的 Pilot 段有 **Retro trigger** 條目時，coordinator 每輪跑 `scripts/pilot-retro-due.mjs`，未收集的 retro 達 5 則或最舊一則滿 8 小時就開分頁跑 `/retro-collect`（門檻可在條目改，見 [05 retro-collect](05-level3.md#retro-collect)）。收集報告裡給 owner 否決的段落落檔在 `.scratch/retro/reports/<YYYY-MM-DD>-<key>.md`，專案 bot 從那裡讀，列進它的收斂回報。

## 導入順序

1. 先把各 repo 跑到 L3，`/loop /issue-pilot` 能穩定常駐。
2. 在 Orca 建總調度 bot，寫它的 `SOUL.md`、`decision-framework.md`。
3. 每個專案建一個專案 bot，從上面的骨架寫它的 `decision-framework.md`，`SOUL.md` 加上交接那一行；把 `session-handoff` skill 連到 bot 讀得到的 skill 目錄。
4. 在各 repo coordinator 的 `preferences.md` 加 gate 改道那一條，先跑一次 A 級的 gate，確認回覆回到 coordinator 分頁。
5. 例行排程逐一從總調度搬到專案 bot：先在專案 bot 跑成功一次，再停原本的。
