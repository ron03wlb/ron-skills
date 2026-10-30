import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../skills/productivity/daily-summary/scripts/day-sessions.mjs', import.meta.url).pathname;

const user = (ts, content) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content } });
const codexMeta = (cwd) => JSON.stringify({ type: 'session_meta', payload: { cwd } });
const codexUser = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

/** 暫存的 Claude projects 與 Codex sessions 根目錄；當天為 2026-10-29（UTC+8）。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'day-sessions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claude = join(root, 'claude');
  const proj = join(claude, '-home-ron-code-spay2');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'aaaaaaaa-1.jsonl'), [
    user('2026-10-28T15:59:00Z', '前一天的 prompt'),
    user('2026-10-28T16:05:00Z', '<command-message>clear</command-message> <command-name>/clear</command-name> <command-args></command-args>'),
    user('2026-10-28T16:06:00Z', '<command-message>issue-queue</command-message> <command-name>/issue-queue</command-name> <command-args>細化 #671</command-args>'),
    user('2026-10-28T16:07:00Z', '<task-notification> <task-id>x</task-id> <status>completed</status>'),
    user('2026-10-28T16:08:00Z', [{ type: 'tool_result', content: 'ok' }]),
    user('2026-10-28T16:09:00Z', [{ type: 'text', text: '開一張\nready-for-human' }]),
    user('2026-10-29T16:00:00Z', '隔天的 prompt'),
  ].join('\n'));
  // 內容在當天、但 mtime 早於當天：模擬不會被讀到的舊檔。
  const stale = join(proj, 'bbbbbbbb-2.jsonl');
  writeFileSync(stale, user('2026-10-28T17:00:00Z', '舊檔'));
  const old = new Date('2026-10-01T00:00:00Z');
  utimesSync(stale, old, old);
  const codexDay = join(root, 'codex', '2026', '10', '29');
  mkdirSync(codexDay, { recursive: true });
  for (const [i, sha] of ['ce1e5148aa', '9d4ee491bb'].entries()) {
    writeFileSync(join(codexDay, `r${i}.jsonl`), [
      codexMeta(`/w/issue-${640 + i}`),
      codexUser('<environment_context>cwd</environment_context>'),
      codexUser(`Use the code-review skill. Fixed point: ${sha}`),
    ].join('\n'));
  }
  return { claude, codex: join(root, 'codex') };
}

function run(roots) {
  return spawnSync(process.execPath, [script, '2026-10-29', '--claude-root', roots.claude, '--codex-root', roots.codex], { encoding: 'utf8' });
}

test('只列當天的 prompt，濾掉 /clear、背景通知與 tool result', (t) => {
  const r = run(fixture(t));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^## -home-ron-code-spay2 \(1\)$/m);
  assert.match(r.stdout, /- 00:06 aaaaaaaa: \/issue-queue 細化 #671 \| 開一張 ready-for-human$/m);
  for (const noise of ['前一天', '隔天', '/clear', 'task-notification', 'tool_result', '舊檔']) {
    assert.doesNotMatch(r.stdout, new RegExp(noise));
  }
});

test('Codex 同類 worker 合成一行並計數，略過環境脈絡訊息', (t) => {
  const r = run(fixture(t));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^## codex \(2\)$/m);
  assert.match(r.stdout, /^- ×2 \(2 cwds\): Use the code-review skill\. Fixed point: #$/m);
  assert.doesNotMatch(r.stdout, /environment_context/);
});

// 2026-10-30 的 `! printf %s <32 位 hex> | gh secret set …` 原樣印出，值進了 daily-summary 的 context；以同形假值重現。
test('遮掉 prompt 裡的 token 與 hash，保留其餘指令', (t) => {
  const roots = fixture(t);
  writeFileSync(join(roots.claude, '-home-ron-code-spay2', 'cccccccc-3.jsonl'), [
    user('2026-10-28T17:00:00Z', `<bash-input>printf %s ${'0123456789abcdef'.repeat(2)} | gh secret set CLOUDFLARE_ACCOUNT_ID</bash-input>`),
    user('2026-10-28T17:01:00Z', `token 是 glpat-${'x'.repeat(20)}，hash $2b$12$${'a'.repeat(53)}`),
  ].join('\n'));
  const r = run(roots);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /- 01:00 cccccccc: ! printf %s <redacted> \| gh secret set CLOUDFLARE_ACCOUNT_ID \| token 是 <redacted>，hash <redacted>$/m);
});

test('缺日期參數時失敗', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: day-sessions\.mjs/);
});
