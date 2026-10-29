// 把文章（Markdown / HTML / Word）解析成：标题 + 适合粘贴进X编辑器的HTML + 图片列表 + 封面
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { marked } from 'marked';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export class ArticleError extends Error {}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// marked 的 text / escape 词元里的文字已经转义过，先还原再转义，避免出现 &amp;quot;
function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// 占位行：先随正文一起粘贴，之后逐个替换成真正上传的图片
export function imageMarker(n) {
  return `XAFIMG${String(n).padStart(3, '0')}XAF`;
}

// 读取图片宽高比（PNG / JPEG / GIF），读不出返回 0
function aspect(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.readUInt32BE(0) === 0x89504e47) return b.readUInt32BE(16) / b.readUInt32BE(20);
    if (b.toString('ascii', 0, 3) === 'GIF') return b.readUInt16LE(6) / b.readUInt16LE(8);
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return b.readUInt16BE(i + 7) / b.readUInt16BE(i + 5);
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* 读不出就当 0 */ }
  return 0;
}

// ---------- 读取不同格式，统一成 Markdown ----------

async function htmlToMarkdown(html) {
  const { default: TurndownService } = await import('turndown');
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  return td.turndown(html);
}

async function docxToMarkdown(file) {
  const mammoth = (await import('mammoth')).default;
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-article-fill-docx-'));
  let count = 0;
  const result = await mammoth.convertToHtml(
    { path: file },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        count += 1;
        const ext = (image.contentType.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const out = path.join(imgDir, `image-${count}.${ext}`);
        fs.writeFileSync(out, await image.read());
        return { src: out };
      }),
    },
  );
  return htmlToMarkdown(result.value);
}

async function readAsMarkdown(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.md', '.markdown', '.txt', ''].includes(ext)) return fs.readFileSync(file, 'utf8');
  if (['.html', '.htm'].includes(ext)) return htmlToMarkdown(fs.readFileSync(file, 'utf8'));
  if (ext === '.docx') return docxToMarkdown(file);
  throw new ArticleError(`不支持的文章格式：${ext}（支持 .md .markdown .txt .html .htm .docx）`);
}

// ---------- Markdown → X编辑器能识别的HTML ----------

