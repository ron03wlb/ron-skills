---
name: senior-interview-loop
description: Run one senior backend interview practice session (closed-book attempt, coaching, scoring), then file the evidence as a Growth Practice Attempt Note plus a 生活總控 practice record, and the mastery result to the Growth ledger, after the user confirms.
disable-model-invocation: true
---

# Senior Interview Loop

One session = one question practised to a confirmed close. **Routing, not mirroring**: each fact has one home. The raw attempt goes to one Growth **Practice Attempt Note** (private Markdown); the 生活總控 `kind: "practice"` record is an overview projection of it; current mastery lives only in the Growth validation ledger. Talk to the user in Traditional Chinese; coaching language follows `learn-professional-topics`.

## 0. Preflight

1. Locate the Growth root: the current git root if it contains `docs/agents/senior-interview-loop.md`, else `$GROWTH_ROOT`, else ask the user. Read that **adapter**: every path, ID, title format and threshold below comes from it, including the 〈練習證據〉 write order.

Done when the adapter is read.

## 1. Load state and pick the question

1. Read the Current View: this period's focus, the active adjustment, the check dates and the acceptance thresholds. If a check date has passed without a linked review, say so in one line ("回顧已到期") and continue; reviews belong to the user.
2. Pick the question, first match wins:
   1. the question the user named;
   2. the Current View focus;
   3. a ledger row whose `Next review` is due;
   4. the next `untested` T 題 in the learning-path step order.
   Earlier Practice Attempt Notes and company dossiers are question material, never a separate queue.
3. Read the matching ledger row, if any. Search the adapter's `practice/` directory for earlier notes on this T 題 or question; resume coaching from the newest note's 摘要, 評分 and 下次 sections, else start at Level 1. Only when no note exists, the adapter's read-only Heptabase fallback may supply the old card's 下次 section.

Done when the question, its T 題 (or "unbanked"), and the starting level are known.

## 2. Announce the unit

State the goal, the time box and the success criteria before any question. Time boxes: system design 60 min, algorithms 45 min, technical concept or BQ about 30 min, each plus debrief. Mention the Current View daily/weekly caps as a reminder only.

## 3. Closed-book attempt

**Output first**: the user answers before seeing any material, hint or model answer. Note the start time; when the user submits or time runs out, record the elapsed minutes (ask if unknown).

## 4. Coach and score

Invoke `learn-professional-topics` and run its method on this one topic: follow-ups, hint ladder, five-dimension scores with evidence, model answer only after two failed attempts plus a teach-back, Loss Function Loop. Track the **hint level** for the whole unit as the highest reached: `獨立` / `一般方向提示` / `關鍵提示或示範`. When explaining, link the existing Formal Notes; the session produces exactly one Practice Attempt Note.

**Time gate**: after each scoring checkpoint, state the elapsed time since the start. When the next checkpoint would cross the Current View daily cap, offer 暫存 before starting it.

Done when its Learning Checkpoint is produced.

## 5. Close: propose, then wait

Close at the end of the unit, or when the user says 暫存 or 結束. Show in chat, then wait for an explicit yes (edits allowed):

1. The Practice Attempt Note draft, per [CARD-TEMPLATE.md](CARD-TEMPLATE.md), and its file path from the adapter.
2. The ledger proposal under **Status rules** below, with the evidence for it.
3. For an unbanked question: the new T 題 row for the Mapping Matrix and the new ledger row.
4. For BQ or English: the proposed one-line update to the Current View summary.
5. The 生活總控 `kind: "practice"` record (fields per the adapter).

## 6. Write in order, read back each step

Follow the adapter's 〈練習證據〉 table for order and fields:

1. **Practice Attempt Note**: check the adapter's path first (an existing file for the same day and question gets the adapter's suffix, unless this is a resumed `paused` note, which is updated in place). Write the Markdown file, then re-read it.
2. **Growth**: grep for the T 題 before adding rows; then update the Mapping Matrix (new T 題 only), the ledger row (`Principal weakness` reads `<weakness>（練習 [[<note file name>]]）`), the ledger `updated` date, and the Current View BQ/English summary (BQ/English only). Re-read each file.
3. **生活總控 record**: upsert the `kind: "practice"` record keyed by `tid` (the question name when unbanked) in the adapter's artifact, appending this attempt to `attempts[]`; its `result` and `nextReview` match the ledger row. Read the record back.

On any failure, stop and report which steps landed and which did not; steps already written stay. Finish by listing every object written with its ID or path.

## Status rules

- `passed`: Level 3 promotion gate of `learn-professional-topics` met **and** hint level `獨立`, **and** the Current View threshold met (algorithms: unfamiliar Medium inside its stated minutes; system design: independent design inside its time box).
- `retrain`: attempted without meeting `passed`.
- Pass streak: +1 on `passed`, reset to 0 on `retrain`.
- Next review: `retrain` +3 days; streak 1 +7, streak 2 +21, streak 3 or more +60.
- Algorithms ledger rows are patterns (for example Sliding Window 變形題); the individual problem lives in the Practice Attempt Note.
- BQ and English have no ledger; their state is the Current View summary line.

## Boundaries

- Mastery is written to the Growth ledger only. The Practice Attempt Note carries dated scores and the next starting point, never a current-status field; its `status` frontmatter is only `closed` or `paused`. When the 生活總控 record and the ledger disagree, the ledger wins and the record is corrected.
- New understanding goes into the note's 要記住的修正 list and does not change Formal Notes by default. Only when the user explicitly asks at the close, write it into a Formal Note under the direct-write conditions the adapter cites, and name the changed sections in the note's Growth section.
- Current View priorities, focus and adjustments change only at the user's reviews.
- Company dossier questions are rewritten as generic questions before any write, without company names or dossier content: the 生活總控 record is outside Growth's private scope.
- Never write to Heptabase: no create, edit or delete. Old Practice Attempt Cards are read-only history.
