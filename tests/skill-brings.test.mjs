// setup-workflow SKILL.md 的 Templates 表每列用「(brings `<相依>`)」寫出範本會帶上的檔；這裡拿 copy-templates.mjs 實際算出的相依比對（#491）。
// #376 讓 worktree-overlap.mjs 多 import ./lib/merge-tree.mjs，表上仍只寫 lib/changed-units.mjs，bin/check 全綠，到 Standards review 才抓到。
// 相依由 copy-templates.mjs --dry-run --no-tests <範本> 算（同一套 references()，不另抄解析）：範本的完整相依扣掉自己，
// 要被套用到它的括號裡的檔名涵蓋（列出的檔連同它自己帶的都算，所以「with what it brings, its row」不必展開）。
// 同格明列的範本不算涵蓋：只拷其中一支時，人要從括號看出會多帶哪些檔（pilot-probe.mjs 靠同格的 pilot-dispatch.mjs 會漏掉 lib/merge-tree.mjs）。
// 括號套用到它前面、上一個括號之後列的每個範本（`a.mjs`, `b.mjs` (bring `x`) 兩個都帶 x）。
// 缺的每項一行 `SKILL_BRINGS_MISSING <範本> <相依>`：把相依補進該列括號，或改掉範本的 import。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const COPY = fileURLToPath(new URL('../skills/engineering/setup-workflow/scripts/copy-templates.mjs', import.meta.url));
const isScript = name => /\.(mjs|sh)$/.test(name);

/** Templates 表的文字 → [{ template, brings }]：brings 是套用到該範本的括號裡所有反引號檔名。 */
export function bringsRows(table) {
  const rows = [];
  for (const line of table.split('\n')) {
    if (!line.startsWith('| `')) continue;
    let pending = [];
    for (const [, name, inner] of line.slice(2).split(' | ')[0].matchAll(/`([^`]+)`|\(([^)]*)\)/g)) {
      if (name) {
        if (isScript(name)) { pending.push({ template: name, brings: [] }); rows.push(pending.at(-1)); }
        continue;
      }
      const names = [...inner.matchAll(/`([^`]+)`/g)].map(match => match[1]);
      for (const row of pending) row.brings = names;
      pending = [];
    }
  }
  return rows;
}

/** 每列缺的相依 → `SKILL_BRINGS_MISSING <範本> <相依>` 行；closure(name) 是 copy-templates 算出的完整相依（含自己），非腳本檔回傳 [name]。 */
export function bringsMissing(rows, closure) {
  const lines = [];
  for (const { template, brings } of rows) {
    const covered = new Set(brings.flatMap(name => closure(name)));
    for (const dep of closure(template)) if (dep !== template && !covered.has(dep)) lines.push(`SKILL_BRINGS_MISSING ${template} ${dep}`);
  }
  return lines;
}

const target = mkdtempSync(join(realTmpdir(), 'skill-brings-'));
after(() => rmSync(target, { recursive: true, force: true }));
const run = promisify(execFile);
// 本 session 在 Orca 分頁裡跑時，不把真的 ORCA_CLI_COMMAND 傳給子行程。
const { ORCA_CLI_COMMAND: _orca, ...env } = process.env;

/** names 裡每個腳本 → copy-templates --dry-run 列出的檔（templates/ 下的相對路徑，含自己）；同時最多 8 支。 */
async function closures(names) {
  const result = new Map();
  const queue = [...new Set(names)].filter(isScript);
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const { stdout } = await run(process.execPath, [COPY, target, '--dry-run', '--no-tests', name], { env, maxBuffer: 1 << 24 })
        .catch(error => { throw new Error(`copy-templates --dry-run ${name} 失敗（表上的範本名稱打錯？）：${error.stderr || error.message}`); });
      result.set(name, [...stdout.matchAll(/^COPY scripts\/(.+)$/gm)].map(match => match[1]));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return name => result.get(name) ?? [name];
}

const allNames = rows => rows.flatMap(({ template, brings }) => [template, ...brings]);

// 紅的證明：#376 之前的第 119 列（worktree-overlap.mjs 已 import ./lib/merge-tree.mjs，表上只寫 lib/changed-units.mjs）。
test('#491：#376 之前的 worktree-overlap.mjs 列缺 lib/merge-tree.mjs，印 SKILL_BRINGS_MISSING', async () => {
  const rows = bringsRows("| `worktree-overlap.mjs` (brings `lib/changed-units.mjs`) | L2 | `retro-collect` names it; the adapter's **Retro collect** entry passes `--main <integration branch>` when the repo has no `main` branch |");
  assert.deepEqual(bringsMissing(rows, await closures(allNames(rows))), ['SKILL_BRINGS_MISSING worktree-overlap.mjs lib/merge-tree.mjs']);
});

test('#491：括號套用到前面一串範本，括號裡的檔連同它帶的都算涵蓋，同格範本不算', () => {
  const rows = bringsRows('| `a.mjs`, `b.mjs` (bring `x.mjs` and `data.json`), `c.mjs` | L1 | uses `d.mjs` |');
  assert.deepEqual(rows, [
    { template: 'a.mjs', brings: ['x.mjs', 'data.json'] },
    { template: 'b.mjs', brings: ['x.mjs', 'data.json'] },
    { template: 'c.mjs', brings: [] },
  ]);
  const deps = { 'a.mjs': ['a.mjs', 'x.mjs', 'lib/z.mjs', 'data.json'], 'c.mjs': ['c.mjs', 'a.mjs'], 'x.mjs': ['x.mjs', 'lib/z.mjs'] };
  assert.deepEqual(bringsMissing(rows, name => deps[name] ?? [name]), ['SKILL_BRINGS_MISSING c.mjs a.mjs']);
});

test('#491：SKILL.md Templates 表每列的 brings 涵蓋 copy-templates 實際帶上的相依', async () => {
  const table = read('skills/engineering/setup-workflow/SKILL.md').split('\n## Templates\n')[1].split('\n## ')[0];
  const rows = bringsRows(table);
  assert.ok(rows.length > 50, `只讀到 ${rows.length} 個範本`);
  const missing = bringsMissing(rows, await closures(allNames(rows)));
  assert.deepEqual(missing, [], `Templates 表的 brings 漏了 copy-templates 會帶上的檔，補進該列括號：\n${missing.join('\n')}`);
});
