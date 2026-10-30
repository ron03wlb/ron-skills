#!/usr/bin/env node
// 取 ADR 編號：README 的「下一個可用編號」只反映整合分支，進行中 worktree 已占用的編號要合併時才撞出來
// （曾有同一個編號同時被兩條分支使用，改號重合一次）。本腳本把整合分支與所有 worktree
// （已提交與未提交變更）占用的編號一起算，印出真正可用的下一號。唯讀。
//
// 用法：node scripts/adr-next.mjs [--json]（cwd 在 repo 任一 worktree）
// stdout 預設文字：第一行 `NEXT ADR-NNNN`；其後每筆占用一行 `CLAIMED ADR-NNNN <branch> <worktree>`；
//   自己 worktree 的編號與他人或整合分支重複時，每筆一行 `CONFLICT ADR-NNNN <對方>`。
//   --json 印 { integration, next, claims: [{ number, branch, worktree, self }], conflicts: [{ number, with }] }。
// exit code：0 無衝突、3 自己的編號有衝突、2 用法錯誤、1 git 失敗。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = '用法：node scripts/adr-next.mjs [--json]';
// 只認章節標題與 README 編號索引列；內文提到的 ADR-NNNN（如 superseded by）不算占用。
const NUMBER = /^(?:## ADR-(\d{4})|\| ADR-(\d{4}) \|)/;
// git grep -E 是 POSIX ERE，不認 \d。
const GREP = '^(## ADR-[0-9]{4}|\\| ADR-[0-9]{4} \\|)';

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}：${(result.stderr || '').trim()}`);
  return result.stdout.trimEnd();
}

/** 文字中各行宣告的 ADR 編號（數字）。 */
export function numbersIn(lines) {
  return lines.map(line => NUMBER.exec(line)).filter(Boolean).map(match => Number(match[1] ?? match[2]));
}

/**
 * 由各處事實算下一號與衝突；不碰 git。
 * @param {{ integrationNumbers: number[], integrationNext: number,
 *   trees: { path: string, branch: string|null, self: boolean, claimed: number[] }[] }} facts
 *   claimed 為該 worktree 相對整合分支 merge-base 新增、且 merge-base 尚未有的編號。
 */
export function plan({ integrationNumbers, integrationNext, trees }) {
  const claims = trees.flatMap(tree => tree.claimed.map(number => ({ number, branch: tree.branch, worktree: tree.path, self: tree.self })))
    .sort((a, b) => a.number - b.number);
  const others = claims.filter(claim => !claim.self);
  const next = Math.max(integrationNext, ...integrationNumbers.map(n => n + 1), ...others.map(claim => claim.number + 1));
  const conflicts = claims.filter(claim => claim.self).flatMap(claim => [
    ...(integrationNumbers.includes(claim.number) ? [{ number: claim.number, with: 'integration' }] : []),
    ...others.filter(other => other.number === claim.number).map(other => ({ number: claim.number, with: other.branch ?? other.worktree })),
  ]);
  return { next, claims, conflicts };
}

export const format = number => `ADR-${String(number).padStart(4, '0')}`;

export function collect(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  const worktrees = git(cwd, 'worktree', 'list', '--porcelain').split(/\n\n+/).filter(Boolean).map(block => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
  }));
  const integration = worktrees[0].branch;
  if (!integration) throw new Error(`主 worktree ${worktrees[0].path} 不在分支上（detached HEAD），無法判定整合分支`);
  const linesAt = (path, rev) => { try { return git(path, 'grep', '-h', '-E', GREP, rev, '--', 'docs/adr').split('\n'); } catch { return []; } };
  const integrationNumbers = numbersIn(linesAt(top, integration));
  const readme = git(top, 'show', `${integration}:docs/adr/README.md`);
  const integrationNext = Number(/下一個可用編號：\*\*ADR-(\d{4})\*\*/.exec(readme)?.[1] ?? 0);
  // 目錄已不存在的 worktree（待 prune）略過。
  const trees = worktrees.filter(tree => existsSync(tree.path)).map(tree => {
    // merge-base 對工作目錄的 diff 同時涵蓋已提交與未提交的追蹤檔；未追蹤的新概念檔另讀。
    const base = git(tree.path, 'merge-base', integration, 'HEAD');
    const added = git(tree.path, 'diff', '--unified=0', base, '--', 'docs/adr').split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1));
    const untracked = git(tree.path, 'ls-files', '--others', '--exclude-standard', '--', 'docs/adr').split('\n').filter(Boolean)
      .flatMap(file => readFileSync(join(tree.path, file), 'utf8').split('\n'));
    const existing = new Set(numbersIn(linesAt(tree.path, base)));
    const claimed = [...new Set(numbersIn([...added, ...untracked]))].filter(number => !existing.has(number));
    return { ...tree, self: tree.path === top, claimed };
  });
  return { integration, integrationNumbers, integrationNext, trees };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json')) { console.error(USAGE); process.exit(2); }
  try {
    const facts = collect(process.cwd());
    const { next, claims, conflicts } = plan(facts);
    if (args.includes('--json')) console.log(JSON.stringify({ integration: facts.integration, next: format(next), claims: claims.map(claim => ({ ...claim, number: format(claim.number) })), conflicts: conflicts.map(conflict => ({ ...conflict, number: format(conflict.number) })) }, null, 2));
    else {
      console.log(`NEXT ${format(next)}`);
      for (const claim of claims) console.log(`CLAIMED ${format(claim.number)} ${claim.branch ?? '(detached)'} ${claim.worktree}${claim.self ? ' (self)' : ''}`);
      for (const conflict of conflicts) console.log(`CONFLICT ${format(conflict.number)} ${conflict.with}`);
    }
    process.exit(conflicts.length ? 3 : 0);
  } catch (error) { console.error(`查詢中止：${error.message}`); process.exit(1); }
}
