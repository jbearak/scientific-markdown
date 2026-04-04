import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { parseEmbedDirective, preprocessEmbeds, type EmbedResolver } from './embed-preprocess';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Filename-safe characters (no quotes, no spaces, no angle brackets). */
const fileCharArb = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
);

const filenameArb = fc.array(fileCharArb, { minLength: 1, maxLength: 12 })
  .map(chars => chars.join(''));

const extensionArb = fc.constantFrom('.csv', '.tsv', '.xlsx', '.md');

const pathArb = fc.tuple(
  fc.array(filenameArb, { minLength: 0, maxLength: 2 }),
  filenameArb,
  extensionArb,
).map(([dirs, name, ext]) => [...dirs, name + ext].join('/'));

/** Path that may contain spaces (requires quoting). */
const spacedNameArb = fc.tuple(filenameArb, filenameArb)
  .map(([a, b]) => a + ' ' + b);

const quotedPathArb = fc.tuple(
  fc.array(fc.oneof(filenameArb, spacedNameArb), { minLength: 0, maxLength: 2 }),
  fc.oneof(filenameArb, spacedNameArb),
  extensionArb,
  fc.constantFrom('"', "'"),
).map(([dirs, name, ext, quote]) => {
  const raw = [...dirs, name + ext].join('/');
  return { raw, quoted: quote + raw + quote, quote };
});

const sheetArb = fc.oneof(
  filenameArb,
  spacedNameArb,
);

const cellRefArb = fc.tuple(
  fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  fc.integer({ min: 1, max: 999 }),
  fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  fc.integer({ min: 1, max: 999 }),
).map(([c1, r1, c2, r2]) => `${c1}${r1}:${c2}${r2}`);

const headersArb = fc.integer({ min: 0, max: 10 });

// ---------------------------------------------------------------------------
// Property 1: parseEmbedDirective round-trip — building a directive string
// from parts and parsing it recovers the parts.
// ---------------------------------------------------------------------------

function buildDirective(path: string, params: { sheet?: string; range?: string; headers?: number }): string {
  const parts = ['<!-- embed:', path];
  if (params.sheet !== undefined) {
    const needsQuote = params.sheet.includes(' ');
    parts.push(needsQuote ? `sheet="${params.sheet}"` : `sheet=${params.sheet}`);
  }
  if (params.range !== undefined) {
    parts.push(`range=${params.range}`);
  }
  if (params.headers !== undefined) {
    parts.push(`headers=${params.headers}`);
  }
  parts.push('-->');
  return parts.join(' ');
}

