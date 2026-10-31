#!/usr/bin/env node
// coordinator 照 adapter 自己跑、會寫外部系統的腳本，都要在 .claude/settings.json 有 Bash(node scripts/<name>:*) 放行規則；
// 缺了 auto mode 會擋成 External System Writes，coordinator 只好把 push、關單交給人（#96、#131）。
// 加新腳本只改 COORDINATOR_SCRIPTS；docs/agents/pilot.md 的 Permissions 條目要同步列出理由。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const COORDINATOR_SCRIPTS = ['gh-tracker.mjs', 'land.mjs', 'pilot-close.mjs'];

export const allowRule = name => `Bash(node scripts/${name}:*)`;

/** 回傳 permissions.allow 裡沒有放行規則的腳本名稱。 */
export function missingAllows(settings) {
  const allow = settings?.permissions?.allow ?? [];
  return COORDINATOR_SCRIPTS.filter(name => !allow.includes(allowRule(name)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? '.claude/settings.json';
  const missing = missingAllows(JSON.parse(readFileSync(file, 'utf8')));
  if (missing.length) {
    console.error(`${file} 的 permissions.allow 缺少 coordinator 腳本的放行規則（auto mode 會擋下，見 docs/agents/pilot.md 的 Permissions）：\n`
      + missing.map(name => `${name}：${allowRule(name)}`).join('\n'));
    process.exit(1);
  }
  console.log('coordinator 腳本放行規則檢查通過。');
}
