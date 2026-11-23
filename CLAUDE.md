## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (ron03wlb/ron-skills) via the gh CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root GLOSSARY.md plus docs/adr/. See `docs/agents/domain.md`.

### Checks and landing

`bin/check` takes longer than the foreground Bash limit: run it with `run_in_background`; `git commit` runs only its changed-path subset through pre-commit (`bin/check --changed`; `CHECK_FULL=1` for the full suite), so acceptance still needs the full `bin/check --upstream`.

Before committing a change to the `SKILL.md` or `ADAPTER.md` of `issue-run`, `issue-pilot`, `retro-collect`, or `setup-workflow`, compare it with `docs/workflow/`, then run `node scripts/build-workflow-site.mjs` and `node scripts/check-workflow-sync.mjs --restamp` (seconds); otherwise pre-commit fails late with `WORKFLOW_SYNC_STALE` (README.md, spay2 retro a78b57aa#1).

Land a manual branch with `node scripts/land.mjs <branch> --title … --body-file …`.

### Other Repos

Cross-repo work started here (upstream upgrades, `/retro-collect`, comparing divergence across projects) finds the other repos below (ADR 0004). Each line: 名稱（用途）：預設路徑。不在就從 <remote> clone；改之前先讀它的 adapter。

- spay2（consumer，GitLab）：`~/code/spay2`。不在就從 `http://192.168.200.202/spay/spay2.git` clone；改之前先讀它的 adapter。
- investing（consumer）：只在 macOS，`~/Documents/Workspace/personal-wiki/investing`。remote 待使用者補；改之前先讀它的 adapter。
- personal-life（consumer，Obsidian vault）：只在 WSL，`/mnt/c/Users/ron.chang/personal-wiki/personal-life`。不在就從 `https://github.com/ron03wlb/personal-life.git` clone；改之前先讀它的 adapter。
- pstack（上游，唯讀）：`~/code/pstack`。不在就從 `backnotprop/pstack` clone；改之前先讀它的 adapter。
- Matt skills fork（上游，唯讀，fork 自 `mattpocock/skills`）：`~/code/skills`。不在就從 `ron03wlb/skills` clone；改之前先讀它的 adapter。

### Language

使用者可以看到的訊息一律用繁體中文（工具呼叫之間的一行進度也算），程式碼、路徑和技術名詞維持英文。`.claude/settings.json` 掛的 `scripts/claude-hook-language.mjs` 在 `Stop`、`PostToolUse`、`PostToolUseFailure` 檢查，英文為主時 exit 2 要求改用繁體中文重新說明。
