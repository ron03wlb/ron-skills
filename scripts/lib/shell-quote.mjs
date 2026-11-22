// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Bash hook 共用的引號比對（#360）：雙引號裡的 `$( … )` 與反引號是新的命令替換，引號狀態重設，裡面的 `"` 不是外層雙引號的結尾。
// claude-hook-zsh-equals 與 claude-hook-main-checkout 都用它找雙引號字串的結尾：
// 先前兩支各自找下一個 `"`，`echo "PR: $(jq -r '[.[]|"\(.name)=\(.bucket)"]' …)"` 與 `echo "x $(gh api "/x?created=>=1" …)"`
// 都被切錯，`=\(.bucket)` 當成 EQUALS 字、`>=1` 當成重導向（#324 第 3 項、#330 第 5 項）。
// 只比對結構，不展開任何東西；沒有閉合時回傳字串長度（呼叫端照原本的未閉合處理）。

/**
 * 雙引號字串的結尾。
 * @param {string} command
 * @param {number} start `"` 的位置
 * @returns {{end: number, commands: string[]}} end 是閉合 `"` 的位置（未閉合時為 command.length）；
 *   commands 是直接出現在這段雙引號裡的命令替換內容（`$( … )` 與反引號，不含 `$(( … ))` 算式），依出現順序
 */
export function doubleQuoteEnd(command, start) {
  const commands = [];
  let i = start + 1;
  while (i < command.length && command[i] !== '"') {
    if (command[i] === '\\') { i += 2; continue; }
    if (command[i] === '$' && command[i + 1] === '(') {
      const end = substitutionEnd(command, i);
      if (command[i + 2] !== '(') commands.push(command.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (command[i] === '`') {
      const end = backtickEnd(command, i);
      commands.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return { end: Math.min(i, command.length), commands };
}

/**
 * `$( … )` 或 `$(( … ))` 的閉合 `)` 位置：裡面依單引號、雙引號（遞迴）、反引號與跳脫規則略過，括號計層數。
 * @param {string} command
 * @param {number} start `$` 的位置
 * @returns {number} 閉合 `)` 的位置（未閉合時為 command.length）
 */
export function substitutionEnd(command, start) {
  let depth = 0;
  for (let i = start + 1; i < command.length; i += 1) {
    const c = command[i];
    if (c === '\\') i += 1;
    else if (c === "'") { const end = command.indexOf("'", i + 1); i = end < 0 ? command.length : end; }
    else if (c === '"') i = doubleQuoteEnd(command, i).end;
    else if (c === '`') i = backtickEnd(command, i);
    else if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return i;
  }
  return command.length;
}

/** 反引號命令替換的閉合反引號位置（未閉合時為 command.length）。 */
function backtickEnd(command, start) {
  let i = start + 1;
  while (i < command.length && command[i] !== '`') i += command[i] === '\\' ? 2 : 1;
  return Math.min(i, command.length);
}