function resolveImage(href, baseDir) {
  if (/^https?:\/\//i.test(href)) {
    throw new ArticleError(`暂不支持网络图片，请先下载到本地：${href}`);
  }
  let p = href.replace(/^file:\/\//i, '');
  try { p = decodeURI(p); } catch { /* 保留原样 */ }
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

function renderInline(tokens, ctx) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
        // 中文写作里单个换行通常就是想换行，保留下来（否则粘贴后几行会并成一行）
        out += t.tokens ? renderInline(t.tokens, ctx) : escapeHtml(unescapeHtml(t.text)).replace(/\n/g, '<br>');
        break;
      case 'escape':
        out += escapeHtml(unescapeHtml(t.text));
        break;
      case 'strong':
        out += `<strong>${renderInline(t.tokens, ctx)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderInline(t.tokens, ctx)}</em>`;
        break;
      case 'del':
        out += `<s>${renderInline(t.tokens, ctx)}</s>`;
        break;
      case 'codespan':
        out += escapeHtml(t.text); // X长文没有行内代码样式，按普通文字处理
        break;
      case 'link':
        out += `<a href="${escapeHtml(t.href)}">${renderInline(t.tokens, ctx)}</a>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'html':
        out += t.text;
        break;
      case 'image':
        throw new ArticleError(
          `图片 ${t.href} 出现在${ctx}里，X编辑器无法在这个位置插图。请把图片单独放一行（前后空一行）。`,
        );
      default:
        out += escapeHtml(t.raw || '');
    }
  }
  return out;
}

function renderList(list) {
  const tag = list.ordered ? 'ol' : 'ul';
  const items = list.items.map((item) => {
    let inner = '';
    for (const child of item.tokens) {
      if (child.type === 'list') inner += renderList(child);
      else if (child.type === 'text' || child.type === 'paragraph') inner += renderInline(child.tokens, '列表');
      else if (child.type !== 'space') inner += renderInline([child], '列表');
    }
    return `<li>${inner}</li>`;
  });
  return `<${tag}>${items.join('')}</${tag}>`;
}

export async function loadArticle(articlePath, { title: titleOverride, cover: coverOverride } = {}) {
  const file = path.resolve(articlePath);
  if (!fs.existsSync(file)) throw new ArticleError(`找不到文章文件：${file}`);
  const baseDir = path.dirname(file);
  const markdown = await readAsMarkdown(file);

  const warnings = [];
  const images = [];
  const parts = [];
  let title = null;

  const tokens = marked.lexer(markdown, { gfm: true });
  for (const tok of tokens) {
    switch (tok.type) {
      case 'heading': {
        if (tok.depth === 1 && title === null) {
          title = tok.text.trim();
          break;
        }
        const tag = tok.depth <= 2 ? 'h2' : 'h3';
        parts.push(`<${tag}>${renderInline(tok.tokens, '标题')}</${tag}>`);
        break;
      }
      case 'paragraph': {
        // 段落里的图片拆成单独一行；图片前后的文字仍是普通段落
        let run = [];
        const flush = () => {
          const html = renderInline(run, '段落').trim();
          if (html && html !== '<br>') parts.push(`<p>${html}</p>`);
          run = [];
        };
        for (const t of tok.tokens) {
          if (t.type === 'image') {
            flush();
            const n = images.length + 1;
            images.push({ n, marker: imageMarker(n), file: resolveImage(t.href, baseDir), alt: t.text || '' });
            parts.push(`<p>${imageMarker(n)}</p>`);
          } else {
            run.push(t);
          }
        }
        flush();
        break;
      }
      case 'list':
        parts.push(renderList(tok));
        break;
      case 'blockquote':
        for (const child of tok.tokens) {
          if (child.type === 'paragraph' || child.type === 'text') {
            parts.push(`<blockquote>${renderInline(child.tokens, '引用')}</blockquote>`);
          } else if (child.type !== 'space') {
            // 引用里的列表等内容按原文逐行保留（X的引用里不能再嵌套列表）
            parts.push(`<blockquote>${escapeHtml(child.raw.trim().replace(/^> ?/gm, '')).replace(/\n/g, '<br>')}</blockquote>`);
          }
        }
        break;
      case 'code':
        // X长文不支持代码块，参照常见做法改成引用，保留换行
        warnings.push('代码块已转换为引用格式（X长文不支持代码块）');
        parts.push(`<blockquote>${escapeHtml(tok.text).replace(/\n/g, '<br>')}</blockquote>`);
        break;
      case 'table': {
        warnings.push('表格已转换为每行一段的文字（X长文不支持表格）');
        const row = (cells) => cells.map((c) => renderInline(c.tokens, '表格')).join(' | ');
        parts.push(`<p><strong>${row(tok.header)}</strong></p>`);
        for (const r of tok.rows) parts.push(`<p>${row(r)}</p>`);
        break;
      }
      case 'hr':
        warnings.push('分隔线（---）已忽略，如需要请在编辑器里手动插入 Divider');
        break;
      case 'html':
        if (tok.text.trim()) parts.push(tok.text);
        break;
      case 'space':
        break;
      default:
        warnings.push(`未识别的内容类型「${tok.type}」，已按普通文字处理`);
        parts.push(`<p>${escapeHtml(tok.raw.trim())}</p>`);
    }
  }

  if (titleOverride) {
    title = titleOverride.trim();
  } else if (title === null) {
    title = path.basename(file, path.extname(file));
    warnings.push(`文章里没有一级标题（# 标题），已用文件名「${title}」作为长文标题`);
  }

  const missing = images.filter((img) => !fs.existsSync(img.file));
  if (missing.length) {
    throw new ArticleError(
      '以下图片找不到，请检查路径：\n' + missing.map((m) => `  第${m.n}张：${m.file}`).join('\n'),
    );
  }
  for (const img of images) {
    if (!IMAGE_EXT.test(img.file)) warnings.push(`第${img.n}张图片格式可能不被X支持：${img.file}`);
  }

  let cover = null;
  if (coverOverride) {
    cover = path.resolve(coverOverride);
    if (!fs.existsSync(cover)) throw new ArticleError(`找不到封面图片：${cover}`);
  } else {
    // cover / 封面 开头的图片；有多张时选最宽的（X长文封面是横图，约 5:2）
    const found = fs.readdirSync(baseDir)
      .filter((f) => /^(cover|封面)/i.test(f) && IMAGE_EXT.test(f))
      .map((f) => path.join(baseDir, f));
    found.sort((a, b) => aspect(b) - aspect(a));
    cover = found[0] || null;
  }

  return { file, title, html: parts.join(''), images, cover, warnings };
}
