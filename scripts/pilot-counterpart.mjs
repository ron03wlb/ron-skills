#!/usr/bin/env node
// pilot 的 Close 要到成員 Issue 的跨 repo 對應單留言交接；對應單寫在本文，如「app 對應單：acme/app#7」。
// 裸的 <owner>/<repo>#<m> 是 github.com；GitLab 與 GitHub Enterprise 的對應單寫成 issue 網址（如 http://192.168.200.202/acme/app/-/issues/7），
// host 種類與留言指令都取自 lib/hosts.mjs（setup-workflow 的 gh／glab 對照表，人看的副本是 HOSTS.md）。
// 用法：gh issue view <n> --json body --jq .body | node scripts/pilot-counterpart.mjs [--file <交接檔>]
// stdout：每張對應單一行（依出現順序、去重；整句在 code block、code span 或「」引號內的不算），沒有對應單時不輸出；exit 0。
//   github.com：`COUNTERPART <owner>/<repo>#<m>`
//   其他 host：`COUNTERPART <path>#<m> <github|gitlab> <repo>`，<repo> 是 `gh --repo`／`glab -R` 的值（GHE 是 host/owner/repo，GitLab 是專案網址）
//   帶 --file 時每張後面多一行 `COMMAND <指令>`：用交接檔到那張對應單留言的一行 shell 指令，Close 執行它，失敗時原樣交給人用 `!` 跑。
import { readFileSync } from 'node:fs';
import { COMMANDS, hostKind, remoteHostname } from './lib/hosts.mjs';

const args = process.argv.slice(2);
const file = args[0] === '--file' ? args[1] : undefined;
if (args.length && !file) {
  console.error('用法：node scripts/pilot-counterpart.mjs [--file <交接檔>] < Issue 本文');
  process.exit(2);
}

// 整句「對應單：ref」在 code block、code span 或「」裡是引用（如引用別張 Issue 的原文或測試 fixture），不是這張 Issue 的對應單；
// 只有 ref 包在 code span 裡（對應單：`acme/app#7`）仍算。
const body = readFileSync(0, 'utf8').replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`|「[^」\n]*」/g, quote => (quote.includes('對應單') ? '' : quote));

/** 一張對應單：`{ ref, kind, repo, m }`；github.com 的 kind 為 null（輸出維持裸 ref）。 */
function parse(text) {
  const bare = text.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (bare) return { ref: text, kind: null, repo: bare[1], m: bare[2] };
  // GitLab 的 issue 網址是 <專案網址>/-/issues/<m>（舊版沒有 `-/`），專案可以在子群組裡；GitHub 是 <repo 網址>/issues/<m>。
  const url = text.match(/^(https?:\/\/[^/]+)\/([\w.-]+(?:\/[\w.-]+)+?)(?:\/-)?\/issues\/(\d+)$/);
  if (!url) return null;
  const [, origin, path, m] = url;
  const host = remoteHostname(origin);
  const kind = hostKind(host);
  if (kind === 'github') return host === 'github.com' ? { ref: `${path}#${m}`, kind: null, repo: path, m } : { ref: `${path}#${m}`, kind, repo: `${host}/${path}`, m };
  return { ref: `${path}#${m}`, kind, repo: `${origin}/${path}`, m };
}

/** shell 參數：只含安全字元時原樣，否則單引號包起來。 */
const quote = value => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

const seen = new Set();
for (const [, text] of body.matchAll(/對應單[：:]\s*`?((?:https?:\/\/[^\s`'"()<>，。；、]+)|[\w.-]+\/[\w.-]+#\d+)/g)) {
  const counterpart = parse(text);
  if (!counterpart) continue;
  const id = `${counterpart.kind ?? 'github'} ${counterpart.repo}#${counterpart.m}`;
  if (seen.has(id)) continue;
  seen.add(id);
  console.log(counterpart.kind ? `COUNTERPART ${counterpart.ref} ${counterpart.kind} ${counterpart.repo}` : `COUNTERPART ${counterpart.ref}`);
  if (file) {
    const command = COMMANDS.otherRepo[counterpart.kind ?? 'github']
      .replace('<n>', () => counterpart.m).replace('<owner>/<repo>', () => quote(counterpart.repo)).replace('<file>', () => quote(file));
    console.log(`COMMAND ${command}`);
  }
}
