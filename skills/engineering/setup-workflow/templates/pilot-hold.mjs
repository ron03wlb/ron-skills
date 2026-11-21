#!/usr/bin/env node
// pilot 的 hold 旗標（PILOT-STORE.md 的 `.scratch/pilot/hold`）：檔案存在就是 hold，Integrate 前一步不 merge。
// 以及 main 暫停旗標（`.scratch/pilot/main-paused`，#379）：main 依決定暫停推送時，Probe 把 NOT_IN_MAIN／RESUME_PUSH 收成一行 MAIN_PAUSED，
// issue-pool 帶 --integration 時把 landed 桶收成 LANDED_COUNT；until 當天仍有效，過期自動失效（判斷在 issue-pool 的 mainPause，這支只寫）。
// 用法：node scripts/pilot-hold.mjs <checkout> show | set <reason> | clear | set-main <reason> --until <YYYY-MM-DD> | clear-main
//   set 寫一行 JSON {since,reason,session}（session 取 $CLAUDE_CODE_SESSION_ID），已有 hold 時覆寫；reason 是一行、不含三個連續空白。
//   set-main 寫一行 JSON {since,reason,until,session}，已有時覆寫；until 要是存在的日期、不早於本機今天。
// stdout：show 印 `HOLD <since>   <reason>`（JSON 沒有 since 時 since 印 `(no since)`）、`HOLD (no reason)`（舊的空檔或內容讀不懂）或 `NO_HOLD`；
//   set 印 `HOLD_SET`；clear 印 `HOLD_CLEARED`，本來就沒有時印 `NO_HOLD`；
//   set-main 印 `MAIN_PAUSE_SET`；clear-main 印 `MAIN_PAUSE_CLEARED`，本來就沒有時印 `NO_MAIN_PAUSE`。exit 0；用法錯誤 exit 2。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isField, now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-hold.mjs <checkout> show | set <reason> | clear | set-main <reason> --until <YYYY-MM-DD> | clear-main';
const [checkout, command, ...rest] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const file = join(storeDir(checkout), 'hold');
const mainFile = join(storeDir(checkout), 'main-paused');
// today、isDate 與 issue-pool.mjs 的 localDate、isDate 同一個判斷（讀端 mainPause 在那裡）；pilot-hold 在 L3 不一定帶著 issue-pool，所以各寫一份，改時兩邊一起改。
const pad = n => String(n).padStart(2, '0');
const today = (at => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`)(new Date());
const isDate = text => /^\d{4}-\d\d-\d\d$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;

if (command === 'show' && !rest.length) {
  if (!existsSync(file)) console.log('NO_HOLD');
  else {
    let value;
    try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 空檔或壞內容：仍是 hold */ }
    console.log(typeof value?.reason === 'string' && value.reason ? `HOLD ${typeof value.since === 'string' && value.since ? value.since : '(no since)'}   ${value.reason}` : 'HOLD (no reason)');
  }
} else if (command === 'set' && rest.length === 1 && isField(rest[0])) {
  mkdirSync(storeDir(checkout), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ since: now(), reason: rest[0], session: process.env.CLAUDE_CODE_SESSION_ID ?? '' })}\n`);
  console.log('HOLD_SET');
} else if (command === 'clear' && !rest.length) {
  console.log(existsSync(file) ? 'HOLD_CLEARED' : 'NO_HOLD');
  rmSync(file, { force: true });
} else if (command === 'set-main' && rest.length === 3 && rest[1] === '--until' && isField(rest[0]) && !rest[0].startsWith('--')
  && isDate(rest[2]) && rest[2] >= today) {
  mkdirSync(storeDir(checkout), { recursive: true });
  writeFileSync(mainFile, `${JSON.stringify({ since: now(), reason: rest[0], until: rest[2], session: process.env.CLAUDE_CODE_SESSION_ID ?? '' })}\n`);
  console.log('MAIN_PAUSE_SET');
} else if (command === 'clear-main' && !rest.length) {
  console.log(existsSync(mainFile) ? 'MAIN_PAUSE_CLEARED' : 'NO_MAIN_PAUSE');
  rmSync(mainFile, { force: true });
} else usage(USAGE);
