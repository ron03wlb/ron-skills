#!/usr/bin/env node
// .claude/settings.json 權限規則格式：Claude Code 對格式錯誤的規則只會略過並警告，不會失敗，
// 例如漏寫 Bash() 外層的 "python3 ..." 會靜默失效。本檢查讓這類規則在 push gate 就被擋下。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 工具名大寫開頭（Bash、Edit、WebFetch…）或 mcp__ 開頭，可帶一組 (...) 指定內容。
const RULE = /^(?:[A-Z][A-Za-z0-9]*|mcp__[A-Za-z0-9_-]+)(?:\(.+\))?$/;
const LISTS = ['allow', 'ask', 'deny'];

/** 回傳格式錯誤的規則：{ list, index, rule }。 */
export function invalidRules(settings) {
  const permissions = settings?.permissions ?? {};
  return LISTS.flatMap(list => (permissions[list] ?? [])
    .map((rule, index) => ({ list, index, rule }))
    .filter(({ rule }) => typeof rule !== 'string' || !RULE.test(rule)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? '.claude/settings.json';
  const problems = invalidRules(JSON.parse(readFileSync(file, 'utf8')));
  if (problems.length) {
    console.error(`${file} 有格式錯誤的權限規則（Claude Code 會略過不生效）；Bash 指令須寫成 Bash(<指令>)：\n`
      + problems.map(p => `permissions.${p.list}[${p.index}]：${JSON.stringify(p.rule)}`).join('\n'));
    process.exit(1);
  }
  console.log('Claude settings 權限規則格式檢查通過。');
}
