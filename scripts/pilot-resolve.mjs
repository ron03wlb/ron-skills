// ron-skills 專屬的 pilot-land resolver（setup-workflow 正本 scripts/pilot-land.mjs 的 `--resolver`，#245）：
// Stage 與 sync-main 的衝突，正本只自己解 workflow-templates.json 的 restamp；其他檔交給這支照 docs/agents/pilot.md 的 Stage 條目允許的解法解：
//   additions  每個衝突 hunk 的 base 是空的（兩邊只在既有檔案的同一處新增，沒有相同的非空行或同名條目）：依號碼兩段都留下；
//   entries    每個衝突 hunk 裡兩邊改的是不同的 `- **<名稱>.**` 條目：各取改過的那一版（#45）；
//   rows       衝突 hunk 三份的行都是 Markdown 表格列（`|` 開頭）、以第一格為鍵兩邊改的是不同列：各取各的版本、
//              依原順序排好，新增的列都留下；同一列兩邊都改照樣 abort（#162）。
//   adjacent   衝突 hunk 裡一邊只改了 base 的某幾行、另一邊只在 base 行之間插入新行（沒改任何 base 行），插入點不在
//              改動的那幾行中間：兩邊都套用；純刪除、兩邊動到同一個 `- **<名稱>.**` 條目（含插入的新條目切開它）、
//              兩邊都改了同一個 base 行、改動或插入碰到表格列（歸 rows）、最短 diff 的對齊不只一種而合出不同結果
//              （接上 hunk 前後各一行）、換上的行和插入的行相同（非空行或同名條目）、碰到檔尾沒換行的行照樣 abort（#175）。
//   additions、entries、rows 與 adjacent 只解三個版本都是 UTF-8 文字的檔案，其他的照樣 abort。
//   流程站戳記 scripts/workflow-doc-sync.json（STAMP_FILES）：其他衝突檔都解完之後由 restamp 重算；land.mjs 的 scripts/restamp.mjs 也用它（#72、#173）。
//   STOP conflict 的種類：Markdown 檔解不了的 hunk 裡兩邊都改的 `- **<名稱>.**` 條目是 `entry <名稱>`（#192）；其他交回正本判斷（code／other）。
// 契約（正本檔頭）：KINDS 是解法名稱的順序；resolveFile(tree, path, kinds) 傳回合併後的文字或 undefined；conflictKind(tree, path) 傳回種類或 undefined；
//   STAMP_FILES 與 restamp(tree, files)。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = 32;
const MARKER_LINE = new RegExp(`^([<|=>])\\1{${MARKER - 1}}`, 'm');
const DOC_SYNC = 'scripts/workflow-doc-sync.json';
// 從 pre-commit hook 或 worktree 呼叫時繼承的 GIT_DIR 等會讓 git -C 讀寫到別的 repo。
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));

/** 流程站戳記檔：正本在其他衝突檔都解完之後呼叫 restamp。 */
export const STAMP_FILES = [DOC_SYNC];

/** RESOLVED 行裡解法名稱的順序（正本照這個排，restamp 一律最後）。 */
export const KINDS = ['additions', 'entries', 'rows', 'adjacent'];

// 在 tree 跑子行程（流程站戳記用）。
const runIn = (cwd, command, args) => spawnSync(command, args, { cwd, encoding: 'utf8', env: childEnv });

/**
 * 重算流程站戳記並 git add：取目標分支（--theirs）版本，有 build-workflow-site.mjs 就重產 docs/workflow/site/，
 * 再以 check-workflow-sync.mjs --restamp 依合併後的來源重寫（#72）；files 不是只有它、或任一步失敗時傳回 false。
 */
export function restamp(tree, files) {
  if (!files.length || !files.every(file => file === DOC_SYNC)) return false;
  if (runIn(tree, 'git', ['checkout', '--theirs', '--', DOC_SYNC]).status !== 0) return false;
  const build = join(tree, 'scripts/build-workflow-site.mjs');
  if (existsSync(build)) {
    if (runIn(tree, 'node', [build]).status !== 0) return false;
    if (runIn(tree, 'git', ['add', '-A', '--', 'docs/workflow/site']).status !== 0) return false;
  }
  if (runIn(tree, 'node', [join(tree, 'scripts/check-workflow-sync.mjs'), '--restamp']).status !== 0) return false;
  return runIn(tree, 'git', ['add', DOC_SYNC]).status === 0;
}

