# Pilot：ron-skills

給使用者層級的 `/issue-pilot` coordinator 用的專案設定（`/loop /issue-pilot`）。[issue-run.md](issue-run.md) 各段在 pilot 底下照樣適用，這裡只寫 pilot 不同的地方。本 repo 的 pilot 腳本有 Pool 與 Dispatch 認領的 `scripts/issue-pool.mjs`、Bare guard 的 `scripts/pilot-unbare.sh`、Probe 的 `scripts/pilot-probe.mjs`、Dispatch 的 `scripts/pilot-dispatch.mjs`（兩支都是 setup-workflow 正本的副本，Bare guard 用同目錄的 `pilot-unbare.sh`）和 Handoff 的 `scripts/pilot-handoff.mjs`（後兩者要 `ORCA_CLI_COMMAND`，Probe 讀 worker 時也要），Stage、Regression、Integrate 的 `scripts/pilot-land.mjs`（setup-workflow 正本的副本；本 repo 的條目解法與流程站戳記在專屬的 `scripts/pilot-resolve.mjs`，指令以 `--resolver` 帶入，#245），Close 的 `scripts/pilot-close.mjs`（setup-workflow 正本的副本，tracker 專案以 `--repo` 帶入；它再呼叫 `scripts/pilot-counterpart.mjs`，Orca 指令同樣要 `ORCA_CLI_COMMAND`；本 repo 的留言、關單由它交給 `scripts/gh-tracker.mjs`），以及寫存檔的 `scripts/pilot-register.mjs`、`pilot-decision.mjs`、`pilot-request.mjs`、`pilot-hold.mjs`、`pilot-sources.mjs`、`pilot-gate.mjs`，Stage 搬移、暫緩成員的 `scripts/pilot-batch.mjs`，與 Push gate 產生 PR body 的 `scripts/pilot-pr-body.mjs`（都是 setup-workflow 正本的副本，指令與結果行見 [PILOT-STORE.md](../../skills/engineering/issue-pilot/PILOT-STORE.md#canonical-scripts)）；watch 由 coordinator 依下列指令手動做，`status.md` 由 Probe 的 `--status` 重產，沒列出的指令就是沒有。`.scratch/pilot/` 每個檔案（含 batch checkpoint）的路徑、格式與合法值都照 [PILOT-STORE.md](../../skills/engineering/issue-pilot/PILOT-STORE.md)，這裡只寫本 repo 的值。

本檔是必讀核心（14000 bytes 以內，`scripts/adapter-size-budget.json`），只留每輪都要先知道的條目；每輪步驟的整條放在 [pilot-round.md](pilot-round.md)，到那一步才用 `node scripts/adapter-line.mjs '<條目名>'` 取（#344）；只在某些情況才用到的條目放在 [pilot-after-merge.md](pilot-after-merge.md)、[pilot-conflict.md](pilot-conflict.md)、[pilot-exceptions.md](pilot-exceptions.md) 與 [pilot-retro-collect.md](pilot-retro-collect.md)，本檔的同名條目是一行 pointer，寫明什麼情況要讀哪份檔；沒遇到那個情況就不讀（#166：整份 63 KB 每任 coordinator 都重付，多數條目一任都用不到）。

- **Coordinator checkout.** 下文的 `<主 checkout>` 是 coordinator 所在 repo 的主 checkout，依機器不同（WSL、macOS 的路徑都不一樣），不寫死：coordinator 在主 checkout 時是 `git rev-parse --show-toplevel`；session 開在 linked worktree 時是 `git rev-parse --path-format=absolute --git-common-dir` 的上一層（兩種情況都可以用後者）。執行時代入實際的絕對路徑。`.scratch/pilot/` 放在主 checkout，不 commit。Orca 指令一律寫成 `"$ORCA_CLI_COMMAND"`（每台機器設成自己的 Orca CLI：WSL 是 PATH 上的指令名，macOS 是 Orca.app 內 `orca` 的絕對路徑）；沒有這個環境變數就回報人，不猜指令名。

- **Bare guard.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Probe、Dispatch、Stage、Close 的腳本都自己跑它（還原時印 `UNBARE`）；腳本 exit 非 0、或主 checkout 還沒有 `scripts/pilot-unbare.sh` 時才讀。

- **Permissions.** 見 [pilot-exceptions.md](pilot-exceptions.md)：coordinator 腳本被 auto mode 擋下，或要加新的 coordinator 腳本時才讀。

- **Sessions.** 見 [pilot-round.md](pilot-round.md)：Entry 註冊 coordinator，與每輪 Reconcile 開頭、跑 Probe 之前的 session 檢查時讀；整條用 `node scripts/adapter-line.mjs 'Sessions'` 取。

- **Sources.** 見 [pilot-round.md](pilot-round.md)：Reconcile 判斷來源是否改變，或 adapter 新增、拆出 coordinator 要讀的檔時讀；整條用 `node scripts/adapter-line.mjs 'Sources'` 取。

