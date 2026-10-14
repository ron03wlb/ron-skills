# Native MySQL — read-only implementation, unfinished delivery

**Implementation is progressing; the original completion criteria are unchanged.** The explicitly selected `mysql-cli-v1` protocol implements an independently audited read-only collector and native exact-key data probes. Its source has offline tests, not real MySQL conformance. Native Batch planning/publication/application writes and `schema --qualify` remain blocked. The DML driver, settlement/cleanup integration, foreign-sentinel verification and qualification state machine are unfinished code work, not tasks that must wait for live resources.

Legacy profiles without `native.protocol` retain the earlier preflight-only behavior: even the named reader CALL is locally refused. No automatic protocol/profile/account upgrade occurs. Custom inspectors, `certified:true`, manually authored qualification files and matching hashes cannot unlock native delivery.

## Named-resource and human boundaries

Before live reads, obtain human authorization naming the existing nonproduction TCP endpoint, server UUID, actual exact native MySQL version, application/control schemas, reader account and approved client. No substitute database, container, checkout, account, tracker or Orca resource; no client installation, compatible-product fallback or version upgrade. MySQL 8.1–8.3 is an eligibility range, not cross-version conformance evidence. Source investigation uses the exact `mysql-8.3.0` upstream tag.

The human reviews and executes all SQL installation/account/grant/role/fault changes. A returned SQL hash identifies bytes, not consent. Separate application-test DML approval and actual qualification are still required; neither profile confirmation nor a read-only doctor pass supplies them. Publication, start, revision/takeover, new-session continuation and integration retain their separate confirmations.

## Profile

A database target's `native` branch replaces `inspect`/`inspectScript`, with no fallback. Common version-1 fields:

- `client:{path,version,sha256}`: absolute pinned executable, complete `mysql --version` output and byte hash.
- `endpoint:{host,port,serverUUID,tlsMode:"VERIFY_IDENTITY",caFile}`: approved TCP identity and absolute CA path. Target `identity` equals the UUID; `serverVersion` is the complete observed version.
- `principal:{user,host}` and `credentials:{readerFileRef,writerFileRef?}`: account names and environment-variable **names referencing owner-only absolute option-file paths**, never passwords. Files must be regular, nonsymlinked, owned by the current user and contain only `[client]`, `user=<approved-user>` and `password=<human-managed-value>`. No includes, hooks, plugins, login paths or alternate endpoints.
- `reader:{schema,name,definer:{user,host},definitionHash}`: explicitly named existing non-system control schema outside application scopes, fixed procedure, distinct locked definer and hash of the **exact native SHOW CREATE definition**. Only offline preparation may omit the definition hash.
- `authorization:{scope:"isolated-read-only",evidence}`: actual named-resource authorization. This is not DML authority.
- Optional `writer:{principal,hookScript,settleScript}` and `qualification:<repository-relative-reference>` participate in profile/source pinning. They do **not** provide an executable writer or qualification by being present.

Set **`protocol:"mysql-cli-v1"` explicitly** to select the new read-only implementation. Reconfirm the changed profile and separately review/install its changed SQL; the legacy reader body is not compatible. New collector snapshots require `lower_case_table_names=0` and `partial_revokes=0`. Assigned/default/mandatory roles are audited as a conservative full reachable grant closure; dangerous privilege paths, cycles, missing roles and admin delegation block CALL. Mandatory-role text currently requires explicit quoted `user@host` components; other grammar stops rather than guessing. Required metadata visibility grants must be direct on the approved roots, not inferred from potentially inactive roles.

New-protocol schema grant patterns escape literal `_`, `%` and backslash; metadata SQL uses literal hex scope predicates. BMP identifiers preserve backticks/newline/tab/CR; NUL, other controls, supplementary-Unicode identifiers and invalid surrogates stop. Metadata/data values support valid UTF8 including supplementary Unicode; data probes carry exact native column bytes as hex. Legacy scope/identifier/role limitations remain unchanged.

## Offline human SQL proposal

The same single public script emits candidates without a checkout, client or connection:

```bash
node /path/to/skills/skills/in-progress/project-batch/scripts/project-batch.mjs \
  init --prepare-reader --input /path/to/native-targets.json
```

Input is `{ "databases": [<explicit native target>] }`. Output includes SQL/body/target/source hashes and a human checklist; no profile write, SQL execution or confirmation token. `--confirm` and execution options are refused.

For `mysql-cli-v1`, the candidate fixes the creation SQL mode and UTF8 charset, proposes the named locked definer and parameterless reader in an **existing** control schema, and grants only the reviewed metadata scopes. The definer gets global REFERENCES for incoming-FK metadata visibility, SHOW_ROUTINE and scoped SELECT/SHOW VIEW/TRIGGER/EXECUTE/EVENT. It receives no global SELECT or account/grant administration. The caller gets scoped read authority, SHOW_ROUTINE, EXECUTE on this reader and **column-only SELECT** on known non-secret grant-table fields. A configured test profile additionally proposes read-only PROCESS authority and exact-table DML-only grants for its distinct writer.

Review the instance-wide account/role-name and grant-metadata exposure explicitly. No authentication-string/password columns are selected or granted. Locked is not a substitute for auditing effective permissions. On collision or partial installation, preserve receipts and stop: no automatic DROP/ALTER/REVOKE/retry or adoption. Any manual reconciliation is separately reviewed human SQL.

