# issue-run adapter：ron-skills

沒寫到的段落都沿用 [ADAPTER.md](../../skills/engineering/issue-run/ADAPTER.md) 的預設值。

## Tracker

[issue-tracker.md](issue-tracker.md)。讀 Issue 一律用 `--json`：`gh issue view <n> --comments` 在非 tty 環境不會輸出任何東西。

## Readiness

就緒狀態是 `ready-for-agent` label（[triage-labels.md](triage-labels.md)）。沒有 preflight。還沒就緒時用 `/triage <n>` 補齊。

## Worktrees and checkpoint

從 `main` 開 `issue/<n>-<slug>` 分支，一張 ticket 也開 worktree：主 checkout 有 `scripts/claude-hook-main-checkout.mjs` 擋寫入（#30）。設了 `ORCA_CLI_COMMAND` 時用 `node scripts/orca-worktree-create.mjs --name issue-<n> --base-branch main --branch issue/<n>-<slug>` 開（看最後一行 JSON 的 `path`），沒有 Orca 時用 `git worktree add`；多張 ticket 依 implement-spec 各開一個。checkpoint 放在 `.scratch/issue-run-<n>/state.md`，不 commit。

## Checks

只有一條：`bin/check`。開發中和寫 brief、驗收條件時都只引用這條，不要自己拼 `node --test …`。單一測試檔可以用 `node --test tests/<name>.test.mjs`。行為不變的重構，以同一條 `bin/check` 在 base 上為綠當作 baseline。

## Review

Skill `code-review`，比對基準是分支的 merge-base。不阻擋的 findings 列在 Issue 的證據留言。所有 `SKILL.md`、`ADAPTER.md` 和 `overlays/*.patch` 都會改變 agent 的行為，不算只改文字。

## Candidate and acceptance

candidate 是分支 tip。acceptance 是在 candidate SHA、工作樹乾淨時跑 `bin/check --upstream`：本機 `~/code/skills` 是會落後上游的 fork，只跑本機版本看不到 overlay 漂移。

## Evidence and closing

證據貼成 Issue 留言（candidate SHA、指令與 exit code、findings）。

單獨跑的 `/issue-run` 在 acceptance 通過、證據貼好之後自己落地，不等人：把 PR body（`/pr` 格式，每張 Issue 一行 `Closes #<n>`）寫進 scratchpad，用 Bash `timeout: 600000` 跑 `node scripts/land.mjs <candidate 所在分支> --title '<標題>' --body-file <檔>`。它 push、開 PR、等 CI、以 merge commit 合併，再移除該分支的 worktree、刪本機與 `origin` 分支、讓主 checkout 的 `main` 跟上；多張 ticket 時，各 ticket 的 worktree 與分支在 `LANDED` 之後另外移除。最後一行是 `LANDED <pr> <merge sha>` 時，對每張 Issue 留言 PR 與 merge SHA，還開著的再關閉；`STOP checks-timeout` 重跑同一條指令，其他 `STOP <原因>`（如 `ci-failed`、`merge`）停下回報人，不硬合。

pilot 底下的 worker 不落地：push、開 PR、合併與關單都由 coordinator 照 [pilot.md](pilot.md) 的 Push gate 與 Close 做。

## Pilot

給 `/issue-pilot` coordinator 的設定整份在 [pilot.md](pilot.md)，條目之間空一行，讓改不同條目的修改落在不同的 hunk（#45）；比對整合分支上的 adapter 時，`docs/agents/pilot.md` 也要一起比。
