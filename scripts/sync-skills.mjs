#!/usr/bin/env node
// 重建 skill 連結：上游原版（Matt、pstack，皆唯讀）＋ overlays/ 補丁＋本 repo 自有 skills。
// 由 bin/sync-skills 呼叫；原本是 bash，macOS 內建 bash 3.2 沒有 `declare -A`，改寫成 node（#85）。
// 用法：bin/sync-skills [--check | --list]
//   --check  只檢查 overlay 能否套用在目前的上游 checkout，不改任何連結；也回報 SKILL_DIRS 裡的失效連結與 repo 外的來源（#287），這是這台機器的狀態，不影響 exit。
//   --list   列出目前可用的 skill：user/model、名稱、來源（含目前目錄的 .claude/skills 專案 skill）。
// 同步時也把 hooks/ 的檔案連到 HOOK_DIR：沒版控的全域 hook 只存在一台機器，換機就失效。實體檔內容相同才換成連結，不同就 SKIP。
// 環境變數：MATT_SKILLS（預設 ~/code/skills）、PSTACK_SKILLS（預設 ~/code/pstack）、
//           SKILL_DIRS（預設 ~/.claude/skills 與 ~/.agents/skills）、
//           HOOK_DIR（預設 ~/.claude/hooks）
//           WIN_SKILL_DIR（Windows 目標的 WSL 路徑；預設在 WSL 裡取 %USERPROFILE%\.claude\skills；設成空字串、或有設 SKILL_DIRS 而沒設它時不碰 Windows）
// 清單檔：matt-skills.txt（相對 skills/，兩層 <類別>/<名稱>）、pstack-skills.txt（相對 skills/，一層 <名稱>）、
//         windows-skills.txt（本 repo 的 skills/，兩層 <類別>/<名稱>；連到 Windows ~/.claude/skills，給 Windows 上的 Claude Code，例如 Orca bot）。
// Windows 目標：透過 interop 以 `cmd.exe /c mklink /D` 建 Windows 原生 symlink，指向主 checkout 的 `\\wsl.localhost\<distro>\…`。
//   從 /mnt/c 用 ln -s 建的是 WSL 專用 symlink，Windows 打不開；junction 不能指向 UNC。建立 symlink 要開發人員模式或系統管理員權限。
//   只新增或更新清單上的項目；不在清單上的項目一律不碰（也不刪）。
// 清單內 `# pin: <SHA>` 註明驗證過的上游版本；checkout 的 HEAD 不同時只警告。
// stdout：--list 每個 skill 一行；--check 成功時 `CHECK_OK <n> skills`；同步成功時先印內容有變的 overlay `SKILL_CHANGED <名稱>`（已安裝的全域行為變了，retro spay2 b949589b#2），再印 `SYNCED <n> skills → <dirs>`。
// stderr：MISSING、DUPLICATE、OVERLAY_FAILED、WIN_LINK_FAILED（exit 1），NEW、SKIP、WARN、DANGLING <連結> -> <目標>、EXTERNAL <連結> -> <真實路徑>（只提示）。exit 0 成功、1 有任何 exit 1 的行或檢查失敗。
//   Windows 目標：WIN_SKIP <原因>（不在 WSL 等，略過）；--check 回報 WIN_MISSING、WIN_WRONG <連結> -> <目前目標>（應為 …）、WIN_NOT_LINK（只提示，這台機器的狀態）；同步時建立或更新印 WIN_LINKED <連結> -> <目標>。
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// 不用 import.meta.url：node 會解開 symlink，ROOT 要和 bash 版的 `cd "$(dirname "$0")/.." && pwd` 一樣是呼叫時的路徑。
const ROOT = resolve(dirname(process.argv[1]), '..');
const HOME = homedir();
const MATT = process.env.MATT_SKILLS || join(HOME, 'code/skills');
const PSTACK = process.env.PSTACK_SKILLS || join(HOME, 'code/pstack');
const BUILD = join(process.env.XDG_DATA_HOME || join(HOME, '.local/share'), 'ron-skills/overlay');
const HOOK_DIR = process.env.HOOK_DIR || join(HOME, '.claude/hooks');
const WIN_LIST = join(ROOT, 'windows-skills.txt');
const DESTS = (process.env.SKILL_DIRS || `${HOME}/.claude/skills ${HOME}/.agents/skills`).split('\n')[0].split(/[ \t]+/).filter(Boolean);
// git hook（pre-commit 跑 bin/check）會匯出這些變數，`git -C <上游 checkout>` 繼承後讀到的是本 repo。
const env = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[key];

