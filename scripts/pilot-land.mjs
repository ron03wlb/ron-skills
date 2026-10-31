#!/usr/bin/env node
// /issue-pilot coordinator 的 Stage → Regression → hold 檢查 → Integrate，一個指令完成（docs/agents/pilot.md 的同名條目，#75）。
// 全部在 stage worktree 做（分支是 pilot/integration 或 pilot/stage-* 的那個 worktree；沒有就用 Orca 建 pilot-stage，再跑 Bare guard）：
//   Stage       stage worktree 要乾淨；`switch -C pilot/stage-<key> <integration tip>`，依號碼 `merge --no-ff` 每個 done 成員。
//               衝突只照 Stage 條目允許的解法自己解，其他 `merge --abort`：
//                 restamp    戳記檔（scripts/restamp.mjs 的 STAMP_FILES：workflow-doc-sync.json、workflow-templates.json）：其他衝突檔都用
//                            下列解法解完之後，交給和 land.mjs 共用的 restamp()（#72、#173）；
//                 additions  每個衝突 hunk 的 base 是空的（兩邊只在既有檔案的同一處新增，沒有相同的非空行或同名條目）：依號碼兩段都留下；
//                 entries    每個衝突 hunk 裡兩邊改的是不同的 `- **<名稱>.**` 條目：各取改過的那一版（#45）；
//                 rows       衝突 hunk 三份的行都是 Markdown 表格列（`|` 開頭）、以第一格為鍵兩邊改的是不同列：各取各的版本、
//                            依原順序排好，新增的列都留下；同一列兩邊都改照樣 abort（#162）。
//                 adjacent   衝突 hunk 裡一邊只改了 base 的某幾行、另一邊只在 base 行之間插入新行（沒改任何 base 行），插入點不在
//                            改動的那幾行中間：兩邊都套用；兩邊都改了同一個 base 行、改動或插入碰到表格列（歸 rows）、
//                            改動或插入的重複行能滑到另一側或滑出 hunk、插入的行裡有被改的 base 行、換上的行和插入的行相同
//                            （非空行或同名條目）、碰到檔尾沒換行的行照樣 abort（#175）。
//               additions、entries、rows 與 adjacent 只解三個版本都是 UTF-8 文字的檔案，其他的照樣 abort。
//               staged SHA 與 stage 時的 integration tip 寫成 checkpoint 的 `current: staged <sha> onto <tip>`。
//   Regression  在 staged SHA 跑 <stage worktree>/bin/check --upstream，完整輸出寫到 <主 checkout>/.scratch/pilot/reg-<key>.log，
//               checkpoint 追加 `regression: <sha> exit <code>`（通過時附 bin/check 最後一行 CHECK_PASS）。
//   hold        <主 checkout>/.scratch/pilot/hold 存在就停。
//   Integrate   pilot/integration 的 tip 要還是 stage 時記下的那個（不數 parent：batch-40-51 用 `$SHA^1` 誤判兩個成員的 batch）；
//               `switch pilot/integration`、`merge --ff-only`、`branch -d` stage 分支，`current:` 寫成 `merged <sha>`。
// 重跑：`current:` 是 `staged <sha> onto <tip>`、tip 沒變、stage 分支還在那個 SHA、成員組合與各分支都沒變、最後一個 regression 行是它的 exit 0 時，
//   不重新 stage、不重跑 Regression，直接從 hold 檢查繼續；其他情況一律從 Stage 重來。已經 `merged` 時只再印一次 MERGED。
// checkpoint 格式見 skills/engineering/issue-pilot/PILOT-STORE.md；寫回之後再讀一次，沒寫進去就 STOP checkpoint，不會靜默失敗（#74）。
// 請求分支（沒有 Issue 的 `retro/<x>`，#143）：`req-<n> --branch retro/<x>`（<n> 是 requests.md 的行號）在 batch-req-<n>.md 不存在時開出它，
//   唯一的成員列 Issue 欄是 `-`、state `done`、candidate 是分支 tip；已存在時成員要是同一個分支，否則 STOP checkpoint。之後與一般 batch 相同。
//   分支不存在印 `STOP branch <分支> …`，不開 checkpoint。成員列是 `-` 時，STOP、RESOLVED 行裡的 <n> 是分支名稱。
//
// 用法：node scripts/pilot-land.mjs <batch key> [--branch retro/<x>]（在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）
// stdout：最後一行是 `MERGED <key> <sha>`，或 `STOP regression <exit>`、`STOP hold`、`STOP drift`（tip 變了，下一輪重新 stage）、
//   `STOP conflict <n> <檔案…>`（已 abort，stage worktree 乾淨），以及 `STOP checkpoint …`、`STOP member <n> <state>`、`STOP dirty <worktree>`、
//   `STOP no-stage-worktree`、`STOP create …`、`STOP merge <n> …`、`STOP git …`。之前的行：`STAGED <key> <sha> onto <tip>`、
//   `RESUME <key> <sha>`、`RESOLVED <n> <解法> <檔案…>`，Bare guard 還原主 checkout 時的 `UNBARE <主 checkout>`。
// exit：0 MERGED；4 STOP；2 用法錯誤；1 其他失敗（程式錯誤，不印 STOP）。
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAMP_FILES, restamp } from './restamp.mjs';

