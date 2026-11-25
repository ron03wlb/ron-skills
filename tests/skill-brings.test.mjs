// setup-workflow SKILL.md 的 Templates 表每列用「(brings `<相依>`)」寫出範本會帶上的檔；這裡拿 copy-templates.mjs 實際算出的相依比對（#491）。
// #376 讓 worktree-overlap.mjs 多 import ./lib/merge-tree.mjs，表上仍只寫 lib/changed-units.mjs，bin/check 全綠，到 Standards review 才抓到。
// 相依由 copy-templates.mjs --dry-run --no-tests <範本> 算（同一套 references()，不另抄解析）；表的解析與比對規則在
// setup-workflow/scripts/skill-brings.mjs，copy-templates 複製明列範本時也對動到的列跑它（#631）。
// 缺的每項一行 `SKILL_BRINGS_MISSING <範本> <相依>`：把相依補進該列括號，或改掉範本的 import。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { git, env as gitEnv, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { bringsMissing, bringsRows, templatesTable } from '../skills/engineering/setup-workflow/scripts/skill-brings.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const COPY = fileURLToPath(new URL('../skills/engineering/setup-workflow/scripts/copy-templates.mjs', import.meta.url));
const isScript = name => /\.(mjs|sh)$/.test(name);

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
  const table = templatesTable(read('skills/engineering/setup-workflow/SKILL.md'));
  const rows = bringsRows(table);
  assert.ok(rows.length > 50, `只讀到 ${rows.length} 個範本`);
  const missing = bringsMissing(rows, await closures(allNames(rows)));
  assert.deepEqual(missing, [], `Templates 表的 brings 漏了 copy-templates 會帶上的檔，補進該列括號：\n${missing.join('\n')}`);
});

// #631 的原錯：pilot-land.mjs 檔頭的 requires 多了 land.mjs、lib/protected-paths.mjs、pilot-pr-body.mjs，表上那列沒跟上；
// `copy-templates.mjs . --staged --no-tests pilot-land …` 只印 COPIED，直到 pre-commit 的本測試排完 805 秒 slot 才抓到。
// 假 ron-skills：真的 copy-templates.mjs 與 skill-brings.mjs、當時那列的 SKILL.md、照當時相依形狀寫的 stub 正本。
const ROW_BEFORE = "| `pilot-land.mjs` (brings `heavy-slot.mjs`, `orca-worktree-create.mjs`, `pilot-unbare.sh`, and `pilot-probe.mjs` with what it brings, its row) | L3, with Orca | the adapter's Pilot line |";
const ROW_FIXED = "| `pilot-land.mjs` (brings `heavy-slot.mjs`, `land.mjs`, `lib/protected-paths.mjs`, `orca-worktree-create.mjs`, `pilot-pr-body.mjs`, `pilot-unbare.sh`, and `pilot-probe.mjs` with what it brings, its row) | L3, with Orca | the adapter's Pilot line |";
const SCRIPTS = new URL('../skills/engineering/setup-workflow/scripts/', import.meta.url);

function bringsFixture(t, row) {
  const temp = mkdtempSync(join(realTmpdir(), 'skill-brings-copy-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'ron-skills');
  const skill = join(source, 'skills/engineering/setup-workflow');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  for (const name of ['copy-templates.mjs', 'skill-brings.mjs']) cpSync(fileURLToPath(new URL(name, SCRIPTS)), join(skill, 'scripts', name));
  write(skill, {
    'SKILL.md': `# setup-workflow\n\n## Templates\n\n| Template | Level | Wiring |\n|---|---|---|\n${row}\n\n## Health\n`,
    'templates/pilot-land.mjs': "// copy-templates: requires orca-worktree-create.mjs pilot-unbare.sh land.mjs lib/protected-paths.mjs pilot-pr-body.mjs\nimport { slot } from './heavy-slot.mjs';\nimport { memberOverlaps } from './pilot-probe.mjs';\n",
    'templates/pilot-land.test.mjs': "import './pilot-land.mjs';\n",
    'templates/heavy-slot.mjs': 'export const slot = 1;\n',
    'templates/pilot-probe.mjs': "import { mergeTree } from './lib/merge-tree.mjs';\nexport const memberOverlaps = 1;\n",
    'templates/lib/merge-tree.mjs': 'export const mergeTree = 1;\n',
    'templates/orca-worktree-create.mjs': '// stub\n',
    'templates/pilot-unbare.sh': '# stub\n',
    'templates/land.mjs': "import { protectedPaths } from './lib/protected-paths.mjs';\n",
    'templates/lib/protected-paths.mjs': 'export const protectedPaths = [];\n',
    'templates/pilot-pr-body.mjs': '// stub\n',
  });
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'templates');
  const target = join(temp, 'target');
  mkdirSync(target);
  git(target, 'init', '-q', '-b', 'main');
  return { target, copier: join(skill, 'scripts/copy-templates.mjs') };
}
const copy = (copier, ...args) => spawnSync(process.execPath, [copier, ...args], { encoding: 'utf8', env: gitEnv });
const bringsLines = stderr => stderr.split('\n').filter(line => line.startsWith('SKILL_BRINGS_MISSING '));

test('#631：pilot-land.mjs 列漏了 requires 新增的三個檔，copy-templates --staged --no-tests 在 stderr 印三行 SKILL_BRINGS_MISSING，照常複製', t => {
  const { target, copier } = bringsFixture(t, ROW_BEFORE);
  const result = copy(copier, target, '--staged', '--no-tests', 'pilot-land');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(bringsLines(result.stderr).sort(), [
    'SKILL_BRINGS_MISSING pilot-land.mjs land.mjs',
    'SKILL_BRINGS_MISSING pilot-land.mjs lib/protected-paths.mjs',
    'SKILL_BRINGS_MISSING pilot-land.mjs pilot-pr-body.mjs',
  ]);
  assert.match(result.stderr, /Templates 表漏了上面的相依/);
  assert.match(result.stdout, /^COPIED 9$/m);
  assert.doesNotMatch(result.stdout, /SKILL_BRINGS_MISSING/);
});

test('#631：--dry-run 也印；只比對明列的範本，帶入的相依那列不查', t => {
  const { target, copier } = bringsFixture(t, `${ROW_BEFORE}\n| \`land.mjs\` | L2 | x |`);
  assert.deepEqual(bringsLines(copy(copier, target, '--dry-run', 'pilot-land').stderr).length, 3);
  const land = copy(copier, target, '--dry-run', 'land');
  assert.equal(land.status, 0, land.stderr);
  assert.deepEqual(bringsLines(land.stderr), ['SKILL_BRINGS_MISSING land.mjs lib/protected-paths.mjs']);
});

test('#631：那列補齊後 copy-templates 不印 SKILL_BRINGS_MISSING', t => {
  const { target, copier } = bringsFixture(t, ROW_FIXED);
  const result = copy(copier, target, '--staged', '--no-tests', 'pilot-land');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
