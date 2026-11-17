import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isHarnessText, isMostlyEnglish, isSyntheticEntry, lastTurnTexts, simplifiedChars, textsBeforeTool } from './claude-hook-language.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = fileURLToPath(new URL('./claude-hook-language.mjs', import.meta.url));
const hook = input => spawnSync('node', [script], { input, encoding: 'utf8' });

const user = content => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const toolResult = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const assistant = text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = id => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });

// session f236b357 jsonl 第 610 行的原句（#284）。
const SIMPLIFIED_LINE = '这一輪也沒事：池子是空的，沒有 worker 在跑，也沒有開著的 gate。下次 18:45 醒來再看。';

test('simplifiedChars：簡體字命中；繁體、繁簡同形、程式碼與「…」引用不算', () => {
  assert.deepEqual(simplifiedChars(SIMPLIFIED_LINE), ['这']);
  for (const text of [
    '這一輪也沒事：池子是空的。',
    '皇后住在公里之外，查一下後面的裡面。',
    '三段文字用了簡體的「这」開頭。',
    '`这` 在程式碼裡不算。',
  ]) assert.deepEqual(simplifiedChars(text), [], text);
});

test('Stop：本輪有簡體字的文字段時 exit 2，要求改用繁體', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'language-simplified-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 't.jsonl');
  writeFileSync(path, `${JSON.stringify({ type: 'user', message: { content: 'x' } })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: SIMPLIFIED_LINE }] } })}\n`);
  const result = hook(JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /語言檢查：本輪有 1 段使用者可見文字用了簡體字（这）/);
});

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
// #262：不靠固定毫秒數排時序（原本 setTimeout 60ms 後才 append，macOS runner 子行程啟動慢時第一次讀取晚於 append）。
// 子行程以 --import 載入 preload，hook 第一次讀完 transcript 就在同一個行程裡同步 append，所以 append 必定落在第一次讀取與重讀之間。
// 代價：append 必定早於重讀前的 RETRY_MS 等待，這裡驗的是「找不到 tool_use 會重讀並以重讀結果判斷」，不驗 RETRY_MS 夠不夠等到真實寫入（那由 .scratch 量測累積判斷）。
test('hook PostToolUse：觸發時文字段與 tool_use 都還沒寫入，稍後寫入時重讀抓到；有 .scratch 時記量測', async () => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [user('收 retro'), toolUse('t0'), toolResult()].join('\n') + '\n');
  mkdirSync(join(dir, '.scratch'));
  const preload = join(dir, 'append-after-first-read.mjs');
  writeFileSync(preload, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const read = fs.readFileSync;',
    'let pending = true;',
    'fs.readFileSync = function (path, ...rest) {',
    '  const out = read.call(this, path, ...rest);',
    '  if (pending && path === process.env.HOOK_TEST_TRANSCRIPT) { pending = false; fs.appendFileSync(path, process.env.HOOK_TEST_APPEND); }',
    '  return out;',
    '};',
    'syncBuiltinESMExports();',
  ].join('\n'));
  const toolUseId = 'toolu_01SEaAZoqmGaWd9tGQMEwb67';
  const lateLines = [assistant('All closed. Now handle the source tabs.'), toolUse(toolUseId)].join('\n') + '\n';
  const child = spawn('node', ['--import', pathToFileURL(preload).href, script], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOOK_TEST_TRANSCRIPT: transcript, HOOK_TEST_APPEND: lateLines },
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', transcript_path: transcript, tool_use_id: toolUseId }));
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 2);
  assert.match(Buffer.concat(stderr).toString(), /All closed/);
  // 擋下時另有一行 {at, hook_event_name, session_id, tool}（#938），量測是帶 first 的那一行
  const log = readFileSync(join(dir, '.scratch', 'language-hook.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => 'first' in entry);
  assert.equal(log.first.found, false);
  assert.equal(log.retry.found, true);
  assert.equal(log.tool, 'Bash');
});

