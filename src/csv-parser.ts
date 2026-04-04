import type { HtmlTableMeta, HtmlTableRow, HtmlTableCell, HtmlTableRun } from './html-table-parser';

/**
 * RFC 4180-compliant CSV/TSV parser.
 * Handles quoted fields with embedded newlines, escaped quotes (""), and
 * fields containing the delimiter.
 */
export function parseCsv(content: string, delimiter: string): string[][] {
  if (!content || content.trim() === '') return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;

  while (i < content.length) {
    // Skip \r in CRLF
    if (content[i] === '\r') {
      i++;
      continue;
    }

    if (content[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = '';
      while (i < content.length) {
        if (content[i] === '"') {
          if (i + 1 < content.length && content[i + 1] === '"') {
            // Escaped quote
            field += '"';
            i += 2;
          } else {
            // End of quoted field
            i++; // skip closing quote
            break;
          }
        } else {
          field += content[i];
          i++;
        }
      }
      row.push(field);
      // After a quoted field, expect delimiter or newline or end
      if (i < content.length && content[i] === '\r') i++;
      if (i < content.length && content[i] === delimiter) {
        i++; // skip delimiter
      } else if (i < content.length && content[i] === '\n') {
        i++; // skip newline
        rows.push(row);
        row = [];
      } else {
        // end of input — handled after loop
      }
    } else {
      // Unquoted field — read until delimiter or newline
      let field = '';
      while (i < content.length && content[i] !== delimiter && content[i] !== '\n' && content[i] !== '\r') {
        field += content[i];
        i++;
      }
      row.push(field);
      if (i < content.length && content[i] === '\r') i++;
      if (i < content.length && content[i] === delimiter) {
        i++; // skip delimiter
      } else if (i < content.length && content[i] === '\n') {
        i++; // skip newline
        rows.push(row);
        row = [];
      }
    }
  }

  // Push last row if it has content.
  // Suppress only if it's a single empty-string field caused by a trailing newline.
  if (row.length > 0) {
    const isTrailingNewline = row.length === 1 && row[0] === '' && rows.length > 0
      && (content.endsWith('\n') || content.endsWith('\r\n'));
    if (!isTrailingNewline) {
      rows.push(row);
    }
  }

  return rows;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a 2D string array into HtmlTableMeta.
 * Cell content is HTML-escaped. Newlines within cells become hardbreak runs.
 */
export function csvToHtmlTableMeta(rows: string[][], headerCount: number): HtmlTableMeta {
  const tableRows: HtmlTableRow[] = rows.map((row, rowIdx) => {
    const cells: HtmlTableCell[] = row.map(cellText => {
      const escaped = escapeHtml(cellText);
      const lines = escaped.split('\n');
      const runs: HtmlTableRun[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          runs.push({ type: 'hardbreak', text: '' });
        }
        runs.push({ type: 'text', text: lines[i] });
      }
      return { runs };
    });
    return { cells, header: rowIdx < headerCount };
  });
  return { rows: tableRows };
}
