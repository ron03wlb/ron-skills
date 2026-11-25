#!/usr/bin/env node
// 單行衝突的自動合併（#557）：PILOT-STORE.md 的 Canonical scripts 用法表、pilot-round.md 與 PILOT-ROUND-TEMPLATE.md 的
// `- **Probe.**`、pilot-exceptions.md 的 **Probe lines.** 這類一整行數 KB 的列，兩邊在同一列不同位置各改一段，git 就整列衝突；
// fresh 重做的 worker 每次手寫 difflib／word-diff 腳本合併（#345、#376、#379、#408、#466、#556）。不綁哪一份檔。
// 用法：node scripts/merge-line-inserts.mjs <檔>...（在 repo 內任一目錄跑；<檔> 相對目前目錄）
//   三方取自 index 的 stage 1／2／3（merge、cherry-pick、`git apply -3` 衝突後都有），以 diff3 重新合併後逐一處理衝突區塊：
//   區塊內兩邊對 base 的改動以行為單位對齊，不重疊的各自套用（相鄰沒改的列等於取 ours）；兩邊都換掉同一行時，
//   在行內以 token（英數字串、空白、其餘單一字元）比對，兩邊對 base 都只是插入或替換、改動不重疊也不相鄰、
//   而且每處改動連同前後錨點（最多 ANCHOR 個沒改的 token）在 base 與另一邊都恰好出現一次，才合併。
//   其他情況（改到同一段、錨點不唯一、一邊刪除另一邊改）保留該區塊的衝突（diff3 標記），印 LINE_CONFLICT。
//   每個 <檔> 印一行：
//     MERGED <檔> <區塊數>        衝突區塊全部合併，寫回工作樹
//     LINE_CONFLICT <檔> <行>     該區塊沒合，<行> 是寫回後 `<<<<<<<` 標記的行號；其餘區塊照樣合併寫回
//     NO_CONFLICT <檔>            index 沒有 stage 1／2／3，或工作樹已沒有衝突標記（已解過）：不動
//   只改工作樹，不 git add。
// exit：0 全部 MERGED 或 NO_CONFLICT；1 有 LINE_CONFLICT；2 用法錯誤、不在 git repo、三方之一不存在（一邊刪檔、兩邊新增）或不是 UTF-8 文字。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = '用法：node scripts/merge-line-inserts.mjs <檔>...';
/** 錨點：每處改動前後各取最多幾個沒改的 token（行內）或行（區塊內），不跨過任一邊的其他改動。 */
const ANCHOR = 8;
/** Myers diff 的編輯距離上限：兩版差太多（整列重寫）不值得逐字合併，當成衝突。 */
const MAX_EDITS = 4000;
const MARKER = 32;
const MARKER_LINE = new RegExp(`^([<|=>])\\1{${MARKER - 1}}`, 'm');

/** 行內 token：英數字串、空白串、其餘每個字元（含中文、標點、反引號）各一個；接起來等於原文。 */
const tokens = text => text.match(/[A-Za-z0-9_]+|\s+|[\s\S]/gu) ?? [];

/** 一份文字切成行，每行保留結尾的 `\n`。 */
const lines = text => text.split(/(?<=\n)/).filter(Boolean);

/**
 * a → b 的最短編輯（Myers），傳回 hunk 清單 [{ from, to, insert }]：a[from, to) 換成 insert（b 的 token 陣列）。
 * 編輯距離超過 MAX_EDITS 時傳回 undefined。
 */
