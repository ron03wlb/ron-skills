# One bounded execution session

## Start and resume

1. `start <root-ref>` previews the plan hash, exact baseline and root. Obtain confirmation before `--confirm`. Start authorizes execution of the planned batch segments, not integration or push.
2. The script reads Orca's matching guide/help, creates or reuses the sole batch worktree, verifies its baseline/common Git directory and complete Orca identity, and launches Pi with explicit skill/extension paths. Repo setup hooks are skipped; any necessary human setup belongs in declared prerequisites. Custom explicit resource loading uses a terminal command rather than assuming Orca's configured Pi launcher loads this extension. Orca may materialize default terminal tabs; retain them unless verified unused.
3. In that batch Pi terminal, use controlled `project_batch_claim` if the actual fresh session is not yet recorded. It binds the actual Pi session identity and displays a live takeover confirmation; cancel preserves ownership. Unclaimed sessions are read-only and cannot use shell/edit/write to claim themselves. Alternatively the human may invoke CLI resume directly. Obtain the **actual** session ID (extension boundary message or Pi session metadata). Call `resume <root-ref> --session <id>` and use its returned generation for every internal step. A fresh initial launch claims once; repeated resume by the same running owner does not increment ownership. A checkpointed owner must use next, not extend its own session.
4. For a different session after interruption, resume returns a takeover preview. Verify the old executor is inactive (terminal/session identity, exit evidence; PID or age alone is insufficient), record `--inactive-evidence <text>` when there is no synchronized stopped handoff, then confirm the exact preview. A saved handoff's commit and uncommitted fingerprint must match. Pending sync is read back before takeover proceeds. No worktree rebuild, stash or reset occurs.

An ambiguous worktree/terminal creation stays journaled. Re-entry reports the existing identity/receipt instead of opening a second terminal or sending the prompt twice. If creation or send outcome is uncertain, inspect that exact operation with Orca before human-confirmed journal recovery. Do not switch to raw Git worktree commands or a different executable.

## Segment loop

