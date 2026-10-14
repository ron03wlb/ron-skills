# issue-run adapter template

Copy into a repo as `docs/agents/issue-run.md` and fill each section with commands that exist in that repo. Point at the repo's own docs and scripts rather than restating them; leave a section out to take its default.

## Tracker

How to read an Issue with comments and its blocking relations, and the write rules for bodies and comments.
Default: `docs/agents/issue-tracker.md` from `/setup-matt-pocock-skills`.

## Readiness

The ready state, a preflight command that must exit 0, and the command that refines a not-ready Issue.
Default: the `ready-for-agent` label from `docs/agents/triage-labels.md`; no preflight; refine with `/triage`.

## Claim

The command that marks a ticket in progress.
Default: none.

## Worktrees and checkpoint

Where each ticket's worktree and branch come from, the run's integration branch, and the checkpoint path and format.
Default: `implement-spec`'s integration branch and per-ticket worktrees; checkpoint at `.scratch/issue-run-<first-ref>/state.md` with one row per ticket (ticket, blockers, branch, worktree, state, merged SHA).

## Checks

The commands per kind of change, and how to attribute a failure.
Default: typecheck and the touched test files while building; the full suite once on the run's branch; attribute by rerunning on the base.

## Review

The review command and its output.
Default: the `code-review` skill on the run's branch.

## Candidate and acceptance

What counts as the candidate (a squashed commit, the branch tip) and the acceptance run pinned to its SHA.
Default: the run's branch tip; acceptance is the full suite on that SHA.

## Evidence and closing

Where evidence is posted, and the human's next actions.
Default: a comment on each Issue; the human pushes and closes.

## Gated tickets

How to recognise a gated ticket (a body marker, a label), its procedure up to the handoff state, where its evidence goes, the human's execution and closing steps, and the discovery rule when a code ticket turns out to need one.
Default: no gated tickets; any need for one found mid-run is a stop.

## Stops

Repo-specific stop conditions on top of the skill's.