export function diff(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const [n, m] = [A.length, B.length];
  if (!n && !m) return [];
  if (!n || !m) return [{ from: head, to: head + n, insert: B }];
  const limit = Math.min(n + m, MAX_EDITS);
  // v[k] 存在 v[k + offset]；trace[d] 是第 d 步開始前 k ∈ [-d-1, d+1] 的快照。
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) [x, y] = [x + 1, y + 1];
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;
  // 從終點往回走，記下每一步的刪除（x 前進）或插入（y 前進）。
  const edits = [];
  let [x, y] = [n, m];
  for (let d = found; d > 0; d--) {
    const snap = trace[d];
    const at = k => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) [x, y] = [x - 1, y - 1];
    edits.push(prevK === k + 1 ? { at: prevX, insert: B[prevY] } : { at: prevX, remove: true });
    [x, y] = [prevX, prevY];
  }
  edits.reverse();
  // 相鄰的刪除與插入併成 hunk（同一個 base 位置的連續編輯，或刪除緊接著刪除）。
  const hunks = [];
  for (const edit of edits) {
    const last = hunks.at(-1);
    const from = head + edit.at;
    if (last && from <= last.to) {
      if (edit.remove) last.to = from + 1;
      else last.insert.push(edit.insert);
    } else hunks.push(edit.remove ? { from, to: from + 1, insert: [] } : { from, to: from, insert: [edit.insert] });
  }
  return hunks;
}

/** 同一邊相隔不到幾個 token 的 hunk 併成一個（Myers 會拿零星的空白、短字對齊，把一段改寫切成碎片，碎片間的錨點太短）。 */
const GLUE = 4;

/** 行內 hunk 的碎片合併：同一邊兩個 hunk 之間沒改的 token 少於 GLUE 個時，併成一個替換（中間那段照原文放進 insert）。 */
function coalesce(hunks, base) {
  const out = [];
  for (const h of hunks) {
    const last = out.at(-1);
    if (last && h.from - last.to < GLUE) out[out.length - 1] = { from: last.from, to: h.to, insert: [...last.insert, ...base.slice(last.to, h.from), ...h.insert] };
    else out.push({ ...h, insert: [...h.insert] });
  }
  return out;
}

const same = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

/** needle 在 list 裡出現幾次（可重疊）。 */
function occurrences(list, needle) {
  if (!needle.length) return Infinity;
  let count = 0;
  for (let i = 0; i + needle.length <= list.length; i++) if (needle.every((item, j) => list[i + j] === item)) count++;
  return count;
}

/**
 * 三方序列合併：兩邊對 base 的 hunk 不重疊也不相鄰時都套用，兩邊相同的 hunk 只套一次。
 * nested(baseItem, oursItem, theirsItem) 給了時，兩邊都把同一個元素一對一換掉就交給它合（傳回 undefined 表示合不了）。
 * 每個 hunk 連同前後錨點在 base 與另一邊都要恰好出現一次（交給 nested 的不查，它自己查）。合不了傳回 undefined。
 */
function mergeSequence(base, ours, theirs, nested) {
  const [mine, yours] = [diff(base, ours), diff(base, theirs)].map(hunks => hunks && (nested ? hunks : coalesce(hunks, base)));
  if (!mine || !yours) return undefined;
  // 一對一的多元素替換拆成逐元素，讓兩邊各換不同列時不算重疊。
  const single = hunks => hunks.flatMap(h => (h.insert.length === h.to - h.from && h.insert.length > 1 ? h.insert.map((item, i) => ({ from: h.from + i, to: h.from + i + 1, insert: [item] })) : [h]));
  const sides = [single(mine).map(h => ({ ...h, other: theirs })), single(yours).map(h => ({ ...h, other: ours }))];
  const edits = [];
  for (const h of sides[0]) {
    const twin = sides[1].find(t => t.from === h.from && t.to === h.to && same(t.insert, h.insert));
    if (twin) {
      edits.push({ ...h, other: undefined });
      sides[1].splice(sides[1].indexOf(twin), 1);
    } else edits.push(h);
  }
  // 行內（沒有 nested）相鄰也算重疊；區塊內只有範圍相交、同一處都插入才算，相鄰兩列各改各的照合。
  const overlap = (h, t) =>
    nested ? (h.from < t.to && t.from < h.to) || (h.from === h.to && t.from === t.to && h.from === t.from) : h.from <= t.to && t.from <= h.to;
  for (const t of sides[1]) {
    const clash = edits.filter(h => overlap(h, t));
    if (!clash.length) {
      edits.push(t);
      continue;
    }
    const [h] = clash;
    const oneToOne = e => e.to - e.from === 1 && e.insert.length === 1;
    if (!nested || clash.length > 1 || h.other !== theirs || h.from !== t.from || !oneToOne(h) || !oneToOne(t)) return undefined;
    const item = nested(base[h.from], h.insert[0], t.insert[0]);
    if (item === undefined) return undefined;
    edits.splice(edits.indexOf(h), 1, { from: h.from, to: h.to, insert: [item], other: undefined });
  }
  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const [i, e] of edits.entries()) {
    if (!e.other) continue;
    const left = Math.max(e.from - ANCHOR, ...edits.slice(0, i).map(p => p.to), 0);
    const right = Math.min(e.to + ANCHOR, ...edits.slice(i + 1).map(n => n.from), base.length);
    const needle = base.slice(left, right);
    if (occurrences(base, needle) !== 1 || occurrences(e.other, needle) !== 1) return undefined;
  }
  const out = [...base];
  for (const e of [...edits].reverse()) out.splice(e.from, e.to - e.from, ...e.insert);
  return out;
}