Use `step <root-ref> --session <id> --generation <n> --action <action>`, optionally `--input <JSON-file>` and `--percent <actual-Pi-percent>`. Daily status/resume/step return a bounded summary by default (`--view summary`); read its runtime/evidence pointer for the active Issue specification, or request `--view full` only when needed. Full includes the confirmed plan, runtime and recovery journals; human confirmation previews always retain their complete payload. Store input files outside the product checkout (Git common directory's `project-batch/` is suitable). Do not replay `begin` for an unfinished active Issue inherited through handoff.

1. **Begin**: `--action begin`. The script selects only the next Issue of this session's segment, requires a clean checkout, accepted internal dependencies, closed/reachable external dependencies and confirmed prerequisites. At ≥60%, start no next Issue. Extension-observed context high-water is persisted so compaction cannot erase this boundary. Unknown usage still keeps the segment bound.
2. Implement only that complete behavior, with relevant tests and fixes. Use ordinary code tools in the batch worktree. At ≥70%, the next tool boundary rejects ordinary write/edit/shell and unknown tools. Use `project_batch_checkpoint` to checkpoint without forcing an unfinished commit. Already-running tools are not killed; one large output can overshoot. The guard is a mistake-prevention tool policy, not an OS sandbox.
3. **Accept**: `--action accept --input <acceptance.json>`. Supply exact key, every criterion in plan order with `passed: true` and observable evidence, all changed paths, and commit message:

   ```json
   {
     "key": "validation",
     "criteria": [{"criterion": "Invalid required fields return the documented error", "passed": true, "evidence": "Named behavior test and observed response"}],
     "paths": ["src/validation.ts", "tests/validation.test.ts"],
     "message": "Reject invalid payment parameters"
   }
   ```

   Verification commands run before staging/commit. Schema identity is rechecked at work-item start, before/after tests, resume and preintegration. `application-write` commands receive a unique run/ledger before effects and always attempt owned-data cleanup; schema or cleanup failure prevents acceptance. Use controlled `project_batch_checkpoint` with `action: "cleanup"` for the current run's safe recovery, including at high context. Never clear the ledger by rerunning a fresh test or executing manual SQL. The path set must exactly match all changed files; unrelated or pre-staged changes stop for recovery. The accepted commit is read back against its parent, tree and exact acceptance marker. A prepared acceptance journal recovers a commit whose successful response was lost. Do not change its input on retry. A behavior already satisfied without code changes uses `paths: []` plus `noChangeEvidence`; verification still runs and records the current commit without manufacturing an implementation commit.
4. Acceptance writes the commit, criterion evidence and command/results to that member's Issue. A multi-Issue root receives only a progress summary and link to the member evidence note. Full logs stay in Git metadata. Every pending destination must read back before another Issue: use `project_batch_checkpoint` with `action: "sync"` (or CLI `--action sync` while shell is still allowed). A partial failure retries only remaining destinations. Legacy single pending records keep their original root/body/key; they are not new member-write authority. Offline checkpoint appends to, rather than replaces, pending acceptance.
5. Continue automatically to the next dependency-ready Issue **inside this segment** only. Internal dependencies use accepted criteria, not tracker closure. All Issues remain open until local integration.
6. If later work breaks prior behavior, `--action regress --input <file>` with `{ "keys": ["validation"], "reason": "Exact regression evidence" }` retracts affected acceptance and transitive dependents, invalidates review and chooses the earliest affected segment. Checkpoint and get a new-session confirmation if that changes this session's segment. Run the same behavior/verification again; no prior acceptance can excuse a regression.

For a newly discovered schema need, use `--action schema-stop --input <file>` with `{ "reason": "Exact unapproved requirement" }`, then checkpoint. Do not implement against a guessed schema. A complete confirmed revision, human SQL execution and actual-schema verification are required; old matching read-back cannot clear this stop. Dirty active work and ownership journals remain intact. See [database contracts](database.md).

For a manual non-schema prerequisite use `--action prerequisite --input <file>` with `{key,id,evidence}`. Display the declared work and evidence, obtain human confirmation of actual completion, then pass the exact returned token. This records the prerequisite; it never performs SQL, credential or dashboard work and invokes no old prerequisite framework.

## Checkpoint and stop

Prefer the extension tool `project_batch_checkpoint` with `{ "ref": "<root-ref>", "action": "checkpoint", "handoff": <object below> }`. It obtains actual session/generation/context and invokes the same owner, specification, environment and fingerprint checks as the script. It offers only checkpoint/sync/owned cleanup; no arbitrary writes, commit, new session, integration or push. It remains available to the recorded owner at segment end/high context when ordinary shell is blocked. CLI `--action checkpoint --input <handoff.json>` is equivalent only while shell is permitted (or when run directly by the human).

The **entire handoff object**, including all arrays, is limited to 4 KiB UTF-8; detailed evidence belongs in referenced local files. Checkpoint persists the full worktree fingerprint separately, owner/session generation, segment and this bounded handoff:

```json
{
  "summary": "Short continuation summary; entire JSON at most 4 KiB UTF-8",
  "completed": ["Observed accepted behavior"],
  "remaining": ["Unfinished behavior and exact files"],
  "verification": ["Command outcomes; detailed log paths"],
  "blockers": [],
  "decisions": [],
  "next": ["Exact next step inside the recorded segment"]
}
```

Details and full outputs live in separate evidence files under Git metadata. Link those paths in the arrays; do not stuff logs or the old transcript into the summary. An unfinished active Issue and its uncommitted files survive. At a completed segment, the runtime advances the segment cursor but this session loses permission to begin it. At all-member completion it enters `awaiting_integration`; request review from the target checkout rather than another execution session. At segment completion, `handoff_ready`, `awaiting_integration`, exhausted context or stale owner/generation/segment, ordinary write/edit/bash and unknown tools are refused. Same-segment blocked owners below the exit threshold can still fix current work. Read-only inspection and the valid owner's controlled checkpoint/sync remain available. Tracker checkpoint notes contain the bounded handoff, not the dirty fingerprint or full files.

For unfinished work, the human runs `/project-batch-next <root-ref>`. The command waits idle, refuses pending messages, validates synchronized handoff, asks **新 session 繼續／暫停**, revalidates, then uses `newSession({parentSession, withSession})`. Only the replacement context claims a new generation and sends the short durable-state continuation. It copies no transcript. Cancellation retains the checkpoint; initialization failure retains a resumable handoff and never silently replays completed work. Lifecycle observers only provide hints and context high-water, never switch sessions.
