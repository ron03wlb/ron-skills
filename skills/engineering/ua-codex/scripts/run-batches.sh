#!/usr/bin/env bash
# 以固定並行數跑多個批次（slot pool）。用法：run-batches.sh [--jobs N] [--batches <batches.json>] (--all | --pending | <idx>...)
#   --all      batches.json 內全部批次
#   --pending  只跑 intermediate/ 還沒有 batch-<i>*.json 的批次
# 任一批因 HEAD 漂移（exit 3）停止時不再派新批，等進行中的批次結束後以 3 結束。結束時印出 summary.txt。
set -u
source "$(dirname "$0")/common.sh"
JOBS=${UA_CODEX_JOBS:-5}; BATCHES=$UA_DIR/intermediate/batches.json; sel=()
for ((k=1;k<=$#;k++)); do [[ ${!k} == --batches ]] && { n=$((k+1)); BATCHES=${!n}; }; done
[[ -f $BATCHES ]] || { echo "ua-codex: 找不到 $BATCHES；先跑 compute-batches.mjs" >&2; exit 2; }
while [[ $# -gt 0 ]]; do case $1 in
  --jobs) JOBS=$2; shift 2;; --batches) BATCHES=$2; shift 2;;
  --all) mapfile -t sel < <(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).batches.map(b=>b.batchIndex).join("\n"))' "$BATCHES"); shift;;
  --pending) mapfile -t sel < <(node -e '
    const fs=require("fs"),[bp,dir]=process.argv.slice(1);const have=fs.readdirSync(dir);
    for(const b of JSON.parse(fs.readFileSync(bp,"utf8")).batches) if(!have.some(f=>new RegExp(`^batch-${b.batchIndex}(-part-\\d+)?\\.json$`).test(f))) console.log(b.batchIndex);' "$BATCHES" "$UA_DIR/intermediate"); shift;;
  *) sel+=("$1"); shift;; esac; done
[[ -f $BATCHES ]] || { echo "ua-codex: 找不到 $BATCHES；先跑 compute-batches.mjs" >&2; exit 2; }
[[ ${#sel[@]} -gt 0 ]] || { echo "ua-codex: 沒有要跑的批次" >&2; exit 2; }
head_gate || exit $?
echo "ua-codex: ${#sel[@]} 批，並行 $JOBS，model=$CODEX_MODEL effort=$CODEX_EFFORT" >&2
stop=0; fail=0
for i in "${sel[@]}"; do
  while (( $(jobs -rp | wc -l) >= JOBS )); do wait -n || { rc=$?; (( rc == 3 )) && stop=1; (( rc != 0 && rc != 3 )) && fail=1; }; done
  (( stop )) && break
  "$(dirname "$0")/run-batch.sh" "$i" --batches "$BATCHES" &
done
while (( $(jobs -rp | wc -l) > 0 )); do wait -n || { rc=$?; (( rc == 3 )) && stop=1; (( rc != 0 && rc != 3 )) && fail=1; }; done
echo "--- summary ($OUT/summary.txt)"; sort -t' ' -k2 -n "$OUT/summary.txt" 2>/dev/null | awk '!seen[$2]++'
(( stop )) && { echo "ua-codex: 因 HEAD 漂移停止，未派出的批次用 --pending 續跑" >&2; exit 3; }
(( fail )) && { echo "ua-codex: 有批次失敗，見 $OUT/status.txt 與對應 .log" >&2; exit 1; }
exit 0
