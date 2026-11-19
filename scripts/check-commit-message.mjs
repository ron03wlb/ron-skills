#!/usr/bin/env node
// commit 訊息格式檢查：主旨後第二行要是空行（retro spay2 ff00a288#2：46134ee 以 `git commit -F -` 提交時 heredoc 第一行後沒空行，
// 整段條列成了主旨並已推送；pre-commit 只看工作樹，沒有任何訊息檢查）。規則同 spay2 scripts/check-commit-messages.mjs 的「第二行須為空行」。
// 用法：node scripts/check-commit-message.mjs <訊息檔>   （.githooks/commit-msg 傳 git 給的 $1；`#` 註解行與 scissors 以下不算）
//       node scripts/check-commit-message.mjs --rev <commit>   （讀已存在 commit 的 %B，查舊 commit 用）
// 輸出：
//   `COMMIT_MSG_SECOND_LINE <第二行前 60 字>` 到 stderr、exit 1（可動手：主旨後加一行空行再 commit；`-F -` 的 heredoc 第一行後要空一行）。
//   `SUBJECT_TOO_LONG <n> 字（advisory，上限 50）` 到 stdout、不影響 exit code（不可動手的提醒，比照 spay2 2026-11-19 使用者裁定先 advisory；
//     字數是 `<類型>(<範圍>): ` 之後的描述，全形半形各算 1）。
//   用法錯誤或讀不到訊息 exit 2。
// 啟用：.githooks/commit-msg 呼叫本檔；ron-skills 沒設 core.hooksPath，bin/sync-skills 把 .git/hooks/commit-msg 連到 .githooks/commit-msg（同 pre-commit，#300）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** `<類型>: <簡短描述>` 描述字數上限 */
export const SUBJECT_MAX = 50;
const PREFIX = /^\w+(?:\([^)]+\))?!?: /;
const SCISSORS = /^# -+ >8 -+$/;

/** git 存檔前會清掉的部分：scissors 以下、`#` 註解行、開頭空行與結尾空白。 */
export function cleanMessage(raw) {
  const lines = [];
  for (const line of String(raw).replace(/\r\n/g, '\n').split('\n')) {
    if (SCISSORS.test(line)) break;
    if (!line.startsWith('#')) lines.push(line.replace(/\s+$/, ''));
  }
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

/** 訊息 → { errors: string[], advisories: string[] } */
export function checkMessage(raw) {
  const lines = cleanMessage(raw);
  const errors = [];
  const advisories = [];
  if (lines.length > 1 && lines[1] !== '') errors.push(`COMMIT_MSG_SECOND_LINE ${[...lines[1]].slice(0, 60).join('').trimEnd()}`);
  const length = [...(lines[0] ?? '').replace(PREFIX, '')].length;
  if (length > SUBJECT_MAX) advisories.push(`SUBJECT_TOO_LONG ${length} 字（advisory，上限 ${SUBJECT_MAX}）`);
  return { errors, advisories };
}

function main(args) {
  let raw;
  if (args[0] === '--rev' && args.length === 2) {
    const log = spawnSync('git', ['log', '-1', '--format=%B', args[1], '--'], { encoding: 'utf8' });
    if (log.status !== 0) { process.stderr.write(log.stderr); return 2; }
    raw = log.stdout;
  } else if (args.length === 1 && !args[0].startsWith('--')) {
    try { raw = readFileSync(args[0], 'utf8'); } catch (error) { console.error(`check-commit-message: ${error.message}`); return 2; }
  } else {
    console.error('用法：node scripts/check-commit-message.mjs <訊息檔> | --rev <commit>');
    return 2;
  }
  const { errors, advisories } = checkMessage(raw);
  for (const line of advisories) console.log(line);
  for (const line of errors) console.error(line);
  if (errors.length) console.error('修正：主旨後加一行空行，內文從第三行開始（`git commit -F -` 的 heredoc 第一行後要空一行）。');
  return errors.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
