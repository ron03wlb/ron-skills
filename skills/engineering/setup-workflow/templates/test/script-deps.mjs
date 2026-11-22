// 測試 fixture 把腳本複製到暫存 repo 的 scripts/ 時，依 import 相依閉包複製，不手列檔名（#473：pilot-land.mjs 頂層多 import
// pilot-probe.mjs 後，只手列部分腳本的 tests/land-restamp.test.mjs 要到整條 bin/check 才報 `Cannot find module`；pilot-probe 加
// lib/merge-tree.mjs 時 pilot-probe.test.mjs、pilot-dispatch.test.mjs 的手列清單也各要補；#454-3 pilot-close.test.mjs 同）。
// 追的引用與 copy-templates.mjs 的 references() 同一套：行首的靜態 import／export、動態 `import('./…')`、
// `// copy-templates: requires <檔名>` 宣告。`join(here, '<檔名>')` 這類「旁邊有才用」的選用檔不追，要用時由呼叫端放進 names。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const IMPORTS = [
  /^\s*(?:(?:import|export)\b[^'"`;]*?\bfrom|\}\s*from|import)\s*'(\.\.?\/[^']+)'/gm,
  /\bimport\(\s*'(\.\.?\/[^']+)'\s*\)/g,
];

/** `names`（相對 `from` 的路徑）加上它們遞迴 import 的同目錄樹內檔案，依字母排序。 */
export function scriptClosure(from, names) {
  const seen = new Set();
  const visit = name => {
    const file = normalize(name);
    if (seen.has(file) || file.startsWith('..')) return;
    if (!existsSync(join(from, file))) throw new Error(`script-deps：${join(from, file)} 不存在`);
    seen.add(file);
    if (!/\.(mjs|js)$/.test(file)) return;
    const text = readFileSync(join(from, file), 'utf8');
    const required = [...text.matchAll(/^(?:\/\/|#) copy-templates: requires (.+)$/gm)].flatMap(m => m[1].trim().split(/\s+/));
    const imported = IMPORTS.flatMap(pattern => [...text.matchAll(pattern)].map(m => m[1]));
    for (const ref of [...required, ...imported]) visit(join(dirname(file), ref));
  };
  names.forEach(visit);
  return [...seen].sort();
}

/** 把 `names` 與其相依閉包從 `from` 複製到 `to`（保留子目錄），回傳複製的相對路徑。 */
export function copyScripts(from, to, names) {
  const files = scriptClosure(from, names);
  for (const file of files) {
    mkdirSync(dirname(join(to, file)), { recursive: true });
    copyFileSync(join(from, file), join(to, file));
  }
  return files;
}
