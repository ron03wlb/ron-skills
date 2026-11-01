# issue-run adapter template

Copy into a repo as `docs/agents/issue-run.md` and fill each section with commands that exist in that repo. Point at the repo's own docs and scripts rather than restating them; leave a section out to take its default.

## Platforms

The platforms the team runs this repo's workflow on, as `/setup-workflow`'s environment station confirmed them: any of `macOS`, `WSL2`, `Linux` (for example `macOS, WSL2`). Native Windows is not supported; use WSL2. Every command this adapter names must run on each listed platform, and a workaround for one platform says which.
Default: the platform `/setup-workflow` ran on.

## Tracker

How to read an Issue with comments and its blocking relations, and the write rules for bodies and comments. Name the tracker host `/setup-workflow`'s Host station confirmed (`github`, `gitlab` or `local`, with its hostname) and take each command from the `gh`/`glab` table in [HOSTS.md](../setup-workflow/HOSTS.md); `glab` flags differ (`glab issue note` takes only `-m`, no `--body-file`).
Default: `docs/agents/issue-tracker.md` from `/setup-matt-pocock-skills`.
On a GitHub tracker at L3, also write the tracker project's URL (`https://<host>/<owner>/<repo>`) here as the section's only GitHub project URL: the setup-workflow `gh-tracker.mjs` copy reads its write target from it, and exits 2 without one.

## Delivery

How a candidate reaches the shared branch on the code host: the code host the Host station confirmed (`github` or `gitlab`, with its hostname; it may differ from the tracker host), its CLI, the PR or MR create, read, wait-for-CI and merge commands from [HOSTS.md](../setup-workflow/HOSTS.md), and where CI is configured (`.github/workflows/` or `.gitlab-ci.yml`).
Name both **CI runners** (CI 執行端) and when to switch. Remote (GitHub Actions, GitLab pipeline) is the default. Local applies only when the remote did not start (billing, no runner: `land.mjs` prints `STOP ci-not-started`): run the `## Checks` entry on the tip SHA to merge, with a clean tree, and comment the SHA and its result line on the PR; on GitHub that is `node scripts/land.mjs <branch> --local-checks <sha> --check-command '<check entry>'`. A remote run that started and failed never falls back to local. With the setup-workflow `land.mjs` (GitHub only), the delivery command is `node scripts/land.mjs <branch> --body-file <file>`.
Default: none when the code host is `local` (no remote): there is no PR, MR or remote CI, the local runner is the only one, and the human merges locally.

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

What this session's Orca tab title says, when it changes, and the commands that change it. The rules below are the default; a project writes here only what differs. Without Orca (`ORCA_TERMINAL_HANDLE` unset): none, and `tab-state.mjs` with valid arguments exits 0 without output.

