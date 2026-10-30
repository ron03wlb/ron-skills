# ron-skills

個人 skill 層：嵌套在 Matt Pocock skills 與 pstack 之上，不修改上游原始檔。

## 三層分工

| 層 | 位置 | 內容 | 誰改 |
| --- | --- | --- | --- |
| Matt 原版 | `~/code/skills`（`main`，只追上游） | 工程方法：`tdd`、`code-review`、`implement-spec`… | 只 `git pull` |
| pstack 原版 | `~/code/pstack`（`backnotprop/pstack` mirror，`main`） | 編排與原則：`poteto-mode` 的 Autopilot／Orchestrate playbook、`principle-*`、`show-me-your-work`、`ketchup` | 只 `git pull` |
| 個人層 | 本 repo | `issue-run`／`issue-pilot` 編排、`explain`、`overlays/` 補丁 | 自己 |
| 專案 adapter | 各 repo 的 `docs/agents/issue-run.md` | tracker、gate、驗證、交付指令 | 各專案 |

## 安裝與升級

```bash
bin/sync-skills --check   # 只檢查 overlay 能否套用在目前的 Matt 版本，並提示上游新增的 skill
bin/sync-skills           # 重建 ~/.claude/skills 與 ~/.agents/skills 的連結
bin/sync-skills --list    # 列出所有可用 skill：user/model、名稱、來源（在專案目錄執行會含專案 skill）
```

升級 Matt：`~/code/skills` 是 fork（ron03wlb/skills），不會自動跟上 mattpocock 上游，先 `gh repo sync ron03wlb/skills` 再 `git -C ~/code/skills pull --ff-only`；`--check` 通過並試跑後，更新 `matt-skills.txt` 的 `# pin:`，再跑 `bin/sync-skills`。升級 pstack：`git -C ~/code/pstack pull`，`--check` 通過並試跑後，更新 `pstack-skills.txt` 的 `# pin:`。出現 `OVERLAY_FAILED` 代表上游改到補丁位置，連結保持舊版，重做該補丁後再同步。

- `matt-skills.txt`：要連結的 Matt skill 清單（相對 `skills/`）；`-<path>` 表示刻意不連結。`--check` 列出的 `NEW` 行，二選一加入清單。
- `pstack-skills.txt`：pstack 白名單，同樣格式；`# pin:` 記錄驗證過的上游 SHA，HEAD 不同時只警告。不連結的理由只有三種：與 Matt 或本 repo 的流程重疊（`tdd`、`teach`、`reflect`／`recall`／`correct` 已併入 `retro` 與 `issue-run`、`swarm` 由專案的分區掃描涵蓋）、與 repo 規範衝突（`no-comments` 的刪註解策略、`technical-writing` 的英文句式規則），或 Cursor 專屬。pstack 的方法沒有一個需要兩家以上模型，Claude 加 Codex 即可；`arena` 以 overlay 接本機 worktree 與 Codex judge，`poteto-mode` 的 Eval playbook 經由它執行。`create-formal-verification-skill`／`maintain-formal-verification-skill` 用於金流與並發屬性的形式驗證（TLA+ 等），`statechart` 是前者讀 TLA+ 結果的依賴，一併連結。
- `bin/check`：唯一的檢查入口，依序跑 `bin/sync-skills --check`、連結檢查與 `tests/`；`bin/check --upstream` 改對 Matt 與 pstack 上游最新 main 檢查（與 CI 相同）。
- 本機 pre-commit（`.githooks/pre-commit`，clone 後執行一次 `ln -s ../../.githooks/pre-commit .git/hooks/pre-commit` 啟用）：跑 `bin/check`。
- CI（`.github/workflows/checks.yml`）：每次 push 與每週一跑 `bin/check --upstream`；上游改到補丁位置時會先在這裡變紅。
- `overlays/<name>.patch`：對 Matt 或 pstack skill 的最小改動，同步時套在 `~/.local/share/ron-skills/overlay/<name>` 的副本上，上游 checkout 本身不變。
- 只處理指向 Matt、本 repo 或 overlay 副本的 symlink；實體目錄與其他來源的連結不動。

## overlays 清單

| 補丁 | 內容 |
| --- | --- |
| `grilling`、`grill-me`、`grill-with-docs` | `effort: high`；`grilling` 另把「派子代理查事實」改為自己用工具查、範圍大才派 |
| `domain-modeling` | repo 自訂的 ADR 版面與索引編號優先 |
| `retro` | 寫入前檢查其他 session 的並行修改；repo 有 `scripts/retro-collect.mjs` 且本 session 是退役 coordinator 時改為收集模式：只寫 retro 檔、不實作，等 `/retro-collect` |
| `poteto-mode` | 本機 harness：先讀上游 `docs/harness/claude-code.md` 做名稱對照；repo 規則與語言優先、無 GitHub PR（對應 candidate／整合分支）、無 cloud（Orca terminal）、Claude 加 Codex 兩家、未連結 skill 改用 Matt 對應 |
| `arena` | 只用在昂貴、難逆轉且多解的設計決策；一席 Claude worktree 子代理、一席 Codex，Codex 唯讀當 judge；Eval 只用於 worker／review／stop-policy 的 skill 變更 |

