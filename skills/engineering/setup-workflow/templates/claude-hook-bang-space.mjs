#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Claude Code UserPromptSubmit hook：使用者訊息開頭多了空白的 `!` 指令提示（spay2 retro b10f5dc4#5 起源，ron-skills #346 升為正本）。
// Claude Code 只在輸入以 `!` 開頭時當 shell 指令執行；` ! node …/verify-728.mjs` 開頭多一個空格，被當一般訊息送給模型、指令沒有執行，使用者以為已跑過。
// 和「交給人的指令一律附 `!` 前綴」互補：人照抄時多帶的前導空白由這支補提示。
// 判定：stdin hook JSON 的 prompt 原文以空白（含 tab、換行、全形空白）開頭，trim 後以 `!` 開頭且 `!` 後還有內容。
// 輸出行：stdout 一行 JSON `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"BANG_LEADING_SPACE: …"}}`，
//   actionable：模型應先告訴使用者「看起來是 `!` 指令但前面有空白，沒有執行；請去掉開頭空白重送」，不要自己代跑該指令。
//   不擋下訊息（不輸出 decision）。
// 其他輸入（含 `! ls` 這種本來就會執行的、`請看 ! 這個` 這種中間有 `!` 的）exit 0 無輸出；stdin 不是 JSON 或 prompt 不是字串也 exit 0 無輸出。
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 使用者訊息若是開頭多了空白的 `!` 指令，回傳去掉前後空白後的指令；否則 null。
 * @param {unknown} prompt hook 輸入的 prompt 原文
 * @returns {string|null}
 */
export function leadingSpaceBang(prompt) {
  if (typeof prompt !== 'string' || !/^\s/.test(prompt)) return null;
  const trimmed = prompt.trimStart();
  return /^!\s*\S/.test(trimmed) ? trimmed.trimEnd() : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const command = leadingSpaceBang(input?.prompt);
  if (command === null) process.exit(0);
  const firstLine = command.split('\n')[0];
  const additionalContext = `BANG_LEADING_SPACE: 使用者這則訊息看起來是 \`!\` 指令（${firstLine}），但開頭多了空白，Claude Code 沒有執行它，而是當一般訊息送出。`
    + '請先以繁體中文告訴使用者：「看起來是 `!` 指令但前面有空白，沒有執行；請去掉開頭空白重送。」不要自行代跑這個指令。';
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } })}\n`);
}
