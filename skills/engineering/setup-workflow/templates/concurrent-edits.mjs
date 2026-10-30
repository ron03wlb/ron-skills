#!/usr/bin/env node
// 開工前查併行編輯：列出其他 worktree 對指定檔案的未合入變更（已提交與未提交），以及整合分支自 base 以來動到這些檔案的 commit。
// 同檔有人在改就先合上或放棄自己的，不要落地重複的修改。唯讀。
// 用法：node scripts/concurrent-edits.mjs [--base <sha>] [--json] <file>...  （cwd 在 repo 任一 worktree；--base 預設為目前 HEAD 與整合分支的 merge-base）
// stdout 預設文字：每筆一行 `<kind> <who> <file> [<detail>]`；kind：COMMITTED（他人分支已提交）、UNCOMMITTED（他人 worktree 工作目錄）、INTEGRATION（整合分支 base 之後的 commit）。
//   無任何命中時印 `CLEAR`。--json 印 { integration, base, hits: [{ kind, worktree, branch, file, detail }] }。
// exit code：0 無命中、3 有命中、2 用法錯誤、1 git 失敗。
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const USAGE = '用法：node scripts/concurrent-edits.mjs [--base <sha>] [--json] <file>...';

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}：${(result.stderr || '').trim()}`);
  return result.stdout.trimEnd();
}

/** `git worktree list --porcelain` → [{ path, branch }]；第一筆是主 worktree，其分支即整合分支。 */
export function parseWorktrees(porcelain) {
  return porcelain.split(/\n\n+/).filter(Boolean).map(block => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
  }));
}

/**
 * 由各處事實算命中；不碰 git。
 * @param {{ files: string[], self: string, integration: string,
 *   worktrees: { path: string, branch: string|null, committed: string[], uncommitted: string[] }[],
 *   integrationCommits: { sha: string, subject: string, files: string[] }[] }} facts
 */
export function findHits({ files, self, integration, worktrees, integrationCommits }) {
  const wanted = new Set(files);
  const hits = [];
  for (const tree of worktrees) {
    if (tree.path === self) continue;
    for (const file of tree.committed.filter(file => wanted.has(file))) hits.push({ kind: 'COMMITTED', worktree: tree.path, branch: tree.branch, file, detail: `${tree.branch} 已提交、未合入 ${integration}` });
    for (const file of tree.uncommitted.filter(file => wanted.has(file))) hits.push({ kind: 'UNCOMMITTED', worktree: tree.path, branch: tree.branch, file, detail: '工作目錄有未提交變更' });
  }
  for (const commit of integrationCommits) {
    for (const file of commit.files.filter(file => wanted.has(file))) hits.push({ kind: 'INTEGRATION', worktree: null, branch: integration, file, detail: `${commit.sha.slice(0, 9)} ${commit.subject}` });
  }
  return hits;
}

export function parseArgs(args) {
  const options = { base: null, json: false, files: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') options.json = true;
    else if (args[i] === '--base') { if (!args[i + 1]) return null; options.base = args[++i]; }
    else if (args[i].startsWith('--')) return null;
    else options.files.push(args[i]);
  }
  return options.files.length ? options : null;
}

export function collect(cwd, options) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  const files = options.files.map(file => relative(top, resolve(cwd, file)).replaceAll('\\', '/'));
  const worktrees = parseWorktrees(git(cwd, 'worktree', 'list', '--porcelain'));
  const integration = worktrees[0].branch;
  if (!integration) throw new Error(`主 worktree ${worktrees[0].path} 不在分支上（detached HEAD），無法判定整合分支`);
  const base = options.base ?? git(cwd, 'merge-base', 'HEAD', integration);
  const list = (path, ...args) => { try { return git(path, ...args).split('\n').filter(Boolean); } catch { return []; } };
  const trees = worktrees.map(tree => ({
    ...tree,
    committed: tree.branch && tree.branch !== integration ? list(tree.path, 'diff', '--name-only', `${integration}...${tree.branch}`) : [],
    uncommitted: list(tree.path, 'status', '--porcelain').map(line => line.slice(3).split(' -> ').at(-1)),
  }));
  const integrationCommits = list(cwd, 'log', '--format=%H%x00%s', '--name-only', `${base}..${integration}`, '--', ...files)
    .reduce((commits, line) => {
      if (line.includes('\0')) { const [sha, subject] = line.split('\0'); commits.push({ sha, subject, files: [] }); } else commits.at(-1)?.files.push(line);
      return commits;
    }, []);
  return { files, self: top, integration, base, worktrees: trees, integrationCommits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) { console.error(USAGE); process.exit(2); }
  try {
    const facts = collect(process.cwd(), options);
    const hits = findHits(facts);
    if (options.json) console.log(JSON.stringify({ integration: facts.integration, base: facts.base, hits }, null, 2));
    else if (!hits.length) console.log('CLEAR');
    else for (const hit of hits) console.log([hit.kind, hit.worktree ?? hit.branch, hit.file, hit.detail].filter(Boolean).join(' '));
    process.exit(hits.length ? 3 : 0);
  } catch (error) { console.error(`查詢中止：${error.message}`); process.exit(1); }
}
