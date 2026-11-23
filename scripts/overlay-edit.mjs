#!/usr/bin/env node
// 編輯 overlays/<name>.patch：不必再手寫 `diff -u a b | sed …`（#462-1）。
// 用法：node scripts/overlay-edit.mjs <name> [--reset] [--dir <dir>]
//       node scripts/overlay-edit.mjs <name> --write [--dir <dir>]
//   不帶 --write：把上游 skill（matt-skills.txt／pstack-skills.txt 列的那一份）複製到編輯目錄，套上現有的 overlays/<name>.patch（沒有就是新 overlay），印出路徑。
//                 編輯目錄已存在時不覆蓋（保留改到一半的內容）；--reset 重新複製。
//   --write：比對目前的上游 skill 與編輯目錄，重產 overlays/<name>.patch（`git diff --no-index`，路徑寫成 a/<file>、b/<file>，和 sync-skills 的 `git apply` 相容），
//            再把新補丁套在上游的乾淨複本上，結果要和編輯目錄完全相同才寫入。
//   --dir <dir>：編輯目錄，預設 <repo>/.scratch/overlay-edit/<name>（.scratch/ 不進版控）。
// 上游位置與套用方式沿用 scripts/sync-skills.mjs（MATT_SKILLS、PSTACK_SKILLS）。
// stdout：OVERLAY_EDIT <dir>、OVERLAY_WRITTEN <patch>。
// stderr：UNKNOWN_SKILL、OVERLAY_FAILED、EXISTS、NO_EDIT_DIR、NO_CHANGES、ROUNDTRIP_FAILED（exit 1）；參數錯誤印用法並 exit 2。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPatch, upstreamSkill } from './sync-skills.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `用法：node scripts/overlay-edit.mjs <name> [--reset | --write] [--dir <dir>]
  （不帶旗標）  把上游 skill 複製到編輯目錄並套上現有補丁，印出路徑
  --reset       編輯目錄已存在時也重新複製
  --write       從編輯目錄重產 overlays/<name>.patch
  --dir <dir>   編輯目錄（預設 .scratch/overlay-edit/<name>）`;

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const fail = line => {
  console.error(line);
  return 1;
};

/** 複製上游 skill 到 dir，套上 patch（存在時）；失敗回傳 git apply 的 stderr。 */
function materialize(src, patch, dir) {
  cpSync(src, dir, { recursive: true, verbatimSymlinks: true });
  if (!existsSync(patch)) return '';
  const applied = applyPatch(patch, dir, ['ignore', 'pipe', 'pipe']);
  return applied.status === 0 ? '' : applied.stderr || `git apply exit ${applied.status}`;
}

/** 兩個目錄的檔案清單與內容是否相同。 */
function sameTree(a, b) {
  const listing = dir => readdirSync(dir, { recursive: true }).map(String).filter(name => statSync(join(dir, name)).isFile()).sort();
  const [left, right] = [listing(a), listing(b)];
  return left.length === right.length && left.every((name, i) => name === right[i] && readFileSync(join(a, name)).equals(readFileSync(join(b, name))));
}

/**
 * 上游 src 與編輯目錄 edit 的差異，寫成 overlay 補丁格式：`diff --git a/<file> b/<file>`。
 * 兩邊放在暫存目錄的 a、b 底下再 `--no-prefix`，路徑就是 a/<file>、b/<file>；使用者的 diff 設定（前綴、顏色、外部 diff）一律關掉。
 */
function makePatch(src, edit) {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-edit-'));
  try {
    cpSync(src, join(tmp, 'a'), { recursive: true, verbatimSymlinks: true });
    cpSync(edit, join(tmp, 'b'), { recursive: true, verbatimSymlinks: true });
    const diff = spawnSync('git', ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--no-index', '--no-prefix', '--no-color', '--no-ext-diff', 'a', 'b'], { cwd: tmp, env, encoding: 'utf8' });
    if (diff.status > 1 || diff.status === null) throw new Error(`git diff --no-index 失敗：${diff.stderr}`);
    return diff.stdout;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  let name, mode, dir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--write' || arg === '--reset') && !mode) mode = arg;
    else if (arg === '--dir' && !dir && argv[i + 1]) dir = resolve(argv[++i]);
    else if (!arg.startsWith('-') && !name) name = arg;
    else return console.error(USAGE), 2;
  }
  if (!name) return console.error(USAGE), 2;

  const upstream = upstreamSkill(name, ROOT);
  if (!upstream) return fail(`UNKNOWN_SKILL ${name}（matt-skills.txt、pstack-skills.txt 都沒有啟用這個名稱）`);
  if (!existsSync(join(upstream.dir, 'SKILL.md'))) return fail(`UNKNOWN_SKILL ${name}（${upstream.label} checkout 沒有 ${upstream.dir}/SKILL.md）`);
  const patch = join(ROOT, 'overlays', `${name}.patch`);
  dir ??= join(ROOT, '.scratch/overlay-edit', name);

  if (mode === '--write') {
    if (!existsSync(dir)) return fail(`NO_EDIT_DIR ${dir}（先跑 node scripts/overlay-edit.mjs ${name}）`);
    const text = makePatch(upstream.dir, dir);
    if (!text) return fail(`NO_CHANGES ${dir} 和上游 ${upstream.dir} 相同；不需要 overlay 就刪掉 ${patch}`);
    // 寫入前驗證：新補丁套在上游乾淨複本上，要和編輯目錄一模一樣。
    const tmp = mkdtempSync(join(tmpdir(), 'overlay-edit-check-'));
    try {
      writeFileSync(join(tmp, 'new.patch'), text);
      const error = materialize(upstream.dir, join(tmp, 'new.patch'), join(tmp, 'tree'));
      if (error || !sameTree(join(tmp, 'tree'), dir)) return fail(`ROUNDTRIP_FAILED ${name}：新補丁套用後和 ${dir} 不同，未寫入${error ? `（${error.trim()}）` : ''}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    mkdirSync(dirname(patch), { recursive: true });
    writeFileSync(patch, text);
    console.log(`OVERLAY_WRITTEN ${patch}`);
    return 0;
  }

  if (existsSync(dir)) {
    if (mode !== '--reset') return fail(`EXISTS ${dir}（保留改到一半的內容；要重新複製加 --reset）`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dirname(dir), { recursive: true });
  const error = materialize(upstream.dir, patch, dir);
  if (error) {
    rmSync(dir, { recursive: true, force: true });
    return fail(`OVERLAY_FAILED ${name}：${patch} 無法套用在目前的 ${upstream.label} 版本（${error.trim()}）`);
  }
  console.log(`OVERLAY_EDIT ${dir}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
