// `from..to` 改了哪些檔與哪些 `- **<名稱>.**` 條目。pilot-probe.mjs 的 OVERLAP 與 worktree-overlap.mjs 共用：
// 獨立成一支，worktree-overlap.mjs 複製到沒有 pilot-probe.mjs 的 repo 時才不必帶上整組 pilot 腳本（retro spay2 6d21b9cc#4）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 在 checkout 跑 git；清掉繼承的 GIT_DIR 等，從 hook 或 worktree 呼叫時才不會讀到別的 repo。 */
function git(checkout, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
  return spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 分支上的檔案內容；沒有這個檔時回空字串。 */
function show(checkout, ref, path) {
  const result = git(checkout, 'show', `${ref}:${path}`);
  return result.status === 0 ? result.stdout : '';
}

/** 一行一個 `- **<名稱>.**` 的條目（adapter 的 Pilot 設定就是這種格式）。 */
const ENTRY = /^- \*\*(.+?)\.\*\*/;

/**
 * 第 `i` 行（0 起算）所在的條目名稱：往上找到 `- **<名稱>.**` 那一行為止，中間只能是空行或縮排的續行；
 * 先碰到其他不縮排的行（標題、段落、別的 bullet）或檔頭時回 null。
 */
function entryAt(lines, i) {
  for (let j = Math.min(i, lines.length - 1); j >= 0; j--) {
    const name = lines[j].match(ENTRY)?.[1];
    if (name) return name;
    if (lines[j].trim() && !/^\s/.test(lines[j])) return null;
  }
  return null;
}

/**
 * `from..to` 改了哪些檔：Map<檔案, { whole, entries }>。`.md` 檔的改動行（空行不算）都落在條目裡時只記條目名稱
 * （刪掉的行看 from 的版本、加上的行看 to 的版本），有任何一行不在條目裡，或不是 `.md`，就記整個檔（whole）。
 * `to` 是 null 時比 `checkout` 的工作樹（含暫存區與未追蹤、沒被 ignore 的新檔；worktree-overlap 用，#194）。
 * `paths` 只比這些檔；`adjacent`（預設開）把緊鄰改動、git 合併時會一起衝突的條目也算進去，只想知道改了哪些條目時關掉。
 */
export function changedUnits(checkout, from, to, { paths = [], adjacent = true } = {}) {
  const run = (...args) => {
    const result = git(checkout, ...args);
    if (result.status !== 0) throw new Error(`git ${args[0]} exit ${result.status}：${result.stderr.trim()}`);
    return result.stdout;
  };
  const refs = to === null ? [from] : [from, to];
  const names = text => text.split('\0').filter(Boolean);
  const untracked = new Set(to === null ? names(run('ls-files', '-z', '--others', '--exclude-standard', '--', ...paths)) : []);
  const after = path => {
    if (to !== null) return show(checkout, to, path);
    const file = join(checkout, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const units = new Map();
  const changed = names(run('diff', '--name-only', '-z', '--no-renames', ...refs, '--', ...paths));
  for (const path of untracked.size ? [...changed, ...untracked].sort() : changed) {
    const unit = { whole: !path.endsWith('.md'), entries: new Set() };
    units.set(path, unit);
    if (unit.whole) continue;
    const versions = { '-': show(checkout, from, path).split('\n'), '+': after(path).split('\n') };
    // 未追蹤的新檔沒有 diff 可讀，整份都是加上的行。
    const hunks = untracked.has(path) ? `@@ -0,0 +1,${versions['+'].length} @@`
      : run('diff', '-U0', '--no-color', '--no-renames', '--diff-algorithm=histogram', ...refs, '--', path);
    for (const [, oldStart, oldCount = '1', newStart, newCount = '1'] of hunks.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      for (const [side, start, count] of [['-', oldStart, oldCount], ['+', newStart, newCount]]) {
        for (let i = Number(start) - 1; i < Number(start) - 1 + Number(count); i++) {
          if (!versions[side][i]?.trim()) continue;
          const name = entryAt(versions[side], i);
          if (name) unit.entries.add(name);
          else unit.whole = true;
        }
      }
      if (!adjacent) continue;
      // git 照位置合併：改到相接的行、或在同一處插入也會衝突，所以 from 那邊緊鄰 hunk 前後的行所在的條目也算。
      // 空行不算（中間隔著沒人改的空行就不會衝突）；純插入的前後都是空行或檔尾時，才往上找插入點所在的條目，同一處的插入才對得上。
      const old = versions['-'];
      const [start, count] = [Number(oldStart), Number(oldCount)];
      // `-<行>,<n>` 的 hunk 佔 0 起算的 start-1 到 start+n-2；n 是 0 時是插在第 start 行之後。
      const around = count ? [start - 2, start + count - 1] : [start - 1, start];
      const anchors = around.filter(i => i >= 0 && old[i]?.trim()).map(i => entryAt(old, i));
      if (!count && !anchors.length && around[0] >= 0) anchors.push(entryAt(old, around[0]));
      for (const name of anchors) if (name) unit.entries.add(name);
    }
  }
  return units;
}
