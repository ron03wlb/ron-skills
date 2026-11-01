// pilot 存檔（issue-pilot 的 PILOT-STORE.md）正本 script 共用的小工具：存檔目錄、時間格式、用法錯誤，以及 requests.md、gates.md 的解析（probe 與 pilot-request、pilot-gate 共用）。
// 存檔一律在 coordinator checkout 的 `.scratch/pilot/`；checkout 由呼叫者傳入，不寫死任何專案路徑。
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Push gate 的入口轉交：從主 checkout 的 `scripts/<x>.mjs` 跑時，改跑 stage worktree（分支是整合分支或 pilot/stage-*）的同名腳本，以它的 exit code 結束。
 * stage worktree 停在整合分支，就是要推的內容，推的 batch 改了這支腳本時 main 上的舊版會誤判（#239）；coordinator 不必自己從 porcelain 算路徑（#275：每任都手算，
 * awk 只比 pilot/integration 時，停在 pilot/stage-* 會撈空）。不是主 checkout 的副本（已在 stage worktree、正本、測試）、沒有 stage worktree、或那邊沒有這支腳本時直接返回，照常跑本檔。
 * @param {string} scriptUrl 呼叫端的 import.meta.url
 * @param {string[]} args 原樣轉交的參數
 * @param {{integration?: string}} [options] 整合分支名稱
 */
export function runInStageWorktree(scriptUrl, args, { integration = 'pilot/integration' } = {}) {
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (list.status !== 0) return;
  const trees = list.stdout.split(/\n\n+/).map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] })).filter(({ path }) => path);
  const self = realpathSync(fileURLToPath(scriptUrl));
  const main = trees[0]?.path;
  if (!main || !existsSync(main) || self !== join(realpathSync(main), 'scripts', basename(self))) return;
  const stage = trees.slice(1).find(({ path, branch }) => existsSync(path) && (branch === integration || branch?.startsWith('pilot/stage-')));
  const target = stage && join(stage.path, 'scripts', basename(self));
  if (!target || !existsSync(target)) return;
  process.exit(spawnSync(process.execPath, [target, ...args], { stdio: 'inherit' }).status ?? 1);
}

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

/** Markdown 表格一列的各欄（去掉首尾的 `|` 與空白）；不是表格列時回空陣列。 */
export const tableCells = line => line.split('|').slice(1, -1).map(cell => cell.trim());

const isMemberRow = line => tableCells(line).length >= 8 && /^\d+$/.test(tableCells(line)[0]);

/**
 * batch checkpoint 的行陣列裡成員全是 `moved …` 時，把 `current:` 就地寫成 `closed moved`；傳回這次是否改了。
 * pilot-batch 的 move／park 與 pilot-dispatch 的 --fresh 共用（#205：--fresh 搬走全部成員的舊 batch 留在 dispatched，status.md 一直列成開著）。
 */
export function closeIfAllMoved(lines) {
  const members = lines.filter(isMemberRow);
  if (!members.length || !members.every(line => /^moved\b/.test(tableCells(line)[6]))) return false;
  const i = lines.findIndex(line => /^current:/.test(line));
  if (i < 0 || /^current:\s*closed moved$/.test(lines[i])) return false;
  lines[i] = 'current: closed moved';
  return true;
}
/** gates.md 的每個 `## G<n>` 段落：id、標題行（不含 `## `）、內文、段落在檔案中的起訖位置（訖點是下一個 `## ` 或檔尾）。 */
export const gateSections = text => [...text.matchAll(/^## (G\d+\b.*)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)]
  .map(match => ({ id: match[1].match(/^G\d+/)[0], title: match[1].trim(), body: match[2], start: match.index, end: match.index + match[0].length }));
/** 表格形式的 gate 列（第一欄是 `G<n>`）的各欄；不是時回 undefined。 */
export const gateRow = line => (/^G\d+$/.test(tableCells(line)[0] ?? '') ? tableCells(line) : undefined);
/** 表格 gate 列的 status 欄（最後一欄）以 `resolved` 開頭。 */
export const isResolvedRow = cells => /^resolved\b/.test(cells.at(-1));
/** `## G<n>` 段落內文有 `- resolved …` 那一行（寫進別的欄位的 resolved 不算）。 */
export const isResolvedSection = body => /^- (?:G\d+ )?resolved\b/m.test(body);

/**
 * gates.md 還開著的 gate：表格 status 欄不以 `resolved` 開頭的列，或 `## G<n>` 段落裡沒有 `resolved` 那一行的 gate。
 * 每個 `{ line, id, issue, title, parked, opened, malformed }`：`line` 是 GATE 行去掉前綴的內容；表格列的 title 是 question 欄，段落的是標題去掉 id；
 * `parked` 是表格的 parks 欄或段落的 `- parked：` 那一行。
 */
export function openGates(text) {
  const gates = [];
  for (const cells of text.split('\n').map(gateRow)) {
    if (cells && !isResolvedRow(cells)) {
      gates.push({ line: `${cells[0]} ${cells[1]} ${cells[2]}`, id: cells[0], issue: cells[1], title: cells[2], parked: cells[5] ?? '', opened: cells[6] ?? '' });
    }
  }
  for (const { id, title, body } of gateSections(text)) {
    if (isResolvedSection(body)) continue;
    // resolved 寫進別的欄位（`- status：resolved …`）不算解除；指出那一行（retro a6）。
    const malformed = body.match(/^- [^：:\n]+[：:]\s*resolved\s+\d{4}-\d\d-\d\dT.*$/m)?.[0].trim();
    const field = name => body.match(new RegExp(`^- ${name}[：:]\\s*(.*)$`, 'm'))?.[1].trim() ?? '';
    gates.push({ line: title, id, issue: field('Issue').match(/#\d+/)?.[0] ?? '', title: title.slice(id.length).trim(), parked: field('parked'), opened: field('opened'), malformed });
  }
  return gates;
}

/** gate 的 parked 以固定寫法 `all-push` 開頭：擋住所有 push（例如 GitHub Actions 帳務），probe 把沒進主分支的 batch 合成一行 PUSH_PARKED（#136）。 */
export const parksAllPush = gate => /^all-push(?![\w-])/.test(gate.parked);

/** pilot-probe 與 pilot-gate list 印的 gate 行：每個開著的 gate 一行 `GATE <line>`，resolved 寫錯欄位的再加 `GATE_MALFORMED <id> <那一行>`。 */
export const gateLines = text => openGates(text)
  .flatMap(gate => [`GATE ${gate.line}`, ...(gate.malformed ? [`GATE_MALFORMED ${gate.id} ${gate.malformed}`] : [])]);