The new body has no caller parameters or arbitrary SQL interface. It reads fixed scoped catalog facets, then a cursor over native table/view/trigger/procedure/function/event inventory constructs **only quoted SHOW CREATE statements**. PREPARE/EXECUTE serve that fixed inventory, not caller SQL. Session settings expose quoted definitions and generated invisible primary keys. It performs no data/schema DML/DDL. Native readback hash, source body, definer, parameterless header and creation attributes must match before CALL.

## Doctor and native data reads

New-protocol `doctor` uses pinned native client bytes/version and restricted TLS/credentials. Each collection:

1. Reads actual version/product/UUID/principal/case/revoke semantics.
2. Directly reads all required non-secret account/grant/role facets **before CALL**, proves locked definer, conservative role closure, caller read-only and writer exact-table DML-only grants, and rejects dangerous/unknown grants.
3. Independently reads and checks the installed reader definition/source.
4. Calls the fixed reader, proving explicit empty facets, complete inventory/native definitions, supported field/type/constraint clauses and column coherence.
5. Repeats the pre-CALL proof and full collection, then reaudits authority; changed/incomplete results fail closed.

Logical snapshots preserve meaningful native definitions, precision/defaults/generated behavior, partitions, events and inbound keys. They exclude live AUTO_INCREMENT option counters without rewriting quoted literals or column AUTO_INCREMENT attributes. Unknown table clauses, malformed/truncated framing, hidden definitions/columns, wrong scope and concurrent schema/authority changes stop the attempt. This is implementation plus offline evidence, **not** a claim that every native grammar/facet/version has real conformance.

The internal `MySQLDatabase.readTarget` is read-only: it derives policy from fresh collected metadata, requires the approved full nonnullable unique key on a transactional base table, and uses a single READ ONLY consistent-snapshot transaction with explicit row/count framing. Every value is a string/null hex byte representation, not lossy numeric conversion. Fresh source/schema/authority checks surround the read. No user-supplied SQL or inspector assertion controls dispatch.

Each attempt persists owner-only evidence in Git metadata, including exact base64 stdout/hash/byte count **before decoding**, and partial stdout on transport failure. Credential/client stderr is withheld; earlier observations/attempts survive. New doctor returns `readerExecution:"native-audited"`, `permissionAudit:"native-role-closure"`, `ready:true`, `qualified:false` on successful read-only collection. Legacy doctor still returns blocked/unverified/false/false. These statuses do not authorize planning or writes.

## Native effect primitives — not an executable writer

Internal `mysql-fixtures.mjs` now supplies offline-tested policy/compilation and durable admission primitives using the **existing fixture ledger**, not another cleanup protocol:

- Native transactional/nonnullable/full unique-key validation; prefix/expression keys, triggers, inbound FK/cascade risk and enabled scoped events are refused rather than assumed isolated.
- Source/run/profile/database/purpose bindings, admitted process-incarnation metadata, durable exact absent-key intents, and irreversible closed admission. Legacy intent/created helpers cannot bypass native bookkeeping.
- Read-only exact-byte probe grammar and only structured insert/update/exact-intent cleanup SQL. Unknown SQL/DDL/columns/actors, generated/unreserved identity, ownership-key updates and out-of-range/coercive integer/decimal keys are refused. Exact string/binary keys are supported; other key types remain unsupported, not silently coerced.
- Initial-plus-two cleanup budget must already be durably consumed by the owning run before compilation; commit frames follow COMMIT, with no automatic retry or assumed rollback after response loss.

**These helpers compile SQL or update local ledger metadata; they do not dispatch DML.** Supplied actor/absence metadata is not, by itself, native process/session/ownership proof. Closed admission is not quiescence. The remaining driver must independently verify real process incarnations, complete queued/background writer settlement, native session/transaction readback, exact ownership, immutable fenced ledger and foreign sentinels before any cleanup dispatch. Boolean/helper/hash assertions cannot replace those checks. Native application execution remains hard-blocked, including with fake qualification files.

## Remaining implementation and acceptance

Resource-independent code work still includes the registered native CLI writer/lease and post-commit/unknown-outcome bridge; actual process/session/transaction fencing and durable hook settlement; sentinel baseline/post-cleanup proof; integration into the existing run journal, unchanged-ledger cleanup/retry/recovery and qualification-purpose state machine; full offline fault/recovery coverage; and fresh independent fixed-source review.

Only the live stage needs new named scopes and manual installation/readback receipts: one actual MySQL 8.1–8.3/client/profile-bound qualification; separately approved DML success/failure/timeout/cancel/crash/lost-response/late-writer/partial-cleanup/exhausted-retry conformance; then approved fresh local/GitLab/GitHub single/multi Orca/Pi delivery. Existing closed historical batches are not reusable acceptance resources. No native qualification or zero-residue receipt exists. Other six engines, SQLite guard, macOS and actual Linux CI remain unaccepted.

Source basis: exact [client/mysql.cc](https://github.com/mysql/mysql-server/blob/mysql-8.3.0/client/mysql.cc), [sql/sql_prepare.cc](https://github.com/mysql/mysql-server/blob/mysql-8.3.0/sql/sql_prepare.cc), [sql/item_func.cc](https://github.com/mysql/mysql-server/blob/mysql-8.3.0/sql/item_func.cc), [system views](https://github.com/mysql/mysql-server/tree/mysql-8.3.0/sql/dd/impl/system_views), [sql/sql_show.cc](https://github.com/mysql/mysql-server/blob/mysql-8.3.0/sql/sql_show.cc) and [sql/auth/sql_authorization.cc](https://github.com/mysql/mysql-server/blob/mysql-8.3.0/sql/auth/sql_authorization.cc). Source investigation is not native-server acceptance.
