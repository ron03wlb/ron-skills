import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidRules } from './check-claude-settings.mjs';

test('工具名大寫開頭、mcp__ 開頭與帶 (...) 的規則都合法', () => {
  const settings = { permissions: {
    allow: ['Bash(git status:*)', 'Bash(orca terminal create *)', 'WebFetch', 'mcp__claude_ai_Linear__authenticate'],
    deny: ['Edit(.claude/settings*.json)'],
  } };
  assert.deepEqual(invalidRules(settings), []);
});
test('漏寫 Bash() 外層、小寫工具名與非字串規則列出所在清單與索引', () => {
  const settings = { permissions: {
    allow: ['Bash(ok)', 'python3 -B scripts/publish-docs.py --publish'],
    ask: ['bash(ls)'],
    deny: [42],
  } };
  assert.deepEqual(invalidRules(settings), [
    { list: 'allow', index: 1, rule: 'python3 -B scripts/publish-docs.py --publish' },
    { list: 'ask', index: 0, rule: 'bash(ls)' },
    { list: 'deny', index: 0, rule: 42 },
  ]);
});
test('沒有 permissions 時不報錯', () => {
  assert.deepEqual(invalidRules({}), []);
});
// repo 根由 git 找：本檔不論放在 scripts/ 或更深的目錄都檢查所在 repo 的設定。
test('repo 的 .claude/settings.json 規則格式皆合法', () => {
  const top = execFileSync('git', ['-C', fileURLToPath(new URL('.', import.meta.url)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  assert.deepEqual(invalidRules(JSON.parse(readFileSync(join(top, '.claude/settings.json'), 'utf8'))), []);
});