// #901：子代理的 hook 輸入帶 agent_id／agent_type，transcript_path 卻指向父 session 的 transcript（2026-11-16 實測，Claude Code 2.1.325）；
// 原本子代理每次跑 Bash，PostToolUse 都引用協調者尾端的英文段（followups 625）。子代理自己的 transcript 在
// `<transcript 去掉 .jsonl>/subagents/agent-<agent_id>.jsonl`：讀得到只檢查它，讀不到就放行，任何情況都不引用父段落。
test('hook：子代理（agent_id）不引用父 transcript 的文字段，只檢查子代理自己的 transcript', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'claude-hook-language-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parent = join(dir, 'sess.jsonl');
  const parentText = "I've finished my own items: dispatching the subagent now.";
  writeFileSync(parent, [user('/retro-collect'), assistant(parentText)].join('\n'));
  const sub = (event = 'PostToolUse') => hook(JSON.stringify({ hook_event_name: event, tool_name: 'Bash', transcript_path: parent, tool_use_id: 'sub1',
    session_id: 'sess', agent_id: 'a1', agent_type: 'general-purpose', stop_hook_active: false }));

  for (const event of ['PostToolUse', 'Stop']) {
    const allowed = sub(event);
    assert.equal(allowed.status, 0, event);
    assert.equal(allowed.stdout + allowed.stderr, '', event);
  }
  const subTranscript = join(dir, 'sess', 'subagents', 'agent-a1.jsonl');
  mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
  writeFileSync(subTranscript, [user('跑測試'), assistant('先跑 echo。'), toolUse('sub1')].join('\n'));
  const chinese = sub();
  assert.equal(chinese.status, 0);
  assert.equal(chinese.stdout + chinese.stderr, '');
  writeFileSync(subTranscript, [user('跑測試'), assistant('Running the focused tests for the subagent now.'), toolUse('sub1')].join('\n'));
  const english = sub();
  assert.equal(english.status, 2);
  assert.match(english.stderr, /Running the focused tests/);
  assert.doesNotMatch(english.stderr, /finished my own items/);
});

// #938：PreToolUse 在工具執行前檢查這次工具呼叫前的文字段，命中就 exit 2（工具不執行）。
// preload 記錄 hook 讀 transcript 的次數（寫到 HOOK_TEST_READS），可選在第一次讀完後同步 append（HOOK_TEST_APPEND），
// 以讀取次數斷言「有沒有等待重讀」，不靠毫秒數排時序（#262）。
function preHook(dir, transcript, input, append = '') {
  const preload = join(dir, 'count-reads.mjs');
  writeFileSync(preload, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const read = fs.readFileSync;',
    'let reads = 0;',
    'fs.readFileSync = function (path, ...rest) {',
    '  const out = read.call(this, path, ...rest);',
    '  if (path === process.env.HOOK_TEST_TRANSCRIPT) {',
    '    reads += 1;',
    "    fs.writeFileSync(process.env.HOOK_TEST_READS, String(reads));",
    '    if (reads === 1 && process.env.HOOK_TEST_APPEND) fs.appendFileSync(path, process.env.HOOK_TEST_APPEND);',
    '  }',
    '  return out;',
    '};',
    'syncBuiltinESMExports();',
  ].join('\n'));
  const readsFile = join(dir, 'reads');
  rmSync(readsFile, { force: true });
  const result = spawnSync('node', ['--import', pathToFileURL(preload).href, script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sess-938', ...input }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOOK_TEST_TRANSCRIPT: transcript, HOOK_TEST_READS: readsFile, HOOK_TEST_APPEND: append },
  });
  let reads = 0;
  try { reads = Number(readFileSync(readsFile, 'utf8')); } catch { /* 沒讀過 transcript */ }
  return { ...result, reads };
}

// session d8f697a3 jsonl 第 587 行「Stop watcher, then hand off.」（去識別化），第 592／596 行才由 PostToolUse 擋下。
const STOP_WATCHER = 'Stop watcher, then hand off.';

