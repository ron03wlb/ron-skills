---
name: retro-collect
description: "Gather the /retro files of retired coordinator sessions, implement every adopted candidate in one retro worktree, land it on the integration branch, and close the collected tabs: /retro-collect [<session8>...]"
disable-model-invocation: true
---

Retired coordinator sessions ran `/retro` in **collect mode**: each wrote its candidates to a file and waits. You turn those files into one retro unit. Project facts (the collector script, worktree naming, checks, merge, push) come from the repo adapter `docs/agents/issue-run.md`, Pilot **Retro collect** line (in the file the Pilot section points to, when it points to one); with no such line, stop and say so. Run from the coordinator checkout (the Pilot **Coordinator checkout** line, or the main checkout without one). `$ARGUMENTS` may name sessions (first 8 characters) to restrict the run to.

## Steps

1. **Roster.** Run the adapter's status command. Each `DONE` row is a file to collect; each `PENDING` row is a retired session whose `/retro` has not finished. With any `PENDING` row, ask the human with `AskUserQuestion` whether to wait for those sessions or collect without them, naming each session and its tab handle; a session left out stays open for the next run. Done when every row is `DONE`, or the human chose to proceed without the rest.

2. **Plan.** Read every collected file in full. Write `.scratch/retro/plan-<MMDD><letter>.md` with one line per candidate of every file: `adopted` (merged with its duplicates from other files, citing all sources), `covered <commit or branch>` (already on the integration branch or in another worktree's unmerged diff: check per the `retro` skill's concurrent-edit step), or `dropped <reason>` (the session itself advised against it). Done when every candidate of every file has exactly one line.

3. **Implement.** Every `adopted` line is implemented: the standing order is that retro candidates are adopted without asking item by item. Use one worktree created as the adapter line says; changes to user-level skills go to `~/code/ron-skills` per its README. Independent file sets may go to parallel subagents in that worktree, each owning disjoint files, running ref-moving git (checkout, switch, reset, stash) only in its own scratch clone, and reporting the adapter sentences its change needs; you apply the adapter and doc edits yourself. A candidate that adds a check is done only with the `retro` skill's proof: the real past mistake as a fixture and the check failing on it. Done when each `adopted` line is marked `done <file>` in the plan, or `blocked <reason>` and reported.

4. **Land.** Confirm `git symbolic-ref HEAD` in the worktree still names the retro branch, run the adapter line's checks on the worktree, commit with a `chore: retro …` subject, recheck concurrent edits against the integration branch, then merge and push as the adapter line says. Done when the merge is on the remote integration branch, or a check failed and you reported its output.

5. **Close.** Run the adapter's mark command with the retro branch and the collected sessions, then its close command, and report: the landed commit, what each plan line became, any `PENDING` session left, and every tab closed or `CLOSE_GONE`.
