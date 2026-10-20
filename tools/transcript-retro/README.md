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

## 費用參考（2026-10-20，268 個 session）

| 步驟 | 模型 | 估計 |
| --- | --- | --- |
| 全量逐 session 分析 | Haiku 5.5 Batch | 約 $0.3 |
| 同上改用 Sonnet | Sonnet 5.5 Batch（`--model claude-sonnet-5-5`） | 約 $5.4 |
| 彙整報告 | Sonnet 5.5 | 約 $0.5–1 |
| `--skill issue-run`（78 個 session，含 adapter） | Sonnet 5.5 Batch | 上限約 $2.3 |
| `--skill deliver-spec`（77 個 session） | Sonnet 5.5 Batch | 上限約 $1.9 |
