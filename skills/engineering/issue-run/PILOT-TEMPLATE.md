<!--
Skeleton for a repo's docs/agents/pilot.md when /setup-workflow installs the resident pilot (#281).
Copy it to docs/agents/pilot.md, replace every {{placeholder}}, drop the bracketed [optional: …] sentences that do not apply, and delete this comment.
  {{repo}}            repo name, also the --capacity key: the main checkout's directory name, which pilot-dispatch reports under (e.g. mec-wiki)
  {{owner/repo}}      the Tracker section's GitHub project (e.g. ron03wlb/mec-wiki)
  {{main}}            the default branch, as origin/HEAD names it (main, master, …)
  {{check}}           the single check entry (e.g. bin/check)
  {{worker cap}}      workers from this repo at once (2 is a safe start)
  {{batch size}}      Issues per batch (2 is a safe start)
  {{timeout cmd}}     how a triage subagent bounds a command that may hang on every platform this repo supports (e.g. Bash tool `timeout: 600000`, since macOS has no `timeout`)
  {{tracker write}}   the command the adapter's Tracker section uses for comments and labels (e.g. `node scripts/gh-tracker.mjs`)
  {{triage traps}}    one sentence per repo-specific trap a triage subagent hit before (write guards, read flags, readiness rules), or delete the line
Placeholders in <angle brackets> (<main checkout>, <key>, <n>, <handle>, …) stay as they are: the coordinator substitutes them at run time.
The filled-in file is a required core of at most 14000 bytes (scripts/adapter-size-budget.json, checked by check-adapter-size.mjs): the longest step entries (Pool, Dispatch, Probe) are already in PILOT-ROUND-TEMPLATE.md, copied to docs/agents/pilot-round.md, with one-line pointers here; when the filled-in file still outgrows that, move more whole entries there the same way.
The script commands and result lines are in ~/.claude/skills/issue-pilot/PILOT-STORE.md; every script named here is a setup-workflow template copy in scripts/.
-->
# Pilot: {{repo}}

Project settings for the user-level `/issue-pilot` coordinator (`/loop /issue-pilot`). Every section of `docs/agents/issue-run.md` still applies under the pilot; this file holds only what differs. Every file under `.scratch/pilot/` (batch checkpoints included) follows the `issue-pilot` skill's `PILOT-STORE.md` (`~/.claude/skills/issue-pilot/PILOT-STORE.md`), which also lists each script's commands and result lines; only this repo's values are written here. Every script named below is a setup-workflow template copy in `scripts/`.

- **Coordinator checkout.** `<main checkout>` below is this repo's main checkout: the parent of `git rev-parse --path-format=absolute --git-common-dir` (the same answer from any worktree). Substitute the absolute path when running. `.scratch/pilot/` lives there and is gitignored. Orca commands are written `"$ORCA_CLI_COMMAND"`; without that variable, report to the human instead of guessing a command name.

- **Bare guard.** `scripts/pilot-unbare.sh <main checkout> <when>` restores `core.bare` if an Orca worktree operation set it. Probe, Dispatch, Stage and Close run it themselves (printing `UNBARE <checkout>` when it fixed something); run it by hand only when one of them exits non-zero. Outside WSL it normally prints nothing.

