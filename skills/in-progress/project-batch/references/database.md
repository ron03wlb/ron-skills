# Project configuration, schema and automated test data

## Configure once, rebind every batch

Inspect Git remotes and current project instructions. Choose exactly one provider with the human: GitHub (`gh`), GitLab (`glab`) or local records (neither CLI). Multiple or enterprise origins require explicit selection. SSH does not establish an HTTP scheme. Never switch provider because a service is offline.

Run `init --input <setup.json>` in the target checkout. Show the complete returned profile/source preview, obtain confirmation, then repeat with `--confirm`. The script verifies remote identity read-only and writes only `.project-batch/project.json`; it never commits, installs a DB client or creates tracker records. Review/commit configuration with project conventions. Updating it also requires the displayed prior-profile hash and explicit confirmation. An active batch cannot silently inherit changed settings.

No-DB local example:

```json
{"id":"sample","tracker":{"provider":"local"},"standards":["AGENTS.md","README.md"],"databases":[]}
```

`init` fills `version`, `targetBranch`, `repositoryBase` and verified tracker identity. Remote trackers use `{provider,origin,projectPath,projectId?,remote?}`. `origin` is credential-free HTTP(S), with HTTPS and `owner/repository` for GitHub. Local binding is `local://<project-id>`; publication returns complete local Issue references. Local records and all journals live under `<git-common-dir>/project-batch/`, shared by this project's worktrees. They are workstation-local, not remotely published.

Custom database ports use `{id,engine,identity,serverVersion,scopes,inspectScript,inspect,test?}`. The optional MySQL `native` branch replaces (and forbids fallback to) `inspectScript`/`inspect`. Legacy profiles provide offline proposals/read-only preflight; explicitly selected `mysql-cli-v1` adds an independently audited native read-only collector and exact-key probes with offline coverage. **Native planning/publication/execution and `schema --qualify` remain blocked**, not certified: the executable writer/settlement/cleanup and qualification bridge are unfinished. Read [native MySQL prerequisites, interface and remaining implementation](mysql.md) before preparing reader SQL or configuring that branch. Supported **contract targets** are `mysql`, `mariadb`, `postgresql`, `sqlserver`, `oracle`, `sqlite`, `db2`. The repository owns the engine/version-specific native-client or JDBC inspector. This trial does **not** ship or certify seven native catalog collectors; unsupported versions, missing permissions, unknown coverage and truncated output must fail closed. Real collector/conformance validation is a completion blocker, not replaced by mock snapshots.

A command is `{file,args,timeoutMs?,envRefs?}`. `envRefs` maps a child environment name to a user-managed environment-variable **name**, never its value. Secrets belong neither in arguments/profile nor in records/logs. Only declared references and a small process baseline are passed to database commands; error text is redacted against those references. Inspectors must use read-only credentials, not the application writer's credentials.

`standards` must include all current rules and relevant schema/migration/ORM/helper dependency sources. Native MySQL additionally binds the internal adapter/dependency source hashes and any configured repository writer/settle/qualification references; storing those references does not make the missing native implementations available. `inspectScript` and test helpers are additionally source-hashed. Paths must remain within the repository. Hash pinning is not an OS sandbox or proof that a helper is safe: inspect and test its complete dependency/command chain before confirmation.

## Read-back protocol

The inspector emits one complete JSON object on stdout (diagnostics belong on stderr):

```json
{
  "version":1,"engine":"postgresql","identity":"isolated-test-db",
  "serverVersion":"ACTUAL_EXACT_VERSION","scopes":["public"],
  "readerReadOnly":true,"permissionEvidence":"Actual catalog/grant evidence",
  "testSchemaWrites":false,"testIsolated":true,
  "facets":{"tables":"complete","columns":"complete","constraints":"complete","indexes":"complete","views":"complete","triggers":"complete","sequences":"complete","routines":"complete","types":"complete","permissions":"complete"},
  "objects":[{"kind":"tables","schema":"public","name":"payments","definition":{"native":"COMPLETE_NATIVE_DEFINITION"}}]
}
```

