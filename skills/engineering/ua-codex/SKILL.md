---
name: ua-codex
description: "Run understand-anything's analysis agents through Codex in a fixed-size slot pool with a HEAD-drift gate: /ua-codex"
disable-model-invocation: true
---

Run the LLM phases of `/understand` (the understand-anything plugin) through **Codex** instead of Claude subagents: a **slot pool** of `codex exec` processes, each fed a dispatch file, gated so the working tree cannot drift under the analysis. Keep every deterministic step of `/understand` as written (scan, batching, merge, validate, fingerprints, save); this skill replaces only the agent dispatches.

Scripts live in `scripts/` next to this file; resolve the directory with `readlink -f ~/.claude/skills/ua-codex`. All read `PROJECT_ROOT` (default `pwd`), auto-resolve the data dir (`.ua/` or legacy `.understand-anything/`) and the newest installed plugin, and accept `CODEX_MODEL` (default `gpt-6.1-sol`), `CODEX_EFFORT` (default `high`), `UA_CODEX_JOBS` (default 5).

## Phase 2: file analysis

After `compute-batches.mjs` has written `intermediate/batches.json`, run in the background and wait for the single completion notification:

```bash
scripts/run-batches.sh --all
```

Done when the summary lists every batch index with `parts>=1` and `codex_exit=0`. A batch missing from the summary or marked `NO OUTPUT` reruns alone: `scripts/run-batch.sh <i>`. Resuming after an interruption uses `--pending`, which selects only batches with no `batch-<i>*.json` yet.

Each batch's `files`, `batchImportData` and `neighborMap` are written to `tmp/batch-input/batch-<i>.json` with a short dispatch file beside it; the Codex prompt points at those paths. Reuse the same shape for any custom dispatch: large inputs go in files, the prompt carries paths.

## Phases 3–5: review, layers, tour

Write the dispatch text to a file (inputs such as the file-node list, import edges, layers go in sibling JSON files, referenced by path), then:

```bash
scripts/run-agent.sh assemble-reviewer    tmp/assemble-review.prompt.md assemble-review
scripts/run-agent.sh architecture-analyzer tmp/architecture.prompt.md    architecture
scripts/run-agent.sh tour-builder          tmp/tour.prompt.md            tour
```

The script prints Codex's final message and leaves the full transcript at `tmp/codex/<tag>.log`. Normalize `layers.json` and `tour.json` exactly as `/understand` Phase 4 and 5 describe before assembling the graph.

## HEAD-drift gate

The first script invocation records `git rev-parse HEAD` in `tmp/codex/head.txt`; every later invocation compares against it. On a mismatch the script exits 3, prints the `git diff --name-status` between the two commits, and `run-batches.sh` stops launching new batches. Either reset the tree to the recorded commit, or treat the run as a new baseline: re-run `scan-project.mjs` + `extract-import-map.mjs` into `scan-result.json`, prune nodes of changed/deleted files from finished batch outputs, rebatch the changed set with `compute-batches.mjs --changed-files=<json>`, delete `head.txt`, then continue with `--pending`. For a long analysis, prefer running `/understand` in a detached worktree so the main tree stays free.

## Codex runtime flags

`run_codex` in `scripts/common.sh` is the single place the `codex exec` line lives: non-interactive, `workspace-write` sandbox, `project_doc_max_bytes=0` (the repo's `AGENTS.md` is irrelevant to graph analysis and would otherwise load into every batch), `--color never`, last message to `tmp/codex/<tag>.last.md`.
