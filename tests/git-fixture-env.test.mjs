// #663：在長 Claude session 裡跑測試時，繼承的 CLAUDE_CODE_SESSION_ID 會讓 pilot-probe 讀到這個 session 的 transcript，
// context 超過門檻就多印 HANDOFF_DUE。git-fixture 的 env 要把 session 相關變數清掉，context 由測試自己用 PILOT_TRANSCRIPT 給。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { sessionContext } from '../scripts/pilot-probe.mjs';

const SESSION = '0e0e0e0e-6630-4663-8663-000000000663';

test('git-fixture 的 env：外層 session 指到超過 200000 的 transcript 時，probe 讀不到它', async t => {
  const config = mkdtempSync(join(realTmpdir(), 'git-fixture-env-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const transcript = join(config, 'projects/-repo', `${SESSION}.jsonl`);
  mkdirSync(join(config, 'projects/-repo'), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 250000 } } })}\n`);
  Object.assign(process.env, { CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: config, PILOT_TRANSCRIPT: transcript });
  assert.deepEqual(sessionContext(process.env), { tokens: 250001 }, '前提：外層 env 讀得到那份 transcript');

  const { env } = await import(`./helpers/git-fixture.mjs?${Date.now()}`);
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'PILOT_TRANSCRIPT']) assert.equal(env[key], undefined, key);
  assert.deepEqual(sessionContext(env), { warn: 'no CLAUDE_CODE_SESSION_ID or PILOT_TRANSCRIPT' });
});
