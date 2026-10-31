import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orcaSamples, ORCA_PLATFORMS } from './helpers/fake-orca.mjs';

const helpers = new URL('./helpers/', import.meta.url).pathname;
const templates = new URL('../skills/engineering/setup-workflow/templates/test/', import.meta.url).pathname;

const type = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
/** 樣本的欄位路徑 → 型別（陣列元素記成 `[]`），只比結構不比值。 */
function shape(value, path = '', out = new Map()) {
  out.set(path || '.', type(value));
  if (Array.isArray(value)) value.forEach(item => shape(item, `${path}[]`, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) shape(item, `${path}.${key}`, out);
  return out;
}

test('兩個平台都有樣本，未知平台丟錯', () => {
  assert.deepEqual(ORCA_PLATFORMS, ['wsl', 'macos']);
  assert.equal(orcaSamples('macos').create.terminal.hostPlatform, 'sample');
  assert.throws(() => orcaSamples('win'), /FAKE_ORCA_PLATFORM/);
});

test('WSL 樣本的每個欄位在 macOS 樣本都在、型別相同：腳本讀的欄位兩邊同路徑', () => {
  const wsl = orcaSamples('wsl');
  const macos = orcaSamples('macos');
  assert.deepEqual(Object.keys(macos).sort(), Object.keys(wsl).sort());
  for (const name of Object.keys(wsl)) {
    const mac = shape(macos[name]);
    for (const [path, t] of shape(wsl[name])) {
      // 值為 null 的欄位（如 wait 的 exitCode）兩邊型別可以不同
      if (t !== 'null' && mac.get(path) !== 'null') assert.equal(mac.get(path), t, `${name} ${path}`);
    }
  }
});

test('tests/helpers 的 fake-orca 與樣本和 setup-workflow 正本一致', () => {
  assert.equal(readFileSync(`${helpers}fake-orca.mjs`, 'utf8'), readFileSync(`${templates}fake-orca.mjs`, 'utf8'));
  for (const platform of ORCA_PLATFORMS) {
    const sub = platform === 'wsl' ? '' : `${platform}/`;
    for (const name of Object.keys(orcaSamples(platform))) {
      const file = `fixtures/orca/${sub}${name}.json`;
      assert.equal(readFileSync(`${helpers}${file}`, 'utf8'), readFileSync(`${templates}${file}`, 'utf8'), file);
    }
  }
});