This is a protocol example, **not** executable fixture SQL or acceptable real evidence. Populate actual definitions, columns/types/length/precision/null/default/generated behavior, keys/indexes, views/triggers/sequences/routines/types, native schema details and permissions. Empty facets mean a proven empty catalog result, not an omitted query. Allowed `not-applicable`: MySQL sequences/types; MariaDB types; SQLite sequences/routines/types/permissions. All other required facets must be complete. SQLite additionally needs an effective authorizer/statement guard denying test schema changes; a configuration boolean alone is not guard validation.

Canonicalization sorts object keys and schema objects, preserves definition-array order and meaningful native definitions, and rejects unsafe numeric values: use lossless strings for large/fractional metadata. Exclude volatile counters/statistics/instance IDs in the engine-specific collector without excluding meaningful schema drift. The engine/version/database/scope must match the profile exactly. Source hashes bind the inspector query set; version its native queries and test coverage explicitly in project sources.

## Complete planning and DDL-first gate

A profile-backed BatchPlan has nonempty `planning.requirements`, `design`, `boundaries`, `implementation`, `testing`, `risks`, plus every Issue's observable criteria and automatic verification. Resolve material design gaps before confirming the whole plan. Design covers interfaces/data flow/errors/security/compatibility; testing maps each behavior to commands, fixture ownership and cleanup.

`database` is `{version:1,targets:[{id,before,after,sql?}]}`; every configured database appears exactly once. Before/after are complete read-back-format snapshots. `plan` observes the actual baseline and binds profile/rule/source hashes. No-DB batches explicitly declare `targets:[]`; no-DDL batches use identical verified before/after snapshots. Schema differences require `sql:{text,hash}` containing actual ordered SQL and SHA256 of the exact text. Include target/environment/version, baseline/preconditions, expected schema, permission/backfill changes, risks and failure handling in the complete design; no unresolved placeholders. The script materializes content-bound SQL files in Git metadata, never executes them. Catalog bodies remain local; publication includes their identities/hashes and complete planned SQL.

After publication, `schema <root-ref>` observes actual schema read-only. The human executes the approved SQL, including test bootstrap, through their own tooling. Then supply `--input <evidence.json>`:

```json
{"planHash":"EXACT_CURRENT_PLAN_HASH","executions":[{"id":"test","sqlHash":"EXACT_APPROVED_SQL_HASH","evidence":"Human's actual execution evidence"}]}
```

Show and confirm that complete evidence/schema preview separately. Wrong environment, partial execution, missing grants or mismatched structure blocks implementation. Acknowledgement does not replace read-back. No AI DDL/retry/rollback, ORM bootstrap or expected-schema alteration to fit reality.

At start/resume, each work-item start, verification boundaries and preintegration, recheck the profile/source/schema freeze. A complete observation that drifts from a no-DDL baseline or an already attested SQL result creates a revision-sticky block; restoring the old schema does not clear it. Pending, not-yet-attested human SQL and transport failures remain distinguishable blockers, not automatic drift confirmation. New schema needs use `step --action schema-stop` with `{reason}`, then checkpoint dirty work. A complete revised plan is confirmed and published, its SQL human-applied, then new schema read-back confirmed. Only a schema-stopped active Issue may survive such revision; other scope changes require the ordinary idle revision boundary. No reset/stash or adoption of old work.

## Isolated application tests and cleanup

Every verification command declares `effect`: `offline`, `read-only` or `application-write`. Write tests also declare `database:<configured-id>`. DB access belongs only in a declared, approved command; do not label a mutating suite offline. There are **no manual DB-write tests**.

