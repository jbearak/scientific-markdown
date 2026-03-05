export interface HtmlTableRun {
  type: 'text' | 'softbreak';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  href?: string;
}

export interface HtmlTableCell {
  runs: HtmlTableRun[];
  colspan?: number;
  rowspan?: number;
}

export interface HtmlTableRow {
  cells: HtmlTableCell[];
  header: boolean;
}

export interface HtmlTableMeta {
  rows: HtmlTableRow[];
  fontSize?: number;   // from data-font-size attribute
  font?: string;       // from data-font attribute
}

export function extractHtmlTables(html: string): HtmlTableMeta[] {
  const tables: HtmlTableMeta[] = [];
  // Regex-based extraction intentionally does not support nested <table> blocks.
  // This parser targets simple manuscript tables (<table>/<tr>/<th>/<td>).
  const tableRegex = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const attrs = tableMatch[1];
    const rows = extractHtmlTableRows(tableMatch[2]);
    // Invariant: only non-empty row sets are returned to callers.
    if (rows.length > 0) {
      const meta: HtmlTableMeta = { rows };
      const fontSizeMatch = attrs.match(/data-font-size\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
      if (fontSizeMatch) {
        const n = parseFloat(fontSizeMatch[1]);
        if (isFinite(n) && n > 0) meta.fontSize = n;
      }
      const fontMatch = attrs.match(/data-font\s*=\s*["']([^"']*)["']/i);
      if (fontMatch && fontMatch[1]) meta.font = fontMatch[1];
      tables.push(meta);
    }
  }
  return tables;
}

function extractHtmlTableRows(tableHtml: string): HtmlTableRow[] {
  const rows: HtmlTableRow[] = [];
  // Similarly, nested <tr> structures are out of scope for this lightweight parser.
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = extractHtmlTableCells(rowMatch[1]);
    // Invariant: rows with no cells are skipped.
    if (cells.length > 0) {
      rows.push({
        cells: cells.map(cell => ({
          runs: cell.runs,
          ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
          ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
        })),
        header: cells.some(c => c.isHeader)
      });
    }
  }
  return rows;
}

function extractHtmlTableCells(rowHtml: string): Array<{ runs: HtmlTableRun[]; isHeader: boolean; colspan?: number; rowspan?: number }> {
  const cells: Array<{ runs: HtmlTableRun[]; isHeader: boolean; colspan?: number; rowspan?: number }> = [];
  // Nested table-cell tags are not supported; this matches flat <th>/<td> content only.
  const cellRegex = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let cellMatch: RegExpExecArray | null;
  while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
    const isHeader = cellMatch[1].toLowerCase() === 'th';
    const attrs = cellMatch[2];
    const runs = parseHtmlCellRuns(cellMatch[3]);
    const colspanMatch = attrs.match(/colspan\s*=\s*["']?(\d+)/i);
    const rowspanMatch = attrs.match(/rowspan\s*=\s*["']?(\d+)/i);
    const colspan = colspanMatch ? parseInt(colspanMatch[1], 10) : undefined;
    const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : undefined;
    cells.push({
      runs,
      isHeader,
      ...(colspan && colspan > 1 ? { colspan } : {}),
      ...(rowspan && rowspan > 1 ? { rowspan } : {}),
    });
  }
  return cells;
}

function parseHtmlCellRuns(cellHtml: string): HtmlTableRun[] {
  const runs: HtmlTableRun[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let strikethrough = false;
  let code = false;
  let superscript = false;
  let subscript = false;
  let href: string | undefined;

  // Tokenize the HTML into tags and text segments
  const tagRegex = /<(\/?)(\w+)\b([^>]*)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(cellHtml)) !== null) {
    // Emit any text before this tag
    if (match.index > lastIndex) {
      const rawText = cellHtml.slice(lastIndex, match.index);
      const decoded = decodeHtmlEntities(rawText);
      const text = code ? decoded : decoded.replace(/\s+/g, ' ');
      if (text) {
        runs.push({
          type: 'text', text,
          ...(bold ? { bold } : {}),
          ...(italic ? { italic } : {}),
          ...(underline ? { underline } : {}),
          ...(strikethrough ? { strikethrough } : {}),
          ...(code ? { code } : {}),
          ...(superscript ? { superscript } : {}),
          ...(subscript ? { subscript } : {}),
          ...(href ? { href } : {}),
        });
      }
    }
    lastIndex = match.index + match[0].length;

    const isClose = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3];

    if (tag === 'br') {
      runs.push({ type: 'softbreak', text: '\n' });
    } else if (tag === 'b' || tag === 'strong') {
      bold = !isClose;
    } else if (tag === 'i' || tag === 'em') {
      italic = !isClose;
    } else if (tag === 'u') {
      underline = !isClose;
    } else if (tag === 's' || tag === 'del' || tag === 'strike') {
      strikethrough = !isClose;
    } else if (tag === 'code') {
      code = !isClose;
    } else if (tag === 'sup') {
      superscript = !isClose;
    } else if (tag === 'sub') {
      subscript = !isClose;
    } else if (tag === 'a') {
      if (!isClose) {
        const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
        href = hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : undefined;
      } else {
        href = undefined;
      }
    } else if (tag === 'p' && isClose) {
      // Treat </p> as a soft break to separate paragraphs within a cell.
      runs.push({ type: 'softbreak', text: '\n' });
    }
  }

  // Emit any trailing text
  if (lastIndex < cellHtml.length) {
    const rawText = cellHtml.slice(lastIndex);
    const decoded = decodeHtmlEntities(rawText);
    const text = code ? decoded : decoded.replace(/\s+/g, ' ');
    if (text) {
      runs.push({
        type: 'text', text,
        ...(bold ? { bold } : {}),
        ...(italic ? { italic } : {}),
        ...(underline ? { underline } : {}),
        ...(strikethrough ? { strikethrough } : {}),
        ...(code ? { code } : {}),
        ...(superscript ? { superscript } : {}),
        ...(subscript ? { subscript } : {}),
        ...(href ? { href } : {}),
      });
    }
  }

  // Trim leading/trailing whitespace from the run sequence
  if (runs.length > 0) {
    const first = runs[0];
    if (first.type === 'text' && !first.code) {
      first.text = first.text.replace(/^\s+/, '');
      if (!first.text) runs.shift();
    }
  }
  if (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last.type === 'softbreak') runs.pop();
    else if (last.type === 'text' && !last.code) {
      last.text = last.text.replace(/\s+$/, '');
      if (!last.text) runs.pop();
    }
  }

  // Keep shape stable for callers expecting at least one run per cell.
  if (runs.length === 0) {
    runs.push({ type: 'text', text: '' });
  }

  return runs;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
