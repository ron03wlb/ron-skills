#!/usr/bin/env node
// pilot 的 Close 要到成員 Issue 的跨 repo 對應單留言交接；對應單寫在本文，如「app 對應單：acme/app#7」。
// 裸的 <owner>/<repo>#<m> 是 github.com；GitLab 與 GitHub Enterprise 的對應單寫成 issue 網址（如 http://192.168.200.202/acme/app/-/issues/7），
// host 種類與留言指令都取自 lib/hosts.mjs（setup-workflow 的 gh／glab 對照表，人看的副本是 HOSTS.md）。
// 用法：gh issue view <n> --json body --jq .body | node scripts/pilot-counterpart.mjs [--adapter <adapter 檔>] [--file <交接檔>]
// stdout：每張對應單一行（依出現順序、去重；整句在 code block、code span 或「」引號內的不算），沒有對應單時不輸出；exit 0。
//   github.com：`COUNTERPART <owner>/<repo>#<m>`
//   其他 host：`COUNTERPART <path>#<m> <github|gitlab> <repo>`，<repo> 是 `gh --repo`／`glab -R` 的值（GHE 是 host/owner/repo，GitLab 是專案網址）
//   帶 --adapter 時（#304），adapter 有一行 `Counterpart projects: <owner>/<repo>[, <owner>/<repo>…]`（宣告不在 github.com 的對應專案，
//     專案可包在 code span 裡，不分大小寫），github.com 的對應單（裸 ref 或 github.com 網址）命中宣告時，COUNTERPART 之後多一行
//     `COUNTERPART_BARE <owner>/<repo>#<m>`：這張單在 github.com 找不到，本文要改寫成 issue 網址。沒有宣告時輸出與不帶時相同。
//   帶 --file 時每張後面多一行 `COMMAND <指令>`：用交接檔到那張對應單留言的一行 shell 指令，Close 執行它，失敗時原樣交給人用 `!` 跑。
// pilot-probe.mjs 以 counterparts()、declaredProjects() 對派工前的 Issue 做同一個判斷（Probe 的 COUNTERPART_BARE <n> <ref>）。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { COMMANDS, hostKind, remoteHostname } from './lib/hosts.mjs';

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

/** adapter 的 `Counterpart projects:` 行宣告的專案（小寫的 `<owner>/<repo>`）；沒有這一行時是空的。 */
export function declaredProjects(adapter) {
  const line = (adapter ?? '').match(/^(?:[-*]\s+)?Counterpart projects:(.*)$/m)?.[1] ?? '';
  return new Set([...line.matchAll(/[\w.-]+\/[\w.-]+/g)].map(([project]) => project.toLowerCase()));
}

/**
 * 本文裡的對應單，依出現順序、去重：`[{ ref, kind, repo, m, bare }]`。`bare` 是 github.com 的對應單（kind 為 null）命中 `projects`
 * （declaredProjects 的結果）：宣告說那個專案不在 github.com，這個 ref 在 Close 會指錯地方。
 */
export function counterparts(text, projects = new Set()) {
  // 整句「對應單：ref」在 code block、code span 或「」裡是引用（如引用別張 Issue 的原文或測試 fixture），不是這張 Issue 的對應單；
  // 只有 ref 包在 code span 裡（對應單：`acme/app#7`）仍算。
  const body = (text ?? '').replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`|「[^」\n]*」/g, quote => (quote.includes('對應單') ? '' : quote));
  const seen = new Set();
  const out = [];
  for (const [, ref] of body.matchAll(/對應單[：:]\s*`?((?:https?:\/\/[^\s`'"()<>，。；、]+)|[\w.-]+\/[\w.-]+#\d+)/g)) {
    const counterpart = parse(ref);
    if (!counterpart) continue;
    const id = `${counterpart.kind ?? 'github'} ${counterpart.repo}#${counterpart.m}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...counterpart, bare: !counterpart.kind && projects.has(counterpart.repo.toLowerCase()) });
  }
  return out;
}

/** shell 參數：只含安全字元時原樣，否則單引號包起來。 */
const quote = value => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = new Map(Object.entries({ '--adapter': 'adapter', '--file': 'file' })).get(args[i]);
    if (!name || name in options || !args[i + 1]) {
      console.error('用法：node scripts/pilot-counterpart.mjs [--adapter <adapter 檔>] [--file <交接檔>] < Issue 本文');
      process.exit(2);
    }
    options[name] = args[i + 1];
  }
  const projects = options.adapter ? declaredProjects(readFileSync(options.adapter, 'utf8')) : new Set();
  for (const counterpart of counterparts(readFileSync(0, 'utf8'), projects)) {
    console.log(counterpart.kind ? `COUNTERPART ${counterpart.ref} ${counterpart.kind} ${counterpart.repo}` : `COUNTERPART ${counterpart.ref}`);
    if (counterpart.bare) console.log(`COUNTERPART_BARE ${counterpart.ref}`);
    if (options.file) {
      const command = COMMANDS.otherRepo[counterpart.kind ?? 'github']
        .replace('<n>', () => counterpart.m).replace('<owner>/<repo>', () => quote(counterpart.repo)).replace('<file>', () => quote(options.file));
      console.log(`COMMAND ${command}`);
    }
  }
}
