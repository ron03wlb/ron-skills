import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestSession, findSkillInvocation } from '../tools/transcript-retro/extract.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

function session(t, entries) {
  const dir = mkdtempSync(join(realTmpdir(), 'transcript-retro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, entries.map((e) => JSON.stringify({ timestamp: '2026-10-20T01:00:00.000Z', ...e })).join('\n'));
  return file;
}

const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } });

// 2026-10-20：截斷只留開頭時，worker 末行的 DONE 與串接指令最後的 deliver-archive 都被切掉，報告因此誤判為缺漏
test('digestSession：長文字與長指令截斷後仍保留結尾', (t) => {
  const summary = `#439 已交付為本機 candidate。${'說明內容。'.repeat(400)}\nDONE 439 4b14f45a922942987473d3a1b9358740c2409777`;
  const command = `cd /wt && ${'node scripts/check.mjs && '.repeat(60)}node scripts/deliver-archive.mjs 373`;
  const file = session(t, [
    user('/issue-run 439'),
    assistant({ type: 'tool_use', name: 'Bash', input: { command } }),
    assistant({ type: 'text', text: summary }),
  ]);
  const lines = digestSession(file).lines;
  const call = lines.find((l) => l.includes('CALL Bash'));
  const text = lines.find((l) => l.includes('ASSISTANT'));
  assert.match(call, /…\(\+\d+\)…/);
  assert.match(call, /deliver-archive\.mjs 373$/);
  assert.match(text, /…\(\+\d+\)…/);
  assert.match(text, /DONE 439 4b14f45a922942987473d3a1b9358740c2409777$/);
});

test('digestSession：遮蔽 secret，只列失敗的工具結果', (t) => {
  const file = session(t, [
    user('token=glpat-abcdefghijklmnop 幫我看'),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'fine' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'Exit code 1 boom' }] } },
  ]);
  const lines = digestSession(file).lines;
  assert.ok(lines.some((l) => l.includes('USER: token=<redacted>')), lines.join('\n'));
  assert.equal(lines.filter((l) => l.includes('TOOL-ERROR')).length, 1);
  assert.ok(!lines.join('\n').includes('glpat-'));
});

test('findSkillInvocation：使用者輸入或模型呼叫 Skill 都算，沒用過回 null', (t) => {
  const typed = session(t, [user('<command-message>issue-run</command-message>\n<command-name>/issue-run</command-name>\n<command-args>1</command-args>')]);
  const called = session(t, [user('跑 pilot'), assistant({ type: 'tool_use', name: 'Skill', input: { skill: 'issue-pilot' } })]);
  assert.equal(findSkillInvocation(typed, 'issue-run'), '2026-10-20T01:00:00.000Z');
  assert.equal(findSkillInvocation(called, 'issue-pilot'), '2026-10-20T01:00:00.000Z');
  assert.equal(findSkillInvocation(typed, 'issue-pilot'), null);
});
