// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { declarations, excusal, importBindings, maskSource, shadowedImports } from './check-shadowed-imports.mjs';

const SCRIPT = new URL('./check-shadowed-imports.mjs', import.meta.url).pathname;
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });

// spay2 retro ff00a288#3 的真實形狀：probe 內新增的區域 helper 與同檔頂層 import 同名，focused 測試全綠，`node --check` 也不報。
const INCIDENT = [
  "import { landingChanges } from './verify-unit.mjs';",
  '',
  'export function probe(units) {',
  '  const landingChanges = unit => unit.changes.filter(change => change.landing);',
  '  return units.flatMap(landingChanges);',
  '}',
  '',
  'export const summary = units => landingChanges(units).length;',
  '',
].join('\n');

function temp(t, files = {}) {
  const dir = mkdtempSync(join(realTmpdir(), 'shadowed-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test('maskSource：註解、字串、template 文字與正規表示式換成空白，長度與換行不變；${…} 保留', () => {
  const source = "const a = 'const b = 1'; // const c\n/* const d */ const e = `const f ${g} x`; const h = /const i/.test(a) ? 1 / 2 : 0;\n";
  const masked = maskSource(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.deepEqual(declarations(masked).map(({ name }) => name), ['a', 'e', 'h']);
  assert.match(masked, /\$\{g\}/);
  assert.match(masked, /1 \/ 2/, '除號不當正規表示式');
});

test('importBindings：預設、具名（as 取區域名）、namespace、跨行；import() 不算', () => {
  const source = "import fs, { a, b as c } from 'x';\nimport * as ns from './y.mjs';\nimport {\n  d,\n  e,\n} from './z.mjs';\nconst lazy = await import('./w.mjs');\n";
  const names = importBindings(maskSource(source), source);
  assert.deepEqual([...names.keys()].sort(), ['a', 'c', 'd', 'e', 'fs', 'ns']);
  assert.equal(names.get('c'), 'x');
  assert.equal(names.get('d'), './z.mjs');
});

test('shadowedImports：const／let／var／解構／function／class 重新宣告 import 名都報；只是屬性或字串不報', () => {
  const source = [
    "import { a, b, c, d, e, f, g } from './m.mjs';",
    'function outer() {',
    '  const a = 1;',
    '  let { x, b } = {};',
    '  var [c] = [];',
    '  function d() {}',
    '  class e {}',
    '  return { f: 1, g() {} }.f + "const g = 2";',
    '}',
  ].join('\n');
  assert.deepEqual(shadowedImports(source), [{ line: 3, name: 'a' }, { line: 4, name: 'b' }, { line: 5, name: 'c' }, { line: 6, name: 'd' }, { line: 7, name: 'e' }]);
});

test('excusal：builtin、同模組重新 import、*.test.mjs 的 ./test/ helper 排除；被測模組 export 與正式碼仍報（負例）', () => {
  assert.equal(excusal({ specifier: 'node:path', from: null }), 'builtin');
  assert.equal(excusal({ specifier: './status.mjs', from: './status.mjs' }), 'same-module-reimport');
  assert.equal(excusal({ specifier: './test/repo-fixture.mjs', from: null }, 'scripts/x.test.mjs'), 'test-helper');
  // 負例：正式碼的 ./test/ 不算 test-helper；不同模組的重新 import 不算；被測模組的 export 不排除
  assert.equal(excusal({ specifier: './test/repo-fixture.mjs', from: null }, 'scripts/x.mjs'), null);
  assert.equal(excusal({ specifier: './a.mjs', from: './b.mjs' }), null);
  assert.equal(excusal({ specifier: './e2e.mjs', from: null }, 'scripts/e2e.test.mjs'), null);
  const source = "import { join } from 'node:path';\nimport { run } from './test/repo-fixture.mjs';\nimport { x, y } from './m.mjs';\nfunction f() {\n  for (const join of []) {}\n  const run = 1;\n  const { x } = await import('./m.mjs');\n  const { y } = await import('./other.mjs');\n}\n";
  assert.deepEqual(shadowedImports(source, 'scripts/a.test.mjs'), [{ line: 8, name: 'y' }]);
  assert.deepEqual(shadowedImports(source, 'scripts/a.mjs'), [{ line: 6, name: 'run' }, { line: 8, name: 'y' }]);
});

test('CLI：真實事故形狀印 SHADOWED_IMPORT <檔>:<行> <名稱>、exit 1；改名後不印、exit 0', t => {
  const dir = temp(t, { 'status.mjs': INCIDENT });
  const before = run(dir, 'status.mjs');
  assert.equal(before.status, 1, before.stderr);
  assert.equal(before.stdout, 'SHADOWED_IMPORT status.mjs:4 landingChanges\n');
  writeFileSync(join(dir, 'status.mjs'), INCIDENT.replace('const landingChanges = unit', 'const ownChanges = unit').replace('flatMap(landingChanges)', 'flatMap(ownChanges)'));
  const after = run(dir, 'status.mjs');
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.equal(after.stdout, '');
});

test('CLI：目錄參數遞迴掃 *.mjs，略過 node_modules 與 . 開頭目錄', t => {
  const dir = temp(t, {
    'scripts/a.mjs': INCIDENT,
    'scripts/lib/b.mjs': INCIDENT,
    'scripts/notes.md': INCIDENT,
    'scripts/node_modules/c.mjs': INCIDENT,
    'scripts/.cache/d.mjs': INCIDENT,
  });
  const result = run(dir, 'scripts');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, 'SHADOWED_IMPORT scripts/a.mjs:4 landingChanges\nSHADOWED_IMPORT scripts/lib/b.mjs:4 landingChanges\n');
});

test('讀不到的檔案或目錄 exit 2', t => {
  const dir = temp(t);
  const result = run(dir, 'no-such-file.mjs');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /讀不到 no-such-file\.mjs/);
});

test('本目錄所有 *.mjs 都沒有遮蔽 import', () => {
  const result = run(new URL('.', import.meta.url).pathname, '.');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