const USAGE = '用法：node scripts/pilot-land.mjs <batch key> [--branch retro/<x>]（--branch 時 key 是 req-<n>；在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）';
const INTEGRATION = 'pilot/integration';
const MARKER = 32;
const MARKER_LINE = new RegExp(`^([<|=>])\\1{${MARKER - 1}}`, 'm');
const here = dirname(fileURLToPath(import.meta.url));
// 從 pre-commit hook 或 worktree 呼叫時繼承的 GIT_DIR 等會讓 git -C 讀寫到別的 repo。
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));

/** 停下：訊息就是 `STOP ` 後面那段。 */
class Stop extends Error {}

/** 同步跑子行程；stdin 一律接 /dev/null（Orca CLI 會吃掉 stdin）。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, ...options });
  // stderr 照常顯示（同 pilot-close.mjs），只濾掉 WSL 上 Orca 每次都印的 crashpad 錯誤行（#73）。
  const stderr = (result.stderr ?? '').split('\n').filter(line => !line.includes('registration_protocol_win.cc')).join('\n');
  if (stderr.trim()) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  const reason = (result.stderr ?? '').trim().split('\n').pop() || (result.error?.message ?? `exit ${result.status}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', reason };
}

const gitIn = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

/** git 指令，exit 非 0 就 STOP git。 */
function must(cwd, ...args) {
  const result = gitIn(cwd, ...args);
  if (result.status !== 0) throw new Stop(`git ${args[0]} ${result.reason}`);
  return result.stdout.trim();
}

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) throw new Stop(`git worktree ${result.reason}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** stage worktree：分支是 pilot/integration 或 pilot/stage-* 的 worktree 路徑，主 checkout 不算（不在主 checkout 切分支，#21）；沒有傳回 undefined。 */
function stageWorktree(main) {
  return must(main, 'worktree', 'list', '--porcelain').split(/\n\n+/)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.path && w.path !== main && existsSync(w.path) && (w.branch === INTEGRATION || w.branch?.startsWith('pilot/stage-')))?.path;
}

/** 用 Orca 建 stage worktree（orca-worktree-create.mjs 不重試、以 git worktree list 為準），接著跑 Bare guard。 */
function createStageWorktree(main, key) {
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!cli) throw new Stop('no-stage-worktree');
  const created = run('node', [join(here, 'orca-worktree-create.mjs'), '--name', 'pilot-stage', '--base-branch', INTEGRATION, '--branch', `pilot/stage-${key}`],
    { cwd: main, env: { ...childEnv, ORCA_BIN: cli }, timeout: 300000 });
  const unbare = run(join(here, 'pilot-unbare.sh'), [main, `stage #${key}`]);
  if (unbare.stdout) process.stdout.write(unbare.stdout);
  if (unbare.status !== 0) throw new Stop(`create unbare ${unbare.reason}`);
  const tree = stageWorktree(main);
  if (!tree) {
    let detail = created.stdout.trim() || created.reason;
    try { detail = JSON.parse(detail).error ?? detail; } catch { /* 非 JSON 就原樣附上 */ }
    throw new Stop(`create ${detail}`);
  }
  return tree;
}

/**
 * batch checkpoint：`current:` 的值、成員 `{ n, branch, state }`（欄位見 PILOT-STORE.md）與最後一個 `regression:` 行的值。欄位前後的空格不影響。
 * Issue 欄是 `-` 的請求分支成員以分支名稱當 n，排在 Issue 成員之後、照表格順序。
 */
const order = ({ n }) => (typeof n === 'number' ? n : Number.MAX_SAFE_INTEGER);

