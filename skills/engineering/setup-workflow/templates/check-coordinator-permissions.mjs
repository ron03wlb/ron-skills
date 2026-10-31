#!/usr/bin/env node
// setup-workflow 正本：coordinator 照 adapter 自己跑、會寫外部系統的腳本，在 .claude/settings.json 的放行規則要與 /setup-workflow L3 的 push 那一題一致。
// 缺了 auto mode 會擋成 External System Writes，coordinator 只好把留言、關單交給人（ron-skills #96、#131）；
// push 答否時多了 land、pilot-close 的規則，則是讓 agent 自己 push、合併，越過人選的 Push gate（#244）。
// 用法：node scripts/check-coordinator-permissions.mjs [--push] [<settings>]（<settings> 預設 .claude/settings.json）
//   一律要有 gh-tracker.mjs 的放行規則；--push（push 答是）時 land.mjs、pilot-close.mjs 也要有，沒帶時兩者都不能有。
//   通過印一行、exit 0；不一致時 stderr 逐條列出、exit 1；旗標錯誤 exit 2。
// 規則一律是 `Bash(node scripts/<name>:*)`：比對的是在 repo 根執行的相對路徑。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TRACKER_SCRIPTS = ['gh-tracker.mjs'];
export const PUSH_SCRIPTS = ['land.mjs', 'pilot-close.mjs'];

export const allowRule = name => `Bash(node scripts/${name}:*)`;

/** missing：該有卻沒有放行規則的腳本；extra：push 答否時卻有放行規則的腳本。 */
export function permissionProblems(settings, { push = false } = {}) {
  const allow = settings?.permissions?.allow ?? [];
  const has = name => allow.includes(allowRule(name));
  const required = push ? [...TRACKER_SCRIPTS, ...PUSH_SCRIPTS] : TRACKER_SCRIPTS;
  return { missing: required.filter(name => !has(name)), extra: push ? [] : PUSH_SCRIPTS.filter(has) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const unknown = args.filter(arg => arg.startsWith('-') && arg !== '--push');
  if (unknown.length) { console.error(`check-coordinator-permissions: 不認得的旗標：${unknown.join(' ')}`); process.exit(2); }
  const push = args.includes('--push');
  const file = args.find(arg => !arg.startsWith('-')) ?? '.claude/settings.json';
  const { missing, extra } = permissionProblems(JSON.parse(readFileSync(file, 'utf8')), { push });
  const list = names => names.map(name => `${name}：${allowRule(name)}`).join('\n');
  if (missing.length) console.error(`${file} 的 permissions.allow 缺少 coordinator 腳本的放行規則（auto mode 會擋下）：\n${list(missing)}`);
  if (extra.length) console.error(`${file} 的 permissions.allow 放行了 push 與合併，但檢查沒帶 --push（setup-workflow L3 的 push 那一題答否）：拿掉這些規則，或把答案改成是、檢查加 --push：\n${list(extra)}`);
  if (missing.length || extra.length) process.exit(1);
  console.log(`coordinator 腳本放行規則檢查通過（push ${push ? '放行' : '交給人'}）。`);
}
