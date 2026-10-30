#!/usr/bin/env node
// 重建 skill 連結：上游原版（Matt、pstack，皆唯讀）＋ overlays/ 補丁＋本 repo 自有 skills。
// 由 bin/sync-skills 呼叫；原本是 bash，macOS 內建 bash 3.2 沒有 `declare -A`，改寫成 node（#85）。
// 用法：bin/sync-skills [--check | --list]
//   --check  只檢查 overlay 能否套用在目前的上游 checkout，不改任何連結。
//   --list   列出目前可用的 skill：user/model、名稱、來源（含目前目錄的 .claude/skills 專案 skill）。
// 環境變數：MATT_SKILLS（預設 ~/code/skills）、PSTACK_SKILLS（預設 ~/code/pstack）、
//           SKILL_DIRS（預設 ~/.claude/skills 與 ~/.agents/skills）
// 清單檔：matt-skills.txt（相對 skills/，兩層 <類別>/<名稱>）、pstack-skills.txt（相對 skills/，一層 <名稱>）。
// 清單內 `# pin: <SHA>` 註明驗證過的上游版本；checkout 的 HEAD 不同時只警告。
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// 不用 import.meta.url：node 會解開 symlink，ROOT 要和 bash 版的 `cd "$(dirname "$0")/.." && pwd` 一樣是呼叫時的路徑。
const ROOT = resolve(dirname(process.argv[1]), '..');
const HOME = homedir();
const MATT = process.env.MATT_SKILLS || join(HOME, 'code/skills');
const PSTACK = process.env.PSTACK_SKILLS || join(HOME, 'code/pstack');
const BUILD = join(process.env.XDG_DATA_HOME || join(HOME, '.local/share'), 'ron-skills/overlay');
const DESTS = (process.env.SKILL_DIRS || `${HOME}/.claude/skills ${HOME}/.agents/skills`).split('\n')[0].trim().split(/[ \t]+/);
// git hook（pre-commit 跑 bin/check）會匯出這些變數，`git -C <上游 checkout>` 繼承後讀到的是本 repo。
const env = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[key];

const warn = line => console.error(line);
const isDir = path => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = path => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const isLink = path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
/** shell glob `*` 的一層：不含點開頭的項目。 */
const entries = dir => (isDir(dir) ? readdirSync(dir).filter(name => !name.startsWith('.')).map(name => join(dir, name)) : []);
const under = (path, base) => path.startsWith(`${base}/`);
/** 和 bash 的 `$(git … || echo <fallback>)` 一樣：失敗時接上 fallback，去掉結尾換行。 */
const git = (cwd, args, fallback = '') => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  return (result.stdout + (result.status === 0 ? '' : fallback)).replace(/\n+$/, '');
};
/** bash 的 $PWD 是邏輯路徑；環境的 PWD 失效時才退回 getcwd。 */
const cwd = () => {
  const pwd = process.env.PWD;
  try {
    if (pwd && realpathSync(pwd) === process.cwd()) return pwd;
  } catch {}
  return process.cwd();
};

function list() {
  const pwd = cwd();
  const lines = [];
  for (const dir of [...entries(DESTS[0]), ...entries(join(pwd, '.claude/skills'))]) {
    if (!isDir(dir) || !isFile(join(dir, 'SKILL.md'))) continue;
    const real = realpathSync(dir);
    const src = under(real, BUILD) ? 'overlay' : under(real, MATT) ? 'matt' : under(real, PSTACK) ? 'pstack' : under(real, ROOT) ? 'ron-skills' : under(real, join(pwd, '.claude')) ? 'project' : 'other';
    const kind = /^disable-model-invocation: true/m.test(readFileSync(join(dir, 'SKILL.md'), 'utf8')) ? 'user' : 'model';
    lines.push(`${kind}\t${basename(dir)}\t${src}\n`);
  }
  // 交給 sort -u：排序跟著本機 locale，輸出才和 bash 版逐行相同。
  const sorted = spawnSync('sort', ['-u'], { input: lines.join(''), encoding: 'utf8' });
  process.stdout.write(sorted.stdout);
  return sorted.status;
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
      const branch = git(base, ['rev-parse', '--abbrev-ref', 'HEAD'], '非 git 目錄');
      if (branch !== 'main' || spawnSync('git', ['-C', base, 'status', '--porcelain', '--', 'skills'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'] }).stdout.trim()) {
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
      for (const dir of dirs.sort()) {
        const rel = dir.slice(join(base, 'skills').length + 1);
        if (isFile(join(dir, 'SKILL.md')) && !listed.has(rel)) warn(`NEW ${label} ${rel}（上游新增；在 ${listName} 加入或以 -${rel} 略過）`);
      }
    };

    syncSource('Matt', MATT, join(ROOT, 'matt-skills.txt'), 2);
    syncSource('pstack', PSTACK, join(ROOT, 'pstack-skills.txt'), 1);

    for (const dir of entries(join(ROOT, 'skills')).flatMap(entries)) {
      if (isDir(dir) && isFile(join(dir, 'SKILL.md'))) target.set(basename(dir), dir);
    }

    const checks = [
      ['node', [join(ROOT, 'scripts/check-loop-invocable.mjs')], { ...env, MATT_SKILLS: MATT, PSTACK_SKILLS: PSTACK }],
      ['node', [join(ROOT, 'scripts/check-pilot-lines.mjs')], env],
    ];
    // 原本是 `… >&2`：檢查的 stdout 一律轉到 stderr，stdout 只留結果行。
    for (const [cmd, args, childEnv] of checks) {
      if (spawnSync(cmd, args, { env: childEnv, stdio: ['ignore', 2, 2] }).status !== 0) failed = true;
    }

    if (failed) return 1;
    if (check) {
      console.log(`CHECK_OK ${target.size} skills`);
      return 0;
    }

    mkdirSync(BUILD, { recursive: true });
    for (const patch of entries(join(ROOT, 'overlays')).filter(path => path.endsWith('.patch')).sort()) {
      const name = basename(patch, '.patch');
      if (!isDir(join(tmp, name))) continue;
      rmSync(join(BUILD, name), { recursive: true, force: true });
      move(join(tmp, name), join(BUILD, name));
    }

    for (const dest of DESTS) {
      mkdirSync(dest, { recursive: true });
      // 移除指向受管來源、但已不在清單內的舊連結；其他連結與實體目錄一律不碰。
      for (const link of entries(dest)) {
        if (!isLink(link)) continue;
        const to = readlinkSync(link);
        if ([MATT, PSTACK, ROOT, BUILD].some(base => under(to, base)) && !target.has(basename(link))) unlinkSync(link);
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
    console.log(`SYNCED ${target.size} skills → ${DESTS.join(' ')}`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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
