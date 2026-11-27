const STRIP_CTRL_RE = /[\u0000\uE000\uE001]/g;
const FENCE_OPEN_RE = /^ {0,3}```(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}```\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const HR_RE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,})\s*$/;
const QUOTE_RE = /^ {0,3}&gt;\s?(.*)$/;
const UL_ITEM_RE = /^(\s*)[-*+]\s+(.+)$/;
const OL_ITEM_RE = /^(\s*)(\d+)[.)]\s+(.+)$/;
const TABLE_DELIM_CELL_RE = /^:?-{2,}:?$/;
const SAFE_LANG_RE = /^[a-zA-Z0-9_+#.-]{1,24}$/;
const MAX_QUOTE_DEPTH = 4;

export interface RenderMarkdownOptions {
  allowLinks?: boolean;
  allowImages?: boolean;
}

function sanitizeHttpsUrl(escapedRawUrl: string): string {
  const decoded = escapedRawUrl
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  if (!decoded) return '';
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return '';
    }
    return escapeHtml(parsed.toString());
  } catch {
    return '';
  }
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(STRIP_CTRL_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInlineEmphasis(text: string): string {
  // Bold+Italic (***...***), Bold (**...**), Italic (*...*)
  // Intentionally avoid _..._ / __...__ so Jianpu duration underscores (5_, 5__) stay intact.
  let formatted = text.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  formatted = formatted.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/(^|[^*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g, '$1<em>$2</em>');
  return formatted;
}

export function renderInline(escapedLine: string, options: RenderMarkdownOptions = {}): string {
  const tokens: string[] = [];
  const pushToken = (html: string): string => {
    const index = tokens.push(html) - 1;
    return `\uE000C${index}\uE001`;
  };
  const resolveTokens = (input: string): string =>
    input.replace(/\uE000C(\d+)\uE001/g, (_match, idx: string) => tokens[Number(idx)] ?? '');

  let text = escapedLine.replace(/``(.+?)``|`([^`]+?)`/g, (_match, doubleTick?: string, singleTick?: string) => {
    const content = doubleTick !== undefined ? doubleTick.trim() : (singleTick ?? '');
    return pushToken(`<code class="md-inline-code">${content}</code>`);
  });

  if (options.allowImages) {
    text = text.replace(
      /!\[([^\]]*)\]\(([^\s)]+(?:\([^\s)]*\))?)(?:\s+&quot;((?:(?!&quot;).)*)&quot;)?\)/g,
      (_match, rawAlt: string, rawUrl: string, rawTitle?: string) => {
        const safeSrc = sanitizeHttpsUrl(rawUrl);
        if (!safeSrc) return rawAlt || '';
        const titleAttr = rawTitle ? ` title="${rawTitle}"` : '';
        return pushToken(
          `<span class="md-img-wrap"><img class="md-img" src="${safeSrc}" alt="${rawAlt}"${titleAttr} loading="lazy" decoding="async" /></span>`,
        );
      },
    );

    // Support GitHub-generated escaped <img src="https://..." alt="..." /> snippets safely
    text = text.replace(/&lt;img\b((?:(?!&gt;).)*?)\/?&gt;/gi, (whole, attrs: string) => {
      const srcMatch = /\bsrc\s*=\s*(?:&quot;|&#39;)((?:(?!&quot;|&#39;).)+)(?:&quot;|&#39;)/i.exec(attrs);
      if (!srcMatch) return whole;
      const safeSrc = sanitizeHttpsUrl(srcMatch[1]);
      if (!safeSrc) return whole;
      const altMatch = /\balt\s*=\s*(?:&quot;|&#39;)((?:(?!&quot;|&#39;).)*)(?:&quot;|&#39;)/i.exec(attrs);
      const alt = altMatch ? altMatch[1] : 'image';
      return pushToken(
        `<span class="md-img-wrap"><img class="md-img" src="${safeSrc}" alt="${alt}" loading="lazy" decoding="async" /></span>`,
      );
    });
  }

  if (options.allowLinks) {
    text = text.replace(
      /\[([^\]]+)\]\(([^\s)]+(?:\([^\s)]*\))?)(?:\s+&quot;((?:(?!&quot;).)*)&quot;)?\)/g,
      (_match, rawLabel: string, rawUrl: string) => {
        const safeHref = sanitizeHttpsUrl(rawUrl);
        const labelHtml = resolveTokens(formatInlineEmphasis(rawLabel));
        if (!safeHref) return labelHtml;
        return pushToken(
          `<a class="md-link" href="${safeHref}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`,
        );
      },
    );
  }

  return resolveTokens(formatInlineEmphasis(text));
}

