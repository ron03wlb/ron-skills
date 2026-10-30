## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (ron03wlb/ron-skills) via the gh CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root GLOSSARY.md plus docs/adr/. See `docs/agents/domain.md`.

### Language

使用者可以看到的訊息一律用繁體中文（工具呼叫之間的一行進度也算），程式碼、路徑和技術名詞維持英文。`.claude/settings.json` 掛的 `scripts/claude-hook-language.mjs` 在 `Stop`、`PostToolUse`、`PostToolUseFailure` 檢查，英文為主時 exit 2 要求改用繁體中文重新說明。