- **Format.** Every title starts with a state prefix `<state>｜` (分頁狀態), one of `處理中` (still working, including waiting on the user's answer or approval), `待 Retro` (the work is done; waiting for the user to run `/retro` in this tab), or `待關閉` (`/retro` has finished; the user closes the tab). Issue work is `<state>｜<issue> <topic>｜<stage>｜<action>`, for example `處理中｜#21 雙池採集｜實作｜補 TPEx 舊版格式`, then `待 Retro｜#21 雙池採集｜已合入 PR #130` and `待關閉｜#21 雙池採集`. `<issue>` keeps the tracker's own form (`#21` on GitHub, `ENG-123` on Linear) and names only the Issue being worked now; `<topic>` is a stable short name for it; `<stage>` is one of `調查 / 規劃 / 實作 / 驗證 / 修正 / 收尾` and appears only while `處理中`; `<action>` stays within about 12 characters. Other work, a pilot coordinator included, is `<state>｜[<category>] <topic>`, with `<category>` one of `設定 / 研究 / 討論 / 維運 / 雜項` (`處理中｜[維運] issue-pilot coordinator`). Append ` ⏸` only while `處理中` and blocked on the user's approval of an action; an ordinary end of turn gets no marker. Write the topic and action in the language the repo uses for user-visible messages, keeping file, function, and command names verbatim. The state, stage, and category words stay as listed in any language: the hook matches the state prefix literally, and fixed stage and category words keep titles comparable across sessions.
- **When to rename.** At session start, once the Issue or topic is known; on each stage or state change; on switching Issues; and on entering or leaving an approval wait. Set the whole title with `node scripts/tab-state.mjs <state> --topic "<everything after the prefix>"`: at session start (`處理中`) because the recorded title may still be the previous session's on the same handle, later for a new stage, action, Issue, or ` ⏸`, and on leaving `處理中` to drop the stage and action (`待 Retro --topic "#21 雙池採集｜已合入 PR #130"`). `node scripts/tab-state.mjs <state>` without `--topic`, and every switch the hook makes itself, replaces only the prefix and keeps the rest of the title, stage and action included; the hook checks only the prefix, so such a title passes until the session resets it.
- **Worktree name.** When creating or entering an Issue worktree, give Orca the stable part only: `orca worktree set --worktree path:<path> --display-name "<issue> <topic>" --issue <n>` (Linear: `--linear-issue <id>`; GitLab: `--gitlab-issue <n>`).
- **State switches.** With the setup-workflow `tab-state.mjs` and `claude-hook-tab-state.mjs`: `待 Retro` once the delivery is merged (`land.mjs` prints `LANDED`; not the pilot coordinator's `--keep-branch` landing), when a pilot worker writes its `DONE` result line (before the coordinator merges it), once a coordinator's handoff completes (`HANDED_OFF`), or, for other work, once the user confirms the topic is done; opening a PR is not enough. `待關閉` when `/retro` finishes: its adopted items are merged or filed, or its candidates went to the collect flow; `/retro`'s last step switches it. The hook makes the detectable switches (`LANDED`, `HANDED_OFF`, `DONE`) itself and, on `Stop`, exits 2 when the title has no valid prefix. A project adds, overrides, or disables hook triggers in `docs/agents/tab-state.json` (format in the hook's header).

## Pool

The tracker pool every level reads: `scripts/issue-pool.mjs`, which `/setup-workflow` copies at L1. `/issue-run --pool [<N>]` (under `/loop`, self-paced) claims and runs its `ready` lines one at a time in one session, `/issue-queue` lists its buckets, and at L3 the Pilot Pool and Dispatch lines name it too. It reads GitHub and GitLab trackers only; with a `local` Markdown tracker there is no pool, so `--pool` and `/issue-queue` stop.
- **Claim timeout.** The hours after which an assigned Issue with no new comment or assignment is listed as `stale` instead of `claimed`. A stale claim is never released automatically: `/issue-queue` shows it, and releasing it is the human's call. Write `Claim timeout: <h> hours` here to change it; `/issue-queue` then passes `--stale-hours <h>` to `issue-pool.mjs`; a Pilot section that names its own pool query adds the same flag there. The other claim windows are fixed in the script: on an assigned Issue, another session's latest claim comment blocks a new claim at any age; on an unassigned one, it blocks only within 5 minutes of being written (a claim still in flight). An assigned Issue whose latest claim comment is not from an assignee always blocks. A blocking claim is taken over in two cases only: a pilot coordinator that succeeded a handed-off coordinator on this machine (per `.scratch/pilot/sessions.md`) takes over that coordinator's claims, and `--take-stale`, for a flow that waits for no one (such as a Retro collect entry's claim), takes over one whose session on this machine has not written its transcript for an hour.
- **Categories.** The category labels an Issue must carry for the pool not to report it as `NO_CATEGORY` (the bucket names themselves are fixed in the script). Write `Categories: <label>,...` here when the triage categories differ; `/issue-queue` then passes `--categories <label>,...`, and a Pilot section that names its own pool query adds the same flag there.

Default: claim timeout 24 hours; categories `bug`, `enhancement`.

## Issue queue

What `/issue-queue` reads beyond the Tracker, Readiness, Pool, and Pilot sections: `Parent hints: off` turns off its parent hints and the per-parent review. Default: on. Its worker cap is the Pilot section's; with no Pilot section (L1, L2) or no cap named there, the cap is `不限`.

## Pilot

What `/issue-pilot` needs on top of the sections above: pool query, worker cap and batch size, dispatch, watch and probe commands, stage, regression, integrate, close, and handoff. The files under `.scratch/pilot/`, batch checkpoints included, follow [PILOT-STORE.md](../issue-pilot/PILOT-STORE.md): write only the values that differ per project here, never a file format. Besides those, name:

