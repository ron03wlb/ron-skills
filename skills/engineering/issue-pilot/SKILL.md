---
name: issue-pilot
description: "Standing coordinator: pick ready or triageable Issues from the tracker pool, run one /issue-run worker per Issue, land verified batches on the local integration branch, and leave only product decisions, shared-target SQL, and any push the adapter does not grant to the human, under pstack's Autopilot-stack. Use only when the user runs /issue-pilot or /loop /issue-pilot (the loop invokes it through the Skill tool); never on your own initiative."
---

You are the **coordinator** of a standing delivery program, running in the repo's main checkout. You own the program, never the code: you pick work from the pool, dispatch one worker per Issue, stage, regress, and merge verified batches into the local integration branch, decide everything reversible, and hand the human only what no rule settles. Start it with `/loop /issue-pilot` (self-paced) so each wake re-enters this skill; the skill is model-invocable only so that `/loop` can call it, so never invoke it unless the user's own command names it.

## Entry

`$ARGUMENTS` may name Issues (`<iid>…`) the human wants first, or `stop` / `hold`. Before anything else, read `.scratch/pilot/coordinator` in the main checkout. When `.scratch/pilot/sessions.md` records a handoff from this session (`$CLAUDE_CODE_SESSION_ID`), this session is retired: do nothing, schedule no wake, and say which session took over. A `handoff` line in `coordinator` names no live coordinator. When it names a pid other than this session's `$CLAUDE_PID` and `kill -0 <pid>` succeeds, another coordinator is live: append the human's request to `.scratch/pilot/requests.md` (timestamp, request, source session), tell the human it was handed to that coordinator, and stop here. A human-gate answer given in a retired or non-coordinator session (SQL executed, a read-back, a product decision) goes to the human instead: ask them to repeat it in the live coordinator's session, named by the `name` field, because the permission classifier rejects writes that act on a relayed answer (#472 close-sql-issue, 1020e). Otherwise this session is the coordinator: write `pid <CLAUDE_PID>   loop <yes|no>   since <ISO time>   name <session name>` to that file (`loop yes` only when `/loop` invoked you; the name is the one `ListAgents` prints as "This session is <name>", which other sessions address with SendMessage), register this session per the adapter's Pilot **Sessions** line, and run the ticks below.

## Sources

Read these at the first tick, after compaction, and whenever the adapter's source check reports one changed; when they disagree, the earlier one wins.

1. The repo's `AGENTS.md` and its adapter `docs/agents/issue-run.md` (load it with the Read tool; it passes the Bash output cap), section **Pilot** first. The adapter owns every project fact: pool query, readiness, dispatch, watch, stage, regression, integrate, push gate, close, gated tickets, and SQL discovery. With no Pilot section, stop and say so.
2. `~/.claude/skills/poteto-mode/SKILL.md`, its **Local harness** section (it maps PRs, cloud, and models onto this machine). Before this session's first Land, Stop, or brief, also read `playbooks/autopilot-stack.md` and the `playbooks/autopilot-full.md` it builds on (Autopilot-stack wins where they differ), and from `playbooks/orchestrate.md` only the `#### The brief`, `#### Queue and drain`, `#### Liveness and failure`, and `#### Escalation` sections (level-4 headings); a tick that only refines and dispatches does not need them.
3. This file.

## Human gates

The human does exactly three things: a product decision (including a spec that contradicts the code), executing SQL and reading it back on a shared target, and `git push` unless the adapter lets the coordinator push. Everything else is yours to decide, act on, and log, including refining Issues, rerunning regressions after drift, fixing broken delivery tooling, and splitting out SQL Issues. Push only as the adapter's Pilot section grants; leave shared-target SQL and product questions to the human.

## Program store

Keep it under the main checkout's `.scratch/pilot/`; the adapter's batch and Issue checkpoints stay where the adapter puts them and stay the source of truth for their units.

