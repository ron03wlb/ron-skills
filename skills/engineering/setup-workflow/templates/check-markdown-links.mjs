#!/usr/bin/env node
// 檢查 repo 內 Markdown 的本地相對連結與 #anchor（含檔首 frontmatter 清單中的 .md 路徑）；外部 URL 不連線。
// docs/archive/ 為凍結歷史文件：其來源檔不檢查；archive 以外指向 archive 的連結照常檢查。
// Anchor 接受 <a id>/<a name>、GitLab heading slug，以及 docs site reader 的 slugify。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('GIT_QUERY_FAILED');
  return result.stdout;
}
function proseLines(text) {
  const lines = []; let fence = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (!fence) lines.push([index + 1, line]);
  });
  return lines;
}
const gitlabSlug = (heading) => heading.replace(/`/g, '').replace(/<[^>]+>/g, '').trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
const readerSlug = (heading) => heading.replace(/`([^`]+)`/g, '$1').replace(/<[^>]+>/g, '').toLocaleLowerCase('en')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
const anchorCache = new Map();
function anchorsOf(path) {
  if (anchorCache.has(path)) return anchorCache.get(path);
  const anchors = new Set(); const gitlabSeen = new Map(); const readerSeen = new Map();
  for (const [, line] of proseLines(readFileSync(path, 'utf8'))) {
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const g = gitlabSlug(heading[1]); const gn = gitlabSeen.get(g) ?? 0; gitlabSeen.set(g, gn + 1); anchors.add(gn ? `${g}-${gn}` : g);
    const r = readerSlug(heading[1]); const rn = (readerSeen.get(r) ?? 0) + 1; readerSeen.set(r, rn); anchors.add(rn === 1 ? r : `${r}-${rn}`);
  }
  anchorCache.set(path, anchors);
  return anchors;
}
function decode(value) { try { return decodeURIComponent(value); } catch { return value; } }
// 檔首 YAML frontmatter 的清單項目若是本地 .md 路徑（如 source_documents），與連結一樣檢查檔案與 #anchor。
function frontmatterPaths(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return [];
  const paths = [];
  for (let index = 1; index < lines.length && lines[index] !== '---'; index++) {
    const item = /^\s*-\s+(\S+\.md(?:#\S+)?)\s*$/.exec(lines[index]);
    if (item) paths.push([index + 1, item[1]]);
  }
  return paths;
}

try {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md']).split('\0')
    .filter(Boolean).filter((path) => !path.startsWith('docs/archive/') && existsSync(join(root, path))).sort();
  let failed = false; let links = 0;
  for (const path of files) {
    const absolute = join(root, path);
    const content = readFileSync(absolute, 'utf8');
    const hrefs = frontmatterPaths(content);
    for (const [line, text] of proseLines(content)) {
      for (const match of text.replace(/`[^`]*`/g, '').matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) hrefs.push([line, match[1]]);
    }
    for (const [line, href] of hrefs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
      links++;
      const [filePart, anchor] = href.split('#', 2);
      const target = filePart ? normalize(join(dirname(absolute), decode(filePart))) : absolute;
      let error = null;
      if (relative(root, target).split(sep)[0] === '..') error = 'OUTSIDE_REPO';
      else if (!existsSync(target)) error = 'MISSING_FILE';
      else if (anchor && target.endsWith('.md') && statSync(target).isFile() && !anchorsOf(target).has(decode(anchor))) error = 'MISSING_ANCHOR';
      if (error) { console.error(JSON.stringify({ path, line, href, error })); failed = true; }
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`Markdown 連結檢查通過（${files.length} 個檔案、${links} 個本地連結）。`);
} catch {
  console.error(JSON.stringify({ error: 'MARKDOWN_LINK_SCAN_FAILED' })); process.exitCode = 1;
}
