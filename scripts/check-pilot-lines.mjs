#!/usr/bin/env node
// skill 以 `Pilot **<名稱>** line` 讀 adapter 的 Pilot 設定；各 repo 照 ADAPTER.md 範本寫 adapter，範本沒列的設定就不會有人寫。
// 無法在更上層消除：ADAPTER.md 是複製進各 repo 再填寫的範本，skill 與範本分屬不同檔案且無型別可共用，只能在 --check 比對兩邊。
// 掃描本 repo 的 SKILL.md 與 README.md 中的 `Pilot **<名稱>** line`，每個名稱都必須是 ADAPTER.md `## Pilot` 段的一個 `**<名稱>.**` 條目。
// 用法：node scripts/check-pilot-lines.mjs
// stdout：每個違規一行 `PILOT_LINE_UNDOCUMENTED <名稱>（<引用檔>）`；exit 0 無違規、1 有違規。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const dirs = base => (existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(base, d.name)) : []);
const nested = base => dirs(base).flatMap(dirs);

const adapter = join(root, 'skills/engineering/issue-run/ADAPTER.md');
const pilot = readFileSync(adapter, 'utf8').match(/^## Pilot\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
const documented = new Set([...pilot.matchAll(/^- \*\*([^*]+?)\.\*\*/gm)].map(([, name]) => name));

const sources = [join(root, 'README.md'), ...nested(join(root, 'skills')).map(dir => join(dir, 'SKILL.md'))].filter(existsSync);
const failures = [];
for (const source of sources) {
  for (const [, name] of readFileSync(source, 'utf8').matchAll(/Pilot \*\*([^*]+)\*\* line/g)) {
    if (!documented.has(name)) {
      failures.push(`PILOT_LINE_UNDOCUMENTED ${name}（${relative(root, source)}）：在 ${relative(root, adapter)} 的 Pilot 段加一個 **${name}.** 條目，寫出內容與預設值`);
    }
  }
}
for (const line of new Set(failures)) console.log(line);
process.exit(failures.length ? 1 : 0);
