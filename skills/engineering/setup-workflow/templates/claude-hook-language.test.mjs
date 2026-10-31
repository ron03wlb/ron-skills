import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHarnessText, isMostlyEnglish, isSyntheticEntry, lastTurnTexts, textsBeforeTool } from './claude-hook-language.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = fileURLToPath(new URL('./claude-hook-language.mjs', import.meta.url));
const hook = input => spawnSync('node', [script], { input, encoding: 'utf8' });

const user = content => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const toolResult = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const assistant = text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = id => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });

test('isMostlyEnglish：英文進度行命中', () => {
  // 2026-10-20 實例
  assert.equal(isMostlyEnglish('Both batches are in (issue-run 75/75, issue-pilot 18/18). Generating the two reports in parallel now.'), true);
  assert.equal(isMostlyEnglish('Rule changes noted (push handoff uses `推送指令` from check-before-push). Running Codex review.'), true);
  // 3–5 個英文單字、沒有中文的短句原本低於門檻
  assert.equal(isMostlyEnglish('Still running; nothing new.'), true);
  assert.equal(isMostlyEnglish('Now the tests.'), true);
});

test('isMostlyEnglish：中文句型夾技術名詞、程式碼與短句不命中', () => {
  for (const text of [
    '兩個 batch 都送出了，背景會等它們完成後自動取回結果。',
    'Fast check exit 0。跑 Docker focused（全部 `OverviewCompatibility*` integration tests）。',
    '執行 `node scripts/check-contracts.sh --verbose --no-cache` 與 /home/user/code/app/scripts/claude-hook-git-bypass.mjs。',
    '```bash\nnode analyze.mjs report --skill issue-run --repo ~/code/app\n```\n報告已產生。',
    'DONE 439 4b14f45a922942987473d3a1b9358740c2409777',
    'OK.',
    'Pushed.',
    'G32 open；#346 等人工。',
    '測試通過：Push and close。',
  ]) assert.equal(isMostlyEnglish(text), false, text);
});

test('lastTurnTexts：只取最後一個使用者輪之後的 assistant 文字，tool_use 與 tool_result 不切輪', () => {
  const jsonl = [
    user('第一個問題'), assistant('Old English answer that should be ignored entirely now.'),
    user('第二個問題'), assistant('第一段'), toolUse('t1'), toolResult(), assistant('第二段'),
  ].join('\n');
  assert.deepEqual(lastTurnTexts(jsonl), ['第一段', '第二段']);
});

test('textsBeforeTool：取緊接在該 tool_use 之前的文字段；平行呼叫第二個為空；找不到時取尾端文字段', () => {
  const jsonl = [
    user('問題'), assistant('前一段'), toolUse('t1'), toolResult(),
    assistant('Merged the branch. Now land the next one.'), toolUse('t2'), toolUse('t3'),
  ].join('\n');
  assert.deepEqual(textsBeforeTool(jsonl, 't1'), ['前一段']);
  assert.deepEqual(textsBeforeTool(jsonl, 't2'), ['Merged the branch. Now land the next one.']);
  assert.deepEqual(textsBeforeTool(jsonl, 't3'), []);
  assert.deepEqual(textsBeforeTool(jsonl, 'missing'), []);
  assert.deepEqual(textsBeforeTool(`${jsonl}\n${toolResult()}\n${assistant('尾端')}`, 'missing'), ['尾端']);
});

// #238：session 8d8ec702 jsonl 第 37 行的英文寫入了，第 38 行 Skill 的 tool_use 在 PostToolUse 觸發時還沒寫入，原本 exit 0、等到 Stop 才抓到
test('hook PostToolUse：transcript 還沒寫入這次 tool_use 時，檢查尾端的文字段', () => {
  const dir = mkdtempSync(join(realTmpdir(), 'claude-hook-language-'));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, [user('/loop /issue-pilot'), assistant('Dynamic mode. Invoke the skill now.')].join('\n'));
  const denied = hook(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Skill', transcript_path: transcript, tool_use_id: 'toolu_014EWebLkG3b61bqJjbLcFSg' }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /這次工具呼叫前.*Dynamic mode/);
});

