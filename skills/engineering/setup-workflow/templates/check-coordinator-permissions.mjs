#!/usr/bin/env node
// setup-workflow 正本：coordinator 照 adapter 自己跑、會寫外部系統的腳本，在 .claude/settings.json 的放行規則要與 /setup-workflow L3 的 push 那一題一致。
// 缺了 auto mode 會擋成 External System Writes，coordinator 只好把留言、關單交給人（ron-skills #96、#131）；
// push 答否時多了 land、pilot-close 的規則，則是讓 agent 自己 push、合併，越過人選的 Push gate（#244）。
// 用法：node scripts/check-coordinator-permissions.mjs [--push] [<settings>]（<settings> 預設 .claude/settings.json）
//   一律要有 gh-tracker.mjs 的放行規則；--push（push 答是）時 land.mjs、pilot-close.mjs 也要有，沒帶時兩者都不能有。
//   放行的腳本都要在 cwd（repo 根）的 scripts/ 下存在：放行不存在的路徑，等於預先放行之後放到那裡的任何腳本（#244 審查：pilot-close.mjs 在 #245 之前不是正本）。
//   通過印一行、exit 0；不一致時 stderr 逐條列出、exit 1；旗標錯誤 exit 2。
// 規則一律是 `Bash(node scripts/<name>:*)`：比對的是在 repo 根執行的相對路徑。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRACKER_SCRIPTS = ['gh-tracker.mjs'];
export const PUSH_SCRIPTS = ['land.mjs', 'pilot-close.mjs'];

export const allowRule = name => `Bash(node scripts/${name}:*)`;

/** missing：該有卻沒有放行規則的腳本；extra：push 答否時卻有放行規則的腳本；absent：有放行規則、檔案卻不存在的腳本（exists 判斷）。 */
export function permissionProblems(settings, { push = false, exists = () => true } = {}) {
  const allow = settings?.permissions?.allow ?? [];
  const has = name => allow.includes(allowRule(name));
  const [required, forbidden] = push ? [[...TRACKER_SCRIPTS, ...PUSH_SCRIPTS], []] : [TRACKER_SCRIPTS, PUSH_SCRIPTS];
  return {
    missing: required.filter(name => !has(name)),
    extra: forbidden.filter(has),
    absent: [...TRACKER_SCRIPTS, ...PUSH_SCRIPTS].filter(name => has(name) && !exists(name)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const unknown = args.filter(arg => arg.startsWith('-') && arg !== '--push');
  if (unknown.length) { console.error(`check-coordinator-permissions: 不認得的旗標：${unknown.join(' ')}`); process.exit(2); }
  const push = args.includes('--push');
  const file = args.find(arg => !arg.startsWith('-')) ?? '.claude/settings.json';
  const { missing, extra, absent } = permissionProblems(JSON.parse(readFileSync(file, 'utf8')), { push, exists: name => existsSync(join('scripts', name)) });
  const list = names => names.map(name => `${name}：${allowRule(name)}`).join('\n');
  if (missing.length) console.error(`${file} 的 permissions.allow 缺少 coordinator 腳本的放行規則（auto mode 會擋下）：\n${list(missing)}`);
  if (extra.length) console.error(`${file} 的 permissions.allow 放行了 push 與合併，但檢查沒帶 --push（setup-workflow L3 的 push 那一題答否）：拿掉這些規則，或把答案改成是、檢查加 --push：\n${list(extra)}`);
  if (absent.length) console.error(`${file} 的 permissions.allow 放行了 scripts/ 下不存在的腳本（先複製或寫好腳本再放行）：\n${list(absent)}`);
  if (missing.length || extra.length || absent.length) process.exit(1);
  console.log(`coordinator 腳本放行規則檢查通過（push ${push ? '放行' : '交給人'}）。`);
}
