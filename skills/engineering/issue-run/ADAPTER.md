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

## Pilot

What `/issue-pilot` needs on top of the sections above: pool query, worker cap and batch size, dispatch, watch and probe commands, stage, regression, integrate, push gate, close, and handoff. Besides those, name:

- **Hold flag.** How the coordinator sets and clears a hold, and which landing commands check it right before they merge.
- **Brief check.** A command that refuses a brief missing goal, scope, acceptance, verify, timebox, forbidden, report, or the standing orders path.
- **Agent rows.** Where the checkpoint records each spawned agent (parent, handle, start time, stuck-after), and which probe line reports a parent still waiting past its child's stuck-after.

Default: no Pilot section; `/issue-pilot` stops and says so.

## Permissions

The `.claude/settings.json` allow rules an unattended `/issue-pilot` tick needs, and where git runs.
Default: none; every git write prompts.

When the pilot runs git in worktrees other than its cwd, do not write `Bash(git -C * <subcommand>)`. A `*` before the subcommand also matches extra git options, so `git -C <path> -c core.sshCommand=<cmd> fetch origin` passes, and Claude Code warns "allows any option at its `*`" on every session start; anchoring the path (`git -C /root/feature-ron-* …`) still warns. Keep each `*` at the end of a rule, after the arguments git parses as options:

1. Copy [templates/pilot_git.py](templates/pilot_git.py) to the repo's `scripts/pilot_git.py` and set its four constants (main checkout, worktree root, branch prefix, base branch). It runs `git -C` itself after checking the target and arguments: the main checkout gets only `fetch`, `rev`, `log`; writes (`sync`, `stage`, `push`) only go to `<worktree root>/<prefix>*`; no argument may start with `-`; `push` only targets `<prefix>*` branches.
2. Allow `Bash(python3 scripts/pilot_git.py:*)` and remove any `Bash(git -C …)` rule.
3. Write the adapter's git steps as `python3 scripts/pilot_git.py <subcommand> <checkout> …`, and add a test that every adapter command has a matching rule and no adapter step calls `git -C` directly (Growth: `tests/test_pilot_permissions.py`).
4. Start a new session and confirm no permission warning is printed.

A repo that already wraps its git steps in delivery scripts (spay2: `node scripts/batch-land.mjs`, `bash scripts/push-pinned.sh feature/ron/*`) needs no `pilot_git.py`; the same rule applies to those scripts' allow rules.
