#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 開工前查併行編輯：列出其他 worktree 對指定檔案的未合入變更（已提交與未提交），以及整合分支自 base 以來動到這些檔案的 commit。
// 同檔有人在改就先合上或放棄自己的，不要落地重複的修改。唯讀。
// 用法：node scripts/concurrent-edits.mjs [--base <sha>] [--json] <file>...  （cwd 在 repo 任一 worktree；--base 預設為目前 HEAD 與整合分支的 merge-base）
// stdout 預設文字：每筆一行 `<kind> <who> <file> [<detail>]`；kind：COMMITTED（他人分支已提交）、UNCOMMITTED（他人 worktree 工作目錄）、INTEGRATION（整合分支 base 之後的 commit）。
//   無任何命中時印 `CLEAR`。--json 印 { integration, base, hits: [{ kind, worktree, branch, file, detail }], templateCopies: [{ file, template }] }。
// 指定檔案是 repo 的 docs/agents/workflow-templates.json（copy-templates.mjs 的副本清單）列出的副本時，先依輸入順序各印一行
//   `TEMPLATE_COPY <file> <template>` 與下一步（同 worktree-overlap.mjs；沒有清單或讀不懂時不印，不改 exit code）。看到這行不要直接改副本：
//   改 ron-skills 正本 → 在 ron-skills 跑 copy-templates.mjs --staged 帶回它自己的副本 → ron-skills commit 並 push → 再 copy 到這個 worktree。
//   否則 ron-skills pre-commit 報 CHECK_FAIL docs-rules、這邊 check-template-copies 報不一致（retro spay2 ddc8bd0e#1：舊版對副本只印 CLEAR）。
//   正本不在本 repo（consumer）時再印 `  開上游單前：<copy-templates --dry-run 指令>…`：SAME 才用範本重現、可能開上游 ron-skills 單，
//   UPDATE（副本落後）、DIFF（被手改）先同步副本；範本是 PreToolUse Bash hook 時多一行 `  hook 類：…`，把 fixture 送過範本每支 PreToolUse Bash hook，
//   有一支已 exit 2 就同步那支（#503：兩次開出範本早已修好的單，另一次真正擋住的是另一支 hook 範本）。
//   清單 `localExceptions`（copy-templates 不覆蓋的本地例外）涵蓋的 scripts/ 下檔案，也印 `TEMPLATE_COPY <file> <template>`（<template> 依 copy-templates 的
//   對應：scripts/<x> ↔ templates/<x>），接一行 `  來源：<template>（…localExceptions 列了 <例外>…）`，不印下一步與開上游單前（例外不能 copy，
//   copy-templates 明列被排除的正本會報錯）；--json 的這筆多帶 `localException: <例外>`。copies 有的檔照 copies，輸出不變（#553：git-bypass
//   移到 localExceptions 後，改這支暫留舊檔沒有提示，本地修補在拿掉例外重新複製時無聲消失）。localExceptions 讀不懂時當作沒有。
// exit code：0 無命中、3 有命中、2 用法錯誤、1 git 失敗。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

const MANIFEST = 'docs/agents/workflow-templates.json';
const TEMPLATES = 'skills/engineering/setup-workflow/templates/';

/** localExceptions 的路徑以 templates/ 為根（同 copy-templates.mjs 的 templatePath）：去掉 ./ 與 scripts/ 前綴及結尾的 /。 */
const templatePath = path => path.replace(/^(\.\/)?(scripts\/)?/, '').replace(/\/+$/, '');

/** 副本路徑 scripts/<x> 被哪一條 localExceptions 涵蓋（檔案本身或其上層目錄）；沒有時 undefined。 */
function exceptionFor(file, localExceptions) {
  if (!file.startsWith('scripts/') || !Array.isArray(localExceptions)) return undefined;
  const name = file.slice('scripts/'.length);
  return localExceptions.find(entry => typeof entry === 'string' && templatePath(entry)
    && (name === templatePath(entry) || name.startsWith(`${templatePath(entry)}/`)));
}

/**
 * `files`（相對 repo 根）中是副本清單 `copies` 列出的副本 → [{ file, template }]，依輸入順序；
 * copies 沒有、但在 `localExceptions` 涵蓋內的 scripts/ 檔 → [{ file, template, localException }]（#553）。
 */
export function findTemplateCopies(files, copies, localExceptions) {
  return files.flatMap(file => {
    if (copies?.[file]?.template) return [{ file, template: copies[file].template }];
    const localException = exceptionFor(file, localExceptions);
    return localException === undefined ? [] : [{ file, template: `${TEMPLATES}${file.slice('scripts/'.length)}`, localException }];
  });
}

