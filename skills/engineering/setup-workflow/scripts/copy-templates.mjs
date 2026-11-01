#!/usr/bin/env node
// /setup-workflow 的複製：把 setup-workflow 正本連同執行期相依與測試複製到目標 repo 的 scripts/，
// 並在 docs/agents/workflow-templates.json 記錄每個副本的正本路徑、ron-skills commit 與 sha256（體檢以此判斷分歧）。
// 用法：node copy-templates.mjs <repo> [--dry-run] [--no-tests] [--yes] <template>...（template 為 templates/ 下的檔名，可省略 .mjs；
//       .sh 正本保留執行權限，並帶上它以 "$(dirname "$0")/<檔名>" 呼叫的同目錄腳本；<名稱>.test.mjs 是它的測試）
//       node copy-templates.mjs <repo> --verify
// 輸出每檔一行 `COPY|SAME|UPDATE|DIFF <副本路徑>`（UPDATE、DIFF 後接 unified diff；UPDATE 是 sha256 與清單記錄一致、沒手改過的舊副本，直接覆寫），最後一行：
//   PLANNED <n>（--dry-run）、COPIED <n>、CONFIRM_OVERWRITE <路徑...>（exit 3：既有檔內容不同且與清單記錄不一致，人確認後加 --yes 重跑）、
//   VERIFIED <n>（--verify 全部一致；有 MISMATCH／MISSING 或沒有清單時 exit 1）。參數或旗標錯誤、正本不存在或有未提交改動時 exit 2。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const MANIFEST = 'docs/agents/workflow-templates.json';

const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const [repoArg, ...names] = args.filter(arg => !arg.startsWith('--'));
const fail = message => { console.error(`copy-templates: ${message}`); process.exit(2); };
const unknown = [...flags].filter(flag => !['--dry-run', '--no-tests', '--yes', '--verify'].includes(flag));
if (unknown.length) fail(`不認得的旗標：${unknown.join(' ')}`);
if (!repoArg) fail('用法：copy-templates.mjs <repo> [--dry-run] [--no-tests] [--yes] <template>... | <repo> --verify');
const repo = resolve(repoArg);

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifestPath = join(repo, MANIFEST);
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { source: 'ron03wlb/ron-skills', copies: {} };

if (flags.has('--verify')) {
  if (!existsSync(manifestPath)) { console.log(`MISSING ${MANIFEST}`); process.exit(1); }
  let bad = 0;
  for (const [path, entry] of Object.entries(manifest.copies)) {
    const file = join(repo, path);
    if (!existsSync(file)) { console.log(`MISSING ${path}`); bad++; } else if (sha256(file) !== entry.sha256) { console.log(`MISMATCH ${path}`); bad++; }
  }
  if (bad) process.exit(1);
  console.log(`VERIFIED ${Object.keys(manifest.copies).length}`);
  process.exit(0);
}
if (!names.length) fail('沒有指定正本');

const git = (...rest) => spawnSync('git', ['-C', TEMPLATES, ...rest], { encoding: 'utf8' });
const sourceRoot = git('rev-parse', '--show-toplevel').stdout.trim();

const isDir = path => existsSync(join(TEMPLATES, path)) && statSync(join(TEMPLATES, path)).isDirectory();

/** 檔案引用的同目錄相對檔（import、new URL；shell 是 "$(dirname "$0")/<檔名>"），以及以 'fixtures/<名稱>' 讀取的整個 fixtures 目錄。 */
function references(file) {
  const text = readFileSync(join(TEMPLATES, file), 'utf8');
  if (file.endsWith('.sh')) return [...text.matchAll(/"\$\(dirname "\$0"\)\/([\w.-]+)"/g)].map(m => join(dirname(file), m[1]));
  const refs = [...text.matchAll(/(?:from\s+|import\s+|new URL\(\s*)'(\.\/[^']+)'/g)].map(m => join(dirname(file), m[1]));
  for (const [, dir] of text.matchAll(/'(fixtures\/[^'/]+)'/g)) {
    const base = join(dirname(file), dir);
    refs.push(...readdirSync(join(TEMPLATES, base), { recursive: true }).map(name => join(base, String(name))).filter(path => !isDir(path)));
  }
  return refs;
}

const files = new Set();
const visit = file => {
  if (files.has(file)) return;
  if (!existsSync(join(TEMPLATES, file)) || isDir(file)) fail(`正本不存在：templates/${file}`);
  files.add(file);
  if (file.endsWith('.mjs') || file.endsWith('.sh')) references(file).forEach(visit);
};
for (const name of names) {
  const file = /\.(mjs|sh)$/.test(name) ? name : `${name}.mjs`;
  visit(file);
  const testFile = file.replace(/\.(mjs|sh)$/, '.test.mjs');
  if (!flags.has('--no-tests') && existsSync(join(TEMPLATES, testFile))) visit(testFile);
}

const plan = [...files].sort().map(file => {
  const template = relative(sourceRoot, join(TEMPLATES, file));
  if (git('status', '--porcelain', '--', join(TEMPLATES, file)).stdout.trim()) fail(`正本有未提交改動：${template}（先 commit，記錄的 commit 才對得上內容）`);
  const dest = join('scripts', file);
  const target = join(repo, dest);
  const current = existsSync(target) && sha256(target);
  const state = !current ? 'COPY' : current === sha256(join(TEMPLATES, file)) ? 'SAME' : current === manifest.copies[dest]?.sha256 ? 'UPDATE' : 'DIFF';
  return { file, template, dest, target, state };
});

const diffs = [];
for (const { file, dest, target, state } of plan) {
  console.log(`${state} ${dest}`);
  if (state === 'DIFF') diffs.push(dest);
  if (state === 'DIFF' || state === 'UPDATE') {
    process.stdout.write(spawnSync('git', ['diff', '--no-index', '--', target, join(TEMPLATES, file)], { encoding: 'utf8' }).stdout);
  }
}
if (flags.has('--dry-run')) { console.log(`PLANNED ${plan.length}`); process.exit(0); }
if (diffs.length && !flags.has('--yes')) { console.log(`CONFIRM_OVERWRITE ${diffs.join(' ')}`); process.exit(3); }

for (const { file, template, dest, target } of plan) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(TEMPLATES, file)));
  chmodSync(target, statSync(join(TEMPLATES, file)).mode & 0o777);
  const commit = git('log', '-1', '--format=%H', '--', join(TEMPLATES, file)).stdout.trim();
  manifest.copies[dest] = { template, commit, sha256: sha256(target) };
}
manifest.copies = Object.fromEntries(Object.entries(manifest.copies).sort(([a], [b]) => a.localeCompare(b)));
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`COPIED ${plan.length}`);