## issue-run

`/issue-run <ref> [<ref>...]`：把已 ready 的 Issue 不中斷地跑到本機 candidate commit。方法照 Matt 的 `implement` / `implement-spec`，專案事實全部讀 repo 的 adapter；沒有 adapter 時用 Matt setup 文件與 [ADAPTER.md](skills/engineering/issue-run/ADAPTER.md) 的預設值。push、合併到共用分支、產品決策仍由人負責。

新專案導入：把 `ADAPTER.md` 複製成該 repo 的 `docs/agents/issue-run.md`，填入實際指令。pilot 要在其他 worktree 跑 git 時，照 ADAPTER.md 的 **Permissions** 段複製 [templates/pilot_git.py](skills/engineering/issue-run/templates/pilot_git.py)，allow 只放行該腳本，不寫 `git -C *`（中間的 `*` 能夾帶 git 選項，Claude Code 每次啟動都會警告）。

新增或改動 skill 的入口時，在新 session 實際觸發一次才算完成。被 `/loop` 驅動的 skill 必須可由 Skill tool 呼叫（不設 `disable-model-invocation`），`bin/sync-skills --check` 以 `scripts/check-loop-invocable.mjs` 檢查。skill 引用的每一行 adapter Pilot 設定，都必須是 ADAPTER.md Pilot 段的條目，`--check` 以 `scripts/check-pilot-lines.mjs` 檢查。

## issue-pilot

`/loop /issue-pilot`：在專案主 checkout（或 adapter Pilot 段 **Coordinator checkout** 指定的 checkout）常駐的 coordinator，採 pstack Autopilot-stack 語意。它自己從 tracker 池子挑 Issue、每張派一個 `/issue-run <iid> --worker <checkpoint>` 的 Orca terminal、整批 regression 後合入本機整合分支，再通知人 push。人只做產品決策、共用環境 SQL 執行與讀回、`git push`。專案事實讀 adapter 的 **Pilot** 段落。專案自己的每 tick 檢查（例如 investing 的每日採集派發與額度檢查）寫在 Pilot 段的 **Project tick hooks**：每個 tick 在 Drain 之後、Pick 之前執行，exit 0 繼續，非 0 開 gate 並跳過該 tick 的 Pick 與 Dispatch；沒寫就略過。

pilot 已達標，2026-10-21 起是唯一編排：`deliver-batch`、`deliver-spec`、`project-batch` 已下架。`/issue-run` 單獨使用是手動入口，不是備援。

## retro-collect

`/retro-collect [<session8>...]`：收集退役 coordinator 以收集模式寫下的 `/retro` 檔，彙整成一份計畫，在單一 retro worktree 實作全部採用項，合入整合分支並推送，最後關掉已收集的分頁。流程是人在每個舊分頁輸入 `/retro`，再於任一 session 輸入 `/retro-collect`。專案事實讀 adapter Pilot 段的 **Retro collect** 行。

## learning

`/senior-interview-loop`：一次練一題資深後端面試題。先閉卷作答，再照 `learn-professional-topics` 的方法追問並評分；收尾經人確認後，原始作答寫成一張 Heptabase 練習卡，掌握度只寫入 Growth 的 validation ledger。路徑、Heptabase ID 和門檻都讀 Growth repo 的 `docs/agents/senior-interview-loop.md`；在 Growth checkout 內執行，或設定 `GROWTH_ROOT`。需要 Heptabase MCP。

`learn-professional-topics` 從舊 fork（`ron03wlb/skills` 的 `skills/personal/`）移入，現以本 repo 為正式版本。

## daily-summary

`/daily-summary [YYYY-MM-DD]`：把 Personal Life vault 某天的 Daily 整理進「🌙 晚間回顧」。推進與可解決的問題從晨間意圖、工作目標、工作紀錄與當天 vault commit 起草；情緒、肯定自己、感恩、擔憂這類只有本人知道的欄位一次問完。確認後只改晚間回顧段，可選擇把未完成的工作目標帶到隔天。段落結構以 `.obsidian/daily-notes.json` 指向的 template 為準；在 vault 內執行，或設定 `PERSONAL_LIFE_ROOT`。
