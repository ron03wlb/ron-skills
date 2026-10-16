#!/usr/bin/env bash
# 用 Codex 跑 understand-anything file-analyzer 的單一批次。
# 用法：run-batch.sh <batchIndex> [--batches <batches.json>]
# 讀 $UA_DIR/intermediate/batches.json（或 --batches 指定檔）取該批的 files / batchImportData / neighborMap，
# 把派工資料寫成檔案讓 Codex 自行讀取，結束後驗證 batch-<i>*.json 存在且為合法 JSON。
set -u
source "$(dirname "$0")/common.sh"
i=$1; shift
BATCHES=$UA_DIR/intermediate/batches.json
[[ ${1:-} == --batches ]] && BATCHES=$2
head_gate || exit $?
IN=$UA_DIR/tmp/batch-input; mkdir -p "$IN"
node - "$BATCHES" "$i" "$IN" "$UA_DIR" "$UA_PLUGIN_ROOT/skills/understand" "$PROJECT_ROOT" <<'NODE'
const fs=require('fs'),[bp,i,inDir,ua,skill,root]=process.argv.slice(2);
const b=JSON.parse(fs.readFileSync(bp,'utf8')).batches.find(x=>String(x.batchIndex)===i);
if(!b){console.error(`ua-codex: batches.json 沒有批次 ${i}`);process.exit(2);}
const sr=JSON.parse(fs.readFileSync(`${ua}/intermediate/scan-result.json`,'utf8'));
let lang='en';try{lang=JSON.parse(fs.readFileSync(`${ua}/config.json`,'utf8')).outputLanguage||'en';}catch{}
fs.writeFileSync(`${inDir}/batch-${i}.json`,JSON.stringify(b));
const files=b.files.map((f,n)=>`${n+1}. \`${f.path}\` (${f.sizeLines} lines, language: \`${f.language}\`, fileCategory: \`${f.fileCategory}\`)`).join('\n');
const directive=lang==='en'?'':`\n> **Language directive**: Generate all textual content (summaries, descriptions, tags, titles, languageNotes, languageLesson) in **${lang}**. Maintain technical accuracy while using natural, native-level phrasing. Keep technical terms in English when no standard translation exists.\n`;
fs.writeFileSync(`${inDir}/batch-${i}.dispatch.md`,`Analyze these files and produce GraphNode and GraphEdge objects.
Project root: \`${root}\`
Project: \`${sr.name}\` — ${sr.description}
Languages: ${sr.languages.map(l=>`\`${l}\``).join(', ')}
Frameworks: ${(sr.frameworks||[]).join(', ')}
Batch: \`${i}\`
Skill directory (for bundled scripts): \`${skill}\`
PLUGIN_ROOT=\`${skill.replace(/\/skills\/understand$/,'')}\` (core already built)
UA_DIR=\`${ua}\`
Output: write to \`${ua}/intermediate/batch-${i}.json\` (single-file mode) OR \`batch-${i}-part-<k>.json\` (split mode). Use exactly this batchIndex (${i}) in the filename.

Pre-resolved import data (\`batchImportData\`) and cross-batch neighbors (\`neighborMap\`) are in \`${inDir}/batch-${i}.json\` (keys: batchIndex, files, batchImportData, neighborMap). Read it with a script; use \`batchImportData\` directly — do NOT re-resolve imports from source. Use \`neighborMap\` as confidence boost for cross-batch edges.

Files to analyze (every entry MUST be passed through to \`batchFiles\` with all four fields) — ${b.files.length} files:
${files}
${directive}`);
NODE
rc=$?; [[ $rc -ne 0 ]] && exit $rc
PROMPT=$OUT/batch-$i.prompt.md
{ echo "# Role: understand-anything file-analyzer (agent definition follows)"; echo; agent_body file-analyzer
  echo; echo "---"; echo; echo "# Dispatch (from main orchestrator session)"; echo; cat "$IN/batch-$i.dispatch.md"
  echo; echo "Notes for Codex runtime: run Node scripts with \`node\`, Python with \`python3\`. Non-interactive: never ask questions, never spawn sub-agents. Reply with a short summary (files written, node/edge counts, skipped files)."
} > "$PROMPT"
run_codex "$PROMPT" "batch-$i"; rc=$?
node -e '
const fs=require("fs"),[dir,i]=process.argv.slice(1);
const fs_=fs.readdirSync(dir).filter(f=>new RegExp(`^batch-${i}(-part-\\d+)?\\.json$`).test(f));
if(!fs_.length){console.log(`batch ${i}: NO OUTPUT`);process.exit(4);}
let n=0,e=0;for(const f of fs_){const d=JSON.parse(fs.readFileSync(`${dir}/${f}`,"utf8"));n+=(d.nodes||[]).length;e+=(d.edges||[]).length;}
console.log(`batch ${i}: parts=${fs_.length} nodes=${n} edges=${e} codex_exit=${process.argv[3]}`);
' "$UA_DIR/intermediate" "$i" "$rc" | tee -a "$OUT/summary.txt"
