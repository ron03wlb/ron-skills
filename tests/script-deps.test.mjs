// #473：pilot-land.mjs 頂層多 import pilot-probe.mjs 後，只手列部分腳本的 tests/land-restamp.test.mjs 要到整條 bin/check 才報
// `Cannot find module …/scripts/pilot-probe.mjs`。templates/test/script-deps.mjs 依 import 相依閉包複製，新增的相依自動帶上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { copyScripts, scriptClosure } from '../skills/engineering/setup-workflow/templates/test/script-deps.mjs';

/** 模仿 #473：land 頂層 import pilot-land，pilot-land 新加頂層 import pilot-probe，probe 再 import lib/merge-tree。 */
function source(t) {
  const dir = mkdtempSync(join(realTmpdir(), 'script-deps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  mkdirSync(join(dir, 'dst'));
  const files = {
    'land.mjs': "import { restampManifest } from './pilot-land.mjs';\nconsole.log(restampManifest());\n",
    'pilot-land.mjs': "import { probe } from './pilot-probe.mjs';\nexport const restampManifest = () => probe();\nexport const later = () => import('./pilot-close.mjs');\n",
    'pilot-probe.mjs': "import {\n  mergeConflicts,\n} from './lib/merge-tree.mjs';\nexport const probe = () => mergeConflicts();\n",
    'lib/merge-tree.mjs': "// copy-templates: requires ../pilot-unbare.sh\nexport const mergeConflicts = () => 'ok';\n",
    'pilot-close.mjs': 'export {};\n',
    'pilot-unbare.sh': '#!/bin/sh\n',
    'gh-tracker.mjs': '// 旁邊有才用的選用檔：不被 import，不追\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'src', name), text);
  return { src: join(dir, 'src'), dst: join(dir, 'dst') };
}

test('scriptClosure：頂層與多行 import、動態 import、copy-templates: requires 都追；選用檔不追', t => {
  const { src } = source(t);
  assert.deepEqual(scriptClosure(src, ['land.mjs']), ['land.mjs', 'lib/merge-tree.mjs', 'pilot-close.mjs', 'pilot-land.mjs', 'pilot-probe.mjs', 'pilot-unbare.sh']);
  assert.throws(() => scriptClosure(src, ['missing.mjs']), /missing\.mjs 不存在/);
});

test('手列清單漏了新相依就 Cannot find module；copyScripts 帶上整個閉包後跑得起來', t => {
  const { src, dst } = source(t);
  for (const name of ['land.mjs', 'pilot-land.mjs']) copyFileSync(join(src, name), join(dst, name));
  const handListed = spawnSync('node', [join(dst, 'land.mjs')], { encoding: 'utf8' });
  assert.notEqual(handListed.status, 0);
  assert.match(handListed.stderr, /Cannot find module '.*pilot-probe\.mjs'/);
  copyScripts(src, dst, ['land.mjs']);
  const closure = spawnSync('node', [join(dst, 'land.mjs')], { encoding: 'utf8' });
  assert.equal(closure.status, 0, closure.stderr);
  assert.equal(closure.stdout, 'ok\n');
});
