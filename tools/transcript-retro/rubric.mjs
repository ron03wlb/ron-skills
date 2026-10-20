// 取得 skill 文件在某個時間點的版本，讓舊 session 以當時的規則評分，而不是今天的規則。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function resolveSkillFile(name, override) {
  const candidates = [
    override,
    path.join(os.homedir(), '.claude', 'skills', name, 'SKILL.md'),
    path.join(process.cwd(), '.claude', 'skills', name, 'SKILL.md'),
  ].filter(Boolean);
  const hit = candidates.find((f) => fs.existsSync(f));
  if (!hit) throw new Error(`找不到 skill「${name}」的 SKILL.md；請用 --skill-path 指定`);
  return fs.realpathSync(hit);
}

function locate(file) {
  const real = fs.realpathSync(file);
  const top = git(path.dirname(real), ['rev-parse', '--show-toplevel']);
  return { real, top, rel: top ? path.relative(top, real) : '' };
}

// 回傳 { sha, text }；檔案不在 git 或當時尚未存在時，sha 為 'current'，內容用目前版本
export function versionAt(file, isoTs) {
  const { real, top, rel } = locate(file);
  if (top) {
    const sha = git(top, ['log', '-1', '--format=%h', `--before=${isoTs}`, '--', rel]);
    if (sha) {
      const text = git(top, ['show', `${sha}:${rel}`]);
      if (text) return { sha, text };
    }
    // session 早於第一次 commit：用最早的版本，並在 sha 標明
    const first = git(top, ['log', '--format=%h', '--reverse', '--', rel]).split('\n')[0];
    if (first) {
      const text = git(top, ['show', `${first}:${rel}`]);
      if (text) return { sha: `before-${first}`, text };
    }
  }
  return { sha: 'current', text: fs.readFileSync(real, 'utf8') };
}

// repo 自某日以來的非 merge commit 標題，讓彙整步驟判斷問題是否已被後來的 commit 修正
export function commitLog(repo, since) {
  const log = git(repo, ['log', '--no-merges', `--since=${since}`, '--format=%h %ad %s', '--date=short']);
  return `### ${repo}\n${log || '（無 commit）'}`;
}

export function historyOf(file) {
  const { top, rel } = locate(file);
  if (!top) return '（不在 git 中，無歷史）';
  return git(top, ['log', '--format=%h %ad %s', '--date=short', '--', rel]) || '（無歷史）';
}
