# ron-skills

個人 skill 層：嵌套在 Matt Pocock skills 與 pstack 之上，不修改上游原始檔。

## 三層分工

| 層 | 位置 | 內容 | 誰改 |
| --- | --- | --- | --- |
| Matt 原版 | `~/code/skills`（`main`，只追上游） | 工程方法：`tdd`、`code-review`、`implement-spec`… | 只 `git pull` |
| pstack 原版 | `~/code/pstack`（`backnotprop/pstack` mirror，`main`） | 編排與原則：`poteto-mode` 的 Autopilot／Orchestrate playbook、`principle-*`、`show-me-your-work`、`ketchup` | 只 `git pull` |
| 個人層 | 本 repo | `issue-run` 編排、`explain`、`project-batch` 試作、`overlays/` 補丁 | 自己 |
| 專案 adapter | 各 repo 的 `docs/agents/issue-run.md` | tracker、gate、驗證、交付指令 | 各專案 |

## 安裝與升級

```bash
bin/sync-skills --check   # 只檢查 overlay 能否套用在目前的 Matt 版本，並提示上游新增的 skill
bin/sync-skills           # 重建 ~/.claude/skills 與 ~/.agents/skills 的連結
bin/sync-skills --list    # 列出所有可用 skill：user/model、名稱、來源（在專案目錄執行會含專案 skill）
```

升級 Matt：`git -C ~/code/skills pull`，再跑 `bin/sync-skills`。升級 pstack：`git -C ~/code/pstack pull`，`--check` 通過並試跑後，更新 `pstack-skills.txt` 的 `# pin:`。出現 `OVERLAY_FAILED` 代表上游改到補丁位置，連結保持舊版，重做該補丁後再同步。

- `matt-skills.txt`：要連結的 Matt skill 清單（相對 `skills/`）；`-<path>` 表示刻意不連結。`--check` 列出的 `NEW` 行，二選一加入清單。
- `pstack-skills.txt`：pstack 白名單，同樣格式；`# pin:` 記錄驗證過的上游 SHA，HEAD 不同時只警告。與 Matt 重疊（`tdd`、`teach`）、需要多家模型（`how`、`why`、`arena`、`swarm`…）或 Cursor 專屬的 skill 不連結。
- CI（`.github/workflows/checks.yml`）：每次 push 與每週一，對 Matt 上游最新 main 跑 `--check`，並以 `node scripts/check-links.mjs` 檢查 Markdown 連結；上游改到補丁位置時會先在這裡變紅。
- `overlays/<name>.patch`：對 Matt skill 的最小改動，同步時套在 `~/.local/share/ron-skills/overlay/<name>` 的副本上，Matt checkout 本身不變。
- 只處理指向 Matt、本 repo 或 overlay 副本的 symlink；實體目錄與其他來源的連結不動。

## overlays 清單

| 補丁 | 內容 |
| --- | --- |
| `grilling`、`grill-me`、`grill-with-docs` | `effort: high`；`grilling` 另把「派子代理查事實」改為自己用工具查、範圍大才派 |
| `domain-modeling` | repo 自訂的 ADR 版面與索引編號優先 |
| `retro` | 寫入前檢查其他 session 的並行修改 |
| `poteto-mode` | 本機 harness：repo 規則與語言優先、無 GitHub PR（對應 candidate／整合分支）、無 cloud（Orca terminal）、只有 Claude 加 Codex verifier、未安裝 skill 改用 Matt 對應 |

## issue-run

`/issue-run <ref> [<ref>...]`：把已 ready 的 Issue 不中斷地跑到本機 candidate commit。方法照 Matt 的 `implement` / `implement-spec`，專案事實全部讀 repo 的 adapter；沒有 adapter 時用 Matt setup 文件與 [ADAPTER.md](skills/engineering/issue-run/ADAPTER.md) 的預設值。push、合併到共用分支、產品決策仍由人負責。

新專案導入：把 `ADAPTER.md` 複製成該 repo 的 `docs/agents/issue-run.md`，填入實際指令。

新增或改動 skill 的入口時，在新 session 實際觸發一次才算完成。被 `/loop` 驅動的 skill 必須可由 Skill tool 呼叫（不設 `disable-model-invocation`），`bin/sync-skills --check` 以 `scripts/check-loop-invocable.mjs` 檢查。

## issue-pilot

`/loop /issue-pilot`：在專案主 checkout 常駐的 coordinator，採 pstack Autopilot-stack 語意。它自己從 tracker 池子挑 Issue、每張派一個 `/issue-run <iid> --worker <checkpoint>` 的 Orca terminal、整批 regression 後合入本機整合分支，再通知人 push。人只做產品決策、共用環境 SQL 執行與讀回、`git push`。專案事實讀 adapter 的 **Pilot** 段落。

目前為 pilot：下一批 2–3 張 Issue 試跑，達標（整批到 regression 通過、人只做上述三件事）後再下架 `deliver-batch`、`deliver-spec`、`project-batch`；未達標前 `/issue-run` 單獨使用仍是 fallback。
