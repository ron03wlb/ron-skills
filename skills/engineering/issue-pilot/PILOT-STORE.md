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
- **Readers besides the coordinator**: `issue-pool.mjs claim` takes over a claim from this machine's session that a handoff line retired, when the claiming session has a start line and no handoff line of its own; it prints `CLAIMED <n> takeover <session>`.

## `.scratch/pilot/hold`

The file's existence is the hold; deleting it clears the hold.

```
{"since":"2026-10-30T21:00:00+08:00","reason":"等 #27 合入","session":"1d6719b0-c957-4d42-84bc-8474ba2fa7c7"}
```

- Content: one JSON line with `since` (time the hold was set), `reason` (string), and `session` (the setting session's `$CLAUDE_CODE_SESSION_ID`). Write it with `pilot-hold set` ([Canonical scripts](#canonical-scripts)), or any JSON encoder, so the reason is escaped.
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

## `.scratch/pilot/sources`

The source check's record: one line per rule file the coordinator reads at its first tick (the adapter's Pilot **Sources** line names them), rewritten in full by `pilot-sources --record`:

```
<sha256>   <path>
```

- `<path>` is relative to the coordinator checkout, or absolute for a file outside it (a user-level skill). A file that did not exist when recorded has `missing` in place of the hash.
- No file means nothing is recorded yet: every source counts as changed.
- `.scratch/pilot/source-snapshots/<sha256>` holds each recorded source's content, named by its hash, also for a file outside the checkout; `--record` rewrites them with the record and removes snapshots of hashes no longer recorded. A record without its snapshot (an older format) still compares by hash: the change is reported without the units below.

## `.scratch/pilot/gates.md`

Open human gates under a `# Gates` heading. Ids are `G<n>`, increasing and never reused. A gate takes either form:

- A row of the table `| id | Issue | question | options | default | parks | opened | status |`: `opened` is a time, and `status` is `open` until it becomes `resolved <time> <how>`.
- A section `## G<n> <title>` with one bullet per field: `- Issue：…`, `- question：…`, `- options：…`, `- default：…`, `- parked：…`, `- opened：<time>`. It is resolved by adding a line `- resolved <time> <how>`; a `- status：resolved` bullet does not count.

