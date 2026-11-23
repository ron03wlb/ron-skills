// scripts/claude-hook-bot-chat-state.mjs：Orca bot 聊天的分頁狀態（事項 #89）。
import '../skills/engineering/setup-workflow/templates/test/isolate-orca-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { orcaReplySource } from '../skills/engineering/setup-workflow/templates/test/fake-orca.mjs';
import { botChatTarget, stateFor } from '../scripts/claude-hook-bot-chat-state.mjs';

const script = new URL('../scripts/claude-hook-bot-chat-state.mjs', import.meta.url).pathname;
const ID = 'b0b0b0b0-0000-4000-8000-000000000000';

test('botChatTarget：只認 cwd 在 bot 資料夾底下、帶 bot token 的 Orca 聊天', () => {
  const env = { ORCA_BOT_TOOLS_TOKEN: 't', ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: ID, BOT_CHAT_ROOT: '/h/.orca/bots' };
  assert.equal(botChatTarget(env, '/h/.orca/bots/ai'), `chat:${ID}`);
  assert.equal(botChatTarget(env, '/h/.orca/bots/ai/memory'), `chat:${ID}`);
  assert.equal(botChatTarget(env, '/h/code/repo'), null, 'bot 以外的資料夾');
  assert.equal(botChatTarget(env, '/h/.orca/bots'), null, 'bots 根目錄本身');
  assert.equal(botChatTarget(env, undefined), null);
  assert.equal(botChatTarget({ ...env, ORCA_TERMINAL_HANDLE: 'term_1' }, '/h/.orca/bots/ai'), null, 'terminal 分頁歸 repo 的 hook');
  assert.equal(botChatTarget({ ...env, ORCA_BOT_TOOLS_TOKEN: '' }, '/h/.orca/bots/ai'), null, '非 bot 的 Orca 聊天歸 repo 的 hook');
  assert.equal(botChatTarget({ ...env, ORCA_STRUCTURED_SESSION: '' }, '/h/.orca/bots/ai'), null);
});

test('stateFor：開工處理中；一輪結束 Home 維持處理中、其他聊天待關閉', () => {
  assert.equal(stateFor('UserPromptSubmit', true), '處理中');
  assert.equal(stateFor('UserPromptSubmit', false), '處理中');
  assert.equal(stateFor('Stop', true), '處理中');
  assert.equal(stateFor('Stop', false), '待關閉');
  assert.equal(stateFor('PostToolUse', false), null);
});

function fixture(t, { home, title }) {
  const temp = mkdtempSync(join(realTmpdir(), 'bot-chat-state-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bots = join(temp, 'bots');
  mkdirSync(join(bots, 'ai'), { recursive: true });
  const live = join(temp, 'title');
  const log = join(temp, 'orca.log');
  writeFileSync(live, title);
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const [a, b] = process.argv.slice(2); const arg = k => process.argv[process.argv.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (a === 'bot' && b === 'chats') reply('bot-chats', { chats: [{ id: ${JSON.stringify(ID)}, title: fs.readFileSync(${JSON.stringify(live)}, 'utf8'), home: ${home} }] });
else if (a === 'chat' && b === 'rename') { fs.writeFileSync(${JSON.stringify(live)}, arg('--name')); reply('chat-rename', { name: arg('--name') }); }
else fail('unexpected');
`);
  chmodSync(cli, 0o755);
  const env = {
    ...process.env, ORCA_CLI_COMMAND: cli, ORCA_BOT_TOOLS_TOKEN: 't', ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: ID,
    BOT_CHAT_ROOT: bots, TAB_STATE_DIR: join(temp, 'state'),
  };
  const hook = (event, cwd = join(bots, 'ai'), extra = {}) => spawnSync('node', [script], {
    input: JSON.stringify({ hook_event_name: event, cwd }), encoding: 'utf8', env: { ...env, ...extra },
  });
  const settle = async expected => {
    for (let i = 0; i < 100 && readFileSync(live, 'utf8') !== expected; i++) await sleep(50);
    return readFileSync(live, 'utf8');
  };
  return { live, log, hook, settle, env, temp };
}

test('排程開的聊天：開工換處理中、跑完換待關閉，原標題主體不動；hook 不輸出', async t => {
  const f = fixture(t, { home: false, title: '每晚 20:30 ron-skills 看板同步 run 1' });
  let result = f.hook('UserPromptSubmit');
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, '');
  assert.equal(await f.settle('處理中｜每晚 20:30 ron-skills 看板同步 run 1'), '處理中｜每晚 20:30 ron-skills 看板同步 run 1');
  result = f.hook('Stop');
  assert.equal(result.stdout + result.stderr, '');
  assert.equal(await f.settle('待關閉｜每晚 20:30 ron-skills 看板同步 run 1'), '待關閉｜每晚 20:30 ron-skills 看板同步 run 1');
  assert.match(readFileSync(f.log, 'utf8'), new RegExp(`^chat rename --session ${ID} --name 待關閉｜每晚 20:30 ron-skills 看板同步 run 1 --json$`, 'm'));
});

test('Home 聊天：一輪結束維持處理中；已是要的標題時不呼叫 rename', async t => {
  const f = fixture(t, { home: true, title: 'Home' });
  f.hook('UserPromptSubmit');
  assert.equal(await f.settle('處理中｜Home'), '處理中｜Home');
  writeFileSync(f.log, '');
  f.hook('Stop');
  for (let i = 0; i < 60 && !readFileSync(f.log, 'utf8').includes('bot chats'); i++) await sleep(50);
  await sleep(300);
  assert.equal(readFileSync(f.live, 'utf8'), '處理中｜Home');
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /chat rename/);
});

test('不是 bot 聊天：不呼叫 Orca、不寫狀態', async t => {
  const f = fixture(t, { home: false, title: 'x' });
  for (const result of [
    f.hook('Stop', f.temp),
    f.hook('Stop', undefined, { ORCA_TERMINAL_HANDLE: 'term_1' }),
    f.hook('Stop', undefined, { ORCA_BOT_TOOLS_TOKEN: '' }),
    f.hook('PostToolUse'),
  ]) assert.equal(result.status, 0);
  await sleep(500);
  assert.equal(readFileSync(f.log, 'utf8'), '');
  assert.equal(existsSync(join(f.temp, 'state')), false);
});

test('輸入不合法、Orca 失敗時安靜 exit 0', t => {
  const f = fixture(t, { home: false, title: 'x' });
  const result = spawnSync('node', [script], { input: 'not json', encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, '');
  const broken = spawnSync('node', [script, '--run', 'Stop', 'seq'], { encoding: 'utf8', env: { ...f.env, ORCA_CLI_COMMAND: join(f.temp, 'missing') } });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout + broken.stderr, '');
});

test('序號不是最新的子行程不改名（Stop 之後才跑完的 UserPromptSubmit 不蓋回處理中）', t => {
  const f = fixture(t, { home: false, title: '待關閉｜run 1' });
  mkdirSync(join(f.temp, 'state'), { recursive: true });
  writeFileSync(join(f.temp, 'state', `chat_${ID}.bot-seq`), 'newer');
  const result = spawnSync('node', [script, '--run', 'UserPromptSubmit', 'older'], { encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(f.live, 'utf8'), '待關閉｜run 1');
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /chat rename/);
});
