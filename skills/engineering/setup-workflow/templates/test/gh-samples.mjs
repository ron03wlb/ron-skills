// 假 gh 的真實回應樣本：fixtures/github/<名稱>.json，以檔名（去掉 .json）為 key。
// 替身的輸出一律從這些樣本長出來（mergeSample，見 fake-orca.mjs），不能自創 gh 沒有的欄位。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'fixtures/github');

export const GH_SAMPLES = Object.fromEntries(readdirSync(dir).filter(file => file.endsWith('.json'))
  .map(file => [file.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, file), 'utf8'))]));