/** git merge-file 等子行程；stdin 接 /dev/null，stderr 不顯示（衝突是預期中的）。 */
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  return { status: result.status, stdout: result.stdout ?? '' };
};

/** 這行是 `- **<名稱>.**` 條目的開頭時傳回名稱，否則 undefined。 */
const entryName = line => line.match(/^- \*\*([^*]+?)\.\*\*/)?.[1];

/** 依 `- **<名稱>.**` 條目切段：第一段是條目前的文字（可能是空的），之後每段從條目開頭那行起。 */
function entries(text) {
  const pieces = [{ name: '', text: '' }];
  for (const line of text.split(/(?<=\n)/)) {
    const name = entryName(line);
    if (name) pieces.push({ name, text: line });
    else pieces.at(-1).text += line;
  }
  return pieces;
}

/** 一個衝突 hunk 照允許的解法解；解不了傳回 undefined。`kinds` 收集用到的解法；`context` 是 hunk 前後各一行與 hunk 之前所在的條目名稱（adjacent 用）。 */
function resolveHunk(base, ours, theirs, kinds, context) {
  if (base === '') {
    // 不重疊：兩邊新增的非空行不能有相同的（diff3 不剝掉共有的行，同一個標題接起來就重複了），條目也不能同名。
    const lines = text => text.split('\n').filter(line => line.trim());
    const names = text => entries(text).map(p => p.name).filter(Boolean);
    if (lines(ours).some(line => lines(theirs).includes(line)) || names(ours).some(name => names(theirs).includes(name))) return undefined;
    kinds.add('additions');
    return `${ours}${ours.endsWith('\n') ? '' : '\n'}${theirs}`;
  }
  const byRows = resolveRows(base, ours, theirs);
  if (byRows !== undefined) {
    kinds.add('rows');
    return byRows;
  }
  const byEntries = resolveEntries(base, ours, theirs);
  if (byEntries !== undefined) {
    kinds.add('entries');
    return byEntries;
  }
  const byAdjacent = resolveAdjacent(base, ours, theirs, context);
  if (byAdjacent !== undefined) {
    kinds.add('adjacent');
    return byAdjacent;
  }
  return undefined;
}

/** entries：兩邊改的是不同的 `- **<名稱>.**` 條目時各取改過的那一版（#45）；解不了傳回 undefined。 */
function resolveEntries(base, ours, theirs) {
  const [b, o, t] = [base, ours, theirs].map(entries);
  const names = pieces => pieces.map(p => p.name).join('\n');
  if (b.length < 2 || names(o) !== names(b) || names(t) !== names(b)) return undefined;
  const merged = b.map(({ text }, i) => {
    if (o[i].text === text) return t[i].text;
    if (t[i].text === text || t[i].text === o[i].text) return o[i].text;
    return undefined;
  });
  return merged.includes(undefined) ? undefined : merged.join('');
}

/** 對齊數超過這個值就不自己解：重複行很多的 hunk 不值得逐一比對。 */
const ALIGNMENTS = 64;

/**
 * 一邊相對 base 的所有最長共同子序列對齊；每種對齊是一份 `{ start, end, lines }` 清單（換掉 base 的 [start, end) 行，
 * start === end 是純插入）。超過 ALIGNMENTS 種傳回 undefined。
 */
