// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// Claude Code transcript 根目錄（~/.claude/projects）的專案篩選，agent-model-audit.mjs 與 token-usage.mjs 共用（#373）。
// Claude Code 以工作目錄的絕對路徑命名專案目錄，英數以外的字元都換成 `-`（/home/u/code/my.repo → -home-u-code-my-repo），
// 所以 --project 的子字串也照這規則換過再比對，Orca worktree（…/workspaces/<repo>/<worktree>）的目錄同樣含 repo 名。
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

/** 專案子字串 → 判斷專案目錄名是否相符的函式。 */
export const projectMatcher = project => {
  const needle = project.replace(/[^a-zA-Z0-9]/g, '-');
  return name => name.includes(needle);
};

/** 預設專案：cwd 所在 repo 主 checkout 的目錄名（在 worktree 裡也取主 checkout），不在 git repo 時取 cwd 的目錄名。 */
export function defaultProject(cwd = process.cwd()) {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (common.status !== 0) return basename(resolve(cwd));
  const gitDir = resolve(cwd, common.stdout.trim());
  return basename(basename(gitDir) === '.git' ? dirname(gitDir) : gitDir.replace(/\.git$/, ''));
}
