#!/usr/bin/env node
// pilot 的 hold 旗標（PILOT-STORE.md 的 `.scratch/pilot/hold`）：檔案存在就是 hold，Integrate 前一步不 merge。
// 用法：node scripts/pilot-hold.mjs <checkout> show | set <reason> | clear
//   set 寫一行 JSON {since,reason,session}（session 取 $CLAUDE_CODE_SESSION_ID），已有 hold 時覆寫；reason 是一行、不含三個連續空白。
// stdout：show 印 `HOLD <since>   <reason>`（JSON 沒有 since 時 since 印 `(no since)`）、`HOLD (no reason)`（舊的空檔或內容讀不懂）或 `NO_HOLD`；
//   set 印 `HOLD_SET`；clear 印 `HOLD_CLEARED`，本來就沒有時印 `NO_HOLD`。exit 0；用法錯誤 exit 2。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isField, now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-hold.mjs <checkout> show | set <reason> | clear';
const [checkout, command, ...rest] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const file = join(storeDir(checkout), 'hold');

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
} else usage(USAGE);