function readCheckpoint(file) {
  if (!existsSync(file)) throw new Stop(`checkpoint 缺 ${file}`);
  const text = readFileSync(file, 'utf8');
  const current = text.match(/^current:[ \t]*(.*)$/m)?.[1].trim();
  if (current === undefined) throw new Stop(`checkpoint ${file} 沒有 current: 行`);
  const members = text.split('\n').filter(line => line.trim().startsWith('|'))
    .map(line => line.trim().split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(([n]) => /^(\d+|-)$/.test(n))
    .map(([n, branch, , , , , state]) => ({ n: n === '-' ? branch : Number(n), branch, state }))
    .sort((a, b) => order(a) - order(b));
  const regression = [...text.matchAll(/^regression:[ \t]*(.*)$/gm)].pop()?.[1].trim();
  return { current, members, regression };
}

/** 請求分支的 batch：checkpoint 不在就開出來（成員列 Issue 欄 `-`），在的話成員要是同一個分支。 */
function openRequest(key, branch) {
  const main = mainCheckout();
  const file = join(main, `.scratch/pilot/batch-${key}.md`);
  if (existsSync(file)) {
    const others = readCheckpoint(file).members.map(m => m.branch);
    if (others.length !== 1 || others[0] !== branch) throw new Stop(`checkpoint ${file} 的成員是 ${others.join(' ') || '（沒有）'}，不是 ${branch}`);
    return;
  }
  const candidate = gitIn(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`).stdout.trim();
  if (!candidate) throw new Stop(`branch ${branch} 不存在`);
  const worktree = must(main, 'worktree', 'list', '--porcelain').split(/\n\n+/)
    .find(block => block.split('\n').includes(`branch refs/heads/${branch}`))?.match(/^worktree (.*)$/m)?.[1] ?? '';
  const now = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# batch ${key}\ncurrent: dispatched ${now}\nintegration: ${INTEGRATION} @ ${must(main, 'rev-parse', INTEGRATION)}\n\n`
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
    + `| - | ${branch} | ${worktree} | | ${now} | | done | ${candidate} |\n`);
  const { members } = readCheckpoint(file);
  if (members.length !== 1 || members[0].branch !== branch || members[0].state !== 'done') throw new Stop(`checkpoint ${file} 的成員列沒寫成 ${branch}`);
}

/** 改寫 `current:` 行；寫完再讀一次，不是這個值就 STOP（多一個空格就靜默不中的 sed 正是 #74 的起因）。 */
function setCurrent(file, value) {
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^current:.*$/m, `current: ${value}`));
  if (readCheckpoint(file).current !== value) throw new Stop(`checkpoint ${file} 的 current: 沒寫成 ${value}`);
}

/** 追加 `regression:` 行；寫完再讀一次，最後一個 regression 行不是它就 STOP。 */
function appendRegression(file, value) {
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, `${text}${text.endsWith('\n') ? '' : '\n'}regression: ${value}\n`);
  if (readCheckpoint(file).regression !== value) throw new Stop(`checkpoint ${file} 的 regression: 沒寫成 ${value}`);
}

/** 依 `- **<名稱>.**` 條目切段：第一段是條目前的文字（可能是空的），之後每段從條目開頭那行起。 */
function entries(text) {
  const pieces = [{ name: '', text: '' }];
  for (const line of text.split(/(?<=\n)/)) {
    const name = line.match(/^- \*\*([^*]+?)\.\*\*/)?.[1];
    if (name) pieces.push({ name, text: line });
    else pieces.at(-1).text += line;
  }
  return pieces;
}

/** 一個衝突 hunk 照允許的解法解；解不了傳回 undefined。`kinds` 收集用到的解法；`context` 是 hunk 前後各一行（adjacent 用）。 */
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

/** 一邊相對 base 的改動：以最長共同子序列對齊，傳回 `{ start, end, lines }` 清單（換掉 base 的 [start, end) 行；start === end 是純插入）。 */
function diffLines(base, side) {
  const [n, m] = [base.length, side.length];
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = base[i] === side[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const edits = [];
  let [i, j] = [0, 0];
  let open;
  const close = () => {
    if (open) edits.push({ ...open, end: i });
    open = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === side[j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { start: i, lines: [] };
      if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) open.lines.push(side[j++]);
      else i++;
    }
  }
  close();
  return edits;
}

