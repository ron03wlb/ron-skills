# ron-skills

個人 skill 層：嵌套在 Matt Pocock skills 之上，不修改 Matt 原始檔。

## 三層分工

| 層 | 位置 | 內容 | 誰改 |
| --- | --- | --- | --- |
| Matt 原版 | `~/code/skills`（`main`，只追上游） | 工程方法：`tdd`、`code-review`、`implement-spec`… | 只 `git pull` |
| 個人層 | 本 repo | `issue-run` 編排、`explain`、`project-batch` 試作、`overlays/` 補丁 | 自己 |
| 專案 adapter | 各 repo 的 `docs/agents/issue-run.md` | tracker、gate、驗證、交付指令 | 各專案 |

## 安裝與升級

```bash
bin/sync-skills --check   # 只檢查 overlay 能否套用在目前的 Matt 版本
bin/sync-skills           # 重建 ~/.claude/skills 與 ~/.agents/skills 的連結
```

升級 Matt：`git -C ~/code/skills pull`，再跑 `bin/sync-skills`。出現 `OVERLAY_FAILED` 代表上游改到補丁位置，連結保持舊版，重做該補丁後再同步。

- `matt-skills.txt`：要連結的 Matt skill 清單（相對 `skills/`）。上游新增想用的 skill 時加一行。
- `overlays/<name>.patch`：對 Matt skill 的最小改動，同步時套在 `~/.local/share/ron-skills/overlay/<name>` 的副本上，Matt checkout 本身不變。
- 只處理指向 Matt、本 repo 或 overlay 副本的 symlink；實體目錄與其他來源的連結不動。

## overlays 清單

| 補丁 | 內容 |
| --- | --- |
| `grilling`、`grill-me`、`grill-with-docs` | `effort: high` |
| `domain-modeling` | repo 自訂的 ADR 版面與索引編號優先 |
| `retro` | 寫入前檢查其他 session 的並行修改 |

## issue-run

`/issue-run <ref> [<ref>...]`：把已 ready 的 Issue 不中斷地跑到本機 candidate commit。方法照 Matt 的 `implement` / `implement-spec`，專案事實全部讀 repo 的 adapter；沒有 adapter 時用 Matt setup 文件與 [ADAPTER.md](skills/engineering/issue-run/ADAPTER.md) 的預設值。push、合併到共用分支、產品決策仍由人負責。

新專案導入：把 `ADAPTER.md` 複製成該 repo 的 `docs/agents/issue-run.md`，填入實際指令。