- **Sessions.** On becoming coordinator, and at the start of every Reconcile before the Probe, run in the main checkout `node scripts/pilot-register.mjs <main checkout> --name <session name from ListAgents> --loop yes|no --sources-file docs/agents/pilot-sources.txt --main {{main}}` (pid and session default to `$CLAUDE_PID`, `$CLAUDE_CODE_SESSION_ID`). Each `ADAPTER_FILE <saved path> <path>` line is an adapter file whose adapter ref copy is newer than `{{main}}`, already fetched and saved: read `<saved path>` in place of `<path>` (#467). `STOP retired` means this session already handed off: do nothing else. Treat its `SOURCE_CHANGED` and `SOURCE_MISSING` lines per Sources.

- **Sources.** The list is `docs/agents/pilot-sources.txt`, one path per line. Reread each file the Sessions command prints as `SOURCE_CHANGED` (only the entries or headings listed under it, when it lists any) or `SOURCE_MISSING`. When this adapter starts pointing at another file the coordinator must read, add it to the list in the same commit.

- **Decisions, requests, hold.** Append to `decisions.md` only with `node scripts/pilot-decision.mjs <main checkout> --decision <text> --reason <text> --evidence <text> --result <text>` (no `|` in a field; `--repair` when the table looks broken). List and mark requests with `node scripts/pilot-request.mjs <main checkout> list`, `apply <line no> [--note <text>]`, `decline <line no> --reason <text>`. Set, clear and show the hold with `node scripts/pilot-hold.mjs <main checkout> set <reason>`, `clear`, `show`.

- **Gates.** Open with `node scripts/pilot-gate.mjs <main checkout> open --title <text> --issue <#n or -> --question <text> --options <text> --default <text> --parked <text> [--hold <n>] [--script <file>]` (see below for `--script`; add `--hold <n>` when the gate holds back batch member #n, so the probe prints `HELD <n> G<k>` instead of `STAGEABLE` and `pilot-land.mjs` stops with `STOP held <n> G<k>` until the gate is resolved; `STOP operator-questions <n>`: gate its `[confirm]` lines, #406), resolve with `resolve G<n> --how <text>`, list with `list`. A gate is how every product question reaches the human. When the human must run commands, write the steps to a file and add `--script <file>`: the gate keeps a rerunnable `.scratch/pilot/gates/G<n>.sh` that survives a handoff, and `open` appends ` 執行：! bash <that path>` to the question, to run from the main checkout, since `G<n>` is unknown before it runs. Start each step with `step <label>`; write a read-only query as `x="$(<command>)" || true` then check its output, so a query that exits non-zero does not end the script; and have a step that changes state check that state first and skip when it is already done, since a rerun after a failure starts from the top.

- **Defaults for `preferences.md`.** At most {{worker cap}} workers from this repo at once (Dispatch's `--repo-cap`), and the machine-wide total stays within `$PILOT_MACHINE_WORKER_CAP`, shared with other repos' coordinators through the ledger the Probe's `--capacity {{repo}}` writes and Dispatch's `--capacity` checks and raises by the members it dispatched. At most {{batch size}} Issues per batch. Only the coordinator merges into a batch and the integration branch. Push, the PR and the merge into `{{main}}` are the human's (Push gate). Hand off on the Probe's `HANDOFF_DUE` (2 merged batches this session dispatched, not a predecessor's, or `context=<tokens>` at Handoff context: 200000) or after a compaction.

- **Integration branch.** Local `pilot/integration`, made from `{{main}}` by `/setup-workflow`. It moves only in the stage worktree. To make it contain `origin/{{main}}` (after a branch landed straight into `{{main}}`, or on `land.mjs`'s `STOP behind-main`), run `node scripts/pilot-land.mjs sync-main --main {{main}} --check-command '{{check}}'` in the main checkout with Bash `run_in_background` and await its notice: it fast-forwards when it can, otherwise merges `origin/{{main}}` on `pilot/stage-sync-main` and runs the regression first.

[optional: - **Adapter ref.** `origin/pilot/integration`: another machine pushes the integration branch, so the coordinator and `pilot-probe` read this adapter from that ref, fetched first.]

- **Stage worktree.** `<stage worktree>` is the worktree in `git -C <main checkout> worktree list --porcelain` whose branch is `pilot/integration` or `pilot/stage-*`. `pilot-land.mjs` creates it through Orca (`pilot-stage`) when there is none. The main checkout stays on `{{main}}`: the coordinator only fetches, reads state, and fast-forwards `{{main}}` there.

- **Pool.** See `docs/agents/pilot-round.md`: read at Pick, when choosing the next batch; fetch only this entry with `node scripts/adapter-line.mjs 'Pool'`.

- **Triage brief.** See `docs/agents/pilot-round.md`: read at Pick, before a subagent refines a `needs-triage` Issue; fetch only this entry with `node scripts/adapter-line.mjs 'Triage brief'`.

- **Batch.** The batch checkpoint is `.scratch/pilot/batch-<key>.md`, created by Dispatch; each Issue's own checkpoint stays in its worktree. Move or park members before staging with `node scripts/pilot-batch.mjs <main checkout> move <key> <n> [--state stop]`, `park <key> <n> --after <m> [--fresh] --reason <text>`, `unpark <n>`, as the Probe's `MOVE` and `UNPARK` lines say (`--fresh` for a member to redispatch fresh once `#m` lands, which the Probe reports as `UNPARK_FRESH`; `park <n> <n>` on a parked member rewrites its `--after` in place). Send a `stop`/`done` worker back to work with `resume <key> <n> --note <text>`, not `terminal send` plus a row edit; adopt its reported candidate with `accept <key> <n> <sha>`.

- **Brief check.** See `docs/agents/pilot-round.md`: read at Dispatch, before dispatching a tooling fix unit; fetch only this entry with `node scripts/adapter-line.mjs 'Brief check'`.

- **Dispatch.** See `docs/agents/pilot-round.md`: read at Dispatch, when claiming members, opening worktrees and starting workers; fetch only this entry with `node scripts/adapter-line.mjs 'Dispatch'`.

- **Watch.** While workers run, start `node scripts/pilot-watch.mjs --batch <key>` in the background (one `--batch` per open batch; all are watched): a `DONE <n> <sha>` or `STOP <n> <cause>` from a running member prints `RESULT <key> <handle> <line>`, an exited terminal with no new one prints `EXITED <key> <handle>` (stuck), and it exits, waking the coordinator to run the Probe and start it again while members still run. It judges results as the Probe's `WORKER` does (indented lines, TUI prompt rows, backslashes in the screen JSON); do not write your own watcher. To read a worker's screen: `node scripts/pilot-probe.mjs --tail <handle>` (the last 40 lines; `--lines <n>` changes it). Stuck-after is the default 90 minutes; the watcher does not judge it, so still schedule the next wakeup.

- **Idle wait.** Nothing in flight and the idle streak at the `issue-pilot` Report and sleep threshold: start `node scripts/pilot-idle-wait.mjs <main checkout> --main {{main}}` in the background instead of a `ScheduleWakeup`. It reads the probe (read-only), `.scratch/pilot/gates.md`, and `pilot/integration`'s HEAD every 300 seconds and exits on the first change (`WAKE probe <new line>`, `WAKE gates …`, `WAKE integration <old> <new>`) or after 3600 seconds (`IDLE_TIMEOUT`); either exit is the next wake. `ERROR probe …` (exit 1, three failed probe rounds in a row): schedule 1800 seconds and report the line.

- **Agent rows.** The member rows of the batch checkpoint; subagents a worker spawns are not recorded.

- **Probe.** See `docs/agents/pilot-round.md`: read at each Reconcile, before running the probe (fetch it once per session; again only when Sources reports the file changed); fetch only this entry with `node scripts/adapter-line.mjs 'Probe'`.

- **Hold flag.** `pilot-land.mjs` checks `.scratch/pilot/hold` right before Integrate and prints `STOP hold`.

- **Stage, regression, integrate.** See `docs/agents/pilot-round.md`: read when every batch member is `DONE` or `STOP` and the batch is to land; fetch only this entry with `node scripts/adapter-line.mjs 'Stage, regression, integrate'`.

- **Push gate.** Once `pilot/integration`'s tip is the last SHA that passed regression: run `node scripts/pilot-pr-body.mjs <main checkout> --out .scratch/pilot/pr-body.md` from the main checkout (it hands over to the stage worktree's copy, the content being pushed, so there is no path to work out) and continue only on `PR_BODY …`. Then hand the human, as a gate, the command `! node scripts/land.mjs pilot/integration --keep-branch --main {{main}} --check-command '{{check}}' --title '<batch keys and title>' --body-file .scratch/pilot/pr-body.md`, run in the main checkout. Do not run `land.mjs` yourself. When the human reports `LANDED <pr> <merge sha>`, rerun the Sessions command and go to Close; on `STOP behind-main` run the Integration branch's `sync-main` and start the Push gate again; any other `STOP` stays with the human.

- **Close.** Once the merge is on `origin/{{main}}`, run in the main checkout `node scripts/pilot-close.mjs <key> <pr> <merge sha> --repo {{owner/repo}}`. It posts the evidence comment, closes each `done` member, closes its terminal, removes its worktree and local and remote branch, and closes a parent whose sub-issues are all done, skipping steps already done, so it can be rerun; the last line is `CLOSED <key>`. When fast-forwarding the main checkout would remove a tracked file under a path the `Protected paths:` line of `docs/agents/issue-run.md` declares, it prints `STOP <key> main` and changes nothing: hand the listed files to the human, and rerun once they are moved aside. It is not in the allow list: when the permission prompt or auto mode blocks it, hand the same command to the human.

- **Handoff.** Per issue-pilot SKILL Handoff: background tasks never defer it; defer one tick at most. Record the reason and running tasks with Decisions, stop waiters, and run in the main checkout with Bash `timeout: 600000` `node scripts/pilot-handoff.mjs --session "$CLAUDE_CODE_SESSION_ID" --pid "$CLAUDE_PID" --reason <reason>` (no `--held-check`: add one only when the repo has an "integration merge in progress" check). Only `HANDED_OFF <handle> [name <name>]` completes it (`name` is the new coordinator's session name for SendMessage, absent when its coordinator line has none); on `STOP <reason>` keep coordinating.

- **Project tick hooks.** None.

- **Retro collect.** None: `/retro` implements its own adopted items in this repo.

- **Retro trigger.** None: the human types `/retro-collect`. [optional: `docs/agents/pilot-round.md`'s entry.]
