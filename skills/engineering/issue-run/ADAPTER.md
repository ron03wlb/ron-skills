# issue-run adapter template

Copy into a repo as `docs/agents/issue-run.md` and fill each section with commands that exist in that repo. Point at the repo's own docs and scripts rather than restating them; leave a section out to take its default.

## Platforms

The platforms the team runs this repo's workflow on, as `/setup-workflow`'s environment station confirmed them: any of `macOS`, `WSL2`, `Linux` (for example `macOS, WSL2`). Native Windows is not supported; use WSL2. Every command this adapter names must run on each listed platform, and a workaround for one platform says which.
Default: the platform `/setup-workflow` ran on.

## Tracker

How to read an Issue with comments and its blocking relations, and the write rules for bodies and comments. Name the tracker host `/setup-workflow`'s Host station confirmed (`github`, `gitlab` or `local`, with its hostname) and take each command from the `gh`/`glab` table in [HOSTS.md](../setup-workflow/HOSTS.md); `glab` flags differ (`glab issue note` takes only `-m`, no `--body-file`).
Default: `docs/agents/issue-tracker.md` from `/setup-matt-pocock-skills`.

## Delivery

How a candidate reaches the shared branch on the code host: the code host the Host station confirmed (`github` or `gitlab`, with its hostname; it may differ from the tracker host), its CLI, the PR or MR create, read, wait-for-CI and merge commands from [HOSTS.md](../setup-workflow/HOSTS.md), and where CI is configured (`.github/workflows/` or `.gitlab-ci.yml`).
Default: none when the code host is `local` (no remote): there is no PR, MR or remote CI, and the human merges locally.

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
Also name the baseline suites a behavior-preserving refactor runs green before its first change, and the history command for reopened or regressed Issues (tracker, git, transcripts).

## Review

The review command and its output, and what the skill's [Review rules](SKILL.md#review-rules) need: where non-blocking findings go as follow-ups, the files pinned by hash, the safety-fact classes, the high-risk classes with the scenario driver and verifier runner, and the cross-model command.
Default: the `code-review` skill on the run's branch; follow-ups in the Issue's report; no pinned files; the default safety-fact classes; no high-risk classes.

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

## Tab state (分頁狀態)