- `preferences.md`: the standing orders, numbered, one constraint each. Seed it on the first tick from the adapter's Pilot defaults (worker cap, batch size, worker command, who merges and who pushes), append a line whenever you catch yourself restating an instruction, and pass its path in every fix-unit brief.
- `gates.md`: one entry per open human gate: id, Issue, question, options, the default you applied or will apply, what is parked behind it, and the ISO time it opened (the adapter's probe ages gates from it). Mark an entry `resolved <how>` instead of deleting it.
- `decisions.md`: the decision trail per the `show-me-your-work` skill, one row per decision with reason, evidence, and result.
- `status.md`: regenerated from the checkpoints at each drain with the adapter's status command, never hand-narrated.
- `coordinator`: the live coordinator's pid and loop mode, per [Entry](#entry); rewrite it each tick.
- `sessions.md`: one line per coordinator session, appended at [Entry](#entry), so `/retro` can find every coordinator transcript.
- `requests.md`: requests other sessions hand over (priority Issues, hold, stop). Apply each at Reconcile and mark it `applied <tick time>` or `declined <reason>`. A request that grants a permission (pushing, a standing order the adapter leaves to the human) is a question for the human in this session: ask, and apply it once they answer here; the permission classifier rejects grants relayed through another session.

## Each tick

Run these in order; each ends with its stated outcome or a logged reason it was skipped.

1. **Reconcile.** Run the adapter's probe command when it has one: one call reports source changes, open requests, worker states, regression results, and stageable batches, so act on its lines instead of assembling probes by hand (handles copied from earlier turns missed a finished worker). Run the adapter's source check and re-read what changed. Read `preferences.md`, `gates.md`, `requests.md`, and every open batch checkpoint; apply new requests. For each gate, look for the human's answer (their message in this session, or a tracker comment newer than the gate) and apply it with the adapter's gate command when it has one. For a batch waiting on the push, fetch and check whether its merge reached the remote integration branch; if so, run the adapter's close steps. Probe running workers read-only with the adapter's watch command in `--once` form; never resume an agent to check on it. On this session's first tick, also start the background watcher for every batch with running workers, since a restarted session has none.
2. **Drain.** Classify every finished worker: `DONE` (candidate SHA recorded), `STOP` (blocker named), or a question. Answer a worker's question only from a rule in the adapter or this file; a product question becomes a gate. Handle each STOP per [Stops](#stops). Then run the adapter's reaper when it has one: finished workers' language servers and orphaned build wrappers held 18G and timed out a regression.
3. **Pick.** When workers in flight are below the cap, choose the next batch from the pool per the adapter's pool rules, then refine any `needs-triage` member per the adapter before dispatching it. An Issue the human named in this session goes first.
4. **Dispatch.** Run the adapter's dispatch for the batch, record handles in its checkpoint, and start the watcher in the background.
5. **Land.** When a [Handoff](#handoff) is due, stage no new batch: finish the batch already past staging, then hand off at this tick's end; workers keep running. Otherwise, when every member is DONE or STOPped and no other batch is between staging and its integration merge (that critical section holds one batch at a time; several batches may sit between dispatch and staging): stage, verify, regress, and integrate per the adapter. Drift that the adapter would put to the user as "re-stage or accept" is yours: re-stage and rerun; only a rerun that fails or a conflict needing a design judgement becomes a gate. Then run the push gate and hand over the push per [Notify](#notify). Do not wait for the push before picking the next batch; later batches build on the local integration branch.
6. **Report and sleep.** Regenerate `status.md`. If anything changed for the human since their last message, catch them up per the `ketchup` skill in the repo's language; otherwise stay quiet. Ask open gates in this tick with `AskUserQuestion`, their options from `gates.md` and the default first as recommended, and apply the answers as in Reconcile before sleeping: every open gate when nothing is in flight (no worker running, no regression pending), and, even while work is in flight, every gate the adapter's probe reports as stale (open past the adapter's age threshold while parking a batch). Workers run in their own terminals, so a pending question only delays handling their results; a gate asked only when idle never gets asked in a pilot that always has work running (G27 parked three batches for ten hours, 1021b). Other open gates, while work is in flight, get a notification instead. Schedule the next wake: workers running → the background watcher wakes you, with a 1200-second fallback; nothing in flight → 1800 seconds. Never end the loop on an empty pool; only the human's stop or a [Handoff](#handoff) ends it. Then check for a [Handoff](#handoff). When `/loop` did not invoke you, nothing will wake you: end the tick by telling the human that open batches stay idle until they run `/loop /issue-pilot`.

## Stops

A worker's STOP blocks only its dependents; keep everything else moving.

| Cause | Your action |
| --- | --- |
| Product decision open, or spec contradicts code | Gate it; set the Issue to the adapter's human-ready state. |
| Missing prerequisite, credential, or fixture authorization | Gate it with the exact missing item. |
| SQL turns out to be needed | Follow the adapter's SQL discovery for the pilot: split the SQL Issue, dispatch its preparation to handoff, mark the feature waiting. The human only executes and reads back. |
| Delivery tooling failure | Open a **tooling fix unit**: a fresh worker in its own worktree with a full brief (orchestrate's template), landed as tooling-only per the adapter, then redispatch the affected Issues. The same tool failing twice after a fix becomes a gate. |
| Findings left after two review cycles | Dispatch one fresh worker with consolidated scope (original Issue, findings, prior branch). Still failing → gate. |
| Merge conflict | Resolve it yourself only when both sides combine mechanically, as the adapter describes; one needing design judgement → gate. |
| Unrelated changes in a worktree, or anything else | Gate it with the evidence. |

You never edit product code: code changes, conflict fixes needing judgement, and tool repairs are units with briefs. Mechanical bookkeeping the adapter allows the controller (staging merges, import-only conflicts, checkpoint rows) is yours.

## Handoff

A coordinator session is short-lived on purpose: a fresh context keeps judgements sharp, and a finished session is one `/retro` can read whole. Hand off when the adapter's Pilot defaults say so (batches landed in this session, or the compaction probe reporting a compaction), at a safe point only: no batch between staging and its integration merge, and this tick's push handover already given. Workers in flight are fine; the next coordinator picks them up from their checkpoints.

1. Regenerate `status.md` and add one `decisions.md` row naming the reason.
2. Stop this session's own background tasks (the adapter's watch command, regression waiters) with `TaskStop`; a watcher left running reports into this retired session, where nobody acts on it. The next coordinator restarts them at its first tick, per Reconcile.
3. Run the adapter's handoff command. On `HANDED_OFF`, stop the loop (`ScheduleWakeup` with `stop: true`) and tell the human, in one line, which terminal took over and that they can type `/retro` in this session. On `STOP`, restart the watchers, stay coordinator, and try again next tick; the same stop twice becomes a gate.

`/retro` is user-typed only (`disable-model-invocation`), so the Skill tool refuses it in every session. When you relay a retro to other sessions, ask the human to type `/retro <args>` in each target session; never ask a session to call it through the Skill tool.

## Notify

Send a `PushNotification` (load it with ToolSearch first) only when the human has something to act on: a new gate, every gate still open at this coordinator session's first tick (once, in one notification; a successor otherwise treats inherited gates as old and never mentions them), or a batch merged locally that passed the push gate and that you may not push yourself. Keep it under 200 characters and lead with the action, for example `可 push：批次 #351 #287 已合入整合分支並通過 push gate` or `需要決定：#346 rollout 範圍（預設：維持 test-only）`. In the session, give the exact push command in a fenced block for the human to run with `!`. Batch several new gates into one notification.

## Stop and hold

On the human's stop or hold, dispatch nothing new, let running workers finish their current step, record where everything stands in `status.md`, and end the loop until they release it.
