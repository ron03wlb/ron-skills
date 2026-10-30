#!/usr/bin/env node
// 從 docs/workflow/*.md 產出帶左側側邊欄的靜態站 docs/workflow/site/（#8）。
// Markdown 是唯一來源：README.md 為首頁，NN-*.md 依檔名排序為章節；章內的 PNG 預覽若有同名互動 HTML（diagrams/<name>.html）
// 就改以 iframe 內嵌。輸出不含時間戳與環境資訊，重產必須零 diff；`--check` 在 OS 暫存目錄重產並與 site/ 比對，有差異即以 1 退出。
// 只用 Node 內建模組；Markdown 只支援本資料夾用到的子集（標題、段落、表格、清單、程式碼區塊、引言、連結、圖片、粗斜體、行內程式碼）。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE = resolve(scriptDir, '..', 'docs', 'workflow');
export const SITE_DIR = 'site';
export const BUILD_COMMAND = 'node scripts/build-workflow-site.mjs';
export const SITE_NAME = 'ron-skills 交付流程';
/** 側邊欄底部的「正式規範」外連：相對於 docs/workflow/，產站時再換算成相對於 site/。 */
const FORMAL_RULES = [
  ['README.md', '../../README.md'],
  ['skills/engineering/issue-run/ADAPTER.md', '../../skills/engineering/issue-run/ADAPTER.md'],
];

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(text) {
  return text.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
}

/**
 * 把 Markdown 內的相對路徑換算成 site/ 內的 href：章節 .md → 同名 .html、README.md → index.html；
 * 其餘相對路徑（diagrams/、../agents/ 等）因 site/ 深一層而加上 ../；外部 URL 與 #anchor 原樣保留。
 */
export function rewriteHref(href, chapters) {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) return href;
  const [path, hash = ''] = href.split('#');
  const anchor = hash ? `#${hash}` : '';
  if (!path) return anchor;
  if (path === 'README.md') return `index.html${anchor}`;
  const chapter = chapters.find((item) => item.file === path);
  if (chapter) return `${chapter.stem}.html${anchor}`;
  return `../${path}${anchor}`;
}

function renderInline(text, chapters) {
  const tokens = [];
  const hold = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let out = text.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => hold(`<img src="${escapeHtml(rewriteHref(src, chapters))}" alt="${escapeHtml(alt)}" loading="lazy">`));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const target = rewriteHref(href, chapters);
    const external = /^(?:[a-z]+:|\/\/)/i.test(target);
    // 連結文字內的行內程式碼已先換成佔位符，最後統一還原（巢狀佔位符逐層展開）。
    return hold(`<a href="${escapeHtml(target)}"${external ? ' rel="noopener" target="_blank"' : ''}>${styled(label)}</a>`);
  });
  out = styled(out);
  while (/\u0000\d+\u0000/.test(out)) out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  return out;
}

/** 跳脫 HTML 並套用粗體／斜體；佔位符（\u0000n\u0000）原樣保留。 */
function styled(text) {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*]+)\*(?!\w)/g, '$1<em>$2</em>');
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** 章內圖片：有同名互動 HTML 時內嵌 iframe，並附全頁開啟連結；否則只放 PNG。 */
function renderFigure(alt, src, chapters, diagrams) {
  const name = basename(src).replace(/\.[^.]+$/, '');
  const diagram = diagrams.find((item) => item.name === name);
  const image = `<img src="${escapeHtml(rewriteHref(src, chapters))}" alt="${escapeHtml(alt)}" loading="lazy">`;
  if (!diagram) return `<figure>${image}<figcaption>${escapeHtml(alt)}</figcaption></figure>`;
  const href = escapeHtml(rewriteHref(diagram.href, chapters));
  return `<figure class="diagram" id="diagram-${escapeHtml(name)}"><iframe src="${href}" title="${escapeHtml(diagram.title)}" loading="lazy"></iframe>`
    + `<figcaption>${escapeHtml(alt)}（互動圖：可切換主題、搜尋節點；<a href="${href}" target="_blank" rel="noopener">全頁開啟</a>）</figcaption></figure>`;
}

