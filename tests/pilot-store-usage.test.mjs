import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// PILOT-STORE.md 的 Canonical scripts 表是 coordinator 讀的用法與結果行（setup-workflow/SKILL.md 指過來），
// 範本加了 CLI 旗標或 stdout 結果行卻沒改表，bin/check 原本全綠，要到 review 才抓到（#456：#326 的 --skip-labels；
// #364 的 NAME_CHECK）。這裡把表的每一列和對應範本比對：
// - 用法欄：表中該腳本各列 Command 欄的 `--旗標`（只取括號外的反引號片段，括號裡是說明，會提到別支腳本的旗標），
//   和範本 `const USAGE =` 字串與檔頭 `// 用法：` 行的旗標集合要相同。
// - 結果行欄：範本檔頭 `// stdout` 段反引號片段開頭的大寫 token（`REGISTERED`、`NAME_CHECK`…），都要出現在該腳本的列裡。
//   只對 RESULT_LINE_SCRIPTS 做：pilot-probe、pilot-watch、pilot-idle-wait、pilot-dispatch 的 stdout 段多數結果行沒加反引號，
//   抽不準（會漏也會把說明裡別支腳本的 token 抽進來）。
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const STORE = 'skills/engineering/issue-pilot/PILOT-STORE.md';
const TEMPLATES = 'skills/engineering/setup-workflow/templates';
const FIXTURES = 'tests/fixtures/pilot-store-usage';

export const RESULT_LINE_SCRIPTS = [
  'pilot-register.mjs', 'pilot-decision.mjs', 'pilot-request.mjs', 'pilot-gate.mjs', 'pilot-hold.mjs', 'pilot-batch.mjs',
  'pilot-capacity.mjs', 'pilot-pr-body.mjs', 'pilot-sources.mjs', 'pilot-land.mjs', 'pilot-close.mjs',
];

// 表列：`| \`<script>\` | <command> | <stdout> | <exit> |`，`\|` 是儲存格內的 |。
export function storeRows(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const m = /^\| `([\w.-]+\.(?:mjs|sh|py))` \|/.exec(line);
    if (!m) continue;
    const cells = line.replace(/\\\|/g, '\u0000').split(' | ').map(cell => cell.replace(/\u0000/g, '|'));
    const list = rows.get(m[1]) ?? [];
    list.push({ line, command: cells[1] ?? '' });
    rows.set(m[1], list);
  }
  return rows;
}

const flagsIn = text => new Set(text.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? []);

// Command 欄括號（半形或全形）外的反引號片段。
export function commandFlags(command) {
  const spans = [];
  let depth = 0, code = null;
  for (const ch of command) {
    if (ch === '`') {
      if (code === null) code = '';
      else { if (depth === 0) spans.push(code); code = null; }
    } else if (code !== null) code += ch;
    else if (ch === '(' || ch === '（') depth++;
    else if ((ch === ')' || ch === '）') && depth > 0) depth--;
  }
  return flagsIn(spans.join(' '));
}

// 範本的 `const USAGE =` 敘述（可跨行，以 `;` 結尾的行為止）加上檔頭 `// 用法：` 行。
export function templateFlags(source) {
  const lines = source.split('\n');
  const parts = lines.filter(line => line.startsWith('// 用法：'));
  const start = lines.findIndex(line => /^const USAGE\s*=/.test(line));
  if (start >= 0) {
    for (let i = start; i < lines.length; i++) {
      parts.push(lines[i]);
      if (/;\s*$/.test(lines[i])) break;
    }
  }
  return flagsIn(parts.join('\n'));
}