/** 同一行兩邊都改：行尾換行三方一致時，以 token 合併行內文字。 */
function mergeLine(base, ours, theirs) {
  const eol = text => text.endsWith('\n');
  if (eol(ours) !== eol(base) || eol(theirs) !== eol(base)) return undefined;
  const strip = text => tokens(eol(base) ? text.slice(0, -1) : text);
  const merged = mergeSequence(strip(base), strip(ours), strip(theirs));
  return merged && merged.join('') + (eol(base) ? '\n' : '');
}

/** 一個衝突區塊（三方的文字）合併後的文字；合不了 undefined。 */
export function mergeBlock(base, ours, theirs) {
  const merged = mergeSequence(lines(base), lines(ours), lines(theirs), mergeLine);
  return merged && merged.join('');
}

/** diff3 標記的一個衝突區塊；eol 是 git merge-file 標記行的換行（CRLF 檔是 `\r\n`）。 */
const conflictBlock = ({ base, ours, theirs, eol }) => `<<<<<<< ours${eol}${ours}||||||| base${eol}${base}=======${eol}${theirs}>>>>>>> theirs${eol}`;

/**
 * 整份檔的三方合併：git merge-file 先合沒衝突的部分，每個衝突區塊再照 mergeBlock 合。
 * 傳回 { text, blocks（衝突區塊數）, conflicts（沒合的區塊在 text 裡 `<<<<<<<` 的行號） }；三方含 MARKER 長度的標記行時傳回 undefined。
 * 檔尾沒換行：三方都沒有時先各補一個再從結果去掉（git merge-file 會在標記前補換行，合併結果不能因此多一個）；
 * 三方不一致（有一邊加或去掉了檔尾換行）時每個區塊都保留衝突，不自動合併。
 */
