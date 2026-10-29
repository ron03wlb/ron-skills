---
name: daily-summary
description: Summarise one day's Daily note in the Personal Life vault into its 🌙 晚間回顧 section, drafting from the day's records and agent sessions and asking the user for the parts only they know, then writing after the user confirms.
disable-model-invocation: true
---

# Daily Summary

`/daily-summary [YYYY-MM-DD]` closes one day: the note's own content becomes a filled 晚間回顧. **Evidence, not invention**: every line written traces to the note, the day's agent sessions, the vault's git history for that day, or the user's own reply. Talk to the user in Traditional Chinese.

## 0. Locate the note

1. Vault root: the current git root if it contains `.obsidian/daily-notes.json`, else `$PERSONAL_LIFE_ROOT`, else ask. Read the vault's `AGENTS.md` and honour its canonical-state gate; when it says fail closed, stop.
2. Read `.obsidian/daily-notes.json` for `folder`, `format` and `template`. The template file is the source of truth for section headings and prompt lines; read it every run.
3. Target date: the argument, else today.

Done when the note path is known and its content (or absence) is read. When the note is absent, offer to create it from the template, with `{{date:...}}` placeholders resolved; the vault's `AGENTS.md` decides where the parent folder may be created.

## 1. Gather evidence

Read from the note, quoting only what is there:

- 晨間意圖: the intended feeling, the most urgent responsibility, the smallest long-term step.
- 工作目標: checked `[x]` items are done; unchecked `[ ]` items with text are open; empty `- [ ]` lines are ignored. The checkboxes already say done or open, so they are context for matching, never content to restate.
- 工作紀錄 and 💡 靈感與反思: what was actually worked on or thought about.
- Agent sessions of that day, the main source for what work actually happened. The date is local time (UTC+8); session timestamps are UTC.
  - Claude Code: `~/.claude/projects/*/*.jsonl` and `/mnt/c/Users/ron.chang/.claude/projects/*/*.jsonl`, entries timestamped that day.
  - Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl`.
  - Per session take the project (directory name or `cwd`), the user's prompts, and outcomes such as PRs opened or merged, Issues closed, commits. Group sessions by project and task; skip sessions that did nothing.
- `git -C <vault> log --since=<date> --until=<date+1>` subjects: vault edits made that day (trip planning, finance updates…), as supporting signals only.

Done when the day's sessions are grouped into work items and each of the three morning intentions is matched to done, partial, open or no evidence.

## 2. Draft and ask

Split the 晚間回顧 prompt lines into two kinds:

- **Drafted** from evidence: 今日實際推進了什麼 (session work items and record highlights, morning intentions met); 可解決的問題 (concrete next steps from the records and sessions). Never copy 工作目標 items or annotate them with done/open wording; mention a goal only when sessions add what the checkbox does not, such as what was concretely delivered.
- **Asked**, since only the user knows them: 困難、挑戰與情緒, 可以肯定自己的是, 值得感恩的事情, 尚未處理的煩惱, 目前無法控制的擔憂. Ask all of them in one message, each with a one-line hint drawn from the evidence (for example, an open goal as a possible 困難). The user may answer, skip, or say 你寫; for 你寫, draft from evidence and mark the draft as yours in the proposal.

When ### English Practice has text, give brief corrections in chat; the note keeps the user's original unless they ask otherwise.

## 3. Propose, then wait

Show the filled 晚間回顧 section exactly as it will be written, then wait for an explicit yes (edits allowed). Also offer, as a separate yes/no: copy the open 工作目標 items into the next day's note (create it from the template if absent).

## 4. Write and read back

- Edit only the 晚間回顧 section, plus the next-day 工作目標 when accepted. Every other section stays byte-for-byte.
- Fill each prompt line after its `：`; several items go as nested bullets under it, using the indentation already in the note.
- A prompt line that already has text keeps it; append new items below it.
- When the note predates the template and lacks the section, insert the template's 晚間回顧 block at the template's position relative to the headings present.
- Write nothing else: no frontmatter changes, no git staging or commits.

Re-read the note and confirm the section matches the approved proposal. Finish by naming each file written.
