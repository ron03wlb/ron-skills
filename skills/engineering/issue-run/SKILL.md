---
name: issue-run
description: "Run ready tracker Issues unattended to a verified local candidate, nesting Matt's skills under the repo's adapter: /issue-run <ref> [<ref>...] | /issue-run <ref> --worker <checkpoint> | /issue-run --pool [<N>]. Use only when the user runs /issue-run or /loop /issue-run --pool (the loop invokes it through the Skill tool), or a coordinator dispatches a worker; never on your own initiative."
---

Deliver the Issues in `$ARGUMENTS` to a verified local **candidate** commit without pausing between steps. You are the **controller**: Matt's skills are the method, the repo's **adapter** supplies every project fact, and the human keeps product decisions, pushes, and merges into shared branches.

Matt's skills stay as published. When a Matt step and the adapter disagree, the adapter wins for this run; list each such override in the report.

## Sources

- **Adapter**: `docs/agents/issue-run.md` in the repo. It is the single source for tracker commands, readiness, claim, worktrees, checkpoint, checks, review, candidate, evidence, closing, and extra stop conditions. Load it with the Read tool, not `cat`: it is larger than the Bash output cap, and the persisted-output detour costs every run an extra call. With no adapter, use the Matt setup docs (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`) and the defaults in [ADAPTER.md](ADAPTER.md), and say so in your first message.
- **Procedures**: `implement` and `implement-spec` are user-invoked, so the Skill tool cannot fire them. Resolve their files with `readlink -f ~/.claude/skills/<name>` and follow `<path>/SKILL.md` as written, with the adapter's overrides.
- **Methods**: call `tdd`, `code-review`, `diagnosing-bugs`, `domain-modeling`, and `codebase-design` with the Skill tool wherever the procedure or a stuck step calls for them.

## Steps

0. **Gate.** Read the adapter, then each Issue with its comments. An Issue passes when its state is the adapter's ready state, the adapter's preflight exits 0, and each blocker is merged or is another Issue in this run; a preflight failure caused only by an open gated ticket in this run counts as such a blocker. Done when every Issue passed or is reported with what it lacks; a failing Issue goes back to the human with the entry that fixes it (`/triage`, `/to-spec`, or the adapter's refine command), never run by you. For an Issue that was reopened, regressed, or is a long-tail problem, also collect the approaches already tried and withdrawn on its topic (tracker, git history, this workspace's transcripts, through the adapter's history command when it has one) into the checkpoint notes, so the run does not retry a disproven one.
1. **Graph.** Build the **task graph**: each passing Issue (or each child of a passing parent) is a ticket, marked code or gated per the adapter; edges come from the tracker's blocking relations. Write the checkpoint where the adapter says, in its format. Done when every ticket has its kind, its blockers, its focused tests or handoff state, and its worktree recorded.
2. **Claim.** Run the adapter's claim command per ticket as it reaches the **frontier**. Done when each claimed ticket shows the in-progress state.
3. **Build.** Gated tickets first, as in [Gated tickets](#gated-tickets). Code tickets: one → follow `implement`; several → follow `implement-spec` (resolve each file as [Sources](#sources) says before writing code; a ticket's first production change comes after a red test from Skill `tdd`, its failing command and exit code recorded in the checkpoint notes; a behavior-preserving refactor instead starts from behavior evidence that is green at the baseline, the adapter's baseline suites plus characterization tests where they miss the touched behavior, recorded the same way, and any behavior change it needs becomes its own ticket). Replace their worktree, branch, verification, review, and closing steps with the adapter's. Review follows [Review rules](#review-rules), and review loops are bounded: after two fix → re-review cycles, remaining findings become a stop. Done when every code ticket on the frontier is merged into the run's branch and the adapter's checks pass on it, each with its command and exit code, and every other ticket is `handoff`, `waiting`, or stopped.
4. **Candidate.** Produce the candidate the adapter defines and run its acceptance pinned to the candidate's full SHA. Skip this step when no code ticket merged. Done when acceptance has a terminal result on that SHA.
5. **Report.** Post evidence where the adapter says, then report in the user's language: candidate SHA, commands with exit codes, review findings per axis (kept separate), unexecuted checks listed as unfinished, Matt overrides used, the human's next actions in order (push, merge, then close: give the close command only once the candidate is on the shared branch, and word its comment after the merge that happened), and per gated ticket its handoff evidence, the human's execution steps, and the tickets waiting on it. Done when nothing remains for you to run.

## Review rules

- **Blocking.** A finding blocks only when it is shown: a failing run at the head, a failed gate, or a doc line this change made wrong. A defect the base already has blocks only when this change copies it or newly reaches it. Every non-blocking finding becomes a follow-up where the adapter says.
- **Wording-only.** A diff that changes only docs or comments, and no behavior, skips the review command; the adapter's doc checks still run. A file the adapter pins by hash is never wording-only.
- **Safety fact.** For a change in the adapter's safety-fact classes (by default: a wire format, a shared contract, tooling that parses source), the review names the one or two facts the change is safe because of and the run that proves each, beyond the caller search.
- **Scenario verification.** For an Issue in the adapter's high-risk classes, a fresh verifier that did not write the code (Codex through the adapter's runner) drives at least one named scenario at the candidate SHA with the adapter's driver, and records SHA, command, and observed result. A test the candidate adds or changes is not an independent driver: with no driver for the path, the verifier writes its own requests from the spec. That record is landing evidence; a diff-only review does not replace it.
- **Cross-model challenge.** A finding still contested after two review cycles, or a finding on a high-risk Issue, goes to Claude and Codex independently with the same question; report where they agree and differ, and decide on that. The two-cycle bound stays.

## Worker mode

`/issue-run <ref> --worker <checkpoint>` runs one Issue as a worker of an `issue-pilot` coordinator, whose batch checkpoint is `<checkpoint>`. Run steps 0–3 for that Issue in its card worktree, then produce its per-Issue candidate as the adapter's **Pilot** section says, and stop. Skip step 4's acceptance, every integration merge, and closing: the coordinator stages, regresses, and lands the batch. Do not claim, dispatch, or touch any other Issue. Report as the adapter's Pilot section specifies: `DONE <iid> <candidate SHA>` or `STOP <iid> <cause>` as the last line, so the coordinator's watcher can read it from the screen tail. After that last line, cancel any pending `/loop` wakeup (`ScheduleWakeup` with `stop: true`) and stop your background tasks: a finished worker that wakes again only re-reads state to report nothing left (#485, #486).

A worker has no human at its screen, so it never calls `AskUserQuestion`, including where a Matt skill (`tdd`, `grilling`) would ask. A product decision, a spec that contradicts the code or a contract, or a change outside the Issue's pinned scope goes to an Issue comment listing the options, then ends the run with `STOP <iid> <cause>`.

Worker mode replaces step 3's review bound:

1. After two fix → re-review cycles, take each remaining finding's options. When exactly one option satisfies the Issue's acceptance criteria and confirmed decisions (`## 驗收條件`, `## 已確認決策`), adopt it and record it in the checkpoint's rulings. When every option fits the Issue's text, the finding is a genuine product trade-off: comment it on the Issue with its options and carry it to step 2.
2. Then run one review-only verifier round (the adapter's review command, no fixes) on the final candidate. When any P2 or higher finding left is not a trade-off step 1 commented, end with `STOP <iid> findings after two review cycles`. Otherwise, when step 1 carried any trade-off, end with `STOP <iid> decision <summary>` even if this round no longer lists it: an open product decision never lands as `DONE`. The coordinator handles either per its Stops; a trade-off reported as findings would only send a fresh worker into it again (#30). With neither, P3 findings only go into the rulings and the run ends with `DONE`.

## Pool mode

`/issue-run --pool [<N>]` takes Issues from the tracker pool and runs them one at a time in this session, each as `/issue-run <n>` would, until `<N>` of them were claimed (default: until the pool is empty). It opens no terminals and runs nothing in parallel, so it needs no Pilot section, only the repo's `scripts/issue-pool.mjs`. Drive it with `/loop /issue-run --pool [<N>]` (self-paced); the skill is model-invocable only so that `/loop` can call it, so never invoke it unless the user's own command names it.

- **Pool.** The pool is the `ready` lines of `node scripts/issue-pool.mjs`, in the order printed; it already leaves out Issues with an open blocker. When the repo has no `scripts/issue-pool.mjs`, stop and tell the human to run `/setup-workflow`; never pick Issues another way.
- **Checkpoint.** The adapter's checkpoint path with `pool` as the ref (`.scratch/issue-run-pool/state.md` by default), one row per Issue this run took: Issue, claiming session, state (`running`, `done`, `waiting`, `stopped`, `skipped`), candidate SHA, stop point. Each Issue still keeps its own checkpoint. The file outlives the session: a new session that picks it up continues its rows.
- **Claim.** `node scripts/issue-pool.mjs claim <n>` is step 2 for a pool Issue, in place of the adapter's claim command. Run the Issue on `CLAIMED <n>` and count it toward `<N>`; `STOP <n> claimed …` means another session has it, so record it `skipped` and take the next. To continue a row an earlier session of this run claimed, claim again with `--session <that session>`.
- **Each wake.** First continue this run's `running` rows per [Resume](#resume), and each `stopped` or `waiting` row whose Issue has a human comment, or a closed gated blocker, newer than its stop; leave the others alone, or every wake re-enters the same stop. Then, while fewer than `<N>` rows printed `CLAIMED`, take the first `ready` Issue with no row or only a `skipped` one. List the pool again after each Issue: a finished one can release its dependents.
- **Stops.** No human watches the screen, so as in [Worker mode](#worker-mode) never call `AskUserQuestion`. On a [stop](#stops), step 0's included, comment on that Issue the step it stopped at and the decision or capability it needs, mark it `stopped`, record every Issue it blocks, directly or indirectly, as `skipped`, and keep going. A gated ticket at handoff marks the Issue `waiting`.
- **Report.** End each wake with one report on every Issue it touched: candidate SHA (and the landing result when the adapter lands), each stop with its stop point, and each skipped Issue with its reason.
- **Pacing.** Under `/loop`, wake again after 1800 seconds when this wake ran an Issue; otherwise double the last delay, up to 3600 seconds. An empty pool never ends the loop, and neither does a `stopped` or `waiting` row still waiting on the human. Only the human's stop ends it, or `<N>` claimed rows all `done`: then give the final report and cancel the loop (`ScheduleWakeup` with `stop: true`).

## Gated tickets

A **gated ticket** delivers an artifact only the human may execute against a shared target, such as a schema migration or a data repair; the adapter defines which tickets are gated and their procedure.

- Run the adapter's gated procedure in the ticket's own worktree up to its **handoff** state, then post its evidence. You prepare and validate offline; executing the artifact, reading back from the target, and closing the ticket belong to the human.
- A ticket blocked by a gated ticket is `waiting`, not stopped: keep every independent ticket moving. A run whose remaining tickets are all `waiting` ends at step 5.
- Rerunning `/issue-run` with the same refs resumes: once the human has closed a gated ticket under the adapter's closing gate, its dependents pass step 0 and continue.
- **Discovery**: when a code ticket turns out to need a gated artifact, follow the adapter's discovery rule (by default, suspend that ticket and everything it blocks, keep its changes, and stop with the missing artifact named). Splitting out the gated ticket stays with the human.

## Stops

Pause only for these; on one, stop that ticket and the tickets it blocks, keep the rest moving, and report all open stops in one message: confirmed facts, affected step, evidence location, the decision or capability needed.

- The Issue leaves a product decision open, or its spec contradicts the code.
- A prerequisite, credential, database, or fixture authorization is missing.
- The worktree holds changes outside the ticket.
- A merge conflict needs a design or spec judgement.
- Findings remain after two review cycles.
- A tool failure blocks a step; report it rather than repairing shared tooling.
- Any stop the adapter adds.

## Resume

After compaction or a hand-off, resume from the checkpoint. Read a ticket's branch and worktree before redispatching anything past `pending`; re-read a gated ticket's tracker state before treating its dependents as still `waiting`.