- **Hold flag.** Which landing commands check `.scratch/pilot/hold` right before they merge.
- **Stage, regression, integrate.** The command that merges a batch's `done` members onto a stage branch, runs the regression at the staged SHA, and fast-forwards the integration branch, plus which conflicts it may resolve itself. Default: with the setup-workflow templates, one command, `node scripts/pilot-land.mjs <key> --check-command '<check entry>'` (`--check-command` defaults to `bin/check`; add `--integration <branch>` when the integration branch is not `pilot/integration`, and the same flags on the Push gate's `pilot-land.mjs sync-main`, with `--main <branch>` when the main branch is not `main`); its result lines are in [Canonical scripts](../issue-pilot/PILOT-STORE.md#canonical-scripts). On its own it resolves only a `docs/agents/workflow-templates.json` conflict (by recomputing the copies) and stops on every other conflict with `STOP conflict`. A project that resolves more (ron-skills: `- **<name>.**` entries, table rows, its flow-site stamps) passes `--resolver <module>`, a path from the repo root to an ES module that may export `resolveFile(tree, path, kinds)` (the merged text of a conflicted file, adding the technique's name to the `kinds` Set, or `undefined`), `conflictKind(tree, path)` (the kind for `STOP conflict`, or `undefined` for the default `code`/`other`), `KINDS` (the order of technique names in `RESOLVED`), and `STAMP_FILES` with `restamp(tree, files)` (project stamp files, recomputed and `git add`ed after every other file; `false` when it cannot).
- **Close.** The command that closes each `done` member once the batch's merge is on the main branch: evidence comment, counterpart handoff, close, terminal, worktree, branch, remote branch, parent. Default: with the setup-workflow templates, `node scripts/pilot-close.mjs <key> <pr> <merge sha> --repo [<host>/]<owner>/<repo>` (the project URL of the Tracker section; `--main <branch>` when it is not `main`), which writes through `scripts/gh-tracker.mjs` beside it when present and skips each step already done, so it can be rerun.
- **Push gate.** What the coordinator runs once the integration branch tip is the last SHA that passed regression: the PR body command, then push, open the PR or MR, and merge, or hand those to the human. Default: hand the push to the human; with the setup-workflow templates, `pilot-pr-body` writes the PR body from the merged batch checkpoints ([Canonical scripts](../issue-pilot/PILOT-STORE.md#canonical-scripts)).
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

Tracker writes and the push decision use the setup-workflow templates (its `gh-tracker.mjs` row): allow `Bash(node scripts/gh-tracker.mjs:*)` for the coordinator's comments, labels and closes, and allow `Bash(node scripts/land.mjs:*)` and `Bash(node scripts/pilot-close.mjs:*)` only when the human answered yes to `/setup-workflow`'s push question; `node scripts/check-coordinator-permissions.mjs [--push]` in the check entry keeps the rules matching that answer.

When the pilot runs git in worktrees other than its cwd, do not write `Bash(git -C * <subcommand>)`. A `*` before the subcommand also matches extra git options, so `git -C <path> -c core.sshCommand=<cmd> fetch origin` passes, and Claude Code warns "allows any option at its `*`" on every session start; anchoring the path (`git -C /root/feature-ron-* …`) still warns. Keep each `*` at the end of a rule, after the arguments git parses as options:

1. Copy [templates/pilot_git.py](templates/pilot_git.py) to the repo's `scripts/pilot_git.py` and set its two constants (branch prefix, base branch). The main checkout and worktree root are not constants: the main checkout is `PILOT_GIT_MAIN_CHECKOUT`, else the parent of `git rev-parse --path-format=absolute --git-common-dir` run in the script's directory (the same answer from the main checkout or any linked worktree); the worktree root is `PILOT_GIT_WORKTREE_ROOT`, else `~/orca/workspaces/<main checkout directory name>`. Set either variable only when the detected path is wrong on that machine. It runs `git -C` itself after checking the target and arguments: the main checkout gets only `fetch`, `rev`, `log`; writes (`sync`, `stage`, `push`) only go to `<worktree root>/<prefix>*`; no argument may start with `-`; `push` only targets `<prefix>*` branches.
2. Allow `Bash(python3 scripts/pilot_git.py:*)` and remove any `Bash(git -C …)` rule.
3. Write the adapter's git steps as `python3 scripts/pilot_git.py <subcommand> <checkout> …`, and add a test that every adapter command has a matching rule and no adapter step calls `git -C` directly (Growth: `tests/test_pilot_permissions.py`).
4. Start a new session and confirm no permission warning is printed.

A repo that already wraps its git steps in delivery scripts (spay2: `node scripts/batch-land.mjs`, `bash scripts/push-pinned.sh feature/ron/*`) needs no `pilot_git.py`; the same rule applies to those scripts' allow rules.
