import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoFixture, source, run, git } from './test/repo-fixture.mjs';

// 違規 fixture 的內容本身就是違規寫法，所以這個檔的相關行都帶例外標記。
function scan(f, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(f.repo, path)), { recursive: true });
    writeFileSync(join(f.repo, path), content);
  }
  return run(f.repo, [process.execPath, join(source, 'check-portability.mjs')]);
}
/** 每個違規的 `<file>:<line>: <規則>`（去掉改法說明）。 */
const violations = result => {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  return result.stderr.trim().split('\n').map(line => line.split(' ').slice(0, 2).join(' '));
};
const passes = result => assert.equal(result.status, 0, result.stderr);

test('proc：讀 procfs 的違規回報 file:line，合法寫法通過', t => {
  const bad = scan(repoFixture(t), { 'lib/mem.mjs': "import { readFileSync } from 'node:fs';\nreadFileSync('/proc/self/status');\n" }); // portability-ok: 違規 fixture
  assert.deepEqual(violations(bad), ['lib/mem.mjs:2: proc']);
  passes(scan(repoFixture(t), { 'lib/mem.mjs': 'process.memoryUsage();\n' }));
});

test('tmpdir：測試檔直接呼叫 os 的 tmpdir 違規，realTmpdir 通過；非測試檔不管', t => {
  const bad = "import { tmpdir } from 'node:os';\nconst dir = tmpdir( );\n"; // portability-ok: 違規 fixture
  const result = scan(repoFixture(t), { 'tests/a.test.mjs': bad, 'test/helper.mjs': bad, 'lib/b.test.js': bad, 'scripts/build.mjs': bad });
  assert.deepEqual(violations(result), ['lib/b.test.js:2: tmpdir', 'test/helper.mjs:2: tmpdir', 'tests/a.test.mjs:2: tmpdir']);
  passes(scan(repoFixture(t), { 'tests/a.test.mjs': "import { realTmpdir } from './helpers/real-tmpdir.mjs';\nconst dir = realTmpdir();\n" }));
});

test('註解裡提到的寫法不算違規；引號裡的 # 與 // 不是註解', t => {
  passes(scan(repoFixture(t), {
    'bin/run': '#!/bin/sh\n# 不要用 sed -i 或 declare -A\necho ok # readlink -f 在舊 macOS 沒有\n',
    'tests/a.test.mjs': '// tmpdir() 在 macOS 是 symlink\n/**\n * 讀 /proc/self 不可攜\n */\nconst x = 1; // /proc/\n', // portability-ok: 違規 fixture
  }));
  const result = scan(repoFixture(t), {
    'bin/run': '#!/bin/sh\necho "step # 1"; sed -i s/a/b/ f\n',
    'lib/a.mjs': "const s = 'a //b'; readFileSync('/proc/x');\n", // portability-ok: 違規 fixture
  });
  assert.deepEqual(violations(result), ['bin/run:2: sed-i', 'lib/a.mjs:1: proc']);
});

test('例外：同一行 portability-ok 加理由才放行，沒理由照樣違規', t => {
  passes(scan(repoFixture(t), { 'bin/run': '#!/bin/sh\nsed -i "s/a/b/" f # portability-ok: 只在 CI 的 Linux 跑\n' }));
  const result = scan(repoFixture(t), { 'bin/run': '#!/bin/sh\nsed -i "s/a/b/" f # portability-ok:\n' });
  assert.deepEqual(violations(result), ['bin/run:2: sed-i']);
});

test('declare-A 只管 bash 系：zsh 有關聯陣列，其他 shell 規則照管', t => {
  passes(scan(repoFixture(t), { 'bin/run': '#!/bin/zsh\ntypeset -A seen\n' }));
  assert.deepEqual(violations(scan(repoFixture(t), { 'bin/run': '#!/bin/zsh\nsed -i s/a/b/ f\n' })), ['bin/run:2: sed-i']);
});

