---
name: issue-run
description: "Run ready tracker Issues unattended to a verified local candidate, nesting Matt's skills under the repo's adapter: /issue-run <ref> [<ref>...] | /issue-run <ref> --worker <checkpoint>"
disable-model-invocation: true
---

Deliver the Issues in `$ARGUMENTS` to a verified local **candidate** commit without pausing between steps. You are the **controller**: Matt's skills are the method, the repo's **adapter** supplies every project fact, and the human keeps product decisions, pushes, and merges into shared branches.

Matt's skills stay as published. When a Matt step and the adapter disagree, the adapter wins for this run; list each such override in the report.

## Sources

- **Adapter**: `docs/agents/issue-run.md` in the repo. It is the single source for tracker commands, readiness, claim, worktrees, checkpoint, checks, review, candidate, evidence, closing, and extra stop conditions. Load it with the Read tool, not `cat`: at about 30 KB it passes the Bash output cap, and the persisted-output detour costs every run an extra call. With no adapter, use the Matt setup docs (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`) and the defaults in [ADAPTER.md](ADAPTER.md), and say so in your first message.
- **Procedures**: `implement` and `implement-spec` are user-invoked, so the Skill tool cannot fire them. Resolve their files with `readlink -f ~/.claude/skills/<name>` and follow `<path>/SKILL.md` as written, with the adapter's overrides.
- **Methods**: call `tdd`, `code-review`, `diagnosing-bugs`, `domain-modeling`, and `codebase-design` with the Skill tool wherever the procedure or a stuck step calls for them.

## Steps

0. **Gate.** Read the adapter, then each Issue with its comments. An Issue passes when its state is the adapter's ready state, the adapter's preflight exits 0, and each blocker is merged or is another Issue in this run; a preflight failure caused only by an open gated ticket in this run counts as such a blocker. Done when every Issue passed or is reported with what it lacks; a failing Issue goes back to the human with the entry that fixes it (`/triage`, `/to-spec`, or the adapter's refine command), never run by you.
1. **Graph.** Build the **task graph**: each passing Issue (or each child of a passing parent) is a ticket, marked code or gated per the adapter; edges come from the tracker's blocking relations. Write the checkpoint where the adapter says, in its format. Done when every ticket has its kind, its blockers, its focused tests or handoff state, and its worktree recorded.
2. **Claim.** Run the adapter's claim command per ticket as it reaches the **frontier**. Done when each claimed ticket shows the in-progress state.
3. **Build.** Gated tickets first, as in [Gated tickets](#gated-tickets). Code tickets: one → follow `implement`; several → follow `implement-spec` (resolve each file as [Sources](#sources) says before writing code; a ticket's first production change comes after a red test from Skill `tdd`, its failing command and exit code recorded in the checkpoint notes). Replace their worktree, branch, verification, review, and closing steps with the adapter's. Review loops are bounded: after two fix → re-review cycles, remaining findings become a stop. Done when every code ticket on the frontier is merged into the run's branch and the adapter's checks pass on it, each with its command and exit code, and every other ticket is `handoff`, `waiting`, or stopped.
4. **Candidate.** Produce the candidate the adapter defines and run its acceptance pinned to the candidate's full SHA. Skip this step when no code ticket merged. Done when acceptance has a terminal result on that SHA.
5. **Report.** Post evidence where the adapter says, then report in the user's language: candidate SHA, commands with exit codes, review findings per axis (kept separate), unexecuted checks listed as unfinished, Matt overrides used, the human's next actions (push, close), and per gated ticket its handoff evidence, the human's execution steps, and the tickets waiting on it. Done when nothing remains for you to run.

## Worker mode

`/issue-run <ref> --worker <checkpoint>` runs one Issue as a worker of an `issue-pilot` coordinator, whose batch checkpoint is `<checkpoint>`. Run steps 0–3 for that Issue in its card worktree, then produce its per-Issue candidate as the adapter's **Pilot** section says, and stop. Skip step 4's acceptance, every integration merge, and closing: the coordinator stages, regresses, and lands the batch. Do not claim, dispatch, or touch any other Issue. Report as the adapter's Pilot section specifies: `DONE <iid> <candidate SHA>` or `STOP <iid> <cause>` as the last line, so the coordinator's watcher can read it from the screen tail.

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