const warn = line => console.error(line);
const isDir = path => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = path => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const isLink = path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
/** shell glob `*` 的一層：不含點開頭的項目。 */
const entries = dir => (isDir(dir) ? readdirSync(dir).filter(name => !name.startsWith('.')).map(name => join(dir, name)) : []);
const hasSkill = dir => isDir(dir) && isFile(join(dir, 'SKILL.md'));
const under = (path, base) => path.startsWith(`${base}/`);
/** 和 bash 的 `$(git … || echo <fallback>)` 一樣：失敗時接上 fallback，去掉結尾換行；stderr 預設丟掉（`2>/dev/null`）。 */
const git = (dir, args, { fallback = '', stderr = 'ignore' } = {}) => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', stderr] });
  return ((result.stdout ?? '') + (result.status === 0 ? '' : fallback)).replace(/\n+$/, '');
};
/** 交給系統的 sort：排序跟著本機 locale，和 bash 的 glob 與 `sort` 一致，輸出才和 bash 版逐行相同。 */
const localeSort = (lines, ...flags) => {
  const result = spawnSync('sort', flags, { input: lines.map(line => `${line}\n`).join(''), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`sort 失敗（exit ${result.status}）`, { cause: result.error });
  return result.stdout.split('\n').filter(Boolean);
};
/** bash 的 $PWD 是邏輯路徑；環境的 PWD 失效時才退回 getcwd。 */
const logicalCwd = () => {
  const pwd = process.env.PWD;
  try {
    if (pwd && realpathSync(pwd) === process.cwd()) return pwd;
  } catch {}
  return process.cwd();
};

/** 受管來源，依 --list 判斷來源的順序；同步時只清掉指向這些位置的舊連結。 */
const MANAGED = [{ base: BUILD, label: 'overlay' }, { base: MATT, label: 'matt' }, { base: PSTACK, label: 'pstack' }, { base: ROOT, label: 'ron-skills' }];

/** 主 checkout：從 worktree 跑時 ROOT 是 worktree，已安裝的連結指向主 checkout 不算外部來源。 */
const mainCheckout = () => dirname(resolve(ROOT, git(ROOT, ['rev-parse', '--git-common-dir'], { fallback: '.git' })));

/** --check 的提示：連結目標已不存在（DANGLING），或來源不在受管位置、也不在另一個 SKILL_DIRS 裡（EXTERNAL）。舊 repo 搬走時不會有別的東西提醒。 */
function reportLinks() {
  const known = [...MANAGED.map(({ base }) => base), mainCheckout(), ...DESTS];
  for (const dest of DESTS) {
    for (const link of entries(dest).filter(isLink)) {
      if (!existsSync(link)) warn(`DANGLING ${link} -> ${readlinkSync(link)}`);
      else if (!known.some(base => under(realpathSync(link), base))) warn(`EXTERNAL ${link} -> ${realpathSync(link)}`);
    }
  }
}

function list() {
  const pwd = logicalCwd();
  const sources = [...MANAGED, { base: join(pwd, '.claude'), label: 'project' }];
  const lines = [];
  for (const dir of [...entries(DESTS[0]), ...entries(join(pwd, '.claude/skills'))]) {
    if (!hasSkill(dir)) continue;
    const real = realpathSync(dir);
    const src = sources.find(({ base }) => under(real, base))?.label ?? 'other';
    const kind = /^disable-model-invocation: true/m.test(readFileSync(join(dir, 'SKILL.md'), 'utf8')) ? 'user' : 'model';
    lines.push(`${kind}\t${basename(dir)}\t${src}`);
  }
  for (const line of localeSort(lines, '-u')) console.log(line);
  return 0;
}

function sync(check) {
  const target = new Map();
  const tmp = mkdtempSync(join(tmpdir(), 'sync-skills-'));
  let failed = false;
  try {
    // 處理一個上游：<標籤> <checkout> <清單檔> <SKILL.md 相對 skills/ 的層數>
    const syncSource = (label, base, listFile, depth) => {
      const listName = basename(listFile);
      if (!isDir(join(base, 'skills'))) {
        warn(`MISSING ${label} checkout：${base}（git clone 後再同步）`);
        failed = true;
        return;
      }
      const branch = git(base, ['rev-parse', '--abbrev-ref', 'HEAD'], { fallback: '非 git 目錄' });
      if (branch !== 'main' || git(base, ['status', '--porcelain', '--', 'skills'], { stderr: 'inherit' })) {
        warn(`WARN ${label} checkout 不是乾淨的 main（${branch}）；overlay 會套在目前內容上`);
      }
      const text = readFileSync(listFile, 'utf8');
      const pin = text.match(/^# pin: *([0-9a-f]{40})/m)?.[1];
      const head = git(base, ['rev-parse', 'HEAD']);
      if (pin && head !== pin) warn(`WARN ${label} HEAD ${head.slice(0, 12)} 不是 ${listName} 的 pin ${pin.slice(0, 12)}；驗證後更新 pin`);

      const listed = new Set();
      for (const rel of text.split('\n').map(line => line.trim())) {
        if (!rel || rel.startsWith('#')) continue;
        listed.add(rel.replace(/^-/, ''));
        if (rel.startsWith('-')) continue;
        const name = basename(rel), src = join(base, 'skills', rel);
        if (!isDir(src)) {
          warn(`MISSING ${label} ${rel}（上游已移除或改名，請更新 ${listName}）`);
          failed = true;
          continue;
        }
        if (target.has(name)) {
          warn(`DUPLICATE ${name}（${label} 與其他來源同名）`);
          failed = true;
          continue;
        }
        const patch = join(ROOT, 'overlays', `${name}.patch`);
        if (isFile(patch)) {
          cpSync(src, join(tmp, name), { recursive: true, verbatimSymlinks: true });
          if (spawnSync('git', ['apply', patch], { cwd: join(tmp, name), env, stdio: ['ignore', 'inherit', 'inherit'] }).status !== 0) {
            warn(`OVERLAY_FAILED ${name}：${patch} 無法套用在目前的 ${label} 版本，請重做補丁`);
            failed = true;
            continue;
          }
          target.set(name, join(BUILD, name));
        } else {
          target.set(name, src);
        }
      }
      // 上游新增、清單未列的 skill 只提示：要用就加一行，不用就加 `-<path>`。
      let dirs = entries(join(base, 'skills'));
      if (depth === 2) dirs = dirs.flatMap(entries);
      // bash 排的是 glob 展開後的 `<dir>/SKILL.md`：`foo-bar/SKILL.md` 和 `foo/SKILL.md` 的順序與只排目錄時相反。
      for (const file of localeSort(dirs.map(dir => join(dir, 'SKILL.md')))) {
        const dir = dirname(file), rel = dir.slice(join(base, 'skills').length + 1);
        if (hasSkill(dir) && !listed.has(rel)) warn(`NEW ${label} ${rel}（上游新增；在 ${listName} 加入或以 -${rel} 略過）`);
      }
    };

    syncSource('Matt', MATT, join(ROOT, 'matt-skills.txt'), 2);
    syncSource('pstack', PSTACK, join(ROOT, 'pstack-skills.txt'), 1);

    for (const dir of entries(join(ROOT, 'skills')).flatMap(entries)) {
      if (hasSkill(dir)) target.set(basename(dir), dir);
    }

    const checks = [
      ['node', [join(ROOT, 'scripts/check-loop-invocable.mjs')], { ...env, MATT_SKILLS: MATT, PSTACK_SKILLS: PSTACK }],
      ['node', [join(ROOT, 'scripts/check-pilot-lines.mjs')], env],
    ];
    // 原本是 `… >&2`：檢查的 stdout 一律轉到 stderr，stdout 只留結果行。
    for (const [cmd, args, childEnv] of checks) {
      if (spawnSync(cmd, args, { env: childEnv, stdio: ['ignore', 2, 2] }).status !== 0) failed = true;
    }

    const win = windowsPlan();
    if (!win) failed = true;
    if (failed) return 1;
    if (check) {
      reportLinks();
      checkWindows(win);
      console.log(`CHECK_OK ${target.size} skills`);
      return 0;
    }

    mkdirSync(BUILD, { recursive: true });
    for (const patch of entries(join(ROOT, 'overlays')).filter(path => path.endsWith('.patch'))) {
      const name = basename(patch, '.patch');
      if (!isDir(join(tmp, name))) continue;
      if (!sameTree(join(BUILD, name), join(tmp, name))) console.log(`SKILL_CHANGED ${name}`);
      rmSync(join(BUILD, name), { recursive: true, force: true });
      move(join(tmp, name), join(BUILD, name));
    }

    for (const dest of DESTS) {
      mkdirSync(dest, { recursive: true });
      // 移除指向受管來源、但已不在清單內的舊連結；其他連結與實體目錄一律不碰。
      for (const link of entries(dest)) {
        if (!isLink(link)) continue;
        const to = readlinkSync(link);
        if (MANAGED.some(({ base }) => under(to, base)) && !target.has(basename(link))) unlinkSync(link);
      }
      for (const [name, to] of target) {
        const path = join(dest, name);
        if (existsSync(path) && !isLink(path)) {
          warn(`SKIP ${path}（實體目錄，不覆蓋）`);
          continue;
        }
        if (isLink(path)) unlinkSync(path);
        symlinkSync(to, path);
      }
    }
    syncHooks();
    linkPreCommit();
    const winOk = syncWindows(win);
    console.log(`SYNCED ${target.size} skills → ${DESTS.join(' ')}`);
    return winOk ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 跑 Windows interop 指令；cmd.exe 在 Linux 路徑的 cwd 會先警告 UNC 不支援，有 /mnt/c 就換過去。stdout 用 latin1：cmd 的中文是 Big5，只需要 ASCII 部分。 */
const interop = (cmd, args) => spawnSync(cmd, args, { encoding: 'latin1', cwd: isDir('/mnt/c') ? '/mnt/c' : undefined, stdio: ['ignore', 'pipe', 'pipe'] });
const toWin = path => {
  const result = interop('wslpath', ['-w', path]);
  if (result.status !== 0) throw new Error(`wslpath -w ${path} 失敗（exit ${result.status}）`, { cause: result.error });
  return result.stdout.trim();
};

/** Windows 目標的 WSL 路徑；不處理時印 WIN_SKIP 並回傳空字串。 */
function windowsDir() {
  if ('WIN_SKILL_DIR' in process.env) {
    if (!process.env.WIN_SKILL_DIR) warn('WIN_SKIP WIN_SKILL_DIR 是空字串，略過 Windows 目標');
    return process.env.WIN_SKILL_DIR;
  }
  if (process.env.SKILL_DIRS) {
    warn('WIN_SKIP 有設 SKILL_DIRS，Windows 目標要另設 WIN_SKILL_DIR，略過');
    return '';
  }
  if (!(process.env.WSL_DISTRO_NAME || /microsoft/i.test(release())) || !isDir('/mnt/c')) {
    warn('WIN_SKIP 不在 WSL 或沒有 /mnt/c，略過 Windows 目標');
    return '';
  }
  const profile = interop('cmd.exe', ['/c', 'echo %USERPROFILE%']).stdout.trim();
  const unix = profile && interop('wslpath', ['-u', profile]);
  if (!unix || unix.status !== 0) {
    warn('WIN_SKIP 取不到 Windows 的 %USERPROFILE%，略過 Windows 目標');
    return '';
  }
  return join(unix.stdout.trim(), '.claude/skills');
}

/**
 * 讀 windows-skills.txt：清單錯（不是本 repo 的 skill、同名）回傳 null，由呼叫端 exit 1，CI 也驗得到；Windows 目標略過時 dir 是空字串。
 * 連結指向主 checkout：worktree 會被刪掉，Windows 端要跟著 main。
 */
function windowsPlan() {
  const listed = [];
  let ok = true;
  for (const rel of readFileSync(WIN_LIST, 'utf8').split('\n').map(line => line.trim())) {
    if (!rel || rel.startsWith('#')) continue;
    if (!hasSkill(join(ROOT, 'skills', rel))) {
      warn(`MISSING windows ${rel}（本 repo 沒有 skills/${rel}/SKILL.md，請更新 windows-skills.txt）`);
      ok = false;
    } else if (listed.some(({ name }) => name === basename(rel))) {
      warn(`DUPLICATE ${basename(rel)}（windows-skills.txt 同名）`);
      ok = false;
    } else {
      listed.push({ name: basename(rel), rel });
    }
  }
  if (!ok) return null;
  const dir = listed.length ? windowsDir() : '';
  if (!dir) return { dir, entries: [] };
  return { dir, entries: listed.map(({ name, rel }) => ({ name, path: join(dir, name), to: toWin(join(mainCheckout(), 'skills', rel)) })) };
}

/** `dir /AL` 列出的 Windows 連結：名稱 → 目標（junction 的 `\??\` 前綴去掉）。沒有任何連結時 dir 回 exit 1，視為空。 */
function windowsLinks(dir) {
  const links = new Map();
  for (const line of interop('cmd.exe', ['/c', 'dir', '/AL', toWin(dir)]).stdout.split(/\r?\n/)) {
    const match = line.match(/<(?:SYMLINKD|SYMLINK|JUNCTION)>\s+(.+?) \[(.*)\]\s*$/);
    if (match) links.set(match[1], match[2].replace(/^\\\?\?\\/, ''));
  }
  return links;
}

/** 每個清單項目的狀態：ok、missing、wrong（Windows 連結指向別處，或 WSL 專用 symlink）、notLink（實體目錄或檔案）。 */
function windowsState({ dir, entries }) {
  const links = entries.length ? windowsLinks(dir) : new Map();
  return entries.map(entry => {
    const current = links.get(entry.name);
    if (current !== undefined) return { ...entry, state: current === entry.to ? 'ok' : 'wrong', current, windowsLink: true };
    if (isLink(entry.path)) return { ...entry, state: 'wrong', current: `${readlinkSync(entry.path)}（WSL 專用 symlink，Windows 打不開）` };
    if (lstatSync(entry.path, { throwIfNoEntry: false })) return { ...entry, state: 'notLink' };
    return { ...entry, state: 'missing' };
  });
}

function checkWindows(plan) {
  for (const { path, to, state, current } of windowsState(plan)) {
    if (state === 'missing') warn(`WIN_MISSING ${path}（bin/sync-skills 會建立，指向 ${to}）`);
    else if (state === 'wrong') warn(`WIN_WRONG ${path} -> ${current}（應為 ${to}）`);
    else if (state === 'notLink') warn(`WIN_NOT_LINK ${path}（實體目錄或檔案，不覆蓋）`);
  }
}

/** 建立或更新清單上的 Windows 連結；失敗回傳 false。 */
function syncWindows(plan) {
  let ok = true;
  if (plan.entries.length) mkdirSync(plan.dir, { recursive: true });
  for (const { path, to, state, windowsLink } of windowsState(plan)) {
    if (state === 'ok') continue;
    if (state === 'notLink') {
      warn(`SKIP ${path}（實體目錄或檔案，不覆蓋）`);
      continue;
    }
    if (state === 'wrong') {
      // Windows 連結用 rmdir 只移除連結本身；WSL 專用 symlink 從 WSL 刪。
      if (windowsLink) interop('cmd.exe', ['/c', 'rmdir', toWin(path)]);
      if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path);
    }
    const result = interop('cmd.exe', ['/c', 'mklink', '/D', toWin(path), to]);
    if (result.status === 0) {
      warn(`WIN_LINKED ${path} -> ${to}`);
    } else {
      warn(`WIN_LINK_FAILED ${path}：mklink /D 失敗（exit ${result.status}）；Windows 建 symlink 要開發人員模式（設定 → 系統 → 開發人員專用）或系統管理員權限，開啟後重跑 bin/sync-skills`);
      ok = false;
    }
  }
  return ok;
}

/** 兩個目錄的檔案清單與內容是否相同；不存在的目錄視為空。 */
function sameTree(a, b) {
  const listing = dir => (isDir(dir) ? readdirSync(dir, { recursive: true }).map(String).filter(name => isFile(join(dir, name))).sort() : []);
  const [left, right] = [listing(a), listing(b)];
  return left.length === right.length && left.every((name, i) => name === right[i] && readFileSync(join(a, name)).equals(readFileSync(join(b, name))));
}

/** hooks/ 的每個檔案連到 HOOK_DIR；內容不同的實體檔留著，交給人判斷。 */
function syncHooks() {
  const hooks = entries(join(ROOT, 'hooks'));
  if (hooks.length) mkdirSync(HOOK_DIR, { recursive: true });
  for (const from of hooks) {
    const path = join(HOOK_DIR, basename(from));
    if (isFile(path) && !isLink(path) && !readFileSync(path).equals(readFileSync(from))) {
      warn(`SKIP ${path}（實體檔內容不同，不覆蓋）`);
      continue;
    }
    rmSync(path, { force: true });
    symlinkSync(from, path);
  }
}

/**
 * 本 repo 的 pre-commit 與 commit-msg 連到 git 的 hooks 目錄：手動 ln 的那一步每個 clone 都要記得，漏了也看不出來（#300）。已有的不動，自己的 hook 留著並提示。
 * commit-msg 擋主旨後第二行非空（retro spay2 ff00a288#2）；本 repo 沒設 core.hooksPath，所以同樣靠連結啟用。
 */
function linkPreCommit() {
  const hooks = process.env.GIT_HOOKS_DIR || git(ROOT, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  for (const name of ['pre-commit', 'commit-msg']) {
    const from = join(mainCheckout(), '.githooks', name);
    if (!hooks || !existsSync(from)) continue;
    const path = join(hooks, name);
    if (isLink(path) && existsSync(path) && realpathSync(path) === realpathSync(from)) continue;
    if (isLink(path) || existsSync(path)) { warn(`SKIP ${path}（已有別的 hook，不覆蓋；要本 repo 把關就自己併入 .githooks/${name}）`); continue; }
    mkdirSync(hooks, { recursive: true });
    symlinkSync(relative(hooks, from), path);
    warn(`GIT_HOOK_LINKED ${path}`);
  }
}

/** 和 mv 一樣：暫存目錄與 BUILD 在不同檔案系統時改成複製再刪除。 */
function move(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const arg = process.argv[2];
process.exitCode = arg === '--list' ? list() : sync(arg === '--check');
