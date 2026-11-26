import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// pilot-probe 新增輸出行種類時，檔頭註解、PILOT-STORE.md 的 pilot-probe 列、本 repo pilot-round.md 的 **Probe.**（含「其他行」清單）
// 與 PILOT-ROUND-TEMPLATE.md 的 **Probe.** 原本都沒檢查，要到 review 才抓到（#484：#398 的 BUDGET 漏了檔頭，#556）。
// 這裡從 probe 正本的程式（不含註解）抽出輸出行開頭的大寫關鍵字，四處都要提到每一個。
// pilot-store-usage.test.mjs（#456）的結果行欄只讀檔頭 `// stdout` 段的反引號片段，pilot-probe 的檔頭多數沒加反引號、抽不準，
// 所以這裡改從程式抽：字串或樣板字面值以關鍵字開頭、後面接空白、`${` 或字面值結尾的才算。
// pilot-watch、pilot-idle-wait、pilot-dispatch 同樣不在 RESULT_LINE_SCRIPTS 裡，同一套抽法對檔頭與 PILOT-STORE.md 該腳本的列比對（#594）。
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const TEMPLATES = 'skills/engineering/setup-workflow/templates';
const PROBE = `${TEMPLATES}/pilot-probe.mjs`;

// 程式裡同樣寫法、但不是輸出行開頭的字面值：tracker 的狀態值、git 的 ref、要清掉的環境變數名稱。
export const NOT_LINE_KEYWORDS = new Set(['CLOSED', 'HEAD', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']);

// 其他三支各自的排除表（#594）：同樣寫法、但不是該腳本輸出行開頭的字面值。
export const SCRIPT_NOT_LINE_KEYWORDS = {
  // 要清掉的 git 環境變數名稱。
  'pilot-watch.mjs': new Set(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']),
  'pilot-idle-wait.mjs': new Set(),
  // git 的 ref、tracker 的狀態值、process.on 的信號名稱，以及草稿裡提到別支腳本（port-entries、merge-line-inserts）印的行。
  'pilot-dispatch.mjs': new Set(['HEAD', 'OPEN', 'SIGINT', 'SIGTERM', 'NO_MATCH', 'AMBIGUOUS', 'LINE_CONFLICT']),
};

export function probeKeywords(source, notLineKeywords = NOT_LINE_KEYWORDS) {
  const code = source.split('\n').filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
  const keywords = new Set();
  for (const [, word] of code.matchAll(/(?<![\w$])['"`]([A-Z][A-Z_]+)(?=[ '"`]|\$\{)/g)) {
    if (!notLineKeywords.has(word)) keywords.add(word);
  }
  return keywords;
}

// `- **Probe.**` 條目（單行）。
const probeEntry = text => text.split('\n').find(line => line.startsWith('- **Probe.**')) ?? '';

// 檔頭：shebang 之後、檔案開頭連續的 `//` 行；中段的 `//` 註解不算，才不會蓋掉檔頭的缺口（#556 review P3）。
export function headerComment(source) {
  const lines = source.split('\n');
  const header = [];
  for (const line of lines.slice(lines[0]?.startsWith('#!') ? 1 : 0)) {
    if (!line.startsWith('//')) break;
    header.push(line);
  }
  return header.join('\n');
}

// PILOT-STORE.md 的 Canonical scripts 表裡該腳本的列。
export function storeRow(script) {
  return read('skills/engineering/issue-pilot/PILOT-STORE.md').split('\n').filter(line => line.startsWith(`| \`${script}\` |`)).join('\n');
}

export function scriptDocs(script, source) {
  return { header: headerComment(source), 'PILOT-STORE.md': storeRow(script) };
}

export function probeDocs(source) {
  return {
    ...scriptDocs('pilot-probe.mjs', source),
    'pilot-round.md': probeEntry(read('docs/agents/pilot-round.md')),
    'PILOT-ROUND-TEMPLATE.md': probeEntry(read('skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md')),
  };
}

// `<關鍵字> <文件>`，每個沒提到的組合一行；關鍵字前後接大寫或 `_` 的不算提到（`IN_MAIN` 不因 `NOT_IN_MAIN` 而算）。
export function keywordGaps(keywords, docs) {
  const gaps = [];
  for (const word of [...keywords].sort()) {
    const mention = new RegExp(`(?<![A-Z_])${word}(?![A-Z_])`);
    for (const [name, text] of Object.entries(docs)) if (!mention.test(text)) gaps.push(`${word} ${name}`);
  }
  return gaps;
}

test('pilot-probe 輸出行開頭的每個關鍵字，檔頭、PILOT-STORE.md、pilot-round.md、PILOT-ROUND-TEMPLATE.md 的 Probe 都有提到', () => {
  const source = read(PROBE);
  const docs = probeDocs(source);
  for (const [name, text] of Object.entries(docs)) assert.ok(text, `${name} 找不到 pilot-probe 的段落`);
  assert.deepEqual(keywordGaps(probeKeywords(source), docs), []);
});

for (const script of Object.keys(SCRIPT_NOT_LINE_KEYWORDS)) {
  test(`${script} 輸出行開頭的每個關鍵字，檔頭與 PILOT-STORE.md 的 ${script} 列都有提到`, () => {
    const source = read(`${TEMPLATES}/${script}`);
    const docs = scriptDocs(script, source);
    for (const [name, text] of Object.entries(docs)) assert.ok(text, `${name} 找不到 ${script} 的段落`);
    assert.deepEqual(keywordGaps(probeKeywords(source, SCRIPT_NOT_LINE_KEYWORDS[script]), docs), []);
  });
}

test('檔頭只取開頭連續的 `//` 段：中段註解提到的關鍵字不算檔頭提到', () => {
  const source = ['#!/usr/bin/env node', '// 印 `DONE <n>`', "import x from 'y';", '// 中段提到 STOP', "console.log(`STOP ${n}`);"].join('\n');
  assert.equal(headerComment(source), '// 印 `DONE <n>`');
  assert.deepEqual(keywordGaps(probeKeywords(source), { header: headerComment(source) }), ['STOP header']);
});

test('抽取：輸出行的關鍵字都抽到，非輸出行的字面值與註解裡的字不算', () => {
  const keywords = probeKeywords([
    '// 檔頭提到 COMMENT_ONLY',
    " * JSDoc 裡的 `DOC_ONLY <n>`",
    "if (hold) out.push('HOLD');",
    'out.push(`DIRTY ${line}`);',
    "out.push(['BUDGET', path].join(' '));",
    'return saved ?? `STUCK orca ${error.message}`;',
    "if (parent?.state !== 'CLOSED') continue;",
    "const x = 'lower case';",
    // #555 的 UNPARK_FRESH 以三元式選關鍵字。
    "const line = `${fresh ? 'UNPARK_FRESH' : 'UNPARK'} ${n}`;",
  ].join('\n'));
  assert.deepEqual([...keywords].sort(), ['BUDGET', 'DIRTY', 'HOLD', 'STUCK', 'UNPARK', 'UNPARK_FRESH']);
});

// 證明（#556 驗收）：de46b4f 的 pilot-probe.mjs 印 BUDGET，檔頭卻沒寫；這裡把現在正本檔頭的 BUDGET 拿掉重現同一個缺口。
test('檔頭漏寫一個輸出行（de46b4f 的 BUDGET）時報 BUDGET header', () => {
  const source = read(PROBE).split('\n').map(line => (line.startsWith('//') ? line.replaceAll('BUDGET', 'B') : line)).join('\n');
  assert.deepEqual(keywordGaps(probeKeywords(source), probeDocs(source)), ['BUDGET header']);
});
