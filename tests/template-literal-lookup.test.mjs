// retro 1122a #430：CLI 子指令或旗標用 object literal 以使用者輸入查表（`{ '--file': 'file' }[args[i]]`）時，
// `constructor`、`toString` 會命中 Object.prototype，未知輸入沒被當成用法錯誤（pilot-counterpart.mjs exit 0、不印用法）。
// 範本裡不准寫 `}[<變數>]` 這種「字面物件緊接變數索引」；改用 `new Map([...]).get(key)` 或 `Object.hasOwn(table, key) ? table[key] : undefined`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const templates = new URL('skills/engineering/setup-workflow/templates/', root);

// `}` 後（可隔空白或換行）接 `[`，索引是識別字（含 a.b、a[i]、a?.b 這類成員存取），不是字串或數字字面值；
// 排除 JSDoc 型別（`{...}[]`，`[` 後立刻 `]`）與 `[,{}[\]]` 這類 regex 字元集（`}` 之後的 `[` 不接識別字）。
const PATTERN = /\}\s*\[\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]\n]*\])*\s*\]/g;

/** @returns {{ line: number, text: string }[]} */
export function literalLookups(source) {
  const hits = [];
  for (const match of source.matchAll(PATTERN)) {
    const line = source.slice(0, match.index).split('\n').length;
    const text = source.split('\n')[line - 1].trim();
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
    hits.push({ line, text });
  }
  return hits;
}

const advice = '改用 `new Map([...]).get(key)` 或 `Object.hasOwn(table, key) ? table[key] : undefined`（#430）';
const files = ['', 'lib/'].flatMap(sub => readdirSync(new URL(sub, templates)).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).map(name => sub + name));

test('範本與 lib 找得到要掃的檔', () => {
  assert.ok(files.includes('pilot-counterpart.mjs') && files.some(name => name.startsWith('lib/')), files.join(' '));
});

for (const name of files) {
  test(`${name}：沒有 object literal 直接以變數索引`, () => {
    const hits = literalLookups(readFileSync(new URL(name, templates), 'utf8'));
    assert.deepEqual(hits, [], `${name} 有 object literal 以使用者輸入查表，constructor、toString 會命中 Object.prototype：\n${hits.map(h => `  :${h.line} ${h.text}`).join('\n')}\n${advice}`);
  });
}

test('偵測器：不誤報字串或數字索引、解構、陣列型別、regex 字元集、obj[key]', () => {
  const fine = [
    "const a = { x: 1 }['x'];",
    'const b = { x: 1 }[0];',
    'const { x } = table; const y = table[key];',
    '/** @param {{ a: string }[]} list */',
    "for (const part of body.split(/[,{}[\\]]/)) {}",
    'const c = [{ a: 1 }].map(o => o)[0];',
    'const d = new Map(Object.entries({ a: 1 })).get(args[i]);',
    '  // 舊寫法：{ a: 1 }[args[i]]',
  ];
  for (const line of fine) assert.deepEqual(literalLookups(line), [], line);
  for (const line of ['const n = { a: 1 }[command];', 'const n = { a: 1 }[args[i]];', 'const n = {\n  a: 1,\n}[rest[i]];', 'const n = { a: 1 }[opts.name];']) {
    assert.equal(literalLookups(line).length, 1, line);
  }
});

// 真實的過去錯誤：HEAD 當時的 pilot-counterpart.mjs（`{ '--adapter': 'adapter', '--file': 'file' }[args[i]]`）
test('過去錯誤的 fixture：#430 之前的 pilot-counterpart.mjs 會被抓到', () => {
  const old = readFileSync(new URL('fixtures/literal-lookup-pilot-counterpart.mjs.txt', import.meta.url), 'utf8');
  const hits = literalLookups(old);
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.match(hits[0].text, /\{ '--adapter': 'adapter', '--file': 'file' \}\[args\[i\]\]/);
});
