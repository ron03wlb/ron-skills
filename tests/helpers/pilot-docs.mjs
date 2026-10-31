// pilot 的 adapter 檔（#166）：issue-run.md 的 Pilot 段連到 pilot.md 與拆出去的檔，順序同 Probe 的 ADAPTER_AHEAD。
// pilot.md 裡移出去的條目只剩一行 pointer（`- **<名稱>.** 見 [<檔>](<檔>)：…`），測條目內容時要讀它所在的那份。
import { readFileSync } from 'node:fs';
import { pilotFiles } from '../../scripts/pilot-probe.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** `[{ path, text }]`，第一份是 pilot.md。 */
export const pilotDocs = pilotFiles(read('docs/agents/issue-run.md')).map(path => ({ path, text: read(path) }));

const isPointer = (line, name) => /^見 \[[^\]]+\.md\]\([^)]+\.md\)：/.test(line.slice(`- **${name}.** `.length));

/** 名稱為 `name` 的條目那一行與它所在的檔；pilot.md 的 pointer 不算。找不到時 line 是空字串。 */
export function pilotEntry(name) {
  for (const { path, text } of pilotDocs) {
    const line = text.split('\n').find(l => l.startsWith(`- **${name}.** `) || l === `- **${name}.**`);
    if (line && !isPointer(line, name)) return { path, text, line };
  }
  return { path: '', text: '', line: '' };
}
