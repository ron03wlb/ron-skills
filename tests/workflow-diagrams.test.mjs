// docs/workflow/diagrams/ 的 6 張 archify 圖（#10）：來源 JSON、產出的 HTML 與 PNG 齊全，各章嵌入 PNG 並連到互動版，
// 來源 JSON 維持一節點一行（用文字編輯改，不整檔重新序列化）。CI 不跑 archify，所以這裡只驗檔案與排版，不驗圖與來源同步。
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../docs/workflow/', import.meta.url).pathname;
const DIAGRAMS = [
  { name: '01-tooling', type: 'architecture', chapter: '01-tooling.md' },
  { name: '02-main-flow', type: 'workflow', chapter: '02-lifecycle.md' },
  { name: '02-issue-labels', type: 'lifecycle', chapter: '02-lifecycle.md' },
  { name: '04-worktree', type: 'lifecycle', chapter: '04-level2.md' },
  { name: '05-pilot-loop', type: 'workflow', chapter: '05-level3.md' },
  { name: '07-retro-loop', type: 'dataflow', chapter: '07-rules.md' },
];
/** 各圖型的節點與邊陣列：每個元素都要獨佔一行。 */
const ITEM_KEYS = ['components', 'connections', 'lanes', 'phases', 'nodes', 'edges', 'states', 'transitions', 'stages', 'flows', 'cards'];

test('diagrams/src 只有這 6 張來源，每張都有產出的 HTML 與 PNG', () => {
  const sources = readdirSync(join(root, 'diagrams', 'src')).sort();
  assert.deepEqual(sources, DIAGRAMS.map(({ name, type }) => `${name}.${type}.json`).sort());
  for (const { name } of DIAGRAMS) {
    assert.ok(existsSync(join(root, 'diagrams', `${name}.html`)), `缺 diagrams/${name}.html`);
    assert.ok(existsSync(join(root, 'diagrams', `${name}.png`)), `缺 diagrams/${name}.png`);
  }
});

test('來源 JSON 的 diagram_type 與檔名一致，meta.output 指向 docs/workflow/diagrams/<name>.html', () => {
  for (const { name, type } of DIAGRAMS) {
    const source = JSON.parse(readFileSync(join(root, 'diagrams', 'src', `${name}.${type}.json`), 'utf8'));
    assert.equal(source.diagram_type, type, name);
    assert.equal(source.meta.output, `docs/workflow/diagrams/${name}.html`, name);
  }
});

test('來源 JSON 一節點一行：每個節點、邊、卡片都能在單獨一行找到', () => {
  for (const { name, type } of DIAGRAMS) {
    const text = readFileSync(join(root, 'diagrams', 'src', `${name}.${type}.json`), 'utf8');
    const lines = new Set(text.split('\n').map((line) => line.trim().replace(/,$/, '')));
    const source = JSON.parse(text);
    for (const key of ITEM_KEYS) {
      for (const item of source[key] ?? []) {
        const found = [...lines].some((line) => {
          try { return line.startsWith('{') && JSON.stringify(JSON.parse(line)) === JSON.stringify(item); } catch { return false; }
        });
        assert.ok(found, `${name} 的 ${key} 元素不在單獨一行：${JSON.stringify(item)}`);
      }
    }
  }
});

test('各章嵌入 PNG 並連到互動版 HTML 與來源 JSON', () => {
  for (const { name, type, chapter } of DIAGRAMS) {
    const markdown = readFileSync(join(root, chapter), 'utf8');
    assert.match(markdown, new RegExp(`^!\\[[^\\]]+\\]\\(diagrams/${name}\\.png\\)$`, 'm'), `${chapter} 沒有嵌入 ${name}.png`);
    assert.ok(markdown.includes(`](diagrams/${name}.html)`), `${chapter} 沒有連到 ${name}.html`);
    assert.ok(markdown.includes(`](diagrams/src/${name}.${type}.json)`), `${chapter} 沒有連到 ${name} 的來源 JSON`);
  }
});
