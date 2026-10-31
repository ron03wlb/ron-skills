// tracker host 與程式碼 host 的判定，setup-workflow 的 Host 站（detect.mjs --host）使用；人看的說明在 ../../HOSTS.md。
// host 只有 github、gitlab、local 三種：github.com 與名稱含 github 的主機（GitHub Enterprise）算 github，
// 其他網路主機一律當自架 GitLab（http、IP 也算，例如 http://192.168.200.202/spay/spay2）；沒有 remote 或 remote 是本機路徑算 local。

/** git remote URL 的主機名稱（不含 port）；本機路徑、file:// 或空值時 null。 */
export function remoteHostname(url) {
  const text = url?.trim();
  if (!text) return null;
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)/i);
  if (scheme) return scheme[1].toLowerCase() === 'file' ? null : scheme[2].toLowerCase();
  // scp 形式 [user@]host:path；`C:\x` 這類 Windows 路徑不算。
  const scp = text.match(/^(?:[^@/:]+@)?([^/:]{2,}):(?!\/\/)/);
  return scp ? scp[1].toLowerCase() : null;
}

/** 主機名稱的 host 種類；null 為 local。 */
export function hostKind(hostname) {
  if (!hostname) return 'local';
  return /github/.test(hostname) ? 'github' : 'gitlab';
}

/** 文件裡第一個屬於 kind 的網址主機（tracker 和程式碼不在同一種 host 時，tracker 的主機從 issue-tracker.md 找）；沒有時 null。 */
export function hostInDoc(doc, kind) {
  return [...(doc ?? '').matchAll(/https?:\/\/[^\s`'")<>]+/g)].map(([url]) => remoteHostname(url)).find(host => host && hostKind(host) === kind) ?? null;
}

/** 程式碼 host：依 origin URL。 */
export function codeHost(originUrl) {
  const host = remoteHostname(originUrl);
  return { value: hostKind(host), host };
}

/** tracker host：issue-tracker.md 寫 glab 是 gitlab、寫 gh 是 github，都沒寫是本機 Markdown（local）；沒有這份文件時 none。 */
export function trackerKind(doc) {
  if (doc === null || doc === undefined) return 'none';
  return /\bglab\b/.test(doc) ? 'gitlab' : /\bgh\b/.test(doc) ? 'github' : 'local';
}

/** 每種 host 的 CLI。 */
export const CLI = { github: 'gh', gitlab: 'glab' };

/** CI 設定檔位置（GitHub 是目錄，底下每個 .yml 一個 workflow）。 */
export const CI_FILES = { github: '.github/workflows/', gitlab: '.gitlab-ci.yml' };

// gh／glab 指令對照：adapter 的 Tracker、Delivery 段與 pilot 的 Counterpart 照它寫指令。`<…>` 是要代入的值。
// 每列的旗標都以 --help 核對過，紀錄在 HOSTS.md；改這裡就要同步改 HOSTS.md 那一列（測試會比對）。
export const COMMANDS = {
  readIssue: { label: 'Read an Issue with comments', github: 'gh issue view <n> --json number,title,body,labels,comments', gitlab: 'glab issue view <n> --comments' },
  listIssues: { label: 'List ready Issues', github: 'gh issue list --state open --label ready-for-agent --json number,title,labels', gitlab: 'glab issue list --label ready-for-agent -O json' },
  createIssue: { label: 'Create an Issue', github: 'gh issue create --title <title> --body-file <file>', gitlab: 'glab issue create --title <title> --description-file <file> --yes' },
  commentIssue: { label: 'Comment on an Issue', github: 'gh issue comment <n> --body-file <file>', gitlab: 'glab issue note <n> -m "$(cat <file>)"' },
  editLabels: { label: 'Change labels', github: 'gh issue edit <n> --add-label <add> --remove-label <remove>', gitlab: 'glab issue update <n> --label <add> --unlabel <remove>' },
  closeIssue: { label: 'Close an Issue', github: 'gh issue close <n> --comment <text>', gitlab: 'glab issue close <n>' },
  createLabel: { label: 'Create a label', github: 'gh label create <name>', gitlab: 'glab label create --name <name>' },
  otherRepo: { label: 'Comment in another repo', github: 'gh issue comment <n> --repo <owner>/<repo> --body-file <file>', gitlab: 'glab issue note <n> -R <owner>/<repo> -m "$(cat <file>)"' },
  createPr: { label: 'Open a PR / MR', github: 'gh pr create --base <base> --head <branch> --title <title> --body-file <file>', gitlab: 'glab mr create --target-branch <base> --source-branch <branch> --title <title> --description-file <file> --yes' },
  viewPr: { label: 'Read a PR / MR', github: 'gh pr view <pr> --json state,headRefOid,mergeCommit', gitlab: 'glab mr view <pr> -F json' },
  waitCi: { label: 'Wait for CI', github: 'gh pr checks <pr> --watch', gitlab: 'glab ci status --branch <branch> --wait' },
  mergePr: { label: 'Merge', github: 'gh pr merge <pr> --merge --match-head-commit <sha>', gitlab: 'glab mr merge <pr> --sha <sha> --auto-merge=false --yes' },
  authStatus: { label: 'Login status', github: 'gh auth status --hostname <host>', gitlab: 'glab auth status --hostname <host>' },
  authLogin: { label: 'Log in', github: 'gh auth login --hostname <host>', gitlab: 'glab auth login --hostname <host>' },
};
