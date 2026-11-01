<!--
Skeleton for a repo's docs/agents/pilot.md when /setup-workflow installs the resident pilot (#281).
Copy it to docs/agents/pilot.md, replace every {{placeholder}}, drop the bracketed [optional: …] sentences that do not apply, and delete this comment.
  {{repo}}            repo name, also the --capacity key (e.g. mec-wiki)
  {{owner/repo}}      the Tracker section's GitHub project (e.g. ron03wlb/mec-wiki)
  {{main}}            the default branch, as origin/HEAD names it (main, master, …)
  {{check}}           the single check entry (e.g. bin/check)
  {{worker cap}}      workers from this repo at once (2 is a safe start)
  {{batch size}}      Issues per batch (2 is a safe start)
Placeholders in <angle brackets> (<main checkout>, <key>, <n>, <handle>, …) stay as they are: the coordinator substitutes them at run time.
The script commands and result lines are in ~/.claude/skills/issue-pilot/PILOT-STORE.md; every script named here is a setup-workflow template copy in scripts/.
-->
# Pilot: {{repo}}

Project settings for the user-level `/issue-pilot` coordinator (`/loop /issue-pilot`). Every section of `docs/agents/issue-run.md` still applies under the pilot; this file holds only what differs. Every file under `.scratch/pilot/` (batch checkpoints included) follows the `issue-pilot` skill's `PILOT-STORE.md` (`~/.claude/skills/issue-pilot/PILOT-STORE.md`), which also lists each script's commands and result lines; only this repo's values are written here. Every script named below is a setup-workflow template copy in `scripts/`.

- **Coordinator checkout.** `<main checkout>` below is this repo's main checkout: the parent of `git rev-parse --path-format=absolute --git-common-dir` (the same answer from any worktree). Substitute the absolute path when running. `.scratch/pilot/` lives there and is gitignored. Orca commands are written `"$ORCA_CLI_COMMAND"`; without that variable, report to the human instead of guessing a command name.

- **Bare guard.** `scripts/pilot-unbare.sh <main checkout> <when>` restores `core.bare` if an Orca worktree operation set it. Probe, Dispatch, Stage and Close run it themselves (printing `UNBARE <checkout>` when it fixed something); run it by hand only when one of them exits non-zero. Outside WSL it normally prints nothing.

- **Sessions.** On becoming coordinator, and at the start of every Reconcile before the Probe, run in the main checkout `node scripts/pilot-register.mjs <main checkout> --name <session name from ListAgents> --loop yes|no --sources-file docs/agents/pilot-sources.txt` (pid and session default to `$CLAUDE_PID`, `$CLAUDE_CODE_SESSION_ID`). `STOP retired` means this session already handed off: do nothing else. Treat its `SOURCE_CHANGED` and `SOURCE_MISSING` lines per Sources.

- **Sources.** The list is `docs/agents/pilot-sources.txt`, one path per line. Reread each file the Sessions command prints as `SOURCE_CHANGED` (only the entries or headings listed under it, when it lists any) or `SOURCE_MISSING`. When this adapter starts pointing at another file the coordinator must read, add it to the list in the same commit.

- **Decisions, requests, hold.** Append to `decisions.md` only with `node scripts/pilot-decision.mjs <main checkout> --decision <text> --reason <text> --evidence <text> --result <text>` (no `|` in a field; `--repair` when the table looks broken). List and mark requests with `node scripts/pilot-request.mjs <main checkout> list`, `apply <line no> [--note <text>]`, `decline <line no> --reason <text>`. Set, clear and show the hold with `node scripts/pilot-hold.mjs <main checkout> set <reason>`, `clear`, `show`.

- **Gates.** Open with `node scripts/pilot-gate.mjs <main checkout> open --title <text> --issue <#n or -> --question <text> --options <text> --default <text> --parked <text>`, resolve with `resolve G<n> --how <text>`, list with `list`. A gate is how every product question reaches the human.

- **Defaults for `preferences.md`.** At most {{worker cap}} workers from this repo at once, and the machine-wide total stays within `$PILOT_MACHINE_WORKER_CAP`, shared with other repos' coordinators through the ledger the Probe's `--capacity {{repo}}` writes and Dispatch's `--capacity` checks. At most {{batch size}} Issues per batch. Only the coordinator merges into a batch and the integration branch. Push, the PR and the merge into `{{main}}` are the human's (Push gate). Hand off after 2 merged batches or after a compaction.

