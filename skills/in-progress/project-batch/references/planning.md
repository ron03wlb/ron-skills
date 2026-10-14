# Planning and publication

## Draft one BatchPlan

1. Read the confirmed `.project-batch/project.json` and current code/tests/rules; initialize first when missing. Ask only for unresolved scope, target, manual work or costly decisions. Do not rechoose a configured provider or infer HTTP from SSH.
2. Read [project/database contracts](database.md). Complete requirements, design, interfaces/data flow/errors/security/compatibility, schema/actual SQL, bounded implementation, test/cleanup mapping and risks before the single whole-plan confirmation. The script rebinds profile/rule/helper hashes and actual database baselines. Missing tooling or incomplete read-back is a blocker, not permission to guess.
3. Decompose by complete, observable behavior, not controller/service/DAO layers. A small single Issue has no parent. A multi-Issue plan publishes one ordinary parent listing its members, without paid hierarchy features.
4. Group ordered Issues into bounded sessions: one main domain, at most three Issues by default, including exploration, implementation, tests and repair costs. Split oversized behaviors; three large Issues are not a budget. Every Issue belongs to exactly one segment. Dependencies precede their consumers both within and across segments.
5. Save the complete structured draft through the script. Inspect its returned publish preview. Planning ends here; it creates neither remote Issues nor worktrees.

No-DB plan example (replace design and executable with actual complete repository evidence; tracker fields are supplied by the initialized profile):

```json
{
  "version": 1,
  "id": "payment-validation",
  "revision": 1,
  "planning": {
    "requirements": "Reject invalid input with documented observable errors",
    "design": "Validate at the input boundary before submission; retain valid behavior",
    "boundaries": "No provider, schema, deployment or public compatibility changes",
    "implementation": "Inspect the boundary, implement validation and its tests",
    "testing": "Run offline validation tests and the full offline suite; no DB fixtures",
    "risks": "Confirm legacy valid inputs still pass; stop for new schema requirements"
  },
  "database": {"version": 1, "targets": []},
  "title": "Validate payment input",
  "targetBranch": "main",
  "issues": [{
    "key": "validation",
    "title": "Reject invalid payment parameters",
    "goal": "Invalid input cannot reach submission",
    "scope": "Validate required fields and return documented errors",
    "exclusions": "No payment provider or deployment changes",
    "criteria": ["Invalid required fields return the documented error"],
    "dependsOn": [],
    "external": [],
    "prerequisites": [],
    "verify": [{"file": "npm", "args": ["test"], "timeoutMs": 300000, "effect": "offline"}]
  }],
  "segments": [{
    "id": "A",
    "domain": "payment",
    "issues": ["validation"],
    "effort": "Small: inspect validation, implement behavior, test and repair",
    "verificationCost": "Full test suite, about two minutes",
    "handoffCondition": "Acceptance recorded, then checkpoint and stop"
  }],
  "verify": [{"file": "npm", "args": ["test"], "timeoutMs": 300000, "effect": "offline"}]
}
```

`maxIssuesPerSegment` can explicitly change the default. Segment IDs `whole-batch` and `cross-domain` are reserved for review. Use stable Issue keys on revision. Each `external` entry is `{url, commit}`: a closed Issue in this selected project/provider plus its full Git commit already in the target baseline. Each manual prerequisite is `{id, description}`. This v1 project adapter does not infer cross-project dependency authorization.

Verification uses `{file,args,timeoutMs?,effect,envRefs?,database?}` arrays, with the worktree as cwd. They are confirmed executable commands, not evidence-supplied shell strings. Prefer direct test executables or existing package scripts; review any command capable of external mutation before including it. Aggregate verification is mandatory even when it repeats per-Issue tests.

## Publish

Run `publish <draft-id>` without a token. Show its entire plan and operation token to the human; after confirmation run the same operation with `--confirm <token>`. A stale token fails.

A single Issue is its own root and publishes the confirmed BatchPlan, including complete design/SQL, target branch, work segments and aggregate commands; no parent is created. Full catalog observations stay in the content-bound local plan; the published representation retains their identities/hashes and complete SQL, not a claim that remote records contain every catalog body. A multi-Issue parent publishes the same complete plan, revision and SHA256 semantics; children carry their specifications, shared target branch, segment and parent link.

The script checks the complete dependency/segment mapping, publishes members and parent using durable operation markers, and reads exact titles and descriptions back. Only complete publication becomes `ready`. Partial publication retains the same draft and markers. Re-enter the same operation; do not create a replacement batch to conceal an uncertain result.

An attempted create without a read-back marker is **uncertain**, not a failed create known to be safe to repeat. Investigate the exact selected-provider operation and reconcile its journal with the human before retry. Matching markers recover successful-but-lost responses; duplicate markers block. Never delete an attempted journal entry merely to get past the guard.

### Reconcile one attempted create

For an **unstarted draft** with an attempted create and no assigned IID, use `publish <draft-id> --reconcile-create <JSON-file>` from its clean target checkout. Begin with `{ "version": 1, "key": "@parent" }` (or the exact planned member key). This returns the complete original journal, exact next request and missing-evidence requirement, **without a token or retry authority**. A matching marker routes back to ordinary publish read-back; duplicate markers require reconciliation, not another create.

1. Obtain the human's explicit conclusion that this exact original POST created no Issue, with its actual basis. Empty searches, timeout, CLI exit or a local transport test alone do not establish that conclusion. Keep unresolved cases stopped; never author the human's evidence yourself.
2. Add `evidence: { "source": "human", "conclusion": "not_created", "description": "<the human-supplied basis for this exact POST>" }` to that file. Run the same recovery operation without `--confirm`; show the **complete** preview and obtain its separate exact confirmation.
3. Confirming recovery rechecks project/Git/request/marker identity, preserves the original attempt in versioned history and authorizes one identical retry. It performs no POST, start, commit or integration. Then obtain the ordinary publish preview/confirmation separately. Dispatch consumes that retry authority **before** POST; another uncertain result requires a new recovery, not replay of the old permission.

Legacy v1 attempts without HTTP receipts remain readable and explicitly unknown; confirmed recovery appends evidence rather than guessing their response or deleting them. Executing revisions, known-IID creates, pending notes and other journals are outside this narrow operation.

## Confirmed revision

Scope changes, adding/removing Issues, regrouping segments, changing target or upgrading an old published description format require a human-confirmed revised BatchPlan. Running batches are never silently republished in the new format. Checkpoint first and synchronize every original pending record before revision. Ordinarily no active Issue is allowed; an explicitly schema-stopped active Issue is preserved, dirty files included, while a complete SQL/design revision is confirmed. No pending test-data cleanup may be invalidated by a revision. `revise <batch-id> --input <next-plan.json>` previews old plan hash, new plan and exact next target. Confirm it, then publish the returned revision preview separately.

The ID/project remain fixed; revision increments by one. The same worktree and branch survive. All acceptance/review is invalidated for revalidation, and ownership is released for explicit resume. A changed target must already be an ancestor of the batch checkout: if not, the confirmed revision preparation records the exact target and stops for a manual merge there. Resolve/verify without automatic rebase, then retry the same revision. No revised tracker specification is published before this succeeds.

Single-to-multi publication adds the parent while retaining matching member IIDs. Removed members or a retired parent receive a revision note and remain for human disposition; they are neither secretly executed nor automatically closed by the revised batch. The current root command is returned after publication.
