#!/usr/bin/env node
// /issue-pilot 的 Entry：這個 session 成為 coordinator 時登記自己（PILOT-STORE.md 的 `coordinator` 與 `sessions.md`），coordinator 不手寫這兩個檔。
// 步驟：sessions.md 有這個 session 的 handoff 行就是已退役，STOP → 改寫 `coordinator` 為 pid 行（原本就是同一個 pid 時保留 since）
//   → sessions.md 還沒有這個 session 的 start 行才附加（舊格式的 start 行也算）→ 以 pilot-sources --record 記錄傳入的來源。
// 用法：node scripts/pilot-register.mjs <checkout> --name <session name> --loop yes|no [--pid <pid>] [--session <id>] [<source>...]
//   pid、session 預設取 $CLAUDE_PID、$CLAUDE_CODE_SESSION_ID；name 是 ListAgents 印的 "This session is <name>"；source 照 pilot-sources。
// stdout：`REGISTERED pid <pid>   since <since>`，有附加 start 行時接 `SESSION_APPENDED`，再接 pilot-sources 的結果行（有傳來源時）；
//   已退役時只印 `STOP retired`。exit：0 成功；4 STOP；2 用法錯誤。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSources } from './pilot-sources.mjs';
import { isField, now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-register.mjs <checkout> --name <name> --loop yes|no [--pid <pid>] [--session <id>] [<source>...]';
const [checkout, ...args] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const options = { pid: process.env.CLAUDE_PID, session: process.env.CLAUDE_CODE_SESSION_ID };
const sources = [];
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) { sources.push(args[i]); continue; }
  const name = args[i].slice(2);
  if (!['name', 'loop', 'pid', 'session'].includes(name) || args[i + 1] === undefined) usage(USAGE, `參數錯誤：${args[i]}`);
  options[name] = args[++i];
}
if (!/^\d+$/.test(options.pid ?? '')) usage(USAGE, '缺少 pid（--pid 或 $CLAUDE_PID）');
if (!/^\S+$/.test(options.session ?? '')) usage(USAGE, '缺少 session（--session 或 $CLAUDE_CODE_SESSION_ID）');
if (!isField(options.name)) usage(USAGE, '缺少 --name，或含三個連續空白');
if (!['yes', 'no'].includes(options.loop)) usage(USAGE, '--loop 只能是 yes 或 no');

const dir = storeDir(checkout);
const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
const sessions = read('sessions.md').split('\n');
if (sessions.some(line => line.includes(`   handoff from-session ${options.session} `))) { console.log('STOP retired'); process.exit(4); }

const [, oldPid, oldSince] = read('coordinator').match(/^pid (\d+)\b.*?\bsince (\S+)/) ?? [];
const time = now();
const since = oldPid === options.pid && oldSince ? oldSince : time;
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'coordinator'), `pid ${options.pid}   loop ${options.loop}   since ${since}   name ${options.name}\n`);
console.log(`REGISTERED pid ${options.pid}   since ${since}`);

const started = sessions.some(line => line.includes(`   session ${options.session}   `) || (line.endsWith('  coordinator start') && line.includes(`  ${options.session}  `)));
if (!started) {
  const text = read('sessions.md');
  appendFileSync(join(dir, 'sessions.md'), `${text && !text.endsWith('\n') ? '\n' : ''}${time}   session ${options.session}   pid ${options.pid}   ${options.name}\n`);
  console.log('SESSION_APPENDED');
}
if (sources.length) for (const line of checkSources(checkout, sources, { record: true })) console.log(line);