/** 最小 Markdown → HTML；回傳 { html, title, headings }。 */
export function renderMarkdown(markdown, chapters, diagrams) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const seen = new Map();
  let title = '';
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${renderInline(paragraph.join(' '), chapters)}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { flush(); index += 1; continue; }
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      index += 1;
      out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const base = slugify(heading[2]);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const id = count === 1 ? base : `${base}-${count}`;
      if (level === 1 && !title) { title = heading[2]; index += 1; continue; }
      if (level === 2) headings.push({ id, text: heading[2] });
      out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(heading[2], chapters)}</h${level}>`);
      index += 1;
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (image) { flush(); out.push(renderFigure(image[1], image[2], chapters, diagrams)); index += 1; continue; }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      flush();
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      const cell = (tag, value) => `<${tag}>${renderInline(value, chapters)}</${tag}>`;
      out.push(`<div class="table-wrap"><table><thead><tr>${headers.map((h) => cell('th', h)).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => cell('td', v)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      flush();
      // 以縮排層級建立巢狀清單；同一層內以第一個項目決定有序或無序。
      const stack = [];
      // 巢狀清單放進上一個 <li> 內：開啟時先拿掉它的 </li>，關閉時補回。
      const open = (indent, ordered) => {
        if (stack.length) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '');
        out.push(ordered ? '<ol>' : '<ul>');
        stack.push({ indent, ordered });
      };
      const close = () => { const { ordered } = stack.pop(); out.push(`${ordered ? '</ol>' : '</ul>'}${stack.length ? '</li>' : ''}`); };
      while (index < lines.length) {
        const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[index]);
        if (!item) {
          // 清單項目的續行（縮排且非空白）併入上一項。
          if (lines[index].trim() && /^\s{2,}/.test(lines[index]) && stack.length) {
            out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${renderInline(lines[index].trim(), chapters)}</li>`);
            index += 1;
            continue;
          }
          break;
        }
        const indent = item[1].length;
        const ordered = /\d/.test(item[2]);
        while (stack.length && indent < stack[stack.length - 1].indent) close();
        if (!stack.length || indent > stack[stack.length - 1].indent) open(indent, ordered);
        out.push(`<li>${renderInline(item[3], chapters)}</li>`);
        index += 1;
      }
      while (stack.length) close();
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${renderInline(quote.join(' '), chapters)}</p></blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return { html: out.join('\n'), title, headings };
}

function readTitle(html, fallback) {
  const match = /<title>([^<]*)<\/title>/i.exec(html);
  return match ? match[1].trim() : fallback;
}

/** 讀取來源資料夾：章節（README 為首頁）與 diagrams/*.html。 */
export function collect(sourceDir) {
  const files = readdirSync(sourceDir).filter((name) => /^\d{2}-.+\.md$/.test(name)).sort();
  const chapters = files.map((file) => ({ file, stem: file.replace(/\.md$/, ''), markdown: readFileSync(join(sourceDir, file), 'utf8') }));
  const diagramDir = join(sourceDir, 'diagrams');
  let diagrams = [];
  try {
    diagrams = readdirSync(diagramDir).filter((name) => name.endsWith('.html')).sort().map((name) => ({
      name: name.replace(/\.html$/, ''),
      href: `diagrams/${name}`,
      title: readTitle(readFileSync(join(diagramDir, name), 'utf8'), name),
    }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const readme = readFileSync(join(sourceDir, 'README.md'), 'utf8');
  return { chapters, diagrams, readme };
}

function sidebar({ chapters, diagrams, titles }, current) {
  const link = (href, text, active) => `<a href="${escapeHtml(href)}"${active ? ' aria-current="page"' : ''}>${escapeHtml(text)}</a>`;
  const chapterLinks = [link('index.html', titles.get('index'), current === 'index')]
    .concat(chapters.map((chapter) => link(`${chapter.stem}.html`, titles.get(chapter.stem), current === chapter.stem)));
  const diagramLinks = diagrams.map((diagram) => `<a href="${escapeHtml(rewriteHref(diagram.href, chapters))}" target="_blank" rel="noopener">${escapeHtml(diagram.title)}</a>`);
  const ruleLinks = FORMAL_RULES.map(([text, href]) => `<a href="${escapeHtml(rewriteHref(href, chapters))}">${escapeHtml(text)}</a>`);
  return `<aside class="sidebar" id="sidebar" aria-label="流程導讀目錄">
<nav class="chapters" aria-label="章節"><h2>章節</h2>${chapterLinks.join('')}</nav>
<nav class="diagrams" aria-label="圖"><h2>圖（全頁開啟）</h2>${diagramLinks.join('')}</nav>
<nav class="rules" aria-label="正式規範"><h2>正式規範（原始 Markdown）</h2>${ruleLinks.join('')}</nav>
</aside>`;
}

function page(context, current, title, body) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}｜${SITE_NAME}</title>
<link rel="stylesheet" href="static/site.css">
<script defer src="static/site.js"></script>
</head>
<body>
<button class="sidebar-toggle" type="button" aria-controls="sidebar" aria-expanded="false">目錄</button>
${sidebar(context, current)}
<main class="content">
<article>
<h1>${escapeHtml(title)}</h1>
${body}
</article>
<footer class="source">本頁由 <code>${BUILD_COMMAND}</code> 自 <code>docs/workflow/${escapeHtml(current === 'index' ? 'README.md' : `${current}.md`)}</code> 產生；請改 Markdown 重產，不要手改 HTML。</footer>
</main>
</body>
</html>
`;
}

const CSS = `:root{--ink:#243044;--muted:#5c687c;--line:#d7dce4;--paper:#f6f8fb;--panel:#fff;--link:#275ca8;--accent:#17735c;--accent-bg:#e8f4f0;--code-bg:#eef1f5}
@media(prefers-color-scheme:dark){:root{--ink:#e6eaf0;--muted:#a3adbd;--line:#3a4352;--paper:#161a21;--panel:#1f242d;--link:#8ab4f8;--accent:#5ccfa6;--accent-bg:#1e3a31;--code-bg:#2a303b}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 system-ui,"Microsoft JhengHei","Noto Sans TC",sans-serif}
a{color:var(--link)}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;background:var(--code-bg);padding:.08em .35em;border-radius:4px}
pre{overflow:auto;padding:14px;background:var(--code-bg);border:1px solid var(--line);border-radius:8px}pre code{background:none;padding:0}
.sidebar{position:fixed;top:0;left:0;bottom:0;width:300px;overflow:auto;padding:24px 20px;background:var(--panel);border-right:1px solid var(--line)}
.sidebar h2{margin:18px 0 8px;font-size:.78rem;font-weight:800;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
.sidebar nav{display:grid;gap:4px}.sidebar nav a{display:block;padding:.4rem .6rem;border-radius:6px;text-decoration:none;font-size:.92rem;overflow-wrap:anywhere}
.sidebar nav a:hover{background:var(--accent-bg)}.sidebar nav a[aria-current=page]{background:var(--accent-bg);color:var(--accent);font-weight:700}
.content{margin-left:300px;padding:32px 40px 64px;max-width:1180px}article>h1{margin-top:0;font-size:clamp(1.8rem,4vw,2.6rem);line-height:1.2}
h2{margin-top:2.2rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}h3{margin-top:1.8rem}p,li{max-width:90ch;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;margin:16px 0;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{padding:.55rem .7rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--code-bg);white-space:nowrap}tr:last-child td{border-bottom:0}
figure{margin:24px 0;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px}figure img{display:block;width:100%;height:auto}
figure.diagram iframe{display:block;width:100%;height:min(78vh,760px);border:0;border-radius:4px;background:#fff}figcaption{margin-top:8px;color:var(--muted);font-size:.88rem}
blockquote{margin:16px 0;padding:8px 16px;border-left:4px solid var(--accent);background:var(--panel)}
.source{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
.sidebar-toggle{display:none;position:fixed;top:12px;left:12px;z-index:3;padding:.5rem .9rem;font:inherit;font-weight:700;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px}
@media(max-width:900px){.sidebar{transform:translateX(-100%);transition:transform .2s;z-index:2;width:min(86vw,320px)}body.sidebar-open .sidebar{transform:none;box-shadow:0 0 0 100vw rgba(0,0,0,.35)}.sidebar-toggle{display:block}.content{margin-left:0;padding:64px 18px 48px}}
`;

const JS = `(() => {
  const toggle = document.querySelector('.sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;
  const set = (open) => { document.body.classList.toggle('sidebar-open', open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', () => set(!document.body.classList.contains('sidebar-open')));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') set(false); });
  sidebar.addEventListener('click', (event) => { if (event.target.closest('a') && matchMedia('(max-width: 900px)').matches) set(false); });
})();
`;

/** 產出所有頁面到記憶體：{ 'index.html': ..., '01-tooling.html': ..., 'static/site.css': ..., 'static/site.js': ... }。 */
export function buildSite(sourceDir = DEFAULT_SOURCE) {
  const { chapters, diagrams, readme } = collect(sourceDir);
  const rendered = new Map();
  const titles = new Map();
  const home = renderMarkdown(readme, chapters, diagrams);
  rendered.set('index', home);
  titles.set('index', home.title || SITE_NAME);
  for (const chapter of chapters) {
    const result = renderMarkdown(chapter.markdown, chapters, diagrams);
    rendered.set(chapter.stem, result);
    titles.set(chapter.stem, result.title || chapter.stem);
  }
  const context = { chapters, diagrams, titles };
  const files = { 'static/site.css': CSS, 'static/site.js': JS };
  for (const [stem, result] of rendered) files[`${stem}.html`] = page(context, stem, titles.get(stem), result.html);
  return files;
}

function writeSite(files, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(outDir, name)), { recursive: true });
    writeFileSync(join(outDir, name), content, 'utf8');
  }
}