test('hook：本輪有英文段落時 exit 2；已續跑一次、中文、輸入不合法時 exit 0 無輸出', () => {
  const dir = mkdtempSync(join(realTmpdir(), 'claude-hook-language-'));
  const english = join(dir, 'english.jsonl');
  writeFileSync(english, [user('進度？'), assistant('Both batches are in. Generating the two reports in parallel now.')].join('\n'));
  const chinese = join(dir, 'chinese.jsonl');
  writeFileSync(chinese, [user('進度？'), assistant('兩份報告正在背景產生。')].join('\n'));

  const denied = hook(JSON.stringify({ transcript_path: english, stop_hook_active: false }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /繁體中文/);
  for (const input of [
    JSON.stringify({ transcript_path: english, stop_hook_active: true }),
    JSON.stringify({ transcript_path: chinese, stop_hook_active: false }),
    JSON.stringify({ transcript_path: join(dir, 'missing.jsonl') }),
    'not json',
  ]) {
    const allowed = hook(input);
    assert.equal(allowed.status, 0, input);
    assert.equal(allowed.stdout + allowed.stderr, '', input);
  }
});

test('hook PostToolUse：工具呼叫前的英文進度行 exit 2；中文、平行呼叫第二個、找不到 tool_use 時 exit 0', () => {
  const dir = mkdtempSync(join(realTmpdir(), 'claude-hook-language-'));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, [
    user('進度？'), assistant('兩個 worker 都完成了，接著合入。'), toolUse('zh'), toolResult(),
    assistant('All three workers DONE. Merging them into integration now.'), toolUse('en'), toolUse('en2'),
  ].join('\n'));
  const post = (id, event = 'PostToolUse') => hook(JSON.stringify({ hook_event_name: event, transcript_path: transcript, tool_use_id: id }));

  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    const denied = post('en', event);
    assert.equal(denied.status, 2, event);
    assert.match(denied.stderr, /這次工具呼叫前.*All three workers DONE/);
  }
  for (const id of ['zh', 'en2', 'missing', undefined]) {
    const allowed = post(id);
    assert.equal(allowed.status, 0, String(id));
    assert.equal(allowed.stdout + allowed.stderr, '', String(id));
  }
  // Stop 仍檢查整輪：PostToolUse 提示過卻未改正的段落會再提一次
  const stop = hook(JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, stop_hook_active: false }));
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /本輪有 1 段/);
});

// 2026-10-23 某 transcript 的實際形狀（欄位節錄）
const LIMIT = "You've hit your weekly limit · resets 3am (Asia/Taipei)";
const synthetic = (text = LIMIT) => JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiError: 'usage_limit_reached',
  message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } });
const continuation = () => JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'auto-continuation' },
  message: { role: 'user', content: 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.' } });
const stopFeedback = sample => JSON.stringify({ type: 'user', isMeta: true,
  message: { role: 'user', content: `Stop hook feedback:\n[node "$CLAUDE_PROJECT_DIR/scripts/claude-hook-language.mjs"]: 語言檢查：本輪有 1 段使用者可見文字以英文為主（例：「${sample}」）。\n` } });
const postBlock = sample => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_blocking_error', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse',
  blockingError: { blockingError: `[node "$CLAUDE_PROJECT_DIR/scripts/claude-hook-language.mjs"]: 語言檢查：這次工具呼叫前有 1 段使用者可見文字以英文為主（例：「${sample}」）。`, command: 'node' } } });

test('isSyntheticEntry／isHarnessText：harness 合成項目與用量上限句型', () => {
  assert.equal(isSyntheticEntry(JSON.parse(synthetic())), true);
  assert.equal(isSyntheticEntry({ type: 'assistant', message: { model: '<synthetic>', content: [] } }), true);
  assert.equal(isSyntheticEntry(JSON.parse(assistant('一般回覆'))), false);
  for (const text of [LIMIT, 'You have hit your weekly limit · resets 3am', 'You’ve hit your session limit ∙ resets 5pm', "You've reached your usage limit",
    'Claude usage limit reached. Your limit will reset at 3am.', 'Your claude.ai usage limit has reset.', 'API Error: Connection lost mid-response']) {
    assert.equal(isHarnessText(text), true, text);
  }
  for (const text of ['Checked whether you have hit your weekly limit; it resets 3am but the runner keeps going anyway.', '語言檢查抓到 weekly limit 提示。',
    `${'Long English analysis sentence goes here. '.repeat(10)}You have hit your limit`]) {
    assert.equal(isHarnessText(text), false, text);
  }
});