- **Decisions.** `decisions.md` 只用 `node scripts/pilot-decision.mjs <主 checkout> --decision <決定> --reason <理由> --evidence <證據> --result <結果>` 附加，不手寫表格列；欄位不能有 `|`。Probe 或任何讀取發現表格散掉（`pilot-unbare.sh` 在檔案不存在時只附加列）時跑 `node scripts/pilot-decision.mjs <主 checkout> --repair`，`MALFORMED` 的行回報人。

- **Requests.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Probe 印 `REQUEST` 時讀。

- **Gates.** 見 [pilot-exceptions.md](pilot-exceptions.md)：要開或解 gate（Probe 印 `GATE`、`GATE_MALFORMED`，或任何條目寫「變成 gate」）時讀。

- **Defaults for `preferences.md`.** 見 [pilot-round.md](pilot-round.md)：第一輪 seed `preferences.md`，或查 worker 上限、批次大小與誰 push 時讀；整條用 `node scripts/adapter-line.mjs 'Defaults for'` 取（名稱含反引號，前綴唯一）。

- **Integration branch.** 本機 `pilot/integration`，第一次用時從 `main` 開（`git branch pilot/integration main`）。push、開 PR、合進 `main` 和之後跟上 `origin/main` 都見 Push gate。要讓它跟上 `origin/main` 時（例如 retro 分支直接落地進 `main` 之後、下一次 Stage 之前）在主 checkout 跑 `node scripts/pilot-land.mjs sync-main --check-command 'bin/check --upstream' --resolver scripts/pilot-resolve.mjs`（見 Push gate 第 3 步，入口自己轉到 stage worktree 的版本，不必算路徑）：切分支與快轉都在 `<stage worktree>` 做，主 checkout 不切分支，也不再手打 `merge --ff-only`。

- **Stage worktree.** 下文的 `<stage worktree>` 是 `git -C <主 checkout> worktree list --porcelain` 裡分支（`branch refs/heads/…` 行）為 `pilot/integration` 或 `pilot/stage-*` 的那個 worktree，取它的 `worktree ` 行的路徑；找不到就是還沒建，照 Stage 用 Orca 建好後再找一次。Stage、Regression、Integrate 全在這裡做，`pilot/integration` 也只在這裡前進。主 checkout 一直停在 `main`，coordinator 在主 checkout 只做 fetch、讀狀態、快轉 `main`（`git -C <主 checkout> merge --ff-only origin/main`）：在主 checkout 切到還沒合入的分支，工作樹會帶出那個分支的 `.claude/settings.json`，在主 checkout 跑的 session 會即時載入它的 hook（#21）。

- **Scripts ahead.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Probe 印 `SCRIPT_AHEAD`，或印 `ADAPTER_AHEAD` 那一輪要跑整合分支才有的腳本時讀。

- **Pool.** 見 [pilot-round.md](pilot-round.md)：Pick 選下一批（列池子、挑成員、細化 `needs-triage`）時讀；整條用 `node scripts/adapter-line.mjs 'Pool'` 取。

- **Triage.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Pool 有 `needs-triage` 單要補齊（含 Probe 印 `POOL_TRIAGE`）、`issue-pool.mjs` 印 `NO_CATEGORY`，或挑到的單本文寫的依賴在本文之後才關閉時讀。

- **Shared registry.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Pool 的 ready 行有同一個 `parent #<p>`、都要改 `workflow-templates.json`、Templates 表、`PILOT-STORE.md` 的 Canonical scripts 表或 `setup-workflow/SKILL.md` 時讀。

- **Batch.** 批次 checkpoint 是 `.scratch/pilot/batch-<key>.md`，由 Dispatch 建立；請求分支的 `batch-req-<行號>.md` 由 `pilot-land.mjs --branch` 建立（見 Requests）。各 Issue 自己的 checkpoint 仍在 `.scratch/issue-run-<n>/state.md`（在它的 worktree 裡）。

- **Brief check.** worker 的 brief 就是 `/issue-run <n> --worker <checkpoint>` 加上 Issue 本文，不跑這條。tooling fix unit 的 brief：先用 `node scripts/brief-check.mjs --skeleton` 印出帶標籤的骨架（`目標：`、`範圍：`、`驗收：`、`驗證：`、`TIMEBOX：<n> 分鐘`、`禁止：`、`回報：`、`Standing orders：` 已填主 checkout 的 `preferences.md`），寫進 `.scratch/pilot/briefs/<檔>` 填好內容，再跑 `node scripts/brief-check.mjs <brief> [--batch <key>] [--iid <n>]`：印 `BRIEF_OK <brief>`（exit 0）才派；`BRIEF_REJECTED … missing=<欄位,…>`（exit 1）時補 brief 再跑，不改 worker 的 prompt（#346）。

- **Dispatch.** 見 [pilot-round.md](pilot-round.md)：Dispatch 認領、開 worktree 與派 worker 時讀；整條用 `node scripts/adapter-line.mjs 'Dispatch'` 取。