export function mergeText(base, ours, theirs) {
  if ([base, ours, theirs].some(text => MARKER_LINE.test(text))) return undefined;
  const noEol = [base, ours, theirs].filter(text => text !== '' && !text.endsWith('\n')).length;
  if (noEol === 3) {
    const result = mergeText(`${base}\n`, `${ours}\n`, `${theirs}\n`);
    return result && { ...result, text: result.text.replace(/\r?\n$/, '') };
  }
  const resolve = noEol === 0;
  const dir = mkdtempSync(join(tmpdir(), 'merge-line-inserts-')); // portability-ok: 暫存檔只給 git merge-file 讀，路徑不外流
  try {
    const files = ['ours', 'base', 'theirs'].map(name => join(dir, name));
    [ours, base, theirs].forEach((text, i) => writeFileSync(files[i], text));
    const merged = spawnSync('git', ['merge-file', '-p', '--diff3', `--marker-size=${MARKER}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', ...files], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (merged.status === null || merged.status > 127) throw new Error(`git merge-file 失敗：${merged.stderr}`);
    let text = '';
    let blocks = 0;
    const conflicts = [];
    let hunk;
    for (const line of merged.stdout.split(/(?<=\n)/)) {
      const marker = line.replace(/\r?\n$/, '');
      if (!hunk && marker === `${'<'.repeat(MARKER)} ours`) hunk = { part: 'ours', ours: '', base: '', theirs: '', eol: line.slice(marker.length) };
      else if (hunk && marker === `${'|'.repeat(MARKER)} base`) hunk.part = 'base';
      else if (hunk && marker === '='.repeat(MARKER)) hunk.part = 'theirs';
      else if (hunk && marker === `${'>'.repeat(MARKER)} theirs`) {
        blocks++;
        const resolved = resolve ? mergeBlock(hunk.base, hunk.ours, hunk.theirs) : undefined;
        if (resolved === undefined) {
          conflicts.push(lines(text).length + 1);
          text += conflictBlock(hunk);
        } else text += resolved;
        hunk = undefined;
      } else if (hunk) hunk[hunk.part] += line;
      else text += line;
    }
    return { text, blocks, conflicts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在 cwd 跑 git，傳回 { status, stdout（Buffer） }；GIT_DIR 等不繼承，免得從 hook 裡呼叫時讀到別的 repo。 */
function gitRaw(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
  return spawnSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

/** 嚴格 UTF-8 解碼：無效位元組不換成 U+FFFD（寫回去會改壞兩邊都沒動的行）。 */
function utf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

/** 一個檔：傳回結果行與 exit code，寫回工作樹。 */
function mergeFile(cwd, path) {
  const staged = gitRaw(cwd, ['ls-files', '-u', '--', path]);
  if (staged.status !== 0) return { line: `${path}：git ls-files 失敗：${staged.stderr.toString().trim()}`, code: 2 };
  const stages = new Set(staged.stdout.toString().split('\n').filter(Boolean).map(row => row.split(/\s+/)[2]));
  const absolute = join(cwd, path);
  let current;
  try {
    current = readFileSync(absolute, 'utf8');
  } catch {
    current = '';
  }
  if (!stages.size || !/^<{7}( |$)/m.test(current)) return { line: `NO_CONFLICT ${path}`, code: 0 };
  if (!['1', '2', '3'].every(stage => stages.has(stage))) return { line: `${path}：index 缺 stage ${['1', '2', '3'].filter(s => !stages.has(s)).join('、')}（一邊刪檔或兩邊各自新增），不自動合併`, code: 2 };
  const [base, ours, theirs] = ['1', '2', '3'].map(stage => {
    const blob = gitRaw(cwd, ['show', `:${stage}:./${path}`]);
    return blob.status === 0 ? utf8(blob.stdout) : undefined;
  });
  if ([base, ours, theirs].includes(undefined)) return { line: `${path}：三方之一讀不到或不是 UTF-8 文字`, code: 2 };
  const result = mergeText(base, ours, theirs);
  if (!result) return { line: `${path}：內容本身有 ${MARKER} 字元長的衝突標記行，不自動合併`, code: 2 };
  writeFileSync(absolute, result.text);
  if (result.conflicts.length) return { line: result.conflicts.map(at => `LINE_CONFLICT ${path} ${at}`).join('\n'), code: 1 };
  return { line: `MERGED ${path} ${result.blocks}`, code: 0 };
}

function main(argv) {
  const files = argv.slice(2);
  if (!files.length) {
    console.error(USAGE);
    return 2;
  }
  const cwd = process.cwd();
  if (gitRaw(cwd, ['rev-parse', '--is-inside-work-tree']).status !== 0) {
    console.error(`不在 git repo：${cwd}`);
    return 2;
  }
  let code = 0;
  for (const path of files) {
    const result = mergeFile(cwd, path);
    if (result.code === 2) console.error(result.line);
    else console.log(result.line);
    code = Math.max(code, result.code);
  }
  return code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
