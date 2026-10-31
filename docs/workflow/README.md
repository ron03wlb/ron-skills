# ron-skills 交付流程

把一張 Issue 交給 agent、驗證到本機 candidate commit、再由人 push 與合併的流程導讀。流程建在三層 skill 上：Matt Pocock 的工程方法（`tdd`、`code-review`、`implement`…）、pstack 的編排原則，以及 ron-skills 自己的 `/issue-run`、`/issue-pilot` 編排；各專案只寫一份 **adapter** 說明自己的 tracker、檢查與交付指令。

正式規則以 [`README.md`](../../README.md)、[`skills/engineering/issue-run/ADAPTER.md`](../../skills/engineering/issue-run/ADAPTER.md) 與各 skill 的 `SKILL.md` 為準；本站只轉述，兩邊說法不同時以正式規則為準。

## 給誰看

- 想把同一套流程搬到自己 repo 的同事，以及我自己的其他 repo。
- skills 放在 private 的 ron-skills repo：要照做，得先能 clone 它（向 repo 擁有者要讀取權限）。只看導讀不需要權限。
- 預設你已經會用 Claude Code、git 與一個 Issue tracker（GitHub 或 GitLab）。本站的 tracker 指令都 `gh`（GitHub）與 `glab`（GitLab）並列。

## 導入等級

不必一次全上。每一級都是完整可用的流程，下一級只在上一級跑順、而且遇到它解決的問題時才加。

| 級 | 你得到什麼 | 進入條件 | 怎麼開始 |
| --- | --- | --- | --- |
| **L0 不導入** | 不寫 adapter，只用個別輔助 skill | 沒有 tracker，或不用 Issue 交付（例如只用輔助 skill 的知識庫） | 不需要開始 |
| **L1 基本** | 一張 `ready-for-agent` Issue 不中斷地跑到本機 candidate commit，附驗證證據；人 push、開 PR／MR、合併、結案 | 用 Issue tracker（GitHub、GitLab 或本機 Markdown）交付工作；這台機器能裝 ron-skills 的 skills；repo 有（或願意先做）一條能跑完所有檢查的指令 | [03 L1 導入](03-level1.md) |
| **L2 守門** | 每張 Issue 一個 worktree、一條整合分支、合入有 lock、push 前 hook 重驗、兩段式結案、`/retro` 把失誤變成檢查 | 已用 L1 的 `/issue-run` 交付過幾張 Issue；而且同時開兩個以上 session，或已經發生過繞過檢查、合錯分支、狀態對不上（兩者擇一） | [04 L2 導入](04-level2.md) |
| **L3 常駐** | `/loop /issue-pilot` 常駐 coordinator 自己挑單、派 worker、整批回歸、合入整合分支；人只剩產品決策、共用環境操作，以及 adapter 沒交給 coordinator 的 push 與合併 | L2 的入口（檢查、合入、push 前 hook）都有固定的 exit code；裝了 Orca；願意讓 agent 在無人值守時跑 git | [05 L3 導入](05-level3.md) |

進入條件就是 `/setup-workflow` 等級站問的是非題，一個分號一題；量得到的（已有 tracker 設定、已有檢查入口、環境站偵測到 Orca）直接取證據，不再問。下一級的條件都符合才建議升一級，否則建議維持目前等級；一次最多升一級，跳級要人明說。

等級相同的專案靠「擴充」區分：卡關單、外部測試環境、自訂分級入口這類特性與等級無關，可以分別勾選。tracker 與程式碼放在 GitHub 還是 GitLab 不算擴充，由 `/setup-workflow` 的 Host 站另外確認。

## 兩個實例

兩個都是 L3，差在擴充：

- **輕量 L3：ron-skills 本身。** tracker 是 GitHub，唯一檢查入口是 `bin/check`；adapter [`docs/agents/issue-run.md`](../agents/issue-run.md) 的 `## Pilot` 段指向 [`docs/agents/pilot.md`](../agents/pilot.md)，由 `/loop /issue-pilot` 把 Issue 整批合進 `pilot/integration`。本站的每一章也是這樣交付的。
- **帶多項擴充的 L3：一個常駐交付的 Java 後端專案。** 它在 L2 的入口之外加了 SQL Issue、Docker 測試入口、自訂的分級 skill 等擴充；導讀站公開在 <https://spay2-workflow-docs.pages.dev>。那裡的專案專屬內容只當例子，不是本流程的規則。

## 章節