function splitTableCells(escapedLine: string): string[] | null {
  let inCode = false;
  let hasPipe = false;
  const cells: string[] = [];
  let current = '';

  for (let i = 0; i < escapedLine.length; i++) {
    const ch = escapedLine[i];
    if (ch === '`') {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (!inCode && ch === '\\' && escapedLine[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (!inCode && ch === '|') {
      hasPipe = true;
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (!hasPipe) return null;
  cells.push(current.trim());

  const trimmed = escapedLine.trim();
  if (trimmed.startsWith('|') && cells.length > 0 && cells[0] === '') {
    cells.shift();
  }
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|') && cells.length > 0 && cells[cells.length - 1] === '') {
    cells.pop();
  }
  return cells.length > 0 ? cells : null;
}

type TableAlign = 'left' | 'center' | 'right';

function parseTableAlignments(escapedLine: string, expectedCols: number): TableAlign[] | null {
  const cells = splitTableCells(escapedLine);
  if (!cells || cells.length !== expectedCols) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!TABLE_DELIM_CELL_RE.test(cell)) return null;
    const starts = cell.startsWith(':');
    const ends = cell.endsWith(':');
    aligns.push(starts && ends ? 'center' : ends ? 'right' : 'left');
  }
  return aligns;
}

function isSpecialBlockStart(line: string, nextLine: string | undefined): boolean {
  if (!line.trim()) return true;
  if (FENCE_OPEN_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) return true;
  if (nextLine !== undefined) {
    const header = splitTableCells(line);
    if (header && (header.length >= 2 || line.trim().startsWith('|')) && parseTableAlignments(nextLine, header.length)) {
      return true;
    }
  }
  return false;
}

interface ListItemNode {
  lines: string[];
  subType?: 'ul' | 'ol';
  subStart?: number;
  subItems: string[][];
}

function renderList(
  lines: string[],
  startIdx: number,
  options: RenderMarkdownOptions,
): { html: string; nextIdx: number } {
  const firstLine = lines[startIdx];
  const ulFirst = UL_ITEM_RE.exec(firstLine);
  const olFirst = ulFirst ? null : OL_ITEM_RE.exec(firstLine);
  const listType: 'ul' | 'ol' = ulFirst ? 'ul' : 'ol';
  const baseIndent = (ulFirst ? ulFirst[1] : olFirst![1]).length;
  const startNum = olFirst ? Number.parseInt(olFirst[2], 10) : 1;

  const items: ListItemNode[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    if (FENCE_OPEN_RE.test(line) || HR_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line)) break;

    const ulMatch = UL_ITEM_RE.exec(line);
    const olMatch = ulMatch ? null : OL_ITEM_RE.exec(line);

    if (ulMatch || olMatch) {
      const indent = (ulMatch ? ulMatch[1] : olMatch![1]).length;
      const itemType: 'ul' | 'ol' = ulMatch ? 'ul' : 'ol';
      const content = ulMatch ? ulMatch[2] : olMatch![3];

      if (indent >= baseIndent + 2 && items.length > 0) {
        const currentItem = items[items.length - 1];
        if (!currentItem.subType) {
          currentItem.subType = itemType;
          if (olMatch) currentItem.subStart = Number.parseInt(olMatch[2], 10);
        }
        currentItem.subItems.push([content]);
        i++;
        continue;
      }

      if (itemType !== listType && indent <= baseIndent) break;
      items.push({ lines: [content], subItems: [] });
      i++;
      continue;
    }

    const leadingSpaces = /^(\s*)/.exec(line)?.[1].length ?? 0;
    if (leadingSpaces >= 2 && items.length > 0) {
      const currentItem = items[items.length - 1];
      if (currentItem.subItems.length > 0) {
        currentItem.subItems[currentItem.subItems.length - 1].push(line.trim());
      } else {
        currentItem.lines.push(line.trim());
      }
      i++;
      continue;
    }

    break;
  }

  const openTag = listType === 'ol' && Number.isSafeInteger(startNum) && startNum > 1
    ? `<ol class="md-list" start="${startNum}">`
    : `<${listType} class="md-list">`;
  const closeTag = `</${listType}>`;

  const body = items.map(item => {
    const mainHtml = item.lines.map(line => renderInline(line, options)).join('<br />');
    if (!item.subItems.length || !item.subType) {
      return `<li>${mainHtml}</li>`;
    }
    const subOpen = item.subType === 'ol' && item.subStart && Number.isSafeInteger(item.subStart) && item.subStart > 1
      ? `<ol class="md-list md-sublist" start="${item.subStart}">`
      : `<${item.subType} class="md-list md-sublist">`;
    const subClose = `</${item.subType}>`;
    const subBody = item.subItems
      .map(subLines => `<li>${subLines.map(line => renderInline(line, options)).join('<br />')}</li>`)
      .join('');
    return `<li>${mainHtml}${subOpen}${subBody}${subClose}</li>`;
  }).join('');

  return { html: `${openTag}${body}${closeTag}`, nextIdx: i };
}

function renderBlocks(lines: string[], quoteDepth = 0, options: RenderMarkdownOptions = {}): string {
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // 1. Fenced code block: ```lang ... ```
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen) {
      const rawInfo = fenceOpen[1].trim().split(/\s+/)[0] ?? '';
      const lang = SAFE_LANG_RE.test(rawInfo) ? rawInfo : '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && FENCE_CLOSE_RE.test(lines[i])) {
        i++;
      }
      const langLabel = lang || 'code';
      blocks.push(
        `<div class="md-codeblock">` +
        `<div class="md-codehead"><span class="md-codelang">${langLabel}</span>` +
        `<button type="button" class="md-copy-btn" data-copy-code="1">复制</button></div>` +
        `<pre><code>${codeLines.join('\n')}</code></pre>` +
        `</div>`,
      );
      continue;
    }

    // 2. Horizontal rule
    if (HR_RE.test(line)) {
      blocks.push('<hr class="md-hr" />');
      i++;
      continue;
    }

    // 3. Heading: # .. #### (5..6 clamped to h4)
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1].length);
      blocks.push(`<h${level} class="md-h md-h${level}">${renderInline(headingMatch[2], options)}</h${level}>`);
      i++;
      continue;
    }

    // 4. Table: | col1 | col2 | followed by | --- | --- |
    if (i + 1 < lines.length) {
      const headerCells = splitTableCells(line);
      const alignments = headerCells && (headerCells.length >= 2 || line.trim().startsWith('|'))
        ? parseTableAlignments(lines[i + 1], headerCells.length)
        : null;
      if (headerCells && alignments) {
        const colCount = headerCells.length;
        const thead = `<thead><tr>${headerCells.map((cell, col) =>
          `<th class="align-${alignments[col]}">${renderInline(cell, options)}</th>`).join('')}</tr></thead>`;
        i += 2;
        const bodyRows: string[] = [];
        while (i < lines.length && lines[i].trim() && !FENCE_OPEN_RE.test(lines[i])) {
          const rowCells = splitTableCells(lines[i]);
          if (!rowCells) break;
          const normalized = Array.from({ length: colCount }, (_, col) => rowCells[col] ?? '');
          bodyRows.push(
            `<tr>${normalized.map((cell, col) =>
              `<td class="align-${alignments[col]}">${renderInline(cell, options)}</td>`).join('')}</tr>`,
          );
          i++;
        }
        const tbody = bodyRows.length ? `<tbody>${bodyRows.join('')}</tbody>` : '';
        blocks.push(`<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`);
        continue;
      }
    }

    // 5. Blockquote: > ... (escaped as &gt;)
    if (QUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qMatch = QUOTE_RE.exec(lines[i]);
        if (!qMatch) break;
        quoteLines.push(qMatch[1]);
        i++;
      }
      const inner = quoteDepth < MAX_QUOTE_DEPTH
        ? renderBlocks(quoteLines, quoteDepth + 1, options)
        : `<p>${quoteLines.map(qLine => renderInline(qLine, options)).join('<br />')}</p>`;
      blocks.push(`<blockquote class="md-quote">${inner}</blockquote>`);
      continue;
    }

    // 6. Ordered / Unordered Lists
    if (UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) {
      const { html, nextIdx } = renderList(lines, i, options);
      blocks.push(html);
      i = nextIdx;
      continue;
    }

    // 7. Paragraph with preserved line breaks
    const paraLines: string[] = [];
    while (i < lines.length && !isSpecialBlockStart(lines[i], lines[i + 1])) {
      paraLines.push(renderInline(lines[i], options));
      i++;
    }
    if (paraLines.length) {
      blocks.push(`<p>${paraLines.join('<br />')}</p>`);
    }
  }

  return blocks.join('');
}

export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  if (!source) return '';
  const escaped = escapeHtml(source.replace(/\r\n?/g, '\n'));
  if (!escaped.trim()) return '';
  return renderBlocks(escaped.split('\n'), 0, options);
}
