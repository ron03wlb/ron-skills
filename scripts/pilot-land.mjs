#!/usr/bin/env node
// /issue-pilot coordinator 的 Stage → Regression → hold 檢查 → Integrate，一個指令完成（docs/agents/pilot.md 的同名條目，#75）。
// 全部在 stage worktree 做（分支是 pilot/integration 或 pilot/stage-* 的那個 worktree；沒有就用 Orca 建 pilot-stage，再跑 Bare guard）：
//   Stage       stage worktree 要乾淨；`switch -C pilot/stage-<key> <integration tip>`，依號碼 `merge --no-ff` 每個 done 成員。
//               衝突只照 Stage 條目允許的解法自己解，其他 `merge --abort`：
//                 restamp    scripts/workflow-doc-sync.json：其他衝突檔都用下兩種解完之後，跑 check-workflow-sync.mjs --restamp（#72）；
//                 additions  每個衝突 hunk 的 base 是空的（兩邊只在既有檔案的同一處新增，沒有相同的非空行或同名條目）：依號碼兩段都留下；
//                 entries    每個衝突 hunk 裡兩邊改的是不同的 `- **<名稱>.**` 條目：各取改過的那一版（#45）。
//               additions 與 entries 只解三個版本都是 UTF-8 文字的檔案，其他的照樣 abort。
//               staged SHA 與 stage 時的 integration tip 寫成 checkpoint 的 `current: staged <sha> onto <tip>`。
//   Regression  在 staged SHA 跑 <stage worktree>/bin/check --upstream，完整輸出寫到 <主 checkout>/.scratch/pilot/reg-<key>.log，
//               checkpoint 追加 `regression: <sha> exit <code>`（通過時附 bin/check 最後一行 CHECK_PASS）。
//   hold        <主 checkout>/.scratch/pilot/hold 存在就停。
//   Integrate   pilot/integration 的 tip 要還是 stage 時記下的那個（不數 parent：batch-40-51 用 `$SHA^1` 誤判兩個成員的 batch）；
//               `switch pilot/integration`、`merge --ff-only`、`branch -d` stage 分支，`current:` 寫成 `merged <sha>`。
// 重跑：`current:` 是 `staged <sha> onto <tip>`、tip 沒變、stage 分支還在那個 SHA、成員組合與各分支都沒變、最後一個 regression 行是它的 exit 0 時，
//   不重新 stage、不重跑 Regression，直接從 hold 檢查繼續；其他情況一律從 Stage 重來。已經 `merged` 時只再印一次 MERGED。
// checkpoint 格式見 skills/engineering/issue-pilot/PILOT-STORE.md；寫回之後再讀一次，沒寫進去就 STOP checkpoint，不會靜默失敗（#74）。
//
// 用法：node scripts/pilot-land.mjs <batch key>（在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）
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

const USAGE = '用法：node scripts/pilot-land.mjs <batch key>（在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）';
const INTEGRATION = 'pilot/integration';
const STAMPS = 'scripts/workflow-doc-sync.json';
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

/** batch checkpoint：`current:` 的值、成員 `{ n, branch, state }`（欄位見 PILOT-STORE.md）與最後一個 `regression:` 行的值。欄位前後的空格不影響。 */
function readCheckpoint(file) {
  if (!existsSync(file)) throw new Stop(`checkpoint 缺 ${file}`);
  const text = readFileSync(file, 'utf8');
  const current = text.match(/^current:[ \t]*(.*)$/m)?.[1].trim();
  if (current === undefined) throw new Stop(`checkpoint ${file} 沒有 current: 行`);
  const members = text.split('\n').filter(line => line.trim().startsWith('|'))
    .map(line => line.trim().split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(([n]) => /^\d+$/.test(n))
    .map(([n, branch, , , , , state]) => ({ n: Number(n), branch, state }))
    .sort((a, b) => a.n - b.n);
  const regression = [...text.matchAll(/^regression:[ \t]*(.*)$/gm)].pop()?.[1].trim();
  return { current, members, regression };
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

/** 一個衝突 hunk 照允許的解法解；解不了傳回 undefined。`kinds` 收集用到的解法。 */
function resolveHunk(base, ours, theirs, kinds) {
  if (base === '') {
    // 不重疊：兩邊新增的非空行不能有相同的（diff3 不剝掉共有的行，同一個標題接起來就重複了），條目也不能同名。
    const lines = text => text.split('\n').filter(line => line.trim());
    const names = text => entries(text).map(p => p.name).filter(Boolean);
    if (lines(ours).some(line => lines(theirs).includes(line)) || names(ours).some(name => names(theirs).includes(name))) return undefined;
    kinds.add('additions');
    return `${ours}${ours.endsWith('\n') ? '' : '\n'}${theirs}`;
  }
  const [b, o, t] = [base, ours, theirs].map(entries);
  const names = pieces => pieces.map(p => p.name).join('\n');
  if (b.length < 2 || names(o) !== names(b) || names(t) !== names(b)) return undefined;
  const merged = b.map(({ text }, i) => {
    if (o[i].text === text) return t[i].text;
    if (t[i].text === text || t[i].text === o[i].text) return o[i].text;
    return undefined;
  });
  if (merged.includes(undefined)) return undefined;
  kinds.add('entries');
  return merged.join('');
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
    let hunk;
    for (const line of merged.stdout.split(/(?<=\n)/)) {
      const marker = line.replace(/\n$/, '');
      if (!hunk && marker === `${'<'.repeat(MARKER)} ours`) hunk = { part: 'ours', ours: '', base: '', theirs: '' };
      else if (hunk && marker === `${'|'.repeat(MARKER)} base`) hunk.part = 'base';
      else if (hunk && marker === '='.repeat(MARKER)) hunk.part = 'theirs';
      else if (hunk && marker === `${'>'.repeat(MARKER)} theirs`) {
        const resolved = resolveHunk(hunk.base, hunk.ours, hunk.theirs, kinds);
        if (resolved === undefined) return undefined;
        out += resolved;
        hunk = undefined;
      } else if (hunk) hunk[hunk.part] += line;
      else out += line;
    }
    return hunk ? undefined : out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 照 Stage 條目允許的解法解掉進行中 merge 的衝突並 add；傳回解法名稱，解不了傳回 undefined（呼叫端 abort）。 */
function resolveConflicts(tree, files) {
  const others = files.filter(path => path !== STAMPS);
  const kinds = new Set();
  const resolved = others.map(path => resolveFile(tree, path, kinds));
  if (resolved.includes(undefined)) return undefined;
  others.forEach((path, i) => writeFileSync(join(tree, path), resolved[i]));
  if (others.length) must(tree, 'add', '--', ...others);
  // 戳記檔最後重算：restamp 讀的是其他檔解完之後的來源。
  if (files.includes(STAMPS)) {
    if (run('node', [join(tree, 'scripts/check-workflow-sync.mjs'), '--restamp'], { cwd: tree }).status !== 0) return undefined;
    must(tree, 'add', STAMPS);
    kinds.add('restamp');
  }
  return [...kinds].sort().join('+');
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key ?? '') || rest.length) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    console.log(`MERGED ${key} ${land(key)}`);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.log(`STOP ${error.message}`);
    process.exit(4);
  }
}
