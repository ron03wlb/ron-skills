# session-handoff — 散佈與接續提案（待 owner 核准，勿直接安裝）

## 1. skill 放哪、怎麼寫
- 正式位置：ron-skills repo `skills/productivity/session-handoff/SKILL.md`（與 `explain`、`daily-summary` 同層，個人層 skill）。
- 純 prose、無 script：它只讀當前對話＋`orca bot work/item/automations list`，不需要 repo 綁定的腳本，因此對 5 個 bot 可攜。
- 慣例已對齊：英文 body、使用者輸出繁中、numbered steps、每步「Done when…」。
- 這份是草案（在我家 `drafts/session-handoff/`）；owner 核准後才在 ron-skills 開 Issue 正式建檔、過 `bin/check` 與流程站守門。

## 2. 散佈到 5 個 bot（spay / skills / personal-wiki / ogp / Chief of Staff）
**查定結果（2026-11-20，已實查，不需 owner 判斷）**：5 個 Orca bot 都是 Windows 上的 Claude Code，撿的是 **Windows 全域 `C:\Users\ron.chang\.claude\skills`**，不是 per-bot linked-skills。
- 證據 1：本 bot 可用的 skill 清單與 Windows `~/.claude/skills` 的連結逐項吻合（`close-issue`、`execute-issue`、`grilling`、`learn-professional-topics`…，連到 `C:\Workspace\open_source\skills`，即 ron03wlb/skills 的 Windows clone）。
- 證據 2：5 個 bot 的 `bot-linked-skills/<botId>/` 全是空的，`orca bot list` 每個都是「Linked: nothing」；這是 per-bot 的選配機制，目前沒在用。
- 證據 3：ron-skills 的 `bin/sync-skills` 只寫 **WSL** 的 `~/.claude/skills`（`issue-run`、`explain`、`daily-summary` 在那裡），所以 Orca bot 看不到它們。
- `orca skills share` 是把 skill 發佈成分享連結，不是本機安裝路徑；不採用。

**結論**：散佈路徑 = Windows 全域 `~/.claude/skills` 放一個 `session-handoff` 連結，5 個 bot 一次全有（「預設全裝」自然達成，裝一處即可，不必逐 bot）。原始檔仍放 ron-skills（個人層的正確位置；`skills` repo 是 Matt fork，依 README 只 `git pull` 不改）。

連結做法（二選一，核准後採用；我推薦 A）：
- **A. 擴充 `bin/sync-skills`**，加一份 Windows 目標清單，在 Windows `~/.claude/skills` 建指向 `\\wsl.localhost\Ubuntu\home\ron\code\ron-skills\skills\productivity\session-handoff` 的連結：單一來源、不會分歧；代價是 WSL 沒開時 bot 讀不到，且這是改 sync-skills 行為，需 owner 核准。
- **B. 手動建一個 Windows 連結**（同目標）：最小改動，但不在 sync-skills 管理範圍內，日後要記得手動維護。

**提案**：預設全裝但**先出草案、不做不可逆安裝**。owner 核准後我才：
1. 在 ron-skills 建檔並過 `bin/check`；
2. 依 A 或 B 在 Windows `~/.claude/skills` 建連結；
3. 每個 bot 在新 chat 實際觸發一次才算完成（ron-skills「新增 skill 入口要在新 session 觸發一次」慣例）。

**與既有 skill 的重疊**：全域已有 Matt 的 `handoff`（寫交接文件到 OS 暫存目錄）與 `claude-handoff`（開背景 agent 接手）。session-handoff 的差異是 Orca 專用：落地到 bot 的 MEMORY.md／items、寫固定位置快照、給「owner 開新 Home chat」接續；兩者不取代、description 會寫明分工以免誤觸發。

## 3. 新 chat 自動接續（owner 已核准；SOUL 由 owner 親手加）
- 5 個 bot 的 SOUL.md 都在 `## How I work` 下加這行（定稿文字，**bot 不改 SOUL**）：
  `- 開新 chat 先讀 memory/session-handoff.md（沒有就略過）：狀態是「接續中」就照「下一步」接續，接完把狀態改成「已接續」。`
- 固定快照位置：各 bot home 的 `memory/session-handoff.md`（覆蓋式單一現況；要留舊的先移到 `memory/handoffs/<date>.md`）。
- 過渡期（某個 bot 的 SOUL 還沒加這行時）：交接摘要最後一行是「新 chat 請先讀 memory/session-handoff.md 接續」，讓 owner 貼成新 chat 的第一句。

## 3b. 自行觸發（owner 已核准）
- bot 不必先問，可在「對話變長」或「一段工作告一段落」時自己跑；owner 說要開新 chat 或輸入 `/session-handoff` 時也跑。
- 自己觸發時，交接摘要開頭寫「我先做了交接」，讓 owner 知道原因。
- 只寫 memory、items 和快照，都可逆；`orca bot new-chat` 一律由 owner 執行。
- SKILL.md 不加 `disable-model-invocation`（保留 bot 自行呼叫）。

## 4. 決策狀態
- #1 散佈路徑：**已查定**——Windows 全域 `~/.claude/skills`（見 §2）；剩連結做法 A／B 隨核准一併定。
- #4 快照策略：**已定案**——覆蓋式 `memory/session-handoff.md`，舊的移 `memory/handoffs/<date>.md`。
- #2 散佈範圍：**已定**，5 個 bot 全裝（裝在 Windows 全域一處即全有）。
- #3 新 chat 接續：**已定**，要；SOUL 那行由 owner 親手加（文字見 §3）。
- #5 觸發權：**已定**，bot 可自行觸發（措辭見 §3b）。
- 唯一未定：連結做法 A（擴充 sync-skills）／B（手動 Windows 連結），總調度問 owner 中。定了並給最終 go 後才建檔、過 check、建連結、各 bot 觸發一次。
