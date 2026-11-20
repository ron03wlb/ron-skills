---
name: session-handoff
description: For Orca bots only — before the owner opens a new Home chat, land the conversation's live state into the bot's own MEMORY.md and items and write a fixed snapshot at memory/session-handoff.md that the new chat picks up. Use when an Orca bot conversation grows long, the owner wants a new chat, or work reaches a stopping point. Not for handing work to another agent: a one-off handoff document is `handoff`, and continuing in a background agent is `claude-handoff`. User-facing output in Traditional Chinese.
---

# Session Handoff

Orca's `orca bot new-chat` is owner-only and a fresh Home chat auto-reads only SOUL.md + MEMORY.md. So before the chat turns over, this skill lands everything a new chat needs and writes one snapshot the new chat can pick up from. **Durable facts go to MEMORY.md/items; the snapshot is the ephemeral "where am I right now".** Talk to the owner in Traditional Chinese.

Run when the owner says they want a new chat or invokes `/session-handoff`. The bot may also run it on its own, without asking first, when the conversation has grown long or a unit of work reaches a stopping point (owner-approved, 2026-11-20). When it runs on its own, the step-4 summary opens with 「我先做了交接」 so the owner knows why. Landing to memory, items and the snapshot is reversible, so no confirmation is needed. This skill never runs `orca bot new-chat` itself: only the owner does that, after reading the summary in step 4.

## 0. Locate the bot home

The bot home is the folder holding this bot's SOUL.md and MEMORY.md (the primary working directory). Confirm MEMORY.md and the `memory/` directory exist there; the snapshot and any topic files are written under it. Done when the home path and MEMORY.md are confirmed.

## 1. Scan live state and categorize

Read the current conversation top-to-bottom and sort its still-live state into these buckets. Pull the machine-readable side from Orca, not memory:

- **進行中的交辦 / worker**：`orca bot work list` (worker, dispatch id, PR + CI, age) and anything in this chat handed to a worker. Record each as `dispatch:<id>` with its PR URL when known.
- **需 owner 的未決決策**：open questions waiting on the owner — each with one line of context and, where the answer is a known set, the options.
- **owner 新偏好 / 指示**：preferences or instructions the owner gave this chat that should outlive it (how to work, what to avoid, naming, cadence).
- **未完成的追蹤 / items**：`orca bot item list` — which deliverables are In progress / Needs you, and what each is waiting on.
- **下一步 TODO**：the concrete next actions, in order, with enough detail that a fresh context can start without re-deriving them.
- **在等誰回覆**：open threads waiting on a person, another bot, CI, or a deadline — name who/what and where the reply lands. Include any waits already set (`orca automations list`).

Done when every live thread in the conversation lands in exactly one bucket, with its Orca id/link attached where one exists.

## 2. Land the durable facts

Separate what must survive any chat (→ long-term memory) from what is only "current position" (→ snapshot, step 3).

- **MEMORY.md**: one line per fact, dated, newest first; details in `memory/<topic>.md`. Follow this bot's memory conventions. owner preferences/instructions → a `feedback` memory (with why + how-to-apply); ongoing work/goals/constraints not derivable from code or git → a `project` memory (convert relative dates to absolute). Do **not** store secrets, or things the repo/git already records. Check for an existing memory that covers it and update rather than duplicate; add the one-line pointer to MEMORY.md.
- **Items**: for each trackable deliverable or owner decision, `orca bot item add`/`item comment`/`item set` so it is visible after the chat turns over. Put a decision the owner must make on its item and set it to Needs you; link known workers/PRs with `orca bot item link`.

Done when nothing that must outlive this chat exists only in the conversation — it is in MEMORY.md, a topic file, or an item.

## 3. Write the handoff snapshot

Write the fixed-location snapshot `memory/session-handoff.md`. **Overwrite** the single current snapshot (durable facts already live in MEMORY.md/items, so the snapshot always reflects only "now"); if the outgoing one still has unfinished threads worth keeping verbatim, move it to `memory/handoffs/<YYYY-MM-DD>.md` first. Structure:

```markdown
# 交接快照

日期：<YYYY-MM-DD>　狀態：接續中
來源 chat：<orca session id if known>

## 現在進行到哪
- <2–5 lines: what was just done, what state the work is in>

## 下一步（接手先做這些）
1. <ordered concrete actions>

## 進行中的 worker / 交辦
- dispatch:<id> — <what> — <PR URL + CI state>

## open threads / 在等誰
- <who/what, where the reply lands, any wait automation id>

## 需 owner 決策
- <item #n / question, with options if known>

## 指標（給週報 C 欄）
- adopted / 關閉 issue / PR / 已做的可逆決策 / 需決策項 / 卡住 / 風險
```

Keep it skimmable — links and ids, not prose. Done when the snapshot is written and every step-1 bucket with live content appears in it.

## 4. Summary for the owner, then owner opens the new chat

Give the owner a short 交接摘要 in chat (Traditional Chinese): what was landed to memory/items, the snapshot path, the top 3 next steps, and anything waiting on them. Ask them to verify, then **the owner** opens the new chat with `orca bot new-chat` (bot/automation cannot). Do not open it yourself.

## 5. Picking up in the new chat

A fresh Home chat auto-reads SOUL.md + MEMORY.md only. For it to continue seamlessly it must also read `memory/session-handoff.md`. Two ways, in order of preference:

1. **SOUL.md line (the owner adds it by hand; this skill never writes SOUL.md)**: under `## How I work`, the line `- 開新 chat 先讀 memory/session-handoff.md（沒有就略過）：狀態是「接續中」就照「下一步」接續，接完把狀態改成「已接續」。`
2. **Fallback while a bot's SOUL.md lacks that line**: the step-4 summary ends with 「新 chat 請先讀 memory/session-handoff.md 接續」 for the owner to paste as the new chat's first message.

On pickup: read the snapshot, re-check each item/worker/thread is still live (item mail can repeat; a worker may have finished), do the "下一步", then set the snapshot 狀態 to `已接續` or refresh it for the next handoff. Done when the new chat has resumed the "下一步" and the snapshot reflects the new position.