/**
 * 一個改動（把 base 的 [start, end) 換成 lines）所有等價的位置，傳回 `[start, end]` 清單：
 * 往前一行等價的條件是「前一行 base + lines」以 base[end - 1] 結尾，往後一行是「lines + 後一行 base」以 base[start] 開頭（插入時 start === end）。
 */
function shifts(base, { start, end, lines }) {
  const ranges = [[start, end]];
  for (let [s, e, moving] = [start, end, lines]; s > 0; s--, e--) {
    const next = [base[s - 1], ...moving];
    if (next.at(-1) !== base[e - 1]) break;
    moving = next.slice(0, -1);
    ranges.push([s - 1, e - 1]);
  }
  for (let [s, e, moving] = [start, end, lines]; e < base.length; s++, e++) {
    const next = [...moving, base[e]];
    if (next[0] !== base[s]) break;
    moving = next.slice(1);
    ranges.push([s + 1, e + 1]);
  }
  return ranges;
}

/**
 * adjacent：一邊只改了 hunk 裡 base 的某幾行（每個改動都換掉至少一行 base），另一邊只在 base 行之間插入新行、沒改任何 base 行，
 * 插入點都不在改動的那幾行中間（落在改動的開頭或結尾就是相鄰）時兩邊都套用（#175）。同一點的插入排在改動之前。其他情況傳回 undefined。
 */
