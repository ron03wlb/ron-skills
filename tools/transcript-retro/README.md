# transcript-retro

以 Claude API 分析 `~/.claude/projects/*/*.jsonl` 的 Claude Code session，跨 session 找出重複發生的摩擦，產出 retro 候選報告。費用走 Console 的 API 額度，不佔訂閱額度。

## 流程

1. 萃取（本機、不花錢）：每個 session 只留使用者訊息、assistant 文字、工具呼叫摘要、失敗的工具結果與系統訊息，遮蔽常見 secret 格式，依 80K token 切段。
2. 逐 session 分析：Claude Haiku 5.5，經 Batch API（5 折），structured output 回傳 finding。
3. 彙整：Claude Sonnet 5.5 把所有 medium／high finding 分群，對照 memory 索引，標出「已有 memory 仍重犯」的項目。

## 設定

API key 放在 `~/.config/ron-skills/anthropic-api-key`（權限 600），程式只把它傳給自己的 client。不要 export 成全域 `ANTHROPIC_API_KEY`：Claude Code 會因此改走 API 計費。

```bash
npm install
```

## 使用

```bash
node analyze.mjs estimate [--since 2026-10-13] [--project spay2]   # 估算費用，不呼叫 API
node analyze.mjs submit --limit 5                                  # 送出 batch；已分析且未變動的 session 會略過
node analyze.mjs collect                                           # 取回結果（batch 未完成時只顯示進度）
node analyze.mjs report --memory ~/.claude/projects/-home-ron-code-spay2/memory/MEMORY.md --repo ~/code/spay2 --repo ~/code/ron-skills
```

`--repo` 可重複：彙整時附上這些 repo 自最早 finding 以來的 commit 標題，報告會把「之後的 commit 看起來已修正」的問題另列，只有修正後仍發生的才排進主要結論。舊 session 的 finding 常常早已修好，建議一律帶上。

狀態、finding 與報告存在 `~/.local/share/transcript-retro/`，不進 repo。

## Skill 遵循度檢查（`--skill`）

以 skill 文件當評分標準，檢查用過該 skill 的 session（使用者輸入 `/<name>` 或模型呼叫 Skill）有沒有照步驟執行：跳過步驟、順序錯誤、違反明確規則、使用者介入、卡關最久的步驟。

- 每個 session 以**當時**的 SKILL.md 評分：從 skill 所在 git repo 取 session 開始前最後一個版本；早於第一次 commit 時用最早版本並標 `before-<sha>`。不在 git 的 overlay 副本用目前版本。
- `--rubric <file>` 可重複，加入 skill 引用的其他文件（例如專案 adapter），同樣取當時版本。
- 預設模型為 Sonnet 5.5（判斷是否遵循比找摩擦難）；rubric 加上 prompt caching，同版本的請求共用快取。
- 報告依步驟彙整，並對照 SKILL.md 的 commit 歷史，標出「修正後仍發生」的問題。

```bash
node analyze.mjs submit --skill issue-run --rubric ~/code/spay2/docs/agents/issue-run.md
node analyze.mjs collect
node analyze.mjs report --skill issue-run --repo ~/code/spay2 --repo ~/code/ron-skills
# 專案內的 skill 在該 repo 下執行，或以 --skill-path 指定
(cd ~/code/spay2 && node ~/code/ron-skills/tools/transcript-retro/analyze.mjs submit --skill deliver-spec)
```

## 例行流程

指令都在本目錄執行。`submit` 只送新增或變動過的 session，所以例行執行只付增量的費用。

### 全面 retro（建議每週一次）

```bash
node analyze.mjs estimate
node analyze.mjs submit
node analyze.mjs collect      # 約 1 小時後執行；未完成時只顯示進度，稍後再跑
node analyze.mjs report --since <上次報告日期> \
  --memory ~/.claude/projects/-home-ron-code-spay2/memory/MEMORY.md \
  --repo ~/code/spay2 --repo ~/code/ron-skills
```

`report` 預設彙整所有累積的 finding。`--since` 填上次報告的日期，報告就只涵蓋這段期間，舊問題不會一再出現。

### Skill 遵循度

- **整體健檢**：照上一節的 `--skill` 指令執行，`report` 同樣加上 `--since`。
- **確認修正是否生效**（最常用）：改過的 skill 實際跑過幾個 session 後，以 `--since <修正 commit 日期>` 產生報告，看「已修正 vs 仍發生」一節。修正後仍發生，代表文字規則無效，應改成腳本或 gate。

| skill | 額外參數 | 執行位置 |
| --- | --- | --- |
| `issue-run`、`issue-pilot` | `--rubric ~/code/spay2/docs/agents/issue-run.md`（adapter） | 任意 |
| spay2 專案內的 skill（`deliver-spec` 等） | 無 | `~/code/spay2` 下，或以 `--skill-path` 指定 |
| overlay（`grilling` 等） | 無 | 任意；不在 git 中，只能以目前版本評分 |

### 從報告到修正

報告只負責找出問題與排序，修正仍透過 `/retro`：

1. 從報告的結論、「已有 memory 仍重犯」或「修正後仍發生」挑一兩項。
2. 報告引用的 session id 為前 8 碼。在新 session 由使用者輸入 `/retro 針對 session <id>：<問題標題>`（`/retro` 只能由使用者輸入）。
3. 修正落點：spay2 開 retro branch，commit 用 `chore: retro …`；ron-skills 直接 commit 到 `main`。
4. 之後以「確認修正是否生效」的方式驗證。

### 注意

- 報告中的次數是模型粗估（「≥N 個 session」）。動手前以 `/retro` 讀原始紀錄確認。
- `collect` 印出「N 筆 finding 的證據提到截斷或無法確認」時，先挑幾筆對照原始 transcript，確認摘要沒有漏掉關鍵內容，再全量送出或據此修改。截斷行為由 `tests/transcript-retro-extract.test.mjs` 把關（CI 的 Tests 步驟）。
- 改了 `extract.mjs` 的萃取方式後，新舊 finding 不可比較：先把 `~/.local/share/transcript-retro/findings` 改名備份，再以 `--rerun` 全部重送。2026-10-20 曾因截斷只保留開頭，把 worker 末行的 `DONE <iid> <SHA>` 誤判為缺漏，就是這樣重跑修正。
- 在 Console 為這把 key 設月上限；依上述頻率，每月約 $5–10。

## 費用參考（2026-10-20 實際用量）

| 步驟 | 模型 | 實際 |
| --- | --- | --- |
| 全量逐 session 分析（276 個請求） | Haiku 5.5 Batch | 約 $0.5 |
| 全面 retro 彙整（1406 筆 finding） | Sonnet 5.5 | 約 $1.1 |
| `--skill issue-run`（80 個 session，含 adapter） | Sonnet 5.5 Batch | 約 $2.9 |
| `--skill issue-pilot`（19 個 session，含 adapter） | Sonnet 5.5 Batch | 約 $0.9 |
| skill 報告彙整 | Sonnet 5.5 | 每份約 $0.2 |
| 每週增量（新 session 與報告） | — | 約 $0.5–1.5 |
