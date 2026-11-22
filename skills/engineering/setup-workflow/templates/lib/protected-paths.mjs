// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本：保護路徑（#303）。land.mjs 與 pilot-close.mjs 快轉主 checkout 的主分支之前共用這一份判斷。
// 宣告：adapter（主 checkout 的 docs/agents/issue-run.md）裡以 `Protected paths:` 開頭的行（前面可以有 `- ` 或 `* `），
//   該行每個 `` `…` `` 是一條字面路徑（不是 pathspec），例如 `Protected paths: \`private\` \`notes/local.md\``；可以有多行，路徑合併。
//   沒有 adapter 或沒有這一行就是沒有宣告；有這一行卻沒有任何 `` `…` `` 時丟錯（宣告寫錯，不能當成沒有防護）。
// 判斷：快轉會讓這些路徑底下的追蹤檔消失（刪除、改名、換成別種類型）時，列出那些檔（#286 的案例）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** adapter 相對於 checkout 根目錄的位置。 */
export const ADAPTER = 'docs/agents/issue-run.md';
const DECLARATION = /^(?:[-*]\s+)?Protected paths:(.*)$/;

/** adapter 內文 → 宣告的路徑（依出現順序、去重）；有宣告行卻沒有路徑時丟錯。 */
export function declaredPaths(text) {
  const paths = [];
  for (const line of String(text ?? '').split('\n')) {
    const rest = DECLARATION.exec(line.trim())?.[1];
    if (rest === undefined) continue;
    const found = [...rest.matchAll(/`([^`]+)`/g)].map(match => match[1].trim()).filter(Boolean);
    if (!found.length) throw new Error(`${ADAPTER} 的 Protected paths: 行沒有路徑（每條路徑寫成 \`<路徑>\`）：${line.trim()}`);
    paths.push(...found);
  }
  return [...new Set(paths)];
}

/** checkout 根目錄的 adapter 宣告的路徑；沒有 adapter 時是空陣列。 */
export function readDeclaredPaths(root) {
  const file = join(root, ADAPTER);
  return existsSync(file) ? declaredPaths(readFileSync(file, 'utf8')) : [];
}

/**
 * 在 cwd 從 from 快轉到 to 時，paths 底下會消失的追蹤檔（paths 空時不跑 git，回空陣列）；git 失敗時丟錯。
 * --no-renames：改名時舊路徑一樣消失，rename 偵測開著會報成 R 而漏掉；T：一般檔換成 symlink 或 gitlink，工作副本的內容也不見了。
 */
export function vanishingFiles(cwd, from, to, paths) {
  if (!paths.length) return [];
  const result = spawnSync('git', ['--literal-pathspecs', '-C', cwd, 'diff', '--no-renames', '--name-only', '--diff-filter=DT', from, to, '--', ...paths], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`git diff ${from} ${to}：${(result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n').pop()}`);
  return result.stdout.split('\n').filter(Boolean);
}

/** 快轉被擋下的原因（兩支腳本同一句）；沒有會消失的檔時回 null。 */
export function protectedReason(files) {
  return files.length ? `快轉會刪掉被保護的路徑 ${files.join(' ')}，交給人處理` : null;
}
