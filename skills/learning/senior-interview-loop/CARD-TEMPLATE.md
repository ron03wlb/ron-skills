# Practice Attempt Note template

Obsidian Markdown with frontmatter; the file path and field values come from the adapter. The H1 is the note title, in the adapter's title format; a paused note adds 「（暫停）」 to it and sets `status: paused`. Keep the note **scannable**: about 60 lines, one line per bullet, the attempt as key points rather than verbatim, and Formal Notes linked rather than restated. Omit a section only where marked optional; omit `miroUrl` until a Miro item exists.

```md
---
title: 練習｜<T 題 or question name>｜<YYYY-MM-DD>
type: practice-attempt
date: <YYYY-MM-DD>
tid: <T 題, empty when unbanked>
category: <adapter category>
status: <closed / paused>
miroUrl: <Miro item deep link>
---

# 練習｜<T 題 or question name>｜<YYYY-MM-DD>

## 摘要
- 題目：<generic wording> · <time box> · <language level>
- 結果：閉卷 <minutes> 分（全程 <total>）· <獨立 / 一般方向提示 / 關鍵提示或示範> · 平均 <score> → <passed / retrain>，下次 <date>
- 主要弱點：<first material gap>

## 我的作答（重點）
- ✅ <what the attempt got right>
- ❌ <misconceptions, in the user's own framing>
- ⚠️ <left unclear or not reached>

## 評分
| 評分點 | 概念 | 心智 | 應用 | 取捨 | 英文 |
| --- | --- | --- | --- | --- | --- |

## 要記住的修正（optional: when a model answer or correction was given）
1. <one correction per line>
教材：<[[Formal Note]] wikilinks>

## 背誦大綱（English）（optional: when the user asks for recall material）
1. "<one recitable interview sentence per line>"

## 下次（<next review date>）
<the Learning Checkpoint's recommended starting point, one line>

## Growth
<ledger file and T 題, or "BQ／英文：Current View 摘要">
```
