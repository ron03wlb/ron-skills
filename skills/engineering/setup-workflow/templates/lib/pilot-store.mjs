// pilot 存檔（issue-pilot 的 PILOT-STORE.md）正本 script 共用的小工具：存檔目錄、時間格式、用法錯誤。
// 存檔一律在 coordinator checkout 的 `.scratch/pilot/`；checkout 由呼叫者傳入，不寫死任何專案路徑。
import { join, resolve } from 'node:path';

export const storeDir = checkout => join(resolve(checkout), '.scratch/pilot');

/** 帶本地時差的 ISO 8601，與 `date -Iseconds` 同形（2026-10-30T21:12:24+08:00）。 */
export function now(date = new Date()) {
  const pad = n => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(offset / 60)}:${pad(offset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

export function usage(text, message) {
  console.error(message ? `${message}\n${text}` : text);
  process.exit(2);
}

/** 欄位值不能含三個連續空白或換行（行格式以三個空白分欄）。 */
export const isField = value => typeof value === 'string' && value.trim() !== '' && !/ {3}|\n/.test(value);

/**
 * requests.md 的一行是不是還開著的 request：不是空行或 `#` 標題，而且最後一個 ` source ` 之後沒有 ` applied <字>`／` declined <字>`
 * （request 內文提到這兩個字或 source 都不算）。新格式以三個空白分欄，舊格式兩個空白，都接受。
 */
export const isOpenRequest = line => Boolean(line.trim()) && !line.startsWith('#')
  && !/\s(?:applied|declined)\s+\S/.test(line.split(/\ssource\s/).slice(1).at(-1) ?? '');
