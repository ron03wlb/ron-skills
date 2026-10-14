---
name: project-batch
description: Configure one project tracker, confirm complete design and human-applied DDL, then deliver bounded Pi segments with isolated test-data cleanup and confirmed local integration.
disable-model-invocation: true
compatibility: Pi with newSession/withSession, Node.js 22.19+, Git and Orca on macOS/Linux/WSL Linux; gh for GitHub, glab for GitLab, neither for local records. Project-native DB tooling when applicable. Native Windows is unsupported.
---

# Project Batch

One confirmed plan, one batch, one worktree. A session owns one planned work segment; completing an Issue does not authorize the next segment or local integration.

This is an independent **in-progress trial**, not the existing Spec/Run workflow. Use only this skill's script and extension. Existing Issues, planning seals, grants, closeout records and installed workflows remain with their original owners. Ordinary tracker records without this flow's metadata are not adopted. Old `gitlab-batch:v1` records and active state are not migrated; an unfinished old trial blocks the new namespace.

## Entry

Interpret the human's operation below. Run the single script `scripts/project-batch.mjs` with Node and argument arrays (paths relative to this skill). `--help` is the exact low-level interface. Natural-language planning belongs to the agent; the script takes structured JSON, never an unparsed requirement.

| Human operation | Agent action | Read first |
|---|---|---|
| `doctor` | Read-only platform, version, guide/help and optional project binding preflight | [contracts](references/contracts.md) |
| `init` | Preview/confirm credential-free `.project-batch/project.json`; select exactly one provider and pin project rules/database helpers. `--prepare-reader` only emits an offline candidate MySQL SQL/checklist | [project and database](references/database.md), [native MySQL limits](references/mysql.md) |
| `plan <requirement>` | Inspect the codebase; draft Issues and work segments; save a BatchPlan with `plan --input <file>` | [planning](references/planning.md) |
| `publish <draft-id>` | Show the complete preview; confirm and publish/read back; reconcile uncertain creates first | [planning](references/planning.md) |
| `schema <issue-ref>` | Read-only actual-schema report; confirm exact human SQL execution evidence and structural match before implementation. Native `--qualify` currently stops without effects | [project and database](references/database.md), [native MySQL limits](references/mysql.md) |
| `start <issue-ref>` | Show start preview; confirm; Orca creates/reuses one worktree and launches its Pi terminal | [execution](references/execution.md) |
| `resume <issue-ref>` | Revalidate tracker/Git/Orca identity and claim/recover ownership in the batch terminal | [execution](references/execution.md) |
| `status <issue-ref>` | Read-only member acceptance, segment, blocker, handoff, review and integration progress | [contracts](references/contracts.md) |
| `review <issue-ref>` | From target checkout, freeze clean T..C, verify all members and batch, run restricted independent Pi review | [delivery](references/delivery.md) |
| `integrate <issue-ref>` | In target checkout, reconcile eligible Orca patch drift if needed, then preview/confirm local FF, notes, closure, cleanup | [delivery](references/delivery.md) |

Native MySQL's explicit `mysql-cli-v1` protocol provides **audited read-only catalog/unique-key probes with offline coverage**; legacy profiles remain preflight-only. Native writer/settlement/cleanup and qualification integration are unfinished, and neither implementation has live conformance. Native targets still block Batch planning/execution; custom assertions and hashes cannot unlock them. Read [native MySQL](references/mysql.md) when preparing a reader, configuring a native target, interpreting doctor evidence or attempting qualification.

Only the human invokes this entry. A human-confirmed start or next-session handoff carries the same batch authority to its execution session: read these instructions and resume the recorded batch, without invoking a different user-only skill. `step` and `revise` are internal operations of this one skill, not additional skills or public slash commands.

Daily status/resume/step use bounded summaries by default. Follow their evidence pointers or use `--view full` on demand; confirmation previews are always complete. Execution/recovery details live in [execution](references/execution.md).

Use a complete GitHub/GitLab Issue URL or the returned `local://<project>/issues/<number>` reference. `#IID` needs a unique, freshly verified origin/project binding. Multi-Issue batches operate through their parent; a child entry returns the parent command. Child `status` is allowed.

## Human boundaries

- A preview SHA256 is an exact operation token, **not** evidence of consent. Present its complete payload and obtain human confirmation before passing `--confirm`. Never manufacture consent from a prior `start`, a review result, an Issue comment or a stored token.
- Explicit human delegation to verify and confirm recovery through completion may cover the named batch's successive displayed previews. Record the actual delegation, check each exact payload and keep its separate token/receipt; stop when the operation expands that scope. This is not permission inferred from a stored token.
- Initialize once, then reread current rules/profile for every batch. Confirm requirements, interfaces, design, SQL, implementation and automated test/cleanup mapping together. SQL is always human-executed, including test DB bootstrap. Inspect actual schema read-only before implementation; acknowledgement alone is insufficient. Unexpected schema needs/drift stop and preserve dirty work for complete confirmed revision. Automated application tests may use DML-only isolated accounts; no manual DB-write tests, auto-DDL, broad cleaners or acceptance with leftover data. Read [database contracts](references/database.md).
- Planning saves a local draft only. Orca capability recovery, publication retry reconciliation, publishing, starting, revision/takeover, next session and local integration have separate boundaries. The retry-recovery flag stays inside publish; read [planning](references/planning.md#reconcile-one-attempted-create) when a create outcome is uncertain.
- Execute ordered dependency-ready Issues automatically **inside one authorized segment**. Acceptance passes every criterion and verification command before any implementation commit. At the segment end, checkpoint and stop, even with low context usage.
- At 60% context usage, finish/checkpoint the active Issue but start no next Issue. At 70% or segment end, ordinary write/edit/shell tools stop at the next tool boundary; use `project_batch_checkpoint` for controlled checkpoint/sync. Unknown usage supplies no spare-budget claim. Compaction does not restore the saved high-water. This policy does not kill running tools or provide an OS sandbox.
- An unfinished synchronized handoff routes to the extension command `/project-batch-next <root-issue-ref>`: choose **新 session 繼續** or **暫停**. Only that user command switches sessions, in the same terminal. Lifecycle handlers provide context hints, not switches.
- Integration is local only. This flow never pushes, creates a PR/MR, deploys, rebases automatically or runs parallel writers. Ask the human to handle any later push separately, outside this v1 flow.

## Trial launch (both platforms)

These are explicit per-process resource loads, not an installation or global settings change:

```bash
cd "/path/to/project"
pi --skill "/path/to/skills/skills/in-progress/project-batch" \
   --extension "/path/to/skills/skills/in-progress/project-batch/extensions/session-handoff.ts"
```

Report missing capabilities exactly and stop at that adapter boundary. Mock tests or help discovery do not establish real Orca creation, Pi interaction or macOS integration. The smoke checklist and evidence limits live in [contracts](references/contracts.md).
