# ron-skills 是 skill 來源層，不改成 Home Repo

Matt 的 [Home Repo pattern](https://aihero.dev/the-home-repo-pattern) 把 skills、AGENTS.md 和共用文件集中在一個 repo，agent 一律在那裡啟動，再開或 clone 其他 repo。我們決定 ron-skills 維持**來源層**：通用 skill 由 `sync-skills` 連到 `~/.claude/skills`，通用 script 依 ADR 0001 複製成各專案的副本，日常 session 照舊在各專案的主 checkout 啟動。只借用 Home Repo 的 Other Repos 清單，放在 ron-skills 的 `CLAUDE.md`，給上游升級、`/retro-collect`、跨專案比對分歧這類跨 repo 工作用。

## 被否決的做法

- **所有 session 從 ron-skills 啟動。** pilot 存檔（ADR 0002）、Orca worktree、tracker 寫入的 allowlist（`gh-tracker.mjs` 只寫一個 repo）都以專案的主 checkout 為中心；團隊 repo 的同事讀不到私人的 ron-skills，ADR 0001 否決「專案直接引用 `~/.claude/skills`」也是這個原因。
- **共用規範集中到 ron-skills。** 各專案的規範是領域專用（spay2 的 Java、SQL），目前沒有兩個專案真正共用的規範；出現時再比照正本做法。

## 後果

「一份通用 skill」靠 `sync-skills` 與正本達成，不靠 session 位置；跨 repo 工作從 ron-skills 啟動時，依 Other Repos 清單找路徑。
