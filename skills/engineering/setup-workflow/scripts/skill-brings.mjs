// setup-workflow SKILL.md 的 Templates 表每列用「(brings `<相依>`)」寫出範本會帶上的檔；這裡拿 copy-templates.mjs 算出的相依比對（#491）。
// copy-templates.mjs 複製明列範本時對動到的列跑同一套比對（#631：pilot-land.mjs 的 requires 多了三個檔、表沒跟上，
// 直到 pre-commit 的 tests/skill-brings.test.mjs 排完 805 秒 slot 才抓到）；tests/skill-brings.test.mjs 對整張表跑。
// 規則：範本的完整相依扣掉自己，要被套用到它的括號裡的檔名涵蓋（列出的檔連同它自己帶的都算，所以「with what it brings, its row」不必展開）。
// 同格明列的範本不算涵蓋：只拷其中一支時，人要從括號看出會多帶哪些檔（pilot-probe.mjs 靠同格的 pilot-dispatch.mjs 會漏掉 lib/merge-tree.mjs）。
// 括號套用到它前面、上一個括號之後列的每個範本（`a.mjs`, `b.mjs` (bring `x`) 兩個都帶 x）。

const isScript = name => /\.(mjs|sh)$/.test(name);

/** SKILL.md 全文 → `## Templates` 一節的文字（沒有這節回傳空字串）。 */
export const templatesTable = skill => skill.split('\n## Templates\n')[1]?.split('\n## ')[0] ?? '';

/** Templates 表的文字 → [{ template, brings }]：brings 是套用到該範本的括號裡所有反引號檔名。 */
export function bringsRows(table) {
  const rows = [];
  for (const line of table.split('\n')) {
    if (!line.startsWith('| `')) continue;
    let pending = [];
    for (const [, name, inner] of line.slice(2).split(' | ')[0].matchAll(/`([^`]+)`|\(([^)]*)\)/g)) {
      if (name) {
        if (isScript(name)) { pending.push({ template: name, brings: [] }); rows.push(pending.at(-1)); }
        continue;
      }
      const names = [...inner.matchAll(/`([^`]+)`/g)].map(match => match[1]);
      for (const row of pending) row.brings = names;
      pending = [];
    }
  }
  return rows;
}

/** 每列缺的相依 → `SKILL_BRINGS_MISSING <範本> <相依>` 行；closure(name) 是 copy-templates 算出的完整相依（含自己），非腳本檔回傳 [name]。 */
export function bringsMissing(rows, closure) {
  const lines = [];
  for (const { template, brings } of rows) {
    const covered = new Set(brings.flatMap(name => closure(name)));
    for (const dep of closure(template)) if (dep !== template && !covered.has(dep)) lines.push(`SKILL_BRINGS_MISSING ${template} ${dep}`);
  }
  return lines;
}