test('hook PreToolUse：這次工具呼叫前的英文段 exit 2（工具不執行）；中文段 exit 0，不拿整輪的舊段落', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [user('/loop /issue-pilot'), assistant(STOP_WATCHER), toolUse('pre1')].join('\n') + '\n');
  const denied = preHook(dir, transcript, { transcript_path: transcript, tool_use_id: 'pre1' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /語言檢查：這次工具呼叫前有 1 段.*Stop watcher, then hand off/);
  assert.match(denied.stderr, /工具未執行/);
  assert.equal(denied.reads, 1);

  // 同一輪前面有英文段（已由別的事件處理過），這次工具前是中文：Stop 會抓整輪，PreToolUse 只看這一段
  writeFileSync(transcript, [user('/loop /issue-pilot'), assistant(STOP_WATCHER), toolUse('t0'), toolResult(), assistant('停掉 watcher，接著交接。'), toolUse('pre2')].join('\n') + '\n');
  const allowed = preHook(dir, transcript, { transcript_path: transcript, tool_use_id: 'pre2' });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout + allowed.stderr, '');
});

test('hook PreToolUse：Skill 立即 exit 0，不讀 transcript 也不等待', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [user('/loop /issue-pilot'), assistant('Dynamic mode. Invoke the skill now.')].join('\n') + '\n');
  const result = preHook(dir, transcript, { tool_name: 'Skill', transcript_path: transcript, tool_use_id: 'sk1' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, '');
  assert.equal(result.reads, 0);
});

test('hook PreToolUse：尾端沒有文字段時等待重讀一次；重讀抓到英文擋下，仍沒有就 exit 0', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 't.jsonl');
  const base = [user('收 retro'), toolUse('t0'), toolResult()].join('\n') + '\n';
  writeFileSync(transcript, base);
  const late = [assistant('Now #922 wontfix: parsers will be deleted in full.'), toolUse('pre3')].join('\n') + '\n';
  const denied = preHook(dir, transcript, { transcript_path: transcript, tool_use_id: 'pre3' }, late);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /Now #922 wontfix/);
  assert.equal(denied.reads, 2);

  writeFileSync(transcript, base);
  const never = preHook(dir, transcript, { transcript_path: transcript, tool_use_id: 'pre4' });
  assert.equal(never.status, 0);
  assert.equal(never.stdout + never.stderr, '');
  assert.equal(never.reads, 2);
});

test('hook PreToolUse：平行呼叫第二個不等待、讀不到 transcript、stop_hook_active、沒有 tool_use_id 時 exit 0', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [user('x'), assistant('All three workers DONE. Merging them into integration now.'), toolUse('p1'), toolUse('p2')].join('\n') + '\n');
  const second = preHook(dir, transcript, { transcript_path: transcript, tool_use_id: 'p2' });
  assert.equal(second.status, 0);
  assert.equal(second.reads, 1);
  for (const input of [
    { transcript_path: join(dir, 'missing.jsonl'), tool_use_id: 'p1' },
    { transcript_path: transcript, tool_use_id: 'p1', stop_hook_active: true },
    { transcript_path: transcript },
  ]) {
    const allowed = preHook(dir, transcript, input);
    assert.equal(allowed.status, 0, JSON.stringify(input));
    assert.equal(allowed.stdout + allowed.stderr, '', JSON.stringify(input));
  }
});

test('hook PreToolUse：子代理讀自己的 transcript，不引用父段落', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parent = join(dir, 'sess.jsonl');
  writeFileSync(parent, [user('/retro-collect'), assistant("I've finished my own items: dispatching the subagent now.")].join('\n') + '\n');
  const subTranscript = join(dir, 'sess', 'subagents', 'agent-a1.jsonl');
  mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
  writeFileSync(subTranscript, [user('跑測試'), assistant('先跑 echo。'), toolUse('sub1')].join('\n') + '\n');
  const input = { transcript_path: parent, tool_use_id: 'sub1', agent_id: 'a1', agent_type: 'general-purpose' };
  const chinese = preHook(dir, subTranscript, input);
  assert.equal(chinese.status, 0);
  assert.equal(chinese.stdout + chinese.stderr, '');
  writeFileSync(subTranscript, [user('跑測試'), assistant('Running the focused tests for the subagent now.'), toolUse('sub1')].join('\n') + '\n');
  const english = preHook(dir, subTranscript, input);
  assert.equal(english.status, 2);
  assert.match(english.stderr, /Running the focused tests/);
  assert.doesNotMatch(english.stderr, /finished my own items/);
});

