// 合併中途只有戳記檔衝突時重算戳記（#173）：land.mjs（setup-workflow 正本）在 PR 和 main 衝突時用；pilot-land.mjs 的 Stage 經 scripts/pilot-resolve.mjs 用它重算流程站戳記（#245）。
// land.mjs 的契約：repo 有 scripts/restamp.mjs 時，衝突檔全在 STAMP_FILES 裡就呼叫 restamp(tree, files)；它解完並 git add，回傳 true，
// 解不了回傳 false（呼叫端 merge --abort）。只處理 files 裡的戳記檔，沒衝突的不動。
//   scripts/workflow-doc-sync.json     交給 pilot-resolve.mjs 的 restamp：取目標分支（--theirs）版本，有 build-workflow-site.mjs 就重產 docs/workflow/site/，
//                                      再以 check-workflow-sync.mjs --restamp 依合併後的來源重寫（#72）。
//   docs/agents/workflow-templates.json  交給 pilot-land.mjs（setup-workflow 正本）的 restampManifest：兩邊 copies 的聯集，依路徑排序（同 copy-templates.mjs）；每個條目取 sha256 等於合併後副本的那一邊，
//                                      兩邊都不等（副本兩邊都改、合併出新內容）時 sha256 依檔案重算、commit 取兩邊歷史裡最後一個改正本的 commit；
//                                      副本已不在的條目拿掉。
import { restampManifest } from './pilot-land.mjs';
import { restamp as restampDocSync } from './pilot-resolve.mjs';

const STAMPS = 'scripts/workflow-doc-sync.json';
const MANIFEST = 'docs/agents/workflow-templates.json';
export const STAMP_FILES = [STAMPS, MANIFEST];

/** 重算 files 裡的戳記檔並 git add；有不是戳記檔的、或任一步失敗時回傳 false。 */
export function restamp(tree, files) {
  if (!files.length || !files.every(file => STAMP_FILES.includes(file))) return false;
  if (files.includes(MANIFEST) && !restampManifest(tree)) return false;
  // 戳記檔最後重算：讀的是其他檔解完之後的來源。
  if (files.includes(STAMPS) && !restampDocSync(tree, [STAMPS])) return false;
  return true;
}