- **Dispatch steps.** 見 [pilot-exceptions.md](pilot-exceptions.md)：要查 `pilot-dispatch.mjs` 對每個成員依序做什麼（認領檢查、建 worktree、Bare guard、開分頁、送出 `/issue-run <n> --worker <主 checkout>/.scratch/pilot/batch-<key>.md`）與 `STOP <n> not-claimed`、`worktree-branch` 的成因時讀。

- **Dispatch stops.** 見 [pilot-exceptions.md](pilot-exceptions.md)：`pilot-dispatch.mjs` 印成員的 `STOP <n> …`、`STOP orca-unavailable`，或 `STOP capacity` 後 stderr 印 `WARN release` 時讀。

- **Fresh redispatch.** 見 [pilot-conflict.md](pilot-conflict.md)：Stage 判定同一條目衝突、Probe 印 `WORKER <n> STOP findings after two review cycles`、Probe 印 `UNBLOCKED <key> <n>` 而那個成員是停下等 blocker，或 Regression 失敗只歸因於某個成員時讀。

- **Scope supplement.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Dispatch 之後要給 worker 補範圍時讀。

- **Watch.** worker 在跑時以 `run_in_background` 起 `node scripts/pilot-watch.mjs --batch <key>`（每批一個）：啟動前的結果行不算，新的 `DONE <n> <sha>`／`STOP <n> <cause>` 印 `RESULT <key> <handle> <行>`，terminal 結束而無新結果印 `EXITED <key> <handle>`（卡住），即結束；接著跑 Probe（`--apply`），還有 running 就再起。解析與 Probe 的 `WORKER` 共用，不另寫（#325、#355）。看畫面：`node scripts/pilot-probe.mjs --tail <handle>`。stuck-after 預設 90 分鐘，仍以 1200 秒排下次喚醒。

- **Idle wait.** 見 [pilot-round.md](pilot-round.md)：閒置次數達到 issue-pilot SKILL 的 Report and sleep 門檻時讀；整條用 `node scripts/adapter-line.mjs 'Idle wait'` 取。

- **Agent rows.** 記在 batch checkpoint 的成員行（見 Batch）；worker 自己開的 subagent 不另外記。

- **Probe.** 見 [pilot-round.md](pilot-round.md)：每輪 Reconcile 跑 Probe 前讀（Entry 時取一次，之後條目沒改就不必重取）；整條用 `node scripts/adapter-line.mjs 'Probe'` 取。

- **Probe lines.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Probe 印了 Probe 條目沒處理的行（如 `OVERLAP`、`MOVE`、`PARKED`、`UNPARK`、`UNBLOCKED`、`ADAPTER_AHEAD`、`SCRIPT_AHEAD`、`HOOK_BEHIND`、`BLOCKER_OPEN_SCOPE`、`SCOPE_CHANGED`、`DEPS_PROSE`、`RESTAGE`、`REGRESSING`、`PUSH_PARKED`）時讀。

- **Hold flag.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Probe 印 `HOLD`，或要設、清、看 hold 時讀。

- **Stage.** 見 [pilot-round.md](pilot-round.md)：批次成員都 DONE 或 STOP、要 Stage、Regression、Integrate 時讀；整條用 `node scripts/adapter-line.mjs 'Stage'` 取。

- **Stage conflict.** 見 [pilot-conflict.md](pilot-conflict.md)：`pilot-land.mjs` 印 `RESOLVED` 或 `STOP conflict` 時讀。

- **Regression.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Stage 的 `pilot-land.mjs` 印 `STOP regression <exit>`，或要讀 `regression:` 行與 `reg-<key>.log` 時讀。

- **Integrate.** 見 [pilot-exceptions.md](pilot-exceptions.md)：Stage 的 `pilot-land.mjs` 印 `STOP hold`、`STOP drift`、`STOP checkpoint …` 或 `RESUME <key> <sha>` 時讀；通過時印 `MERGED <key> <sha>`，接 Push gate。

- **Push gate.** 見 [pilot-after-merge.md](pilot-after-merge.md)：Stage 印 `MERGED`，或 Probe 印 `RESUME_PUSH`、`NOT_IN_MAIN` 時讀。

- **Counterpart.** 見 [pilot-after-merge.md](pilot-after-merge.md)：跑 Close 之前，成員本文有跨 repo 對應單（`pilot-counterpart.mjs` 有輸出）時讀。

- **Close.** 見 [pilot-after-merge.md](pilot-after-merge.md)：Push gate 印 `LANDED`，或 Probe 印 `IN_MAIN` 時讀。

- **Handoff.** 見 [pilot-after-merge.md](pilot-after-merge.md)：Defaults 的 handoff 條件達到（合入 2 批或 compaction）時讀。

- **Project tick hooks.** 預設：沒有。

- **Memory audit.** `Memory audit days: 7`。Probe 印 `MEMORY_AUDIT_DUE` 時，當輪在主 checkout 跑它箭頭後的指令，處理照 issue-pilot 的 PILOT-STORE.md `memory-audit.md` 段（#347）。

- **Retro collect.** 見 [pilot-retro-collect.md](pilot-retro-collect.md)：`/retro-collect` 讀那裡的同名條目；`/retro` 只看這一條在不在，決定要不要進收集模式。