test('lastTurnTexts／textsBeforeTool：略過合成的用量上限訊息，結構欄位缺漏時以句型略過', () => {
  const jsonl = [user('/loop'), synthetic(), continuation(), toolUse('t1'), toolResult(), assistant(LIMIT), assistant('接著探針。'), toolUse('t2')].join('\n');
  assert.deepEqual(lastTurnTexts(jsonl), ['接著探針。']);
  assert.deepEqual(textsBeforeTool(jsonl, 't1'), []);
  assert.deepEqual(textsBeforeTool(jsonl, 't2'), ['接著探針。']);
});

test('lastTurnTexts：本 hook 提示過（Stop feedback 或 PostToolUse blocking error）的段落不再重提', () => {
  const english = 'Merged the branch. Now land the next one please.';
  assert.deepEqual(lastTurnTexts([user('/loop'), assistant(english), stopFeedback(english), assistant('已改用中文說明。')].join('\n')), ['已改用中文說明。']);
  assert.deepEqual(lastTurnTexts([user('/loop'), assistant(english), toolUse('t1'), postBlock(english), toolResult()].join('\n')), []);
  // 別的 hook 的 Stop feedback 不算
  const other = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\n其他檢查' } });
  assert.deepEqual(lastTurnTexts([user('/loop'), assistant(english), other].join('\n')), [english]);
});

test('hook Stop：只有用量上限訊息、或英文段落已提示過一次時 exit 0', () => {
  const dir = mkdtempSync(join(realTmpdir(), 'claude-hook-language-'));
  const limit = join(dir, 'limit.jsonl');
  writeFileSync(limit, [user('/loop /issue-pilot'), synthetic(), continuation(), toolUse('t1'), toolResult(), assistant('額度恢復，繼續協調。')].join('\n'));
  const again = join(dir, 'again.jsonl');
  writeFileSync(again, [user('/loop'), assistant('Tracker reachable again; relaunching the watcher now.'), stopFeedback('Tracker reachable again'), assistant('Tracker 已可連線，重新啟動監看。')].join('\n'));
  for (const transcript of [limit, again]) {
    const result = hook(JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, stop_hook_active: false }));
    assert.equal(result.status, 0, transcript);
    assert.equal(result.stdout + result.stderr, '', transcript);
  }
  const post = hook(JSON.stringify({ hook_event_name: 'PostToolUse', transcript_path: limit, tool_use_id: 't1' }));
  assert.equal(post.status, 0);
  assert.equal(post.stdout + post.stderr, '');
});

// #250：session a0f6ae91 jsonl 第 598 行「All closed. Now handle the source tabs.」與第 599 行的 Bash tool_use，
// 在 PostToolUse 觸發時都還沒寫入（前 597 行跑 hook exit 0），尾端文字段是空的。找不到 tool_use 時重讀一次就抓得到。
test('hook PostToolUse：觸發時文字段與 tool_use 都還沒寫入，稍後寫入時重讀抓到；有 .scratch 時記量測', async () => {
  const dir = realTmpdir();
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [user('收 retro'), toolUse('t0'), toolResult()].join('\n') + '\n');
  mkdirSync(join(dir, '.scratch'));
  const child = spawn('node', [script], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', transcript_path: transcript, tool_use_id: 'toolu_01SEaAZoqmGaWd9tGQMEwb67' }));
  await new Promise(resolve => setTimeout(resolve, 60));
  appendFileSync(transcript, [assistant('All closed. Now handle the source tabs.'), toolUse('toolu_01SEaAZoqmGaWd9tGQMEwb67')].join('\n') + '\n');
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 2);
  assert.match(Buffer.concat(stderr).toString(), /All closed/);
  const log = JSON.parse(readFileSync(join(dir, '.scratch', 'language-hook.log'), 'utf8').trim());
  assert.equal(log.first.found, false);
  assert.equal(log.retry.found, true);
  assert.equal(log.tool, 'Bash');
});