describe('Feature: embedded-tables, Property 1: parseEmbedDirective round-trip', () => {
  it('recovers path from a bare-path directive', () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        const directive = buildDirective(path, {});
        const parsed = parseEmbedDirective(directive);
        expect(parsed).not.toBeNull();
        expect(parsed!.path).toBe(path);
      }),
      { numRuns: 200 },
    );
  });

  it('recovers path from a quoted-path directive', () => {
    fc.assert(
      fc.property(quotedPathArb, ({ raw, quoted }) => {
        const directive = `<!-- embed: ${quoted} -->`;
        const parsed = parseEmbedDirective(directive);
        expect(parsed).not.toBeNull();
        expect(parsed!.path).toBe(raw);
      }),
      { numRuns: 200 },
    );
  });

  it('recovers all params from a full XLSX directive', () => {
    fc.assert(
      fc.property(pathArb, sheetArb, cellRefArb, headersArb, (path, sheet, range, headers) => {
        const needsQuote = sheet.includes(' ');
        const sheetStr = needsQuote ? `sheet="${sheet}"` : `sheet=${sheet}`;
        const directive = `<!-- embed: ${path} ${sheetStr} range=${range} headers=${headers} -->`;
        const parsed = parseEmbedDirective(directive);
        expect(parsed).not.toBeNull();
        expect(parsed!.path).toBe(path);
        expect(parsed!.sheet).toBe(sheet);
        expect(parsed!.range).toBe(range);
        expect(parsed!.headers).toBe(headers);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: parseEmbedDirective returns null for non-embed comments.
// ---------------------------------------------------------------------------

const nonEmbedCommentArb = fc.oneof(
  fc.constantFrom(
    '<!-- landscape -->',
    '<!-- /landscape -->',
    '<!-- table-font-size: 12 -->',
    '<!-- table-font: Arial -->',
    '<!-- table-orientation: landscape -->',
    '<!-- table-col-widths: 2,1,1 -->',
    '<!-- some random comment -->',
  ),
  fc.string({ minLength: 0, maxLength: 50 }).filter(s => !s.includes('embed:')),
);

describe('Feature: embedded-tables, Property 2: non-embed comments return null', () => {
  it('returns null for any non-embed HTML comment', () => {
    fc.assert(
      fc.property(nonEmbedCommentArb, (comment) => {
        const result = parseEmbedDirective(comment);
        expect(result).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: preprocessEmbeds does not alter content inside fenced code blocks.
// ---------------------------------------------------------------------------

describe('Feature: embedded-tables, Property 3: fenced code blocks are untouched', () => {
  it('embed directives inside fenced code blocks are not expanded', () => {
    const resolver: EmbedResolver = {
      readFile() { return new TextEncoder().encode('a,b\n1,2'); },
      resolveRelative(_base, rel) { return '/' + rel; },
    };

    fc.assert(
      fc.property(pathArb, fc.constantFrom('```', '~~~'), (path, fence) => {
        const directive = `<!-- embed: ${path} -->`;
        const input = `${fence}\n${directive}\n${fence}`;
        const result = preprocessEmbeds(input, resolver, '/doc/file.md');
        // The embed should NOT be expanded — the directive should remain
        expect(result).toContain(directive);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: preprocessEmbeds always produces blank-line-separated blocks.
// ---------------------------------------------------------------------------

describe('Feature: embedded-tables, Property 4: blank lines around expanded tables', () => {
  it('expanded tables are surrounded by blank lines', () => {
    const resolver: EmbedResolver = {
      readFile() { return new TextEncoder().encode('a,b\n1,2'); },
      resolveRelative(_base, rel) { return '/' + rel; },
    };

    const contextArb = fc.constantFrom('Before paragraph', '# Heading', '> blockquote', 'plain text');

    fc.assert(
      fc.property(contextArb, contextArb, (before, after) => {
        const input = `${before}\n<!-- embed: data.csv -->\n${after}`;
        const result = preprocessEmbeds(input, resolver, '/doc/file.md');
        const lines = result.split('\n');

        const tableStart = lines.findIndex(l => l.startsWith('<table'));
        const tableEnd = lines.findIndex(l => l.includes('</table>'));

        if (tableStart > 0) {
          expect(lines[tableStart - 1].trim()).toBe('');
        }
        if (tableEnd >= 0 && tableEnd < lines.length - 1) {
          expect(lines[tableEnd + 1].trim()).toBe('');
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: preprocessEmbeds emits error placeholders for missing files
// and never throws.
// ---------------------------------------------------------------------------

describe('Feature: embedded-tables, Property 5: missing files produce error placeholders', () => {
  it('never throws and always produces output containing error text for missing files', () => {
    const emptyResolver: EmbedResolver = {
      readFile() { return null; },
      resolveRelative(_base, rel) { return '/' + rel; },
    };

    fc.assert(
      fc.property(pathArb, (path) => {
        const input = `<!-- embed: ${path} -->`;
        const result = preprocessEmbeds(input, emptyResolver, '/doc/file.md');
        expect(typeof result).toBe('string');
        expect(result).toContain('Error');
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: .md embeds always produce HTML tables regardless of source format.
// ---------------------------------------------------------------------------

describe('Feature: embedded-tables, Property 6: .md embeds produce HTML tables', () => {
  // Generator: pipe table with random column count and row count
  const wordArb = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 10 }).map(a => a.join(''));
  const pipeTableArb = fc.integer({ min: 1, max: 4 }).chain(numCols => {
    const headerRow = fc.array(wordArb, { minLength: numCols, maxLength: numCols })
      .map(cells => '| ' + cells.join(' | ') + ' |');
    const separatorRow = fc.constant('|' + Array(numCols).fill('---').join('|') + '|');
    const dataRow = fc.array(wordArb, { minLength: numCols, maxLength: numCols })
      .map(cells => '| ' + cells.join(' | ') + ' |');
    return fc.tuple(headerRow, separatorRow, fc.array(dataRow, { minLength: 1, maxLength: 4 }))
      .map(([header, sep, rows]) => [header, sep, ...rows].join('\n'));
  });

  it('.md pipe table embeds always produce HTML <table> output', () => {
    fc.assert(
      fc.property(pipeTableArb, (tableContent) => {
        const resolver: EmbedResolver = {
          readFile() { return new TextEncoder().encode(tableContent); },
          resolveRelative(_base: string, rel: string) { return '/' + rel; },
        };
        const result = preprocessEmbeds('<!-- embed: table.md -->', resolver, '/doc/file.md');
        expect(result).toContain('<table');
        expect(result).toContain('</table>');
        expect(result).toContain('data-embed-idx=');
      }),
      { numRuns: 100 },
    );
  });

  // Generator: grid table
  const gridTableArb = fc.integer({ min: 1, max: 3 }).chain(numCols => {
    const colWidth = 5;
    const separator = '+' + Array(numCols).fill('-'.repeat(colWidth)).join('+') + '+';
    const headerSep = '+' + Array(numCols).fill('='.repeat(colWidth)).join('+') + '+';
    const cellArb = fc.array(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 1, maxLength: colWidth - 2 }).map(a => a.join(''));
    const rowArb = fc.array(cellArb, { minLength: numCols, maxLength: numCols })
      .map(cells => '| ' + cells.map((c: string) => c.padEnd(colWidth - 2)).join(' | ') + ' |');
    return fc.tuple(rowArb, fc.array(rowArb, { minLength: 1, maxLength: 3 }))
      .map(([headerRow, bodyRows]) =>
        [separator, headerRow, headerSep, ...bodyRows.flatMap(r => [r, separator])].join('\n')
      );
  });

  it('.md grid table embeds always produce HTML <table> output', () => {
    fc.assert(
      fc.property(gridTableArb, (tableContent) => {
        const resolver: EmbedResolver = {
          readFile() { return new TextEncoder().encode(tableContent); },
          resolveRelative(_base: string, rel: string) { return '/' + rel; },
        };
        const result = preprocessEmbeds('<!-- embed: table.md -->', resolver, '/doc/file.md');
        expect(result).toContain('<table');
        expect(result).toContain('</table>');
        expect(result).toContain('data-embed-idx=');
      }),
      { numRuns: 100 },
    );
  });
});
