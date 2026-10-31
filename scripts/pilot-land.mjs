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
//                            改動的那幾行中間：兩邊都套用；純刪除、兩邊動到同一個 `- **<名稱>.**` 條目（含插入的新條目切開它）、
//                            兩邊都改了同一個 base 行、改動或插入碰到表格列（歸 rows）、最短 diff 的對齊不只一種而合出不同結果
//                            （接上 hunk 前後各一行）、換上的行和插入的行相同（非空行或同名條目）、碰到檔尾沒換行的行照樣 abort（#175）。
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
//   `STOP conflict <n> <檔>=<來源>:<種類> …`（已 abort，stage worktree 乾淨；每個衝突檔一項，#192）：來源是 `member <m>`（本次 stage
//     依號碼先合入、自己的分支改過這個檔的成員）、`integration`（成員開分支之後整合分支改過），或以 + 相連的多個來源（`member 79+integration`、`member 1+member 3`），
//     都看不出來（不該發生）時是 `unknown`；種類是 `entry <名稱>`（Markdown 檔解不了的 hunk 裡兩邊都改的 `- **<名稱>.**` 條目，
//     一邊增刪了條目、條目對不齊時是 hunk 碰到的每個條目，多個以、相連）、`code`（程式檔）或 `other`。
//     例：`STOP conflict 108 scripts/lib/hosts.mjs=member 79:code docs/agents/pilot.md=integration:entry Pool`。以及 `STOP checkpoint …`、`STOP member <n> <state>`、`STOP dirty <worktree>`、
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

/** 一個衝突檔逐一解每個 hunk；有一個解不了就傳回 undefined。 */
function resolveFile(tree, path, kinds) {
  const segments = diff3(tree, path);
  return segments && walkHunks(segments, (hunk, context) => resolveHunk(hunk.base, hunk.ours, hunk.theirs, kinds, context));
}

/** 程式檔的副檔名；副檔名不在清單裡時看 ours 那一版開頭是不是 shebang。 */
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cc|cpp)$/;

/**
 * STOP conflict 的種類欄（#192）：Markdown 檔裡解不了的 hunk 有兩邊都改的 `- **<名稱>.**` 條目時是 `entry <名稱>`（多個以、連接，
 * 條目開頭之前的文字歸到 hunk 之前所在的條目）；不然程式檔是 `code`，其他是 `other`。
 */
function conflictKind(tree, path) {
  const segments = path.endsWith('.md') && !STAMP_FILES.includes(path) ? diff3(tree, path) : undefined;
  const names = new Set();
  if (segments) {
    walkHunks(segments, (hunk, context) => {
      const resolved = resolveHunk(hunk.base, hunk.ours, hunk.theirs, new Set(), context);
      if (resolved === undefined) for (const name of bothChangedEntries(hunk, context.entry)) names.add(name);
      return resolved;
    });
  }
  if (names.size) return `entry ${[...names].join('、')}`;
  if (CODE.test(path)) return 'code';
  return blob(tree, `:2:${path}`)?.startsWith('#!') ? 'code' : 'other';
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

/** 這個檔在 from..to 之間有改動（新增、刪除也算）。 */
const touches = (tree, from, to, path) => gitIn(tree, 'diff', '--quiet', from, to, '--', path).status === 1;

/**
 * STOP conflict 的來源欄（#192）：本次 stage 先合入、自己的分支改過這個檔的成員是 `member <m>`，成員開分支之後整合分支改過的是
 * `integration`；兩者都有時以 + 連接（`member 79+integration`）。都看不出來（不該發生）時是 `unknown`。
 */
function conflictSource(tree, path, tip, branch, earlier) {
  const since = ref => must(tree, 'merge-base', tip, ref);
  const sources = earlier.filter(m => touches(tree, since(m.branch), m.branch, path)).map(m => `member ${m.n}`);
  if (touches(tree, since(branch), tip, path)) sources.push('integration');
  return sources.join('+') || 'unknown';
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
  for (const [index, { n, branch }] of members.entries()) {
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
      if (!conflicted.length) throw new Stop(`merge ${n} ${merge.reason}`);
      // 種類要讀 index 的三個 stage，在 abort 之前標好。
      const labels = conflicted.map(path => `${path}=${conflictSource(tree, path, tip, branch, members.slice(0, index))}:${conflictKind(tree, path)}`);
      throw new Stop(`conflict ${n} ${labels.join(' ')}`);
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
