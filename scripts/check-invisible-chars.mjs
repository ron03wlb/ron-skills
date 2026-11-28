#!/usr/bin/env node
// .mjs 原始碼不能留原始的 U+00A0 或零寬字元（#716）：tab-sweep.mjs 空提示列的正則 `[\s│]` 裡夾了原始 U+00A0，
// 畫面上和一般空白一樣，Edit 與 Python str.replace 都對不上（#713 worker 多花 3 次工具呼叫）；#700 的 Edit 把 `\u00a0` 寫成原始字元落進 issue-pool.test.mjs。
// 要用這些字元就寫成 `\u00a0`、`\u200b` 這類跳脫。看的字元：U+00A0、U+200B–U+200D、U+2060、U+FEFF。
// 用法：node scripts/check-invisible-chars.mjs [<檔案>…]（不帶參數時掃本 repo git 追蹤的 *.mjs，略過 test/fixtures/ 與 tests/fixtures/ 底下的檔）
// stdout：每個命中一行 `CHECK_FAIL invisible-char <檔案>:<行> U+XXXX`，最後一行是修正提示；exit 0 沒有、1 有命中、2 git ls-files 失敗。
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INVISIBLE = /[\u00a0\u200b-\u200d\u2060\ufeff]/gu;
const FIXTURES = /(^|\/)tests?\/fixtures\//;

// 回傳 [{ line, code }]，line 從 1 起算，code 是 `U+00A0` 這種寫法；同一行有多個字元各算一筆。
export function invisibleChars(text) {
  const hits = [];
  text.split('\n').forEach((content, index) => {
    for (const match of content.matchAll(INVISIBLE)) {
      hits.push({ line: index + 1, code: `U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` });
    }
  });
  return hits;
}

function trackedFiles(repo) {
  const result = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--', '*.mjs'], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(2);
  }
  return result.stdout.split('\0').filter(file => file && !FIXTURES.test(file)).map(file => join(repo, file));
}

function main(args) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = args.length ? args : trackedFiles(repo);
  const lines = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue; // 追蹤中但工作樹刪掉的檔
      throw error;
    }
    for (const { line, code } of invisibleChars(text)) lines.push(`CHECK_FAIL invisible-char ${file}:${line} ${code}`);
  }
  if (!lines.length) return 0;
  for (const line of lines) console.log(line);
  console.log('修正：把這些字元改成 \\u00a0 這類跳脫；用腳本替換，Edit 可能又寫回原始字元。');
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