// 檔頭 `// stdout` 開頭的那段（接著以 `//  ` 縮排的續行）裡，反引號片段的第一個字是大寫 token 的。
export function stdoutTokens(source) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith('// stdout'));
  if (start < 0) return new Set();
  const section = [lines[start]];
  for (let i = start + 1; i < lines.length && lines[i].startsWith('//  '); i++) section.push(lines[i]);
  const tokens = new Set();
  for (const [, span] of section.join('\n').matchAll(/`([^`\n]+)`/g)) {
    const word = span.trim().split(/\s+/)[0];
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(word) && word.length > 1) tokens.add(word);
  }
  return tokens;
}

export function usageProblems(script, rows, source) {
  const store = new Set(rows.flatMap(row => [...commandFlags(row.command)]));
  const template = templateFlags(source);
  const problems = [];
  const missingStore = [...template].filter(flag => !store.has(flag)).sort();
  const missingTemplate = [...store].filter(flag => !template.has(flag)).sort();
  if (missingStore.length) problems.push(`${script}：PILOT-STORE.md 用法欄缺 ${missingStore.join(' ')}（範本 USAGE／用法 有）`);
  if (missingTemplate.length) problems.push(`${script}：範本 USAGE／用法 缺 ${missingTemplate.join(' ')}（PILOT-STORE.md 用法欄有）`);
  return problems;
}

export function resultLineProblems(script, rows, source) {
  const text = rows.map(row => row.line).join('\n');
  const missing = [...stdoutTokens(source)].filter(token => !new RegExp(`(?<![A-Z0-9_])${token}(?![A-Z0-9_])`).test(text)).sort();
  return missing.length ? [`${script}：PILOT-STORE.md 該列缺結果行 ${missing.join(' ')}（範本檔頭 stdout 段有）`] : [];
}

const rows = storeRows(read(STORE));

test('Canonical scripts 表的每一列都有對應範本', () => {
  assert.ok(rows.size >= 10, `只讀到 ${rows.size} 列`);
  for (const script of rows.keys()) {
    assert.ok(existsSync(new URL(`../${TEMPLATES}/${script}`, import.meta.url)), `${script} 沒有範本 ${TEMPLATES}/${script}`);
  }
});

test('用法欄的 --旗標 和範本 USAGE／檔頭用法一致', () => {
  const problems = [...rows].flatMap(([script, list]) => usageProblems(script, list, read(`${TEMPLATES}/${script}`)));
  assert.deepEqual(problems, []);
});

test('範本檔頭 stdout 段的大寫結果行都寫在該腳本列', () => {
  for (const script of RESULT_LINE_SCRIPTS) assert.ok(rows.has(script), `表裡沒有 ${script}`);
  const problems = RESULT_LINE_SCRIPTS.flatMap(script => {
    const source = read(`${TEMPLATES}/${script}`);
    assert.ok(stdoutTokens(source).size > 0, `${script} 檔頭沒抽到 stdout 結果行`);
    return resultLineProblems(script, rows.get(script), source);
  });
  assert.deepEqual(problems, []);
});

test('#326 的真實漂移：pilot-probe 加了 --skip-labels，用法欄沒有，會擋', () => {
  const fixture = storeRows(read(`${FIXTURES}/326-store-row.md`)).get('pilot-probe.mjs');
  const problems = usageProblems('pilot-probe.mjs', fixture, read(`${FIXTURES}/326-pilot-probe.mjs.txt`));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PILOT-STORE\.md 用法欄缺 .*--skip-labels/);
});

test('#364 的真實漂移：pilot-register 加了 NAME_CHECK，結果行欄沒有，會擋', () => {
  const fixture = storeRows(read(`${FIXTURES}/364-store-row.md`)).get('pilot-register.mjs');
  const problems = resultLineProblems('pilot-register.mjs', fixture, read(`${FIXTURES}/364-pilot-register.mjs.txt`));
  assert.deepEqual(problems, ['pilot-register.mjs：PILOT-STORE.md 該列缺結果行 NAME_CHECK（範本檔頭 stdout 段有）']);
});

test('括號裡的說明不算用法：pilot-idle-wait 提到 pilot-probe 的 --apply 不會被算進來', () => {
  assert.deepEqual([...commandFlags('`<checkout> [--main <b>]` (runs `pilot-probe.mjs` without `--apply`), or `--tail <h>`')].sort(), ['--main', '--tail']);
});
