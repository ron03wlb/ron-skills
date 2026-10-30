# issue-run adapter：ron-skills

沒寫到的段落都沿用 [ADAPTER.md](../../skills/engineering/issue-run/ADAPTER.md) 的預設值。

## Tracker

[issue-tracker.md](issue-tracker.md)。讀 Issue 一律用 `--json`：`gh issue view <n> --comments` 在非 tty 環境不會輸出任何東西。

## Readiness

就緒狀態是 `ready-for-agent` label（[triage-labels.md](triage-labels.md)）。沒有 preflight。還沒就緒時用 `/triage <n>` 補齊。

## Worktrees and checkpoint

從 `main` 開 `issue/<n>-<slug>` 分支。只有一張 ticket 時直接在主 checkout 做；多張 ticket 依 implement-spec 開 worktree（設了 `ORCA_CLI_COMMAND` 時透過 Orca 開）。checkpoint 放在 `.scratch/issue-run-<n>/state.md`，不 commit。

## Checks

只有一條：`bin/check`。開發中和寫 brief、驗收條件時都只引用這條，不要自己拼 `node --test …`。單一測試檔可以用 `node --test tests/<name>.test.mjs`。行為不變的重構，以同一條 `bin/check` 在 base 上為綠當作 baseline。

## Review

Skill `code-review`，比對基準是分支的 merge-base。不阻擋的 findings 列在 Issue 的證據留言。所有 `SKILL.md`、`ADAPTER.md` 和 `overlays/*.patch` 都會改變 agent 的行為，不算只改文字。

## Candidate and acceptance

candidate 是分支 tip。acceptance 是在 candidate SHA、工作樹乾淨時跑 `bin/check --upstream`：本機 `~/code/skills` 是會落後上游的 fork，只跑本機版本看不到 overlay 漂移。

## Evidence and closing

證據貼成 Issue 留言（candidate SHA、指令與 exit code、findings）。人負責 push 和合併 PR；candidate 進到 `origin/main` 之後才關閉 Issue，然後把本機和 `origin` 上的工作分支刪掉。