The database's `test` contract is `{isolated:true,ownership:"test-run-id",schemaWrites:false,targets,cleanup,cleanupScript,leftovers,leftoversScript}`. The application/test account is DML-only in a known isolated nonproduction DB; schema inspection uses a separate read-only account. Disable migrations, ORM auto-update/bootstrap and framework schema fixtures. Verify effective permission/statement guards with engine-specific conformance before running a real write suite. Project helpers must reject unknown/production identities and broad deletion.

Before test effects, the core saves a unique run (`purpose:"delivery"`) and JSON fixture ledger. Native qualification is not implemented and cannot masquerade as delivery acceptance. Test/cleanup/probe commands receive `GB_TEST_RUN_ID`, `GB_TEST_DATABASE_ID`, `GB_TEST_DATABASE_IDENTITY`, `GB_FIXTURE_LEDGER_PATH`. The profile's `test.targets` declares approved `{schema,table,keyColumns}` unique application identities. Await internal `scripts/lib/fixtures.mjs`'s `recordIntent(ledgerPath,{schema,table,key})` **before** an application effect, then `recordCreated(ledgerPath,intentId,{schema,table,key})` afterward. Ledger `intents` contain `{id,schema,table,key}`; `created` contains `{intentId,schema,table,key}`. Each exact selector must match an approved target/key-column set; duplicates, missing intent, changed IDs, symlinked ledgers and unresolved writers fail closed. Journal relationships/derived/async data as additional exact intents before their effects. Generated-only IDs require a project-specific safe reservation/reconciliation bridge using existing unique application identities; response-only or guessed-prefix ownership is insufficient. The core validates the ledger itself, not only helper counts. Prefer valid rollback; otherwise use application deletion or a test-only, run-owned scoped cleaner. No table-wide DELETE, TRUNCATE/DROP, guessed date/prefix ownership or new product schema merely for cleanup. Soft deletion is insufficient when owned rows remain.

The read-only `leftovers` helper returns `{version:1,testRunId,databaseId,identity,readerReadOnly:true,quiescent:true,remaining:<nonnegative-safe-integer>,ledgerHash,coveredIntents,ownershipEvidence,writerEvidence}`. Hash is SHA256 of the parsed ledger JSON; `coveredIntents` is the sorted complete intent-ID array. Evidence strings identify actual unique-key/ownership and writer-completion observations; they are not magic proof or a replacement for certified native helpers. It must prove writer completion and exact ledger ownership, including asynchronous effects, not merely observe no active process. Cleanup returns `{version:1,testRunId,databaseId,identity,scope:"owned-test-data",removed:<nonnegative-safe-integer>,ledgerHash,coveredIntents}`. It must delete only the ledger's approved exact selectors. Core binds both probes/deletion to the unchanged validated ledger and checks quiescence before deletion, then remaining **zero**, and schema unchanged. No-intent/zero-row runs never dispatch a cleaner; unknown rows without intents have no deletion authority. Native helper honesty, actual key uniqueness and effective writer/async guards still require engine-specific conformance, not booleans alone. Exit zero alone is insufficient.

Failed tests still attempt cleanup. Interruptions/abort may prevent cleanup from completing; the durable pending run survives and blocks acceptance/new write tests. Controlled `project_batch_checkpoint` with `action:"cleanup"` recovers only the same run under current identity/schema/ownership checks. No concurrent writer adoption. Maximum destructive dispatches are initial cleanup plus two safe retries, durably consumed before dispatch; exhausted authority stops with the ledger intact. A changed plan/profile cannot silently reuse prior cleanup authority. Record exact evidence and obtain separately scoped recovery, not edit the journal to bypass it.

Each persisted `VerificationResult` receipt binds source fingerprint, profile/plan/SQL-package/schema hashes, command/output identity and, for application writes, exact `testRunId` plus ledger-bound `CleanupResult`. Acceptance/aggregate verification retains that receipt with the command log, not a detached pass boolean. Changed inputs invalidate evidence. Do not report complete environmental acceptance until real catalog, effective guards, test failure/cancellation/crash recovery, zero-residue checks and all applicable platform/tracker/Orca/Pi flows have actual receipts.