function resolveAdjacent(base, ours, theirs, { before, after } = {}) {
  // 檔尾沒有換行的行接上插入行會黏成同一行：hunk 碰到這種行就不自己解。
  if (![base, ours, theirs].every(text => text === '' || text.endsWith('\n'))) return undefined;
  const split = text => (text === '' ? [] : text.split(/(?<=\n)/));
  const b = split(base);
  const [o, t] = [ours, theirs].map(text => diffLines(b, split(text)));
  const inserts = edits => edits.length > 0 && edits.every(({ start, end }) => start === end);
  const modifies = edits => edits.length > 0 && edits.every(({ start, end }) => start < end);
  const [changed, inserted] = modifies(o) && inserts(t) ? [o, t] : modifies(t) && inserts(o) ? [t, o] : [];
  if (!changed) return undefined;
  // 動到表格列（改掉的 base 行、換上或插入的行）歸 rows 判斷：一邊改欄數、一邊加列逐行套用會留下欄數不對的列。
  const touched = [...changed, ...inserted].flatMap(({ start, end, lines }) => [...b.slice(start, end), ...lines]);
  if (touched.some(line => line.startsWith('|'))) return undefined;
  const added = inserted.flatMap(({ lines }) => lines);
  // 插入那一邊含有被改的 base 行的另一份副本時，base 行對齊哪一份都說得通（拆成兩段插入），結果不唯一；整塊平移的檢查看不到。
  if (changed.some(({ start, end }) => b.slice(start, end).some(line => added.includes(line)))) return undefined;
  // 換上的行和插入的行相同（非空行或同名條目），兩邊都套用就重複了，同 additions 的判斷。
  const replacing = changed.flatMap(({ lines }) => lines);
  const names = lines => entries(lines.join('')).map(p => p.name).filter(Boolean);
  if (replacing.some(line => line.trim() && added.includes(line)) || names(replacing).some(name => names(added).includes(name))) return undefined;
  // 改動或插入碰到重複行時可以前後滑動（刪掉兩個相同行的哪一個、插在重複行的前面或後面都說得通）：
  // 每個插入的每個可能位置，對每個改動的每個可能區間都要落在同一側（不在中間），不然結果取決於對齊方式，不自己解。
  // 滑動接上 hunk 前後各一行一起算；能滑出 hunk 的（例如 hunk 外緊鄰一行相同的行）也不自己解：hunk 外的對齊看不到。
  const lead = before === undefined ? 0 : 1;
  const around = [...(lead ? [before] : []), ...b, ...(after === undefined ? [] : [after])];
  const moves = ({ start, end, lines }) => shifts(around, { start: start + lead, end: end + lead, lines });
  const outside = ([start, end]) => start < lead || end > lead + b.length;
  const side = (at, [start, end]) => (at <= start ? 'before' : at >= end ? 'after' : 'inside');
  for (const insert of inserted) {
    const spots = moves(insert);
    if (spots.some(outside)) return undefined;
    for (const edit of changed) {
      const ranges = moves(edit);
      if (ranges.some(outside)) return undefined;
      const sides = new Set(ranges.flatMap(range => spots.map(([at]) => side(at, range))));
      if (sides.size > 1 || sides.has('inside')) return undefined;
    }
  }
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

/** 一個衝突檔：從 index 的三個 stage 以 diff3 重新合併，逐一解每個 hunk；有一個解不了就傳回 undefined。 */
function resolveFile(tree, path, kinds) {
  const [base, ours, theirs] = [1, 2, 3].map(n => blob(tree, `:${n}:${path}`));
  // 沒有 base（兩邊各自新增同一個檔）、有一邊刪掉，或不是 UTF-8 文字：不自己解。
  if ([base, ours, theirs].includes(undefined)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'pilot-land-'));
  try {
    const files = ['ours', 'base', 'theirs'].map(name => join(dir, name));
    [ours, base, theirs].forEach((text, i) => writeFileSync(files[i], text));
    // 標記用長的 MARKER：預設 7 個字元時，內容本身的 `=======`（setext 標題底線）會被當成分隔線。內容裡真有這麼長的標記行就不自己解。
    if ([base, ours, theirs].some(text => MARKER_LINE.test(text))) return undefined;
    const merged = run('git', ['merge-file', '-p', '--diff3', `--marker-size=${MARKER}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', ...files]);
    if (merged.status === null || merged.status > 127) return undefined;
    let out = '';
    let last;
    let hunk;
    const lines = merged.stdout.split(/(?<=\n)/);
    for (const [i, line] of lines.entries()) {
      const marker = line.replace(/\n$/, '');
      if (!hunk && marker === `${'<'.repeat(MARKER)} ours`) hunk = { part: 'ours', ours: '', base: '', theirs: '' };
      else if (hunk && marker === `${'|'.repeat(MARKER)} base`) hunk.part = 'base';
      else if (hunk && marker === '='.repeat(MARKER)) hunk.part = 'theirs';
      else if (hunk && marker === `${'>'.repeat(MARKER)} theirs`) {
        const resolved = resolveHunk(hunk.base, hunk.ours, hunk.theirs, kinds, { before: last, after: lines[i + 1] });
        if (resolved === undefined) return undefined;
        out += resolved;
        last = resolved === '' ? last : resolved.split(/(?<=\n)/).at(-1);
        hunk = undefined;
      } else if (hunk) hunk[hunk.part] += line;
      else {
        out += line;
        last = line;
      }
    }
    return hunk ? undefined : out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 照 Stage 條目允許的解法解掉進行中 merge 的衝突並 add；傳回解法名稱，解不了傳回 undefined（呼叫端 abort）。 */
function resolveConflicts(tree, files) {
  const others = files.filter(path => !STAMP_FILES.includes(path));
  const stamps = files.filter(path => STAMP_FILES.includes(path));
  const kinds = new Set();
  const resolved = others.map(path => resolveFile(tree, path, kinds));
  if (resolved.includes(undefined)) return undefined;
  others.forEach((path, i) => writeFileSync(join(tree, path), resolved[i]));
  if (others.length) must(tree, 'add', '--', ...others);
  // 戳記檔最後重算：restamp 讀的是其他檔解完之後的來源。
  if (stamps.length) {
    if (!restamp(tree, stamps)) return undefined;
    kinds.add('restamp');
  }
  // 固定順序，restamp 最後：它在其他解法之後才跑（`entries+restamp`、`rows+restamp`）。
  return ['additions', 'entries', 'rows', 'adjacent', 'restamp'].filter(kind => kinds.has(kind)).join('+');
}

/** Stage：從 `tip` 重開 stage 分支、依號碼合入成員；傳回 staged SHA。 */
function stage(tree, key, members, tip) {
  must(tree, 'switch', '-q', '-C', `pilot/stage-${key}`, tip);
  for (const { n, branch } of members) {
    const merge = gitIn(tree, 'merge', '--no-ff', '--no-edit', branch);
    if (merge.status === 0) continue;
    const conflicted = must(tree, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    // 解的途中失敗（restamp、add、commit 被 hook 擋）也先 abort，stage worktree 不停在 merge 中途。
    try {
      const how = conflicted.length ? resolveConflicts(tree, conflicted) : undefined;
      if (how) {
        must(tree, 'commit', '--no-edit');
        console.log(`RESOLVED ${n} ${how} ${conflicted.join(' ')}`);
        continue;
      }
      throw new Stop(conflicted.length ? `conflict ${n} ${conflicted.join(' ')}` : `merge ${n} ${merge.reason}`);
    } catch (error) {
      if (gitIn(tree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) must(tree, 'merge', '--abort');
      throw error;
    }
  }
  return must(tree, 'rev-parse', 'HEAD');
}

/** Regression：在 stage worktree 跑 bin/check --upstream，輸出寫到 reg-<key>.log，checkpoint 追加 regression 行；傳回 exit code。 */
function regression(main, tree, key, sha, file) {
  const log = join(main, `.scratch/pilot/reg-${key}.log`);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'w');
  const result = spawnSync(join(tree, 'bin/check'), ['--upstream'], { cwd: tree, env: childEnv, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const code = result.status ?? 1;
  const last = readFileSync(log, 'utf8').trimEnd().split('\n').pop();
  appendRegression(file, `${sha} exit ${code}${code === 0 && last.startsWith('CHECK_PASS ') ? ` ${last}` : ''}`);
  return code;
}

/**
 * staged SHA 合的還是現在這組成員：每個 done 成員的分支都在裡面，其他成員（如 hold 期間 `moved` 的）的分支沒有被這次 stage 合進來。
 * 成員分支在 stage 之後多了 commit 也不算，否則 RESUME 會把沒驗過的組合當成通過。
 */
function sameMembers(main, members, staged, tip) {
  const within = (branch, sha) => gitIn(main, 'merge-base', '--is-ancestor', branch, sha).status === 0;
  return members.every(({ branch, state }) => (state === 'done' ? within(branch, staged) : !within(branch, staged) || within(branch, tip)));
}

/** 整個流程；傳回 MERGED 的 SHA，其他結果丟 Stop。 */
function land(key) {
  const main = mainCheckout();
  const file = join(main, `.scratch/pilot/batch-${key}.md`);
  const checkpoint = readCheckpoint(file);
  const branch = `pilot/stage-${key}`;
  const merged = checkpoint.current.match(/^merged ([0-9a-f]{40})\b/)?.[1];
  if (merged && gitIn(main, 'merge-base', '--is-ancestor', merged, INTEGRATION).status === 0) return merged;
  if (!/^(dispatched|staged)\b/.test(checkpoint.current)) throw new Stop(`checkpoint current: ${checkpoint.current}`);
  const pending = checkpoint.members.find(m => m.state !== 'done' && !m.state?.startsWith('moved'));
  if (pending) throw new Stop(`member ${pending.n} ${pending.state}`);
  const members = checkpoint.members.filter(m => m.state === 'done');
  if (!members.length) throw new Stop(`checkpoint ${file} 沒有 done 成員`);

  const tree = stageWorktree(main) ?? createStageWorktree(main, key);
  if (must(tree, 'status', '--porcelain')) throw new Stop(`dirty ${tree}`);
  const tip = must(main, 'rev-parse', INTEGRATION);
  const [, staged, onto] = checkpoint.current.match(/^staged ([0-9a-f]{40}) onto ([0-9a-f]{40})\b/) ?? [];
  let sha;
  if (staged && onto === tip && checkpoint.regression?.startsWith(`${staged} exit 0`)
    && gitIn(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`).stdout.trim() === staged
    && sameMembers(main, checkpoint.members, staged, tip)) {
    sha = staged;
    console.log(`RESUME ${key} ${sha}`);
  } else {
    sha = stage(tree, key, members, tip);
    setCurrent(file, `staged ${sha} onto ${tip}`);
    console.log(`STAGED ${key} ${sha} onto ${tip}`);
    const code = regression(main, tree, key, sha, file);
    if (code !== 0) throw new Stop(`regression ${code}`);
  }

  if (existsSync(join(main, '.scratch/pilot/hold'))) throw new Stop('hold');
  if (must(main, 'rev-parse', INTEGRATION) !== tip) throw new Stop('drift');
  must(tree, 'switch', '-q', INTEGRATION);
  must(tree, 'merge', '--ff-only', '-q', branch);
  must(tree, 'branch', '-d', branch);
  setCurrent(file, `merged ${sha}`);
  return sha;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [key, ...rest] = process.argv.slice(2);
  const request = rest[0] === '--branch' ? rest[1] : undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key ?? '')
    || (rest.length && !(rest.length === 2 && /^req-\d+$/.test(key) && /^retro\/[a-z0-9][a-z0-9-]*$/.test(request ?? '')))) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    if (request) openRequest(key, request);
    console.log(`MERGED ${key} ${land(key)}`);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.log(`STOP ${error.message}`);
    process.exit(4);
  }
}