| 章 | 內容 |
| --- | --- |
| [01 工具與角色](01-tooling.md) | Operator、coordinator、worker、subagent、Codex 各負責什麼；Claude Code、skills、hooks、tracker、Orca 的關係 |
| [02 Issue 生命週期](02-lifecycle.md) | 五個 triage label 加 `in-progress`／`completed` 的狀態機與看板；從開單到結案；批次 |
| [03 L1 導入](03-level1.md) | checklist：`/setup-workflow` 的環境、Host、等級三站（含單一檢查入口）、label、adapter、`/triage`、`/issue-run`、PR／MR |
| [04 L2 導入](04-level2.md) | worktree、整合分支與 lock、pre-push、兩段式結案、`/retro`、權限規則；每個入口的契約 |
| [05 L3 導入](05-level3.md) | `/loop /issue-pilot`、adapter 的 Pilot 段、tick hooks、Orca、Codex 跨模型 review、`/retro-collect` |
| [06 品質校驗時間軸](06-quality-gates.md) | 強度分級；從編輯到結案每道校驗的觸發點、能證明與不能證明什麼 |
| [07 規則沉澱](07-rules.md) | memory → skill → repo 規範 → 腳本／gate；新檢查要先在歷史錯誤上失敗 |
| [08 常見坑](08-pitfalls.md) | 換了專案也會踩的坑：症狀、原因、做法 |
| [09 Skills 索引](09-skills.md) | 依階段列出 skill 與它所屬的導入等級 |

## 本站怎麼產生

Markdown 是唯一來源，`site/` 下的 HTML 全是產物。改完 Markdown 在 repo 根目錄重產，不要手改 HTML：

```bash
node scripts/build-workflow-site.mjs
```

`bin/check` 對本資料夾跑四道守門：

- `node scripts/build-workflow-site.mjs --check`：`site/` 與 Markdown 不同步就失敗（忘了重產或手改 HTML）。
- `node scripts/check-workflow-strings.mjs`：擋住從實例專案帶進來的專屬字串，讓本站維持通用。
- `node scripts/check-workflow-sync.mjs`：`issue-run`、`issue-pilot`、`retro-collect` 的 `SKILL.md` 或 `ADAPTER.md` 一改就失敗，直到有人對照本站並執行 `node scripts/check-workflow-sync.mjs --restamp`。
- `tests/workflow-diagrams.test.mjs`：`diagrams/` 的來源、HTML 與 PNG 不齊全、來源 JSON 不是一節點一行，或章節沒嵌入圖與連結時失敗（見下方「圖怎麼看、怎麼改」）。

## 圖怎麼看、怎麼改

- 章內的 PNG 是靜態預覽；圖下方的「互動版」連到 archify 產出的 HTML（可切換主題、搜尋節點、匯出圖片）。站上各章直接內嵌互動版。
- 圖以 [archify](https://github.com/tt-a1i/archify) 製作。來源是 `diagrams/src/*.json`，`diagrams/` 下的 HTML 與 PNG 都是產物；要改圖就改 JSON 重產，不要手改 HTML。CI 不跑 archify，改了 JSON 要在本機重產並一起 commit。
- 來源 JSON 維持一個節點一行：用文字編輯修改，不要整檔重新序列化（例如 `json.dump`），否則一個小改動會變成數百行 diff。`tests/workflow-diagrams.test.mjs` 會擋。
- 重產一張圖（在 repo 根目錄；`<archify>` 是 skill 安裝路徑，例如 `~/.claude/skills/archify`；`--quality` 照來源 `meta.quality_profile`）：

```bash
node <archify>/bin/archify.mjs validate workflow docs/workflow/diagrams/src/02-main-flow.workflow.json
node <archify>/bin/archify.mjs finalize workflow docs/workflow/diagrams/src/02-main-flow.workflow.json docs/workflow/diagrams/02-main-flow.html --quality showcase --out-dir /tmp/archify-evidence/02-main-flow --json
node <archify>/bin/archify.mjs visual-check docs/workflow/diagrams/02-main-flow.html --summary --require-provenance --out-dir /tmp/archify-evidence/02-main-flow
cp /tmp/archify-evidence/02-main-flow/02-main-flow.visual-check.1440x900.light.png docs/workflow/diagrams/02-main-flow.png
node scripts/build-workflow-site.mjs
```

- `finalize` 會在 HTML 旁留下 `*.delivery.json` 收據，`visual-check --require-provenance` 靠它確認 HTML 是由 `finalize` 產生；收據含本機絕對路徑，已列在 `.gitignore`，不 commit。
- `finalize` 會驗證版面，不過就失敗。一次過的限制：workflow 圖最多 6 欄（col 0–5）；畫布寬度上限 1240px，節點標籤要短（約 12 個中文字內，副標更短）；邊不能跨越泳道的垂直邊，跨欄回頭的邊改用虛線另畫或拆成兩個節點；跨泳道的垂直邊不要掛標籤（會把欄撐寬），狀態改寫在節點的 `tag`；先 `validate` 再 `finalize`，每次只改一處再重跑。
- `finalize` 需要 Chrome／Chromium：`export ARCHIFY_CHROME=<chrome 路徑>`（例如 Playwright 快取裡的 `chromium-*/chrome-linux/chrome`）。WSL 預設沒有中文字型，截圖時中文會變方框，做法見 [08 常見坑](08-pitfalls.md#wsl)。