function alignments(base, side) {
  const [n, m] = [base.length, side.length];
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = base[i] === side[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const found = [];
  // 從 (i, j) 起，下一個對上的行可以是任何不減少共同行數的 (k, l)；中間沒對上的就是一個改動。
  const walk = (i, j, edits) => {
    if (found.length > ALIGNMENTS) return;
    const step = (k, l) => (k > i || l > j ? [...edits, { start: i, end: k, lines: side.slice(j, l) }] : edits);
    if (lcs[i][j] === 0) {
      found.push(step(n, m));
      return;
    }
    for (let k = i; k < n; k++)
      for (let l = j; l < m; l++)
        if (base[k] === side[l] && lcs[k][l] === lcs[i][j] && lcs[k + 1][l + 1] === lcs[i][j] - 1) walk(k + 1, l + 1, step(k, l));
  };
  walk(0, 0, []);
  return found.length > ALIGNMENTS ? undefined : found;
}

/**
 * adjacent：一邊只改了 hunk 裡 base 的某幾行（每個改動都把至少一行 base 換成至少一行新行，純刪除不算），另一邊只在 base 行之間
 * 插入新行、沒改任何 base 行，插入點都不在改動的那幾行中間（落在改動的開頭或結尾就是相鄰）時兩邊都套用（#175）。
 * 同一點的插入排在改動之前。兩邊各自所有最長共同子序列對齊（接上 hunk 前後各一行）的每種組合都要成立、合出同一個結果，
 * 不然結果取決於對齊方式（重複行能滑動、拆段插入），不自己解；對齊動到 hunk 外那一行時也不解：hunk 外的對齊看不到。
 */
function resolveAdjacent(base, ours, theirs, { before, after, entry = '' } = {}) {
  // 檔尾沒有換行的行接上插入行會黏成同一行：hunk 碰到這種行就不自己解。
  if (![base, ours, theirs].every(text => text === '' || text.endsWith('\n'))) return undefined;
  const split = text => (text === '' ? [] : text.split(/(?<=\n)/));
  const lead = before === undefined ? [] : [before];
  const tail = after === undefined ? [] : [after];
  const b = split(base);
  const [o, t] = [ours, theirs].map(text => alignments([...lead, ...b, ...tail], [...lead, ...split(text), ...tail]));
  if (!o || !t) return undefined;
  const inHunk = edits => {
    const shifted = edits.map(({ start, end, lines }) => ({ start: start - lead.length, end: end - lead.length, lines }));
    return shifted.every(({ start, end }) => start >= 0 && end <= b.length) ? shifted : undefined;
  };
  const results = new Set();
  for (const ourEdits of o)
    for (const theirEdits of t) {
      const [oe, te] = [ourEdits, theirEdits].map(inHunk);
      const merged = oe && te && applyAdjacent(b, oe, te, { after, entry });
      if (merged === undefined) return undefined;
      results.add(merged);
    }
  return results.size === 1 ? [...results][0] : undefined;
}

/** adjacent 的一種對齊：兩邊的改動清單合得起來就傳回結果，不然 undefined。`after` 是 hunk 後一行，`entry` 是 hunk 之前所在的條目。 */
function applyAdjacent(b, o, t, { after, entry }) {
  const inserts = edits => edits.length > 0 && edits.every(({ start, end }) => start === end);
  const modifies = edits => edits.length > 0 && edits.every(({ start, end, lines }) => start < end && lines.length > 0);
  const [changed, inserted] = modifies(o) && inserts(t) ? [o, t] : modifies(t) && inserts(o) ? [t, o] : [];
  if (!changed) return undefined;
  // 動到表格列（改掉的 base 行、換上或插入的行）歸 rows 判斷：一邊改欄數、一邊加列逐行套用會留下欄數不對的列。
  const touched = [...changed, ...inserted].flatMap(({ start, end, lines }) => [...b.slice(start, end), ...lines]);
  if (touched.some(line => line.startsWith('|'))) return undefined;
  // 兩邊動到同一個 `- **<名稱>.**` 條目是同一條目衝突（Stage 條目要 Fresh redispatch），不自己解。
  // 每個 base 行歸到它所在的條目（hunk 之前的條目接續下來）。插入歸到它接著的那一行的條目；自己以條目開頭時是新條目，
  // 但後面接的還是前一個條目的內文（不是下一個條目的開頭）時，等於把前一個條目切開，也算動到它。
  const owner = [];
  for (const line of b) owner.push(entryName(line) ?? owner.at(-1) ?? entry);
  const edited = changed.flatMap(({ start, end }) => owner.slice(start, end));
  const homes = inserted.map(({ start, lines }) => {
    const previous = start ? owner[start - 1] : entry;
    const next = start < b.length ? b[start] : after;
    return entryName(lines[0]) === undefined || (next !== undefined && entryName(next) === undefined) ? previous : '';
  });
  if (homes.some(name => name && edited.includes(name))) return undefined;
  // 換上的行和插入的行相同（非空行或同名條目），兩邊都套用就重複了，同 additions 的判斷。
  const added = inserted.flatMap(({ lines }) => lines);
  const replacing = changed.flatMap(({ lines }) => lines);
  const names = lines => entries(lines.join('')).map(p => p.name).filter(Boolean);
  if (replacing.some(line => line.trim() && added.includes(line)) || names(replacing).some(name => names(added).includes(name))) return undefined;
  if (inserted.some(({ start: at }) => changed.some(({ start, end }) => start < at && at < end))) return undefined;
  let out = '';
  for (let i = 0; i <= b.length; ) {
    for (const edit of inserted) if (edit.start === i) out += edit.lines.join('');
    const edit = changed.find(({ start }) => start === i);
    if (edit) {
      out += edit.lines.join('');
      i = edit.end;
    } else out += b[i++] ?? '';
  }
  return out;
}

/** Markdown 表格列的第一格：開頭的 `|` 之後到下一個沒跳脫的 `|`，去掉前後空白。 */
const firstCell = line => line.match(/^\|((?:\\.|[^|\\])*)/)[1].trim();
/** 表格列的欄數：沒跳脫的 `|` 數，收尾那個不算（GFM 可以省略）。欄數不同（一邊加了欄）時不逐列合併。 */
const pipes = line => (line.replace(/(?<!\\)\|\s*$/, '').match(/\\.|\|/g) ?? []).filter(token => token === '|').length;

/**
 * rows：hunk 的 base、ours、theirs 每一行都是 Markdown 表格列（`|` 開頭）時，以第一格為鍵逐列合併（#162）。
 * 只有一邊改（或刪）的列取那一邊，兩邊改成一樣的照留；新增的列接在它在自己那一邊的前一個 base 列之後，同一處 ours 先。
 * 同一列兩邊改成不同內容、一邊刪一邊改、兩邊新增同一個鍵、某一份有重複的鍵、留下的 base 列順序變了、各列的欄數不同：解不了，傳回 undefined。
 */
function resolveRows(base, ours, theirs) {
  const parse = text => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const versions = [base, ours, theirs].map(parse);
  if (!versions[0].length || !versions.flat().every(line => line.startsWith('|'))) return undefined;
  if (new Set(versions.flat().map(pipes)).size > 1) return undefined;
  const [b, o, t] = versions.map(lines => new Map(lines.map(line => [firstCell(line), line])));
  if ([b, o, t].some((map, i) => map.size !== versions[i].length)) return undefined;
  const position = new Map([...b.keys()].map((key, i) => [key, i]));
  const kept = map => [...map.keys()].filter(key => b.has(key)).map(key => position.get(key));
  if ([o, t].some(map => kept(map).some((at, i, all) => i > 0 && all[i - 1] > at))) return undefined;
  if ([...o.keys()].some(key => !b.has(key) && t.has(key))) return undefined;
  // 新增的列依前一個 base 列分組；檔頭那組的鍵是 undefined。
  const added = map => {
    const at = new Map();
    let anchor;
    for (const [key, line] of map) {
      if (b.has(key)) anchor = key;
      else at.set(anchor, [...(at.get(anchor) ?? []), line]);
    }
    return at;
  };
  const [oAdded, tAdded] = [o, t].map(added);
  const out = [...(oAdded.get(undefined) ?? []), ...(tAdded.get(undefined) ?? [])];
  for (const [key, was] of b) {
    const [mine, yours] = [o.get(key), t.get(key)];
    let line;
    if (mine === was) line = yours;
    else if (yours === was || yours === mine) line = mine;
    else return undefined;
    if (line !== undefined) out.push(line);
    out.push(...(oAdded.get(key) ?? []), ...(tAdded.get(key) ?? []));
  }
  return out.length ? `${out.join('\n')}${base.endsWith('\n') ? '\n' : ''}` : '';
}

/**
 * index 裡的一個 blob 解成 UTF-8 文字；不存在或不是合法 UTF-8 時傳回 undefined。
 * 以位元組讀再嚴格解碼：用 utf8 讀會把無效位元組換成 U+FFFD，寫回去就改壞了兩邊都沒動的行。ignoreBOM 讓開頭的 BOM 留在文字裡。
 */
function blob(tree, spec) {
  // 不走 run：它把 stdout、stderr 當字串處理。stderr 不顯示：缺 stage（add/add、一邊刪掉）時 git show 的錯誤是預期中的。
  const result = spawnSync('git', ['-C', tree, 'show', spec], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv });
  if (result.status !== 0) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * 一個衝突檔：從 index 的三個 stage 以 diff3 重新合併，切成段落清單：沒衝突的 `{ text }` 與衝突 hunk `{ base, ours, theirs, after }`
 * （after 是 hunk 後一行）。沒有 base（兩邊各自新增同一個檔）、有一邊刪掉、不是 UTF-8 文字或合不出來時傳回 undefined。
 */
function diff3(tree, path) {
  const [base, ours, theirs] = [1, 2, 3].map(n => blob(tree, `:${n}:${path}`));
  if ([base, ours, theirs].includes(undefined)) return undefined;
  // 標記用長的 MARKER：預設 7 個字元時，內容本身的 `=======`（setext 標題底線）會被當成分隔線。內容裡真有這麼長的標記行就不自己解。
  if ([base, ours, theirs].some(text => MARKER_LINE.test(text))) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'pilot-land-'));
  try {
    const files = ['ours', 'base', 'theirs'].map(name => join(dir, name));
    [ours, base, theirs].forEach((text, i) => writeFileSync(files[i], text));
    const merged = run('git', ['merge-file', '-p', '--diff3', `--marker-size=${MARKER}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', ...files]);
    if (merged.status === null || merged.status > 127) return undefined;
    const segments = [];
    let hunk;
    const lines = merged.stdout.split(/(?<=\n)/);
    for (const [i, line] of lines.entries()) {
      const marker = line.replace(/\n$/, '');
      if (!hunk && marker === `${'<'.repeat(MARKER)} ours`) hunk = { part: 'ours', ours: '', base: '', theirs: '' };
      else if (hunk && marker === `${'|'.repeat(MARKER)} base`) hunk.part = 'base';
      else if (hunk && marker === '='.repeat(MARKER)) hunk.part = 'theirs';
      else if (hunk && marker === `${'>'.repeat(MARKER)} theirs`) {
        const { base: b, ours: o, theirs: t } = hunk;
        segments.push({ base: b, ours: o, theirs: t, after: lines[i + 1] });
        hunk = undefined;
      } else if (hunk) hunk[hunk.part] += line;
      else segments.push({ text: line });
    }
    return hunk ? undefined : segments;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 依 diff3 段落逐一處理 hunk：`onHunk(hunk, context)` 傳回 hunk 合併後的文字（undefined 表示解不了），context 是 adjacent 要的
 * hunk 前後各一行與 hunk 之前所在的條目名稱；解不了的 hunk 之後以 ours 那一版接續 context。傳回整份合併後的文字，有 hunk 解不了時 undefined。
 */
function walkHunks(segments, onHunk) {
  let out = '';
  let failed = false;
  let last;
  let entry = '';
  for (const segment of segments) {
    let text = segment.text;
    if (text === undefined) {
      text = onHunk(segment, { before: last, after: segment.after, entry });
      if (text === undefined) {
        failed = true;
        text = segment.ours;
      }
    }
    out += text;
    const pieces = text.split(/(?<=\n)/).filter(Boolean);
    last = pieces.at(-1) ?? last;
    entry = pieces.map(entryName).filter(Boolean).at(-1) ?? entry;
  }
  return failed ? undefined : out;
}

/** 一個衝突檔逐一解每個 hunk（用到的解法名稱加進 kinds）；有一個解不了就傳回 undefined。 */
export function resolveFile(tree, path, kinds) {
  const segments = diff3(tree, path);
  return segments && walkHunks(segments, (hunk, context) => resolveHunk(hunk.base, hunk.ours, hunk.theirs, kinds, context));
}

/**
 * STOP conflict 的種類欄（#192）：Markdown 檔裡解不了的 hunk 有兩邊都改的 `- **<名稱>.**` 條目時是 `entry <名稱>`（多個以、連接，
 * 條目開頭之前的文字歸到 hunk 之前所在的條目）；不是這種情況傳回 undefined，由正本判斷 code／other。
 */
export function conflictKind(tree, path) {
  const segments = path.endsWith('.md') ? diff3(tree, path) : undefined;
  const names = new Set();
  if (segments) {
    walkHunks(segments, (hunk, context) => {
      const resolved = resolveHunk(hunk.base, hunk.ours, hunk.theirs, new Set(), context);
      if (resolved === undefined) for (const name of bothChangedEntries(hunk, context.entry)) names.add(name);
      return resolved;
    });
  }
  return names.size ? `entry ${[...names].join('、')}` : undefined;
}

/** 一個解不了的 hunk 裡兩邊都改（而且改得不一樣）的條目名稱；條目沒對齊（一邊增刪了條目）時是 hunk 碰到的每個條目。 */
function bothChangedEntries({ base, ours, theirs }, entry) {
  const [b, o, t] = [base, ours, theirs].map(entries);
  const named = (piece, i) => (i === 0 ? entry : piece.name);
  const list = pieces => pieces.map(p => p.name).join('\n');
  if (list(o) === list(b) && list(t) === list(b)) {
    return b.map(named).filter((name, i) => name && o[i].text !== b[i].text && t[i].text !== b[i].text && o[i].text !== t[i].text);
  }
  return [...new Set([b, o, t].flatMap(pieces => pieces.map((p, i) => (i > 0 || p.text.trim() ? named(p, i) : ''))))].filter(Boolean);
}