- **Integration branch.** Local `pilot/integration`, made from `{{main}}` by `/setup-workflow`. It moves only in the stage worktree. To make it contain `origin/{{main}}` (after a branch landed straight into `{{main}}`, or on `land.mjs`'s `STOP behind-main`), run `node scripts/pilot-land.mjs sync-main --main {{main}} --check-command '{{check}}'` in the main checkout with Bash `timeout: 600000`: it fast-forwards when it can, otherwise merges `origin/{{main}}` on `pilot/stage-sync-main` and runs the regression first.

- **Stage worktree.** `<stage worktree>` is the worktree in `git -C <main checkout> worktree list --porcelain` whose branch is `pilot/integration` or `pilot/stage-*`. `pilot-land.mjs` creates it through Orca (`pilot-stage`) when there is none. The main checkout stays on `{{main}}`: the coordinator only fetches, reads state, and fast-forwards `{{main}}` there.

- **Pool.** Run `node scripts/issue-pool.mjs` and pick from its `ready` lines in the printed order, skipping Issues already in an open batch checkpoint. [optional: Never pick a whole Spec (an Issue that still needs splitting): open a gate asking the human to run `/to-tickets` on it, and pick its tickets once they are ready.] `needs-triage` Issues are refined per Readiness first; `/triage` cannot be invoked through the Skill tool, so the coordinator reads `~/.claude/skills/triage/SKILL.md` and follows it. A product question becomes a gate and the Issue `ready-for-human`. Give a `NO_CATEGORY <n>` Issue a category the same way, or report it.

- **Batch.** The batch checkpoint is `.scratch/pilot/batch-<key>.md`, created by Dispatch; each Issue's own checkpoint stays in its worktree. Move or park members before staging with `node scripts/pilot-batch.mjs <main checkout> move <key> <n> [--state stop]`, `park <key> <n> --after <m> --reason <text>`, `unpark <n>`, as the Probe's `MOVE` and `UNPARK` lines say.

- **Brief check.** No command: a worker's brief is `/issue-run <n> --worker <checkpoint>` plus the Issue body.

- **Dispatch.** First claim each member in the main checkout with `node scripts/issue-pool.mjs claim <n>`; dispatch only on `CLAIMED <n>` (or `CLAIMED <n> takeover <session>`), and leave a member claimed by another session out of the batch. Then, after this tick's Probe, run in the main checkout with Bash `timeout: 600000` `node scripts/pilot-dispatch.mjs <key> <n>:<slug>... --capacity` (members in number order). It prints `DISPATCHED <n> <handle>` or `STOP <n> <cause>` per member, and only `STOP capacity <total>/<cap>` when the machine is full (leave the batch for the next tick and release the claims with `node scripts/gh-tracker.mjs edit <n> --remove-assignee @me`).

- **Watch.** `"$ORCA_CLI_COMMAND" terminal read --terminal <handle> --screen --json | jq -r '.result.terminal.tail[-40:][]'`: a last line `DONE <n> <sha>` or `STOP <n> <cause>` means finished; `status: exited` without one means stuck. Stuck-after is the default 90 minutes.

- **Agent rows.** The member rows of the batch checkpoint; subagents a worker spawns are not recorded.

- **Probe.** Each Reconcile, after Sessions, run in the main checkout `node scripts/pilot-probe.mjs <main checkout> --apply --status --capacity {{repo}} --main {{main}}`. Act on its lines as `PILOT-STORE.md` and the `issue-pilot` skill describe: `WORKER` results are written back by `--apply`; `STAGEABLE <key>` goes to Stage; `MOVE`, `PARKED`, `UNPARK` go to Batch; `IN_MAIN <key>` goes to Close; `RESUME_PUSH` and `NOT_IN_MAIN` go to the Push gate; `OVERLAP` lines are reported, not filtered; `REQUEST`, `GATE` and `HOLD` are handled before Pick; `POOL_READY` means run the Pool command. When it exits non-zero, run the Bare guard by hand, report its stderr, and do not stage or merge this tick.

- **Hold flag.** `pilot-land.mjs` checks `.scratch/pilot/hold` right before Integrate and prints `STOP hold`.

- **Stage, regression, integrate.** One command in the main checkout with Bash `timeout: 600000`: `node scripts/pilot-land.mjs <key> --main {{main}} --check-command '{{check}}'`. It stages every `done` member by number on `pilot/stage-<key>`, runs the check entry at the staged SHA (log in `.scratch/pilot/reg-<key>.log`), checks the hold, and fast-forwards `pilot/integration`, printing `MERGED <key> <sha>`. [optional, without a resolver module: It resolves only `docs/agents/workflow-templates.json` conflicts and stops on any other with `STOP conflict …`; redispatch that member fresh with `node scripts/pilot-dispatch.mjs <key> --fresh <n>:<slug>` or open a gate.] `STOP load` reruns next tick; `STOP regression <exit>`: read the log, fix, rerun the same command.

- **Push gate.** Once `pilot/integration`'s tip is the last SHA that passed regression: run `node scripts/pilot-pr-body.mjs <main checkout> --out .scratch/pilot/pr-body.md` from the main checkout (it hands over to the stage worktree's copy, the content being pushed, so there is no path to work out) and continue only on `PR_BODY …`. Then hand the human, as a gate, the command `! node scripts/land.mjs pilot/integration --keep-branch --main {{main}} --check-command '{{check}}' --title '<batch keys and title>' --body-file .scratch/pilot/pr-body.md`, run in the main checkout. Do not run `land.mjs` yourself. When the human reports `LANDED <pr> <merge sha>`, rerun the Sessions command and go to Close; on `STOP behind-main` run the Integration branch's `sync-main` and start the Push gate again; any other `STOP` stays with the human.

- **Close.** Once the merge is on `origin/{{main}}`, run in the main checkout `node scripts/pilot-close.mjs <key> <pr> <merge sha> --repo {{owner/repo}}`. It posts the evidence comment, closes each `done` member, closes its terminal, removes its worktree and local and remote branch, and closes a parent whose sub-issues are all done, skipping steps already done, so it can be rerun; the last line is `CLOSED <key>`. It is not in the allow list: when the permission prompt or auto mode blocks it, hand the same command to the human.

- **Handoff.** When Defaults says so, record the reason with Decisions, stop background work, and run in the main checkout with Bash `timeout: 600000` `node scripts/pilot-handoff.mjs --session "$CLAUDE_CODE_SESSION_ID" --pid "$CLAUDE_PID" --reason <reason>` (no `--held-check`: add one only when the repo has an "integration merge in progress" check). Only `HANDED_OFF <handle>` completes it; on `STOP <reason>` keep coordinating.

- **Project tick hooks.** None.

- **Retro collect.** None: `/retro` implements its own adopted items in this repo.
