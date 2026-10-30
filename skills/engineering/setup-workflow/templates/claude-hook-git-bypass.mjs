#!/usr/bin/env node
// Claude Code PreToolUse hook（Bash）：拒絕繞過 git hook 的指令，例如 `git -c core.hooksPath=/dev/null commit`、`--no-verify`、`-n` commit。
// 整合分支的 reference-transaction guard 與 pre-push gate 都靠 git hook；繞過即失去保護。
// 另攔以 shell `&` 背景化的長等待指令（`--long-wait` 指定）：前景 Bash 裡的 `&` 工作結束時不會觸發 task notification，
// 必須改用 Bash tool 的 run_in_background。與 git 無關，但 settings.json 只有使用者能改，沿用這支既有的 Bash PreToolUse hook。
// 另攔要整份讀的指令（`--whole-output` 指定）以管線接 grep／head／tail：過濾會丟掉縮排明細行
// （文字規則寫了仍再犯，依「prose rules become scripts」改由 hook 擋，與背景化長等待指令同為拒絕）。
// 用法：node scripts/claude-hook-git-bypass.mjs [--long-wait <spec>]… [--whole-output <spec>]…
//   spec 是「script 名稱[ 旗標]」，例如 `watch.mjs` 或 `queue.mjs --wait`：帶旗標時同段指令要有該旗標才算。不帶時只攔 git 繞過。
// stdin 是 hook JSON（tool_input.command）；命中時 exit 2，stderr 交回 agent；其他情況 exit 0 不輸出。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 只比對 git 指令本身（前面是行首、空白或 shell 分隔符），字串、grep 與唯讀查詢不攔。
const BYPASS = [
  [/(^|[\s;&|(])git\b[^;&|]*\s-c\s*["']?core\.hooks[Pp]ath=/, '改寫 core.hooksPath'],
  [/(^|[\s;&|(])git\b[^;&|]*\sconfig\b(?![^;&|]*\s--(get|get-all|list|unset)\b)[^;&|]*\score\.hooks[Pp]ath\s+[^\s;&|]/, '改寫 core.hooksPath'],
  [/(^|[\s;&|(])git\b[^;&|]*\s--no-verify\b/, '--no-verify'],
  [/(^|[\s;&|(])git\b[^;&|]*\bcommit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/, 'git commit -n'],
];

/**
 * @param {string} command Bash tool 的完整指令
 * @returns {string|null} 命中的繞過方式；未命中為 null
 */
export function bypassReason(command) {
  for (const [pattern, reason] of BYPASS) if (pattern.test(command)) return reason;
  return null;
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** spec「script 名稱[ 旗標]」→ regex 片段：名稱本身，帶旗標時接同段指令內（不跨 `;`、`&`、`|`、換行）的 `\s<旗標>`。 */
function specPattern(spec) {
  const [script, flag] = spec.trim().split(/\s+/);
  return escape(script) + (flag ? String.raw`[^;&|\n]*\s${escape(flag)}(?![\w-])` : '');
}

// 長等待指令之後、同一段指令內（不跨 `;`、`|`、換行）出現單獨的 `&`：排除 `&&`、`2>&1`／`>&`、`&>`、`|&`。
// 若 `&&` 串起的整串最後以 `&` 結尾，整串都在背景，一樣攔。
const backgrounded = specs => new RegExp(`(${specs.map(specPattern).join('|')})[^;|\\n]*?(?<![&>|<])&(?![&>])`);

/**
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} specs 長等待指令的 spec
 * @returns {string|null} 以 `&` 背景化的長等待指令 spec；未命中為 null
 */
export function backgroundJobReason(command, specs = []) {
  if (!specs.length) return null;
  const match = backgrounded(specs).exec(command);
  return match ? specs.find(spec => new RegExp(`^${specPattern(spec)}`).test(match[1])) : null;
}

// 指令之後、同一段指令內（不跨 `;`、`&&`／`&`、換行；`2>&1` 等重導向不算）以 `|`（或 `|&`）接 grep／egrep／rg／head／tail（可帶路徑，
// 中間可經 tee 等其他管線）。指令前同段出現引號（例如 `grep "status.mjs --probe | grep" docs`）視為字串，不攔。
const FILTER = String.raw`\|&?\s*(?:\S*\/)?(?:e?grep|rg|head|tail)\b`;
const filtered = spec => new RegExp(String.raw`(?:^|[;&|\n(])[^;&|\n"']*?${specPattern(spec)}`
  + String.raw`(?:[^;&|\n]|(?<=[<>])&|\|(?!${FILTER}))*?(?<filter>${FILTER})`);

/**
 * @param {string} command Bash tool 的完整指令
 * @param {string[]} specs 要整份讀的指令 spec
 * @returns {string|null} 過濾輸出的指令名稱（grep／head／tail…）；未命中為 null
 */
export function probeFilterReason(command, specs = []) {
  for (const spec of specs) {
    const filter = filtered(spec).exec(command)?.groups.filter;
    if (filter) return /(e?grep|rg|head|tail)\b/.exec(filter)[1];
  }
  return null;
}

/** 輸出要整份讀而被過濾的 spec；未命中為 null。 */
function filteredSpec(command, specs) {
  return specs.find(spec => probeFilterReason(command, [spec])) ?? null;
}

/** argv 中所有 `<flag> <value>` 的 value。 */
const values = (args, flag) => args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let command = '';
  try { command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? ''; } catch { process.exit(0); }
  const reason = bypassReason(command);
  if (reason) {
    process.stderr.write(`拒絕：指令以 ${reason} 繞過 git hook。整合分支 guard 與 push gate 都在 hook 內；照常執行 git，讓 hook 跑完。hook 失敗時修正原因或回報使用者。\n`);
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const job = backgroundJobReason(command, values(args, '--long-wait'));
  if (job) {
    process.stderr.write(`拒絕：以 shell \`&\` 在前景 Bash 背景化 ${job}，結束時不會觸發 task notification。去掉 \`&\`，改用 Bash tool 的 run_in_background: true 執行同一指令。\n`);
    process.exit(2);
  }
  const whole = values(args, '--whole-output');
  const filter = probeFilterReason(command, whole);
  if (filter) {
    process.stderr.write(`拒絕：${filteredSpec(command, whole)} 的輸出以 ${filter} 過濾。這個輸出要整份讀：底下的縮排明細行會被濾掉，下一輪誤判為沒變。拿掉管線，直接執行。\n`);
    process.exit(2);
  }
}