When this session's Orca tab title switches its state prefix (分頁狀態: `處理中`, `待 Retro`, `待關閉`; the format is in the user's global Orca session titles rule), and the command that switches it.
Default, with the setup-workflow `tab-state.mjs` and `claude-hook-tab-state.mjs`: switch with `node scripts/tab-state.mjs <state>`, which replaces only the prefix and keeps the rest of the title; at session start set the whole title with `node scripts/tab-state.mjs 處理中 --topic "<topic>"`, since the recorded title may still be the previous session's on the same handle. `待 Retro` once the delivery is merged (`land.mjs` prints `LANDED`; not the pilot coordinator's `--keep-branch` landing), when a pilot worker writes its `DONE` result line (before the coordinator merges it), once a coordinator's handoff completes (`HANDED_OFF`), or, for other work, once the user confirms the topic is done; opening a PR is not enough. `待關閉` when `/retro` finishes: its adopted items are merged or filed, or its candidates went to the collect flow; `/retro`'s last step switches it. The hook makes the detectable switches (`LANDED`, `HANDED_OFF`, `DONE`) itself and, on `Stop`, exits 2 when the title has no valid prefix. A project adds, overrides, or disables hook triggers in `docs/agents/tab-state.json` (format in the hook's header). Without Orca: none.

## Pilot

What `/issue-pilot` needs on top of the sections above: pool query, worker cap and batch size, dispatch, watch and probe commands, stage, regression, integrate, push gate, close, and handoff. The files under `.scratch/pilot/`, batch checkpoints included, follow [PILOT-STORE.md](../issue-pilot/PILOT-STORE.md): write only the values that differ per project here, never a file format. Besides those, name:

- **Hold flag.** Which landing commands check `.scratch/pilot/hold` right before they merge.
- **Brief check.** A command that refuses a brief missing goal, scope, acceptance, verify, timebox, forbidden, report, or the standing orders path.
- **Agent rows.** Where the checkpoint records each spawned agent (parent, handle, start time, stuck-after), and which probe line reports a parent still waiting past its child's stuck-after.
- **Sessions.** The register command: writes `.scratch/pilot/coordinator` and appends the session's start line to `.scratch/pilot/sessions.md`. Default: the coordinator writes both itself; with the setup-workflow templates, `node scripts/pilot-register.mjs <checkout> --name <session name> --loop yes|no <source>...`.
- **Sources.** The rule files the coordinator re-reads when they change: the source list `pilot-sources` hashes (`node scripts/pilot-sources.mjs <checkout> --record <source>...`), the same list passed to the register command. Default: `AGENTS.md`, this adapter and any file its Pilot section points to, and the `issue-pilot` skill.
- **Decisions, requests, hold.** The commands that write `decisions.md`, mark `requests.md` lines, and set or clear `hold`. Default: the coordinator writes them by hand per [PILOT-STORE.md](../issue-pilot/PILOT-STORE.md); with the setup-workflow templates, `pilot-decision`, `pilot-request`, and `pilot-hold` ([Canonical scripts](../issue-pilot/PILOT-STORE.md#canonical-scripts)).
- **Gates.** The commands that open, resolve, and list `gates.md` entries. Default: the coordinator writes them by hand per [PILOT-STORE.md](../issue-pilot/PILOT-STORE.md); with the setup-workflow templates, `pilot-gate` ([Canonical scripts](../issue-pilot/PILOT-STORE.md#canonical-scripts)).
- **Coordinator checkout.** The checkout the coordinator runs in and keeps `.scratch/pilot/` under, for a project whose coordinator does not live in the main checkout. Default: the repo's main checkout.
- **Project tick hooks.** Scripts the coordinator runs each tick after Drain and before Pick, in order, from the coordinator checkout, for project checks ron-skills does not model (a daily collection dispatch, a quota check). Exit 0 continues; any other exit opens a gate with the script's output and skips Pick and Dispatch for that tick. Default: none; the step is skipped.
- **Retro collect.** What `/retro-collect` needs to turn the open `retro-candidates` Issues into one retro unit: the checkout it runs from, the command that claims each collected Issue, the retro worktree's name, branch, and target branch, the checks, and how it merges and pushes. `/retro` runs in collect mode only when this entry exists. Default: none; `/retro-collect` stops and says so.

Run every Pilot command once in the repo before writing it into the adapter; a command copied from another repo's adapter fails on that repo's paths (ron-skills retro 4f58fc81#1). Orca under WSL records repos by their Windows UNC path, so `orca worktree create --repo path:<WSL path>` returns `repo_not_found`, wrapped as `agent_session_operation_unknown` when `--agent` rides along: omit `--repo` and run it from the repo's checkout, which Orca infers it from. A repo without delivery scripts can start from ron-skills' own [`docs/agents/pilot.md`](../../../docs/agents/pilot.md).

Default: no Pilot section; `/issue-pilot` stops and says so.

## Permissions

The `.claude/settings.json` allow rules an unattended `/issue-pilot` tick needs, and where git runs.
Default: none; every git write prompts.

When the pilot runs git in worktrees other than its cwd, do not write `Bash(git -C * <subcommand>)`. A `*` before the subcommand also matches extra git options, so `git -C <path> -c core.sshCommand=<cmd> fetch origin` passes, and Claude Code warns "allows any option at its `*`" on every session start; anchoring the path (`git -C /root/feature-ron-* …`) still warns. Keep each `*` at the end of a rule, after the arguments git parses as options:

1. Copy [templates/pilot_git.py](templates/pilot_git.py) to the repo's `scripts/pilot_git.py` and set its two constants (branch prefix, base branch). The main checkout and worktree root are not constants: the main checkout is `PILOT_GIT_MAIN_CHECKOUT`, else the parent of `git rev-parse --path-format=absolute --git-common-dir` run in the script's directory (the same answer from the main checkout or any linked worktree); the worktree root is `PILOT_GIT_WORKTREE_ROOT`, else `~/orca/workspaces/<main checkout directory name>`. Set either variable only when the detected path is wrong on that machine. It runs `git -C` itself after checking the target and arguments: the main checkout gets only `fetch`, `rev`, `log`; writes (`sync`, `stage`, `push`) only go to `<worktree root>/<prefix>*`; no argument may start with `-`; `push` only targets `<prefix>*` branches.
2. Allow `Bash(python3 scripts/pilot_git.py:*)` and remove any `Bash(git -C …)` rule.
3. Write the adapter's git steps as `python3 scripts/pilot_git.py <subcommand> <checkout> …`, and add a test that every adapter command has a matching rule and no adapter step calls `git -C` directly (Growth: `tests/test_pilot_permissions.py`).
4. Start a new session and confirm no permission warning is printed.

A repo that already wraps its git steps in delivery scripts (spay2: `node scripts/batch-land.mjs`, `bash scripts/push-pinned.sh feature/ron/*`) needs no `pilot_git.py`; the same rule applies to those scripts' allow rules.
