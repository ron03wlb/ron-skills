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

## Pilot

給使用者層級的 `/issue-pilot` coordinator 用的專案設定（`/loop /issue-pilot`）。上面各段在 pilot 底下照樣適用，這裡只寫 pilot 不同的地方。本 repo 的 pilot 腳本只有 `scripts/orca-session-send.mjs`（Dispatch）和 `scripts/pilot-handoff.mjs`（Handoff），兩者都要 `ORCA_CLI_COMMAND`；probe、watch、status 都由 coordinator 依下列指令手動做，沒列出的指令就是沒有。

- **Coordinator checkout.** 主 checkout `/home/ron/code/ron-skills`，`.scratch/pilot/` 放在這裡，不 commit。
- **Sessions.** 預設：coordinator 自己在 `.scratch/pilot/sessions.md` 追加一行（ISO 時間、`$CLAUDE_CODE_SESSION_ID`、session 名稱）。
- **Defaults for `preferences.md`.** 不限同時跑的 worker 數；每批最多 2 個 Issue；worker 指令見 Dispatch；只有 coordinator 合進 batch 與整合分支；push 一律由人做（coordinator 不 push）；每個 session 合入 2 批或遇到 compaction 就 handoff。
- **Integration branch.** 本機 `pilot/integration`，第一次用時從 `main` 開（`git branch pilot/integration main`）。人 push 它、開 PR、合進 `main`；合進 `origin/main` 之後，coordinator 用 `git merge --ff-only origin/main` 讓它跟上。
- **Pool.** `gh issue list --state open --label ready-for-agent --json number,title,labels`，再用 `gh api repos/ron03wlb/ron-skills/issues/<n> --jq .issue_dependencies_summary.blocked_by` 濾掉 `blocked_by > 0` 的 Issue，以及已經在某個開著的 batch checkpoint 裡的 Issue；號碼小的先挑。`needs-triage` 的先照 [Readiness](#readiness) 用 `/triage <n>` 補齊，補完變成 `ready-for-agent` 才挑。
- **Batch.** key 是成員號碼用 `-` 連起來（如 `8-12`）。checkpoint 在 `.scratch/pilot/batch-<key>.md`，每個成員一行：Issue、branch、worktree、terminal handle、開始時間、stuck-after、state（`running`／`done`／`stop`）、candidate SHA；另一行 `current:` 記 batch 狀態（`dispatched`／`staged <sha>`／`merged <sha>`／`pushed`／`closed`）。各 Issue 自己的 checkpoint 仍在 `.scratch/issue-run-<n>/state.md`（在它的 worktree 裡）。
- **Brief check.** 沒有指令。worker 的 brief 就是 `/issue-run <n> --worker <checkpoint>` 加上 Issue 本文；tooling fix unit 的 brief 由 coordinator 寫在 `.scratch/pilot/briefs/<name>.md`，派出去前自己核對 goal、scope、acceptance、verify、timebox、forbidden、report 和 `preferences.md` 路徑都在。
- **Dispatch.** 每個成員依序跑三步，都在主 checkout：
  1. `orca-ide worktree create --name issue-<n> --base-branch pilot/integration --branch issue/<n>-<slug> --issue <n> --json`。不要帶 `--repo`：Orca 會從 cwd 推斷 repo，帶 `--repo path:<WSL 路徑>` 會回 `repo_not_found`。也不要帶 `--agent`：一起帶時錯誤會被包成 `agent_session_operation_unknown`。
  2. `orca-ide terminal create --worktree path:<worktree> --title '#<n>' --command claude --json`，從回傳取 `result.terminal.handle`。
  3. `node scripts/orca-session-send.mjs --terminal <handle> --prompt "/issue-run <n> --worker /home/ron/code/ron-skills/.scratch/pilot/batch-<key>.md"`，最後一行是 `SENT <handle>` 才算送達，`STOP <原因>` 就是沒送到。不要用裸 `terminal send`：它會回 accepted，文字卻停在輸入框沒提交，重送又會黏成兩份。

  把 worktree 路徑和 handle 記進 batch checkpoint。
- **Watch.** `orca-ide terminal read --terminal <handle> --screen --json`：畫面最後一行是 `DONE <n> <sha>` 或 `STOP <n> <cause>` 就是做完了；`status: exited` 但沒有這行就是卡住。stuck-after 預設 90 分鐘，等累積了實際跑的時間再調。沒有背景 watcher 指令：worker 還在跑時，coordinator 每次被叫醒都 read 一次，以 1200 秒排下一次喚醒。
- **Agent rows.** 記在 batch checkpoint 的成員行（見 Batch）；worker 自己開的 subagent 不另外記。
- **Probe.** 沒有 probe 指令。Reconcile 時依序做：`git -C /home/ron/code/ron-skills status --short`（主 checkout 有改動就先回報人，不 merge）、讀 `requests.md` 和 `gates.md` 裡還開著的列、對每個 `running` 成員跑 Watch、`git fetch origin` 後檢查 `current: pushed` 的 batch 有沒有進到 `origin/main`。
- **Hold flag.** `.scratch/pilot/hold` 這個檔案存在就是 hold；`touch` 設定、`rm` 清除。Integrate 前一步要先檢查它，存在就不 merge。
- **Stage.** 在主 checkout 從 `pilot/integration` 開 `pilot/stage-<key>`，依號碼順序 `git merge --no-ff issue/<n>-<slug>` 合進每個 `done` 成員。只有兩邊都只是新增、不重疊的段落時，coordinator 才可以自己解衝突；其他衝突一律變成 gate。
- **Regression.** 在 staged SHA、工作樹乾淨時跑 `bin/check --upstream`，exit 0 才算過；只對那個 SHA 有效。結果（SHA、exit code、尾段輸出）記進 batch checkpoint。
- **Integrate.** 沒有 hold flag、而且 `pilot/integration` 從 stage 之後沒有新 commit，才在主 checkout 做 `git checkout pilot/integration && git merge --ff-only pilot/stage-<key>`；有新 commit 就重新 stage、重跑 Regression。合完刪掉 `pilot/stage-<key>`，`current:` 設成 `merged <sha>`，再切回 `main`。
- **Push gate.** `pilot/integration` 的 tip 等於最後一次 Regression 通過的 SHA。通過後把指令交給人：`git push -u origin pilot/integration`，然後開 PR 合進 `main`。push 完把 `current:` 設成 `pushed`。
- **Close.** batch 的 merge 進到 `origin/main` 之後，對每個成員照 [Evidence and closing](#evidence-and-closing) 處理：證據留言、`gh issue close <n>`、用 `orca-ide worktree rm --worktree branch:issue/<n>-<slug>` 移除 worktree（rm 之後在主 checkout 跑 `git rev-parse --is-bare-repository`，印出 `true` 就執行 `git config core.bare false`：Orca 從 WSL 移除 worktree 會把主 repo 設成 bare，之後的 stage、merge 全部失敗），並刪掉本機和 `origin` 上的 `issue/<n>-<slug>`；`current:` 設成 `closed`。
- **Handoff.** 條件達到時（見 Defaults），coordinator 先在 `decisions.md` 記一筆原因、停掉自己的背景工作，再在主 checkout 用 Bash `timeout: 600000` 跑 `node scripts/pilot-handoff.mjs --session "$CLAUDE_CODE_SESSION_ID" --pid "$CLAUDE_PID" --reason <原因>`（腳本 540 秒內必定結束：逾時印 `STOP timeout`，收到 SIGTERM、SIGINT 印 `STOP signal <名稱>`，都會先還原）。它確認 `coordinator` 的 pid 是自己後改寫成 handoff 行，新開分頁 `issue-pilot coordinator` 送出 `/loop /issue-pilot`，等新 session 寫入 `pid ` 行。最後一行 `HANDED_OFF <handle>` 才算交接完成，這時才在 `sessions.md` 追加 `<ISO 時間>   handoff from-session <本 session id> → terminal <handle>   reason <原因>`（`sessions.md` 有本 session 的 handoff 就代表已退役，提早記會讓 STOP 後的自己誤判退役）；`STOP <原因>` 時 `coordinator` 已還原、新開的分頁已關掉，照常繼續當 coordinator（`STOP not-coordinator` 表示已經有別的 coordinator，不要再交接）。
- **Project tick hooks.** 預設：沒有。
- **Retro collect.** 預設：沒有；`/retro-collect` 停下並說明原因。
