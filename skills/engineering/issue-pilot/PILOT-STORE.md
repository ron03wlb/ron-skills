# Pilot store contract

The **pilot store** is the set of files a coordinator keeps across sessions. This file is its only format source: canonical pilot scripts read and write exactly what is written here, and an adapter names only the values that differ per project (the coordinator checkout, integration branch, checks), never a file format (ADR 0002). [SKILL.md](SKILL.md) says when each file is written and acted on.

Every file lives under the coordinator checkout's `.scratch/pilot/` (the adapter's Pilot **Coordinator checkout** line, else the main checkout) and is never committed. The per-Issue checkpoint `.scratch/issue-run-<n>/state.md` belongs to `/issue-run` and its adapter, not to this store.

Conventions for every file:

- A time is ISO 8601 with its offset, as `date -Iseconds` prints it (`2026-10-30T21:12:24+08:00`) or as JavaScript's `toISOString()` does (`2026-10-30T13:12:24.000Z`).
- In a line format, fields are separated by three spaces; a field's value never contains three spaces in a row.
- A table cell never contains `|`.
- Append-only files keep their history: mark a line or row as done instead of deleting it.

## `.scratch/pilot/coordinator`

One line naming who holds the coordinator role, rewritten in place:

```
pid <pid>   loop <yes|no>   since <time>   name <session name>
```

- `pid` is the coordinator's `$CLAUDE_PID`; readers find the owner with `^pid (\d+)\b`. `loop` is `yes` only when `/loop` runs the coordinator. `since` is when this session became coordinator and stays the same on every rewrite. `name` is the name `ListAgents` prints as "This session is <name>", which other sessions address with SendMessage.
- During a handoff, `pilot-handoff` replaces it with `handoff   from-session <uuid>   from-pid <pid>   at <time>   reason <reason>`, which names no live coordinator; the next session overwrites it with its own `pid` line.
- No file means no coordinator.

## `.scratch/pilot/sessions.md`

Append-only, one line per event, no header:

```
2026-10-30T20:43:33+08:00   session 1d6719b0-c957-4d42-84bc-8474ba2fa7c7   pid 553382   ron-skills-0c
2026-10-30T20:43:41+08:00   handoff from-session 65514abc-cac8-41b6-a870-996eec768045 → terminal term_c1f21a41-235c-4d2c-9c6c-3fb672082f39   reason 合入 2 批
```

- **Start line**, appended when a session becomes coordinator: `<time>   session <$CLAUDE_CODE_SESSION_ID>   pid <$CLAUDE_PID>   <session name>`.
- **Handoff line**, appended by `pilot-handoff` itself once the handoff completed, right before it prints `HANDED_OFF <handle>`, and never on `STOP`: `<time>   handoff from-session <old session id> → terminal <handle>   reason <reason>`. A session named by a handoff line's `from-session` is retired.
- **Old start line**, still accepted by readers and never rewritten: `<time>  <session id>  <session name>  coordinator start` (two spaces, no pid).

## `.scratch/pilot/hold`

The file's existence is the hold; deleting it clears the hold.

```
{"since":"2026-10-30T21:00:00+08:00","reason":"等 #27 合入","session":"1d6719b0-c957-4d42-84bc-8474ba2fa7c7"}
```