// PreToolUse exit 2 在 transcript 留下的形狀（2026-11-17 實測，session 6c87c01e jsonl 第 210 行，claude-hook-main-checkout.mjs 擋下 Edit）：
// 沒有 hook_blocking_error attachment，只有一筆 is_error 的 tool_result，內容為 `PreToolUse:<工具> hook error: [<command>]: <stderr>`。
const preBlock = (id, sample) => JSON.stringify({ type: 'user', toolUseResult: 'Error: PreToolUse:Bash hook error: …',
  message: { role: 'user', content: [{ type: 'tool_result', is_error: true, tool_use_id: id,
    content: `PreToolUse:Bash hook error: [node "$CLAUDE_PROJECT_DIR/scripts/claude-hook-language.mjs"]: 語言檢查：這次工具呼叫前有 1 段使用者可見文字以英文為主（例：「${sample}」）。\n` }] } });

test('PreToolUse 擋下的段落：之後的 Stop 與該工具的 PostToolUse 不重提；別的 hook 的 PreToolUse 錯誤不算', t => {
  const english = 'Now #913 wontfix: set label, reread since, post note, close.';
  const blocked = [user('/loop'), assistant(english), toolUse('b1'), preBlock('b1', english)];
  assert.deepEqual(lastTurnTexts([...blocked, assistant('改用中文：設標籤後結案。'), toolUse('b2')].join('\n')), ['改用中文：設標籤後結案。']);
  const other = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, tool_use_id: 'b1',
    content: 'PreToolUse:Edit hook error: [node "$CLAUDE_PROJECT_DIR/scripts/claude-hook-main-checkout.mjs"]: 主 checkout 防護：…' }] } });
  assert.deepEqual(lastTurnTexts([user('/loop'), assistant(english), toolUse('b1'), other].join('\n')), [english]);

  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, blocked.join('\n') + '\n');
  for (const input of [
    { hook_event_name: 'Stop', transcript_path: transcript, stop_hook_active: false },
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', transcript_path: transcript, tool_use_id: 'b1' },
  ]) {
    const result = hook(JSON.stringify(input));
    assert.equal(result.status, 0, input.hook_event_name);
    assert.equal(result.stdout + result.stderr, '', input.hook_event_name);
  }
});

test('hook 擋下時在 .scratch/language-hook.log 記 session、hook 名稱與工具名，不含文字；沒有 .scratch 不寫', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [user('x'), assistant(STOP_WATCHER), toolUse('l1')].join('\n') + '\n');
  const noScratch = preHook(dir, transcript, { transcript_path: transcript, tool_use_id: 'l1' });
  assert.equal(noScratch.status, 2);
  assert.throws(() => readFileSync(join(dir, '.scratch', 'language-hook.log')));

  mkdirSync(join(dir, '.scratch'));
  const denied = preHook(dir, transcript, { transcript_path: transcript, tool_use_id: 'l1' });
  assert.equal(denied.status, 2);
  const log = readFileSync(join(dir, '.scratch', 'language-hook.log'), 'utf8');
  assert.doesNotMatch(log, /Stop watcher/);
  const blockLine = log.trim().split('\n').map(line => JSON.parse(line)).find(entry => !('first' in entry));
  assert.deepEqual(Object.keys(blockLine).sort(), ['at', 'hook_event_name', 'session_id', 'tool']);
  assert.deepEqual({ ...blockLine, at: typeof blockLine.at }, { at: 'string', hook_event_name: 'PreToolUse', session_id: 'sess-938', tool: 'Bash' });
});

test('PostToolUseFailure：PreToolUse 擋下紀錄在等待重讀期間才寫入時，重讀後也不重提', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'hook-language-pre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 't.jsonl');
  const english = 'Now #913 wontfix: set label, reread since, post note, close.';
  writeFileSync(transcript, [user('/loop'), assistant(english)].join('\n') + '\n');
  const late = [toolUse('b1'), preBlock('b1', english)].join('\n') + '\n';
  const result = preHook(dir, transcript, { hook_event_name: 'PostToolUseFailure', transcript_path: transcript, tool_use_id: 'b1' }, late);
  assert.equal(result.reads, 2);
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, '');
});