test('case：兩個追蹤檔只差大小寫時違規，各自不同名時通過', t => {
  const f = repoFixture(t);
  // 在不分大小寫的檔案系統上兩個檔會互相覆蓋，所以直接寫進 index。
  const blob = git(f.repo, 'hash-object', '-w', 'source.md');
  git(f.repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},docs/Readme.md`);
  git(f.repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},docs/README.md`);
  assert.deepEqual(violations(scan(f, {})), ['docs/README.md: case']);
  passes(scan(repoFixture(t), { 'docs/README.md': 'a', 'docs/Guide.md': 'b' }));
});

// [規則, 違規行, 合法行]；違規行放在 shell 檔的第 3 行。
const SHELL = [
  ['declare-A', 'declare -A seen', 'declare -a list'],
  ['sed-i', "sed -i 's/a/b/' docs/a.md", "sed -i.bak 's/a/b/' docs/a.md && rm docs/a.md.bak"],
  ['sed-i', "sed -i '' 's/a/b/' docs/a.md", "sed -n 's/ -i //p' docs/a.md"],
  ['sed-i', "sed --expression='s/a/b/' -i f", 'git commit -m "use sed -i here"'],
  ['sed-i', 'echo "$(sed -i s/a/b/ f)"', "echo 'not a sed -i call'"],
  ['readlink-f', 'dir=$(readlink -f "$0")', 'dir=$(cd "$(dirname "$0")" && pwd -P)'],
  ['readlink-f', 'readlink -nf x', 'readlink x'],
  ['date-d', 'date -d yesterday +%F', 'date -u +%F'],
  ['date-d', 'date -ud @0', 'date -Iseconds'],
  ['stat-c', 'stat -c %s file', 'wc -c < file'],
  ['xargs-r', 'git ls-files | xargs -0 -r rm', 'git ls-files | xargs rm -rf'],
  // #98：BSD paste 沒有檔案參數時只印 usage，錯誤藏在 $(…) 裡。
  ['paste-s', `echo "CHECK_PASS tests $(sed -n 's/^ℹ tests \\([0-9]*\\)$/\\1/p' "$tmp/tests.log" | paste -sd+)"`,
    `echo "CHECK_PASS tests $(sed -n 's/^ℹ tests \\([0-9]*\\)$/\\1/p' "$tmp/tests.log" | paste -sd+ -)"`],
  ['paste-s', 'seq 3 | paste -s -d ,', 'paste -s -d , list.txt'],
  ['paste-s', "seq 3 | paste -sd ' '", "seq 3 | paste -sd ' ' -"],
  ['paste-s', 'paste -sd, < f', 'seq 3 | paste -s -d "," f.txt'],
  ['paste-s', 'seq 3 | paste -s > out', 'seq 3 | paste -s -d"," -'],
  ['sed-i', 'echo a; sed -i s/a/b/ f', 'x="$(seq 3 | paste -s -d "," -)"; echo a;# sed -i x'],
  // 路徑常放在引號裡，proc 比對保留引號內容的那一行；引號外的註解照樣不掃。
  ['proc', 'cat "/proc/cpuinfo"', 'echo "see /proc in docs"'], // portability-ok: 違規 fixture
  ['proc', "f='/proc/meminfo'", "echo ok # cat '/proc/meminfo'"], // portability-ok: 違規 fixture
  ['proc', 'f="/proc/$$/status"; echo "$f"', 'echo "a # b"; ps -o rss= -p $$'], // portability-ok: 違規 fixture
];
for (const [rule, bad, good] of SHELL) {
  test(`${rule}：${bad}`, t => {
    assert.deepEqual(violations(scan(repoFixture(t), { 'bin/run': `#!/usr/bin/env bash\nset -eu\n${bad}\n` })), [`bin/run:3: ${rule}`]);
    passes(scan(repoFixture(t), { 'bin/run': `#!/usr/bin/env bash\nset -eu\n${good}\n` }));
  });
}