function listFiles(dir, prefix = '') {
  let names = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(path).isDirectory()) names = names.concat(listFiles(path, rel));
    else names.push(rel);
  }
  return names;
}

/** 比對 site/ 與重產結果；回傳有差異的相對路徑清單（缺少、多出或內容不同）。 */
export function diffSite(files, siteDir) {
  let existing = [];
  try { existing = listFiles(siteDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expected = Object.keys(files).sort();
  const changed = new Set();
  for (const name of expected) {
    let current = null;
    try { current = readFileSync(join(siteDir, name), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== files[name]) changed.add(name);
  }
  for (const name of existing) if (!(name in files)) changed.add(name);
  return [...changed].sort();
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const sourceArg = argv.find((arg) => arg.startsWith('--source='));
  const sourceDir = sourceArg ? resolve(sourceArg.slice('--source='.length)) : DEFAULT_SOURCE;
  const siteDir = join(sourceDir, SITE_DIR);
  const files = buildSite(sourceDir);
  if (!check) {
    writeSite(files, siteDir);
    process.stdout.write(`已產出 ${Object.keys(files).length} 個檔案到 ${relative(process.cwd(), siteDir) || '.'}\n`);
    return 0;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'workflow-site-'));
  try {
    writeSite(files, tmp); // 確認寫檔路徑可行；比對仍以記憶體內容為準。
    const changed = diffSite(files, siteDir);
    if (!changed.length) { process.stdout.write('docs/workflow/site 與 Markdown 同步。\n'); return 0; }
    process.stderr.write(`docs/workflow/site 與 Markdown 不同步（請執行 ${BUILD_COMMAND} 重產，不要手改 HTML）：\n${changed.map((name) => `  ${name}`).join('\n')}\n`);
    return 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