A gate is open until its `resolved` mark; never delete one. With the setup-workflow templates, open, resolve, and list gates with `pilot-gate` ([Canonical scripts](#canonical-scripts)) instead of editing the file.

## `.scratch/pilot/preferences.md`

The standing orders: a heading line, then a numbered list, one constraint per item (`<n>. <constraint>`). Orders keep their numbers, so removing one leaves a gap. An item overriding an adapter default names who overrode it and when, in parentheses at its start.

## `.scratch/pilot/status.md`

Regenerated from the store and git at each drain, never edited by hand (`pilot-probe --status` writes it): a heading `# pilot status（<time>，coordinator <session name>）`, where the name comes from the `coordinator` file's `pid` line (`(none)` without one), a blank line, then bullets in this order:

```
- batch 77-124：dispatched 2026-10-31T11:32:03+08:00
  - #77 done d2121d1
  - #124 stop
- gate G2 #12 要不要拆？（開了 1h35m）
- request 2026-10-30T17:26:01+08:00   hold 到 #27 合入   source ad
- origin/main 370114b
- main 370114b
- pilot/integration 370114b
```

- One bullet per batch whose `current:` is not `closed`, with its `current:` value (`(沒有 current:)` when the line is missing), and one sub-bullet per member, `moved` ones included: `#<n> <state>` and its candidate, a SHA shortened to 7 characters and any other text as written; `- 沒有開著的 batch` when there is none.
- One bullet per open gate: id, Issue, question or section title, and how long since `opened`; `- 沒有開著的 gate` when there is none.
- One bullet per open request, its line as written; `- 沒有開著的 request` when there is none.
- The SHAs of `origin/<main branch>` (as of the last fetch), the main branch, and the integration branch, `none` for a missing ref.

Only people read it; no script parses it.

## `.scratch/pilot/briefs/`

One brief per tooling fix unit, `briefs/<name>.md`, where `<name>` is a short slug. It is Markdown with one `##` section per field that [SKILL.md](SKILL.md)'s **Briefs** rule lists.

## `.scratch/pilot/batch-<key>.md`

The batch checkpoint, one per batch. `<key>` is the members' Issue numbers in ascending order joined by `-` (`53-55`; one member: `65`). A **request batch** lands one request branch that has no Issue (`retro/<x>`, from a `requests.md` line): its key is `req-<n>`, `<n>` being that request's line number, and the project's land script opens it from the branch, so the coordinator never writes one by hand.

```
# batch 53-55
current: dispatched 2026-10-30T21:12:24+08:00
integration: pilot/integration @ 202f8ec

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
| 53 | issue/53-close-cross-repo-handoff | /path/to/workspaces/ron-skills/issue-53 | term_5cbbd19b-… | 2026-10-30T21:12:24+08:00 | 90m | running | |
```

- `current:` holds the batch state, one of `dispatched`, `staged <sha>`, `merged <sha>`, `pushed <sha>`, `closed`; the three SHAs are the same staged SHA. A batch whose members were all moved out is closed as exactly `closed moved`: nothing of it landed. Text after the value, separated by a space, is a note readers ignore (dispatch time, PR and merge SHA), with one exception: the optional `staged <sha> onto <integration sha>` records the integration branch tip the batch was staged on; an Integrate step that reads it compares it with the current tip and restages when they differ. The old form `pushed` without a SHA is still accepted; readers then take the SHA from the last `regression:` line.
- `integration:` names the integration branch and its SHA when the batch was dispatched: `<branch> @ <sha>`.
- One table row per member: Issue number, branch `issue/<n>-<slug>`, absolute worktree path, terminal handle, start time, stuck-after as `<minutes>m`, state, and candidate SHA (empty until `done`). A state is `running`, `done`, `stop`, or `parked after #<m>`: a `done` member held back until Issue `#m` lands (its candidate stays), which sits alone in `batch-<n>.md` with a line `parked: after #<m> <time> <reason>` below the table. `moved batch-<n>` marks a member moved to `batch-<n>.md`, which no longer counts toward this one; the moved row keeps its other cells, and the bare `moved` of older checkpoints reads the same. A member is moved by copying the header (title changed to `# batch <n>`, `current:` and `integration:` as they are) and its row to `batch-<n>.md`. A request batch's single row has `-` in the Issue column and branch `retro/<x>`, its worktree path when one has the branch checked out (else empty), empty handle and stuck-after, state `done`, and the branch tip as candidate; readers that act on Issues (comments, closing) skip such a row, and landing and cleanup treat it like any other member.
- Below the table, each regression run appends `regression: <sha> exit <code>`, optionally followed by a note; the last `regression:` line is the one in force.

## Canonical scripts

The setup-workflow templates that read and write this store, copied into a project's `scripts/` (ADR 0001). Each takes the coordinator checkout as its first argument (except `pilot-dispatch`, which runs in it and finds it with `git worktree list`) and writes only under its `.scratch/pilot/` (`pilot-pr-body` writes only the file its `--out` names); every project value (checkout, source list, session name, integration branch) comes in as an argument, never as a constant. Exit 2 is always a usage error.

`pilot-probe` and `pilot-dispatch` also run the project's own Bare guard when a `pilot-unbare.sh` sits next to them (`<checkout> <when>`, `when` being `probe` or `dispatch #<n>`; its stdout, such as `UNBARE <checkout>`, is passed through, and a non-zero exit fails the probe or stops the member with `unbare`); without one they skip it. Their integration branch defaults to `pilot/integration` and the main branch to `main`.

| Script | Command | stdout | exit |
| --- | --- | --- | --- |
| `pilot-register.mjs` | `<checkout> --name <session name> --loop yes\|no [--pid <pid>] [--session <id>] [<source>...]` (pid and session default to `$CLAUDE_PID`, `$CLAUDE_CODE_SESSION_ID`) | `REGISTERED pid <pid>   since <since>`; `SESSION_APPENDED` when it appended the start line; then `pilot-sources --record`'s lines for the sources given; `STOP retired` when `sessions.md` has a handoff from this session | 0; 4 `STOP` |
| `pilot-decision.mjs` | `<checkout> --decision <text> --reason <text> --evidence <text> --result <text> [--time <time>]` | `DECISION <time>` (appends only; writes the heading and header row first when the file is missing or empty) | 0 |
| `pilot-decision.mjs` | `<checkout> --repair` | `REPAIRED` (rewrote it as heading, header, every row: rows `pilot-unbare.sh` appended before the header, blank lines and repeated headers inside the table) or `OK` (also when there is no file); `MALFORMED <line no> <line>` per line that is not a five-column row, and the file is left as is | 0; 1 `MALFORMED` |
| `pilot-request.mjs` | `<checkout> list` | `REQUEST <line no>   <line>` per open request (a line with no ` source ` field counts as open, as the probe reads it) | 0 |
| `pilot-request.mjs` | `<checkout> apply <line no> [--note <text>]`, `<checkout> decline <line no> --reason <text> [--note <text>]` | `APPLIED <line no>`, `DECLINED <line no>` (a line with no ` source ` field gets `   source unknown` before its mark); `NOT_OPEN <line no>` when that line is not an open request | 0; 1 `NOT_OPEN` |
| `pilot-gate.mjs` | `<checkout> open --title <text> --issue <text> --question <text> --options <text> --default <text> --parked <text>` | `GATE_OPENED G<n>` (appends a `## G<n> <title>` section with the next id, one past the highest in the table and the sections, and `- opened：<time>`; writes the `# Gates` heading first when the file is missing or empty) | 0 |
| `pilot-gate.mjs` | `<checkout> resolve G<n> --how <text>`, `<checkout> list` | `GATE_RESOLVED G<n>` (adds `- resolved <time> <how>` after the section's last bullet, or sets a table row's status to `resolved <time> <how>`); `STOP G<n> resolved` or `STOP G<n> missing`, and the file is left as is; `list` prints the probe's `GATE …` and `GATE_MALFORMED <id> <line>` lines | 0; 4 `STOP` |
| `pilot-hold.mjs` | `<checkout> show`, `set <reason>`, `clear` | `HOLD <since>   <reason>` (`(no since)` for a JSON line without one), `HOLD (no reason)`, `NO_HOLD`; `HOLD_SET`; `HOLD_CLEARED` or `NO_HOLD` | 0 |
| `pilot-probe.mjs` | `<checkout> [--integration <branch>] [--main <branch>] [--apply] [--status] [--capacity <repo>]` (reads running members with `$ORCA_CLI_COMMAND`, and the checkout's open Issues with `gh`; `--apply` writes each `WORKER <n> DONE <sha>` back to that member's row as state `done` and candidate `<sha>`, each `STOP` as state `stop`, changing only those two cells of the one `running` row, and rewrites `current: merged` as `pushed` for a batch it prints `IN_MAIN` for, and fixes each `PARENT_LABEL` (adds `parent`, removes its triage labels) and `PARENT_REOPEN` (reopens) through a `gh-tracker.mjs` beside it, or `gh issue` without one; `--status` then rewrites `status.md`; `--capacity <repo>` reports this round's still-running members, the `running` rows less those this round read `DONE` or `STOP` for, as `<repo>`'s row of the machine ledger through `pilot-capacity`) | one line per finding, nothing when all is well: `UNBARE`, `NOT_MAIN <branch>`, `HOLD`, `DIRTY <status line>`; `ADAPTER_AHEAD <file> [<name>,…]` for `docs/agents/issue-run.md`, or a same-directory `.md` its `## Pilot` section links to, that is newer on the integration branch, followed by the changed `- **<name>.**` entry names (sorted, `,`-separated, names may hold spaces) when every change is inside such entries, and with no names when anything outside them changed; `REQUEST <line>`, `GATE …`, `GATE_MALFORMED <id> <line>`; `DEPS_PROSE <n> #<m>` for an open `ready-for-agent` Issue whose body names open Issue `#m` after `依賴` (up to the next `。`, `；`, `;`, `，`, `,` or line break outside full-width parentheses; not after `不` or `無`, and not its own number) while its `blocked_by` lacks `#m`, `DEPS_PROSE_FAILED <error>` when `gh` fails (the other checks still run, the `PARENT_*` lines from the same query do not); `PARENT_LABEL <n>` for a parent (an open Issue with sub-issues, or a closed parent an open Issue points to) that lacks the `parent` label or still carries a triage label, `PARENT_REOPEN <n>` for a closed parent in the same repository that an open Issue still points to (each by number, once); `WORKER <n> DONE <sha>`, `STOP <cause>`, `RUNNING <minutes>`, `STUCK <why>`; for a `dispatched` batch with no member still running (this round's results counted, `moved` members left out), `STAGEABLE <key>` when every member is `done`, `MOVE <key> <n…>` naming the members that are not `done` when some are, `PARKED <key> <n…>` when none is; `UNPARK <n>` for a `parked after #<m>` member of an open batch once `#m` is a `done` member of a `closed` batch; `OVERLAP <n> <m\|integration> <count> files [**<entry>.**…]` when two running or done members of open batches change the same file, or the integration branch changed it since the member's merge-base with it (one line per pair: `<count>` is the number of shared files, followed by the shared `- **<name>.**` entries, for each `.md` file whose every changed line falls inside entries, without file names and listed once even when two files share the name (names may hold spaces, so split on `**`…`.**`); `files` even for 1; report only); after `git fetch`, `IN_MAIN <key>`, `RESUME_PUSH <key>`, `NOT_IN_MAIN <key> [no-sha\|no-regression\|tip <sha>]`, `FETCH_FAILED <error>` (the script's header comment has the details); with `--capacity`, a last `OVER_CAP <total> <cap>` when every repo's total exceeds the cap (report only); the flags change none of the other lines, and `--apply` adds `APPLY_MISS <key> <n> rows <count>` when it finds no single `running` row for that member (it then writes nothing) or `APPLY_MISS <key> <n\|current> verify` when the file does not read back as written, and `PARENT_APPLY_FAILED <n> <error>` when a tracker write fails (the other parents are still fixed) | 0; 1 failure, `APPLY_MISS` or `PARENT_APPLY_FAILED`; 2 usage, including a `--capacity` repo name that is empty or holds a tab or line break, or a cap that is not a positive integer |
| `pilot-dispatch.mjs` | `<key> <n>:<slug>... [--allow-overlap] [--capacity] [--integration <branch>] [--stuck-after <minutes>m]` (needs `$ORCA_CLI_COMMAND`; budget `$PILOT_DISPATCH_BUDGET_MS`, default 510000) | with `--capacity`, first `pilot-capacity`'s check for the number of members (1 on `--fresh`): `STOP capacity <total>/<cap>` alone, with nothing written, created or opened, or `CAPACITY ok <total>/<cap>` before the member lines; per member `DISPATCHED <n> <handle>` or `STOP <n> <cause>`; `STOP <n> not-claimed` (row `stop`, no worktree, no terminal) when the Issue's latest claim comment, in `issue-pool.mjs claim`'s format and takeover rule, is not this session's (`$CLAUDE_CODE_SESSION_ID`, then `$ORCA_TERMINAL_HANDLE`), and `STOP <n> claim-check …` when `gh` cannot read the comments; `STOP <n> overlap <m> <file>[:<entry>]…` (further members joined by `, <m> …`; nothing touched: no terminal closed or opened, no branch, the row left as it was; `STOP <n> overlap-check …` when the comparison itself fails, row `stop` on a plain dispatch and nothing touched on `--fresh`) when the member's local branch, compared the way `pilot-probe`'s `OVERLAP` compares (shared through its `memberOverlaps`), touches a file or `- **<name>.**` entry that a `running` or `done` member of an open batch also touches, unless `--allow-overlap`; a member with no local branch yet has nothing to compare; otherwise it dispatches after creating worktree `issue-<n>` on branch `issue/<n>-<slug>` from the integration branch, a `claude` terminal (when the worktree already exists, after closing every terminal in it, as `--fresh` does, or `STOP <n> running <handle>` with nothing touched when its row is still `running` and that terminal is still open), and sending `/issue-run <n> --worker <checkpoint>`; it writes the checkpoint's header once and each member's row (state `running` or `stop`, stuck-after default `90m`). `<key> --fresh <n>:<slug> --note <file> [--again] [--allow-overlap]` redispatches one member as a fresh worker in its existing worktree: `STOP <n> not-claimed` as above (nothing touched), `STOP <n> overlap …` as above for the branch it would keep as prior (nothing touched), `STOP dirty <n>` when the worktree has uncommitted changes (nothing touched), `STOP refresh-twice <n>` when it was already redispatched and has new commits (unless `--again`); `STOP <n> running <handle>` when that fresh worker is already running in the worktree (its terminal is left open); otherwise it closes every terminal in the worktree, renames the branch to `<branch>-prior` (`-prior2`, … on `--again`), recreates the branch from the integration branch, renames the worker's `.scratch/issue-run-<n>` the same way, comments the note plus `prior: <branch> @ <sha>` on the Issue, moves the row to `batch-<n>.md` (header plus one row; the old row becomes `moved batch-<n>`), dispatches, and prints `DISPATCHED <n> <handle>` then `PRIOR <n> <prior branch> <sha>`; each step is skipped when already done | 0; 4 a `STOP` |
| `pilot-batch.mjs` | `<checkout> move <key> <n> [--state stop]`, `<checkout> park <key> <n> --after <m> --reason <text>`, `<checkout> unpark <n>` | `MOVED <key> <n> batch-<n>`, with ` closed` appended when that left the old batch all `moved` and its `current:` became `closed moved`: `move` moves member `#n` as [the batch checkpoint](#scratchpilotbatch-keymd) describes, the old row becoming `moved batch-<n>`; `--state stop` writes the new row as `stop` with an empty candidate, otherwise the row is copied unchanged. `park` moves a `done` member the same way as `parked after #<m>` with its candidate and the `parked:` line, or, when `<key>` is `<n>` and it is that batch's only member, marks it in place and prints `PARKED_MEMBER <n> after #<m>`. `unpark` sets a parked member of `batch-<n>.md` back to `done` and prints `UNPARKED <n>`. A rerun of a finished or interrupted move prints the same line, completing the old row. `STOP <key> missing`, `STOP <n> rows <count>`, `STOP <n> same-batch`, `STOP <n> members <count>` (an in-place park in a batch with other members), `STOP <n> state <state>`, `STOP <n> target batch-<n>.md` (it exists without that member), and the files are left as they are | 0; 4 `STOP` |
| `pilot-capacity.mjs` | `report <repo> <running>`, `check <add>` (no checkout argument: the ledger is machine-wide, `$PILOT_WORKERS_LEDGER`, default `~/.local/state/pilot-workers.tsv`, one `<repo>\t<running>\t<ISO time>` row per coordinator repo, each coordinator rewriting only its own; rows not updated for 2 hours, and rows that do not parse, count as 0; the cap is `$PILOT_MACHINE_WORKER_CAP`, default 4; `report` rewrites the file under a `<ledger>.lock` directory lock, taking over a lock older than 30 seconds and failing after waiting 10) | `REPORTED <repo> <running> <total>/<cap>`; `CAPACITY ok <total>/<cap>` or `STOP capacity <total>/<cap>`, the total including `<add>` | 0; 4 `STOP capacity`; 2 usage, or a cap that is not a positive integer; 1 the ledger cannot be read or written, or the lock wait timed out |
| `pilot-pr-body.mjs` | `<checkout> [--out <file>]` | the PR body for every batch whose `current:` is `merged <sha>`, in key order: a `## Batches` heading, one line per batch (`- batch <key>：staged <sha>，` then its last `regression:` line in backticks; a request batch's key is followed by its branch in `（）`), one `Closes #<n>` line per `done` Issue member in number order (request rows get none), and the Claude Code signature line; with `--out` it writes the body there and prints `PR_BODY <file> batches <n> closes <m>` instead. `STOP no-merged-batch`; `STOP regression <key>` when a merged batch's last `regression:` line is not its staged SHA with `exit 0` (nothing written) | 0; 4 `STOP` |
| `pilot-sources.mjs` | `<checkout> [--record] <source>...` | `SOURCE_CHANGED <path>` per source whose hash differs from the record (or has none), followed, when the old snapshot exists, by one indented line per changed unit in the new file's order with removed ones last: `  entry <name>` (a `- **<name>.**` entry with its indented continuation lines), `  heading <title>` (a `##`-or-deeper heading itself, or non-entry content under it), `  outside` (non-entry content before the first such heading); `SOURCE_MISSING <path>` per source that does not exist and was not already recorded `missing`; `--record` then rewrites the record and snapshots and prints `RECORDED <n>` | 0 |

A note, reason, or field is one line without three spaces in a row; a decisions cell and a gate's `--how` also have no `|`, and a request mark has no `source` word, which would reopen the line.