/** 範本裡掛在 `PreToolUse` matcher `Bash` 的 hook（setup-workflow SKILL.md 的表）；hook 類問題要把 fixture 送過每一支。 */
const PRE_TOOL_USE_BASH_HOOKS = ['zsh-equals', 'bash-pitfalls', 'git-bypass', 'main-checkout'];

/**
 * consumer 為副本開上游 ron-skills 單之前的比對（#503：兩次開出範本早已修好的單，另一次真正擋住的是另一支 PreToolUse hook 範本）。
 * copy-templates --dry-run 對每個副本印 SAME（與範本相同）／UPDATE（與清單 sha256 相同的舊版）／DIFF（被手改）。
 */
function upstreamCheckLines(names) {
  const lines = [`  開上游單前：node <ron-skills>/skills/engineering/setup-workflow/scripts/copy-templates.mjs <本 worktree> --dry-run --no-tests ${names.join(' ')}`
    + '（<ron-skills> 先更新到 origin/main）；SAME 才用範本重現、可能是上游問題；UPDATE（副本落後）或 DIFF（副本的 sha256 和 workflow-templates.json 記的不同，被手改過）'
    + '先在本 repo 重跑 copy-templates 同步再重現，不開上游單'];
  if (names.some(name => PRE_TOOL_USE_BASH_HOOKS.some(hook => name === `claude-hook-${hook}.mjs`))) {
    lines.push(`  hook 類：把重現的 fixture 送過範本每支 PreToolUse Bash hook：for h in ${PRE_TOOL_USE_BASH_HOOKS.join(' ')}; do`
      + ' node <ron-skills>/skills/engineering/setup-workflow/templates/claude-hook-$h.mjs < <fixture.json>; echo "$h exit=$?"; done'
      + '；有一支已 exit 2 就是本 repo 該同步（或裝上）那支，不開上游單');
  }
  return lines;
}

/**
 * TEMPLATE_COPY 行與下一步；<x> 是 copy-templates.mjs 接受的範本名（templates/ 下的路徑）。
 * 給了 repo 根目錄 `top` 而正本就在 top 裡（本 repo 是 ron-skills）時，不印開上游單前的比對。
 */
export function templateCopyLines({ file, template, localException }, top) {
  if (localException !== undefined) return [`TEMPLATE_COPY ${file} ${template}`, localExceptionLine(template, localException)];
  const name = template.startsWith(TEMPLATES) ? template.slice(TEMPLATES.length) : template;
  return [
    `TEMPLATE_COPY ${file} ${template}`,
    `  下一步：改 ron-skills 正本 → node skills/engineering/setup-workflow/scripts/copy-templates.mjs <ron-skills> --no-tests --yes --staged ${name}`
      + ` → ron-skills commit 並 push → node <ron-skills>/skills/engineering/setup-workflow/scripts/copy-templates.mjs <本 worktree> --no-tests --yes ${name}`,
    ...(top && existsSync(join(top, template)) ? [] : upstreamCheckLines([name])),
  ];
}

/** localExceptions 內的檔沒有來源行、copy-templates 也不覆蓋：指出正本，提醒本地修補在拿掉例外重新複製時會被蓋掉（#553）。 */
function localExceptionLine(template, localException) {
  return `  來源：${template}（workflow-templates.json 的 localExceptions 列了 ${localException}，copy-templates 不覆蓋這個檔；`
    + '拿掉例外重新複製時本地修補會被正本蓋掉，要留的修補先改正本）';
}

function readManifest(top) {
  try { return JSON.parse(readFileSync(join(top, MANIFEST), 'utf8')) ?? {}; } catch { return {}; }
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
  const manifest = readManifest(top);
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
  return { files, self: top, integration, base, worktrees: trees, integrationCommits, templateCopies: findTemplateCopies(files, manifest.copies, manifest.localExceptions) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) { console.error(USAGE); process.exit(2); }
  try {
    const facts = collect(process.cwd(), options);
    const hits = findHits(facts);
    if (options.json) console.log(JSON.stringify({ integration: facts.integration, base: facts.base, hits, templateCopies: facts.templateCopies }, null, 2));
    else {
      for (const line of facts.templateCopies.flatMap(copy => templateCopyLines(copy, facts.self))) console.log(line);
      if (!hits.length) console.log('CLEAR');
      else for (const hit of hits) console.log([hit.kind, hit.worktree ?? hit.branch, hit.file, hit.detail].filter(Boolean).join(' '));
    }
    process.exit(hits.length ? 3 : 0);
  } catch (error) { console.error(`查詢中止：${error.message}`); process.exit(1); }
}