- Content: one JSON line with `since` (time the hold was set), `reason` (string), and `session` (the setting session's `$CLAUDE_CODE_SESSION_ID`). Write it with a JSON encoder so the reason is escaped: `node -e 'console.log(JSON.stringify({since: process.argv[1], reason: process.argv[2], session: process.env.CLAUDE_CODE_SESSION_ID}))' "$(date -Iseconds)" '<reason>' > .scratch/pilot/hold`.
- An empty file (the old `touch` form) is a hold with no reason. Content that does not parse is still a hold: readers decide on existence, and read the JSON only for display.

## `.scratch/pilot/decisions.md`

The decision trail: a `# Decisions` heading, then one Markdown table with five columns, one row per decision, appended. Readers do not require the heading or the header row: `pilot-unbare.sh` appends its `還原 core.bare` rows even when the file does not exist yet.

```
| time | decision | reason | evidence | result |
|---|---|---|---|---|
| 2026-10-30T12:33:07+08:00 | 成為 coordinator（ron-skills-44） | 無 coordinator 檔 | .scratch/pilot/coordinator | ok |
```

## `.scratch/pilot/requests.md`

Requests other sessions hand to the live coordinator, one per line, appended; lines starting with `#` are headings.

```
<time>   <request>   source <session name or id>
```

Older lines separate the fields with two spaces; readers accept both.

The coordinator closes a request by appending `   applied <time>` or `   declined <reason>` to the same line, optionally followed by a note. A request is open while the text after its last ` source ` holds no ` applied <word>` or ` declined <word>`; so neither the request text nor the source contains ` source `, and the source contains neither word.

## `.scratch/pilot/gates.md`

Open human gates under a `# Gates` heading. Ids are `G<n>`, increasing and never reused. A gate takes either form:

- A row of the table `| id | Issue | question | options | default | parks | opened | status |`: `opened` is a time, and `status` is `open` until it becomes `resolved <time> <how>`.
- A section `## G<n> <title>` with one bullet per field: `- Issue：…`, `- question：…`, `- options：…`, `- default：…`, `- parked：…`, `- opened：<time>`. It is resolved by adding a line `- resolved <time> <how>`; a `- status：resolved` bullet does not count.

A gate is open until its `resolved` mark; never delete one.

## `.scratch/pilot/preferences.md`

The standing orders: a heading line, then a numbered list, one constraint per item (`<n>. <constraint>`). Orders keep their numbers, so removing one leaves a gap. An item overriding an adapter default names who overrode it and when, in parentheses at its start.

## `.scratch/pilot/status.md`

Regenerated from the checkpoints at each drain, never edited by hand: a heading `# pilot status（<time>，coordinator <session name>）`, then one bullet per open batch with its `current:` state, then bullets for the pool, open gates, and batches merged in this session. Only people read it; no script parses it.

## `.scratch/pilot/briefs/`

One brief per tooling fix unit, `briefs/<name>.md`, where `<name>` is a short slug. It is Markdown with one `##` section per field that [SKILL.md](SKILL.md)'s **Briefs** rule lists.

## `.scratch/pilot/batch-<key>.md`

The batch checkpoint, one per batch. `<key>` is the members' Issue numbers in ascending order joined by `-` (`53-55`; one member: `65`).

```
# batch 53-55
current: dispatched 2026-10-30T21:12:24+08:00
integration: pilot/integration @ 202f8ec

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
| 53 | issue/53-close-cross-repo-handoff | /path/to/workspaces/ron-skills/issue-53 | term_5cbbd19b-… | 2026-10-30T21:12:24+08:00 | 90m | running | |
```

- `current:` holds the batch state, one of `dispatched`, `staged <sha>`, `merged <sha>`, `pushed <sha>`, `closed`; the three SHAs are the same staged SHA. Text after the value, separated by a space, is a note readers ignore (dispatch time, PR and merge SHA). The old form `pushed` without a SHA is still accepted; readers then take the SHA from the last `regression:` line.
- `integration:` names the integration branch and its SHA when the batch was dispatched: `<branch> @ <sha>`.
- One table row per member: Issue number, branch `issue/<n>-<slug>`, absolute worktree path, terminal handle, start time, stuck-after as `<minutes>m`, state, and candidate SHA (empty until `done`). A state is `running`, `done`, or `stop`; `moved` marks a member moved to another batch, which no longer counts toward this one.
- Below the table, each regression run appends `regression: <sha> exit <code>`, optionally followed by a note; the last `regression:` line is the one in force.
