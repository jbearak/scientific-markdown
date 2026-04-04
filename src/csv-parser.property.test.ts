import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { parseCsv, csvToHtmlTableMeta } from './csv-parser';
import { renderHtmlTable } from './embed-preprocess';

/**
 * Feature: embedded-tables
 * Property 1: CSV round-trip — any 2D string array can be serialized to CSV
 * and parsed back to the same array.
 */

/** Serialize a 2D array to CSV format. Always quote to ensure round-trip fidelity. */
function toCsv(rows: string[][], delimiter: string): string {
  return rows.map(row =>
    row.map(cell => '"' + cell.replace(/"/g, '""') + '"').join(delimiter)
  ).join('\n');
}

// Generator: cell content that may include commas, quotes, newlines
const cellArb = fc.oneof(
  { weight: 5, arbitrary: fc.string({ minLength: 0, maxLength: 20 }).filter(s => !s.includes('\r')) },
  { weight: 2, arbitrary: fc.constantFrom('', 'hello, world', 'say "hi"', 'line1\nline2') },
);

// Generator: a row of cells (fixed width per test run)
const rowArb = (numCols: number) => fc.array(cellArb, { minLength: numCols, maxLength: numCols });

// Generator: a table with consistent column count
const tableArb = fc.integer({ min: 1, max: 6 }).chain(numCols =>
  fc.array(rowArb(numCols), { minLength: 1, maxLength: 10 }).map(rows => ({ rows, numCols }))
);

describe('Feature: embedded-tables, Property 1: CSV round-trip fidelity', () => {
  it('serializing then parsing CSV recovers the original data', () => {
    fc.assert(
      fc.property(tableArb, ({ rows }) => {
        const csv = toCsv(rows, ',');
        const parsed = parseCsv(csv, ',');
        expect(parsed).toEqual(rows);
      }),
      { numRuns: 200 },
    );
  });

  it('serializing then parsing TSV recovers the original data', () => {
    // toCsv always quotes every cell, so tabs inside quoted fields round-trip correctly
    const tsvCellArb = cellArb;
    const tsvRowArb = (numCols: number) => fc.array(tsvCellArb, { minLength: numCols, maxLength: numCols });
    const tsvTableArb = fc.integer({ min: 1, max: 6 }).chain(numCols =>
      fc.array(tsvRowArb(numCols), { minLength: 1, maxLength: 10 }).map(rows => ({ rows, numCols }))
    );

    fc.assert(
      fc.property(tsvTableArb, ({ rows }) => {
        const tsv = toCsv(rows, '\t');
        const parsed = parseCsv(tsv, '\t');
        expect(parsed).toEqual(rows);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Feature: embedded-tables
 * Property 2: parseCsv always returns rectangular data — all rows have the
 * same number of fields as the first row (or at most as many fields).
 */

describe('Feature: embedded-tables, Property 2: parseCsv output row consistency', () => {
  it('all rows from parseCsv have a consistent number of columns', () => {
    fc.assert(
      fc.property(tableArb, ({ rows }) => {
        const csv = toCsv(rows, ',');
        const parsed = parseCsv(csv, ',');
        if (parsed.length === 0) return;
        const colCount = parsed[0].length;
        for (const row of parsed) {
          expect(row.length).toBe(colCount);
        }
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Feature: embedded-tables
 * Property 3: csvToHtmlTableMeta preserves row count and column count,
 * and header flag is correctly assigned.
 */

describe('Feature: embedded-tables, Property 3: csvToHtmlTableMeta structure preservation', () => {
  it('preserves row and column counts from input', () => {
    fc.assert(
      fc.property(tableArb, fc.integer({ min: 0, max: 5 }), ({ rows, numCols }, headerCount) => {
        const meta = csvToHtmlTableMeta(rows, headerCount);
        expect(meta.rows.length).toBe(rows.length);
        for (let i = 0; i < meta.rows.length; i++) {
          expect(meta.rows[i].cells.length).toBe(numCols);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('marks exactly the first headerCount rows as header rows', () => {
    fc.assert(
      fc.property(tableArb, ({ rows }) => {
        const headerCount = Math.min(rows.length, Math.floor(rows.length / 2) + 1);
        const meta = csvToHtmlTableMeta(rows, headerCount);
        for (let i = 0; i < meta.rows.length; i++) {
          expect(meta.rows[i].header).toBe(i < headerCount);
        }
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Feature: embedded-tables
 * Property 4: csvToHtmlTableMeta → renderHtmlTable produces correctly escaped HTML
 * (no raw < > & in rendered cell content).
 */

describe('Feature: embedded-tables, Property 4: HTML escaping through renderHtmlTable', () => {
  it('rendered HTML never contains unescaped special characters in cell text', () => {
    const htmlCellArb = fc.oneof(
      fc.constantFrom('<script>alert(1)</script>', 'a & b', 'x > y', '"quoted"', 'normal'),
      fc.string({ minLength: 0, maxLength: 30 }),
    );
    const htmlRowArb = fc.array(htmlCellArb, { minLength: 1, maxLength: 4 });
    const htmlTableArb = fc.array(htmlRowArb, { minLength: 1, maxLength: 5 });

    fc.assert(
      fc.property(htmlTableArb, (rows) => {
        const meta = csvToHtmlTableMeta(rows, 1);
        const html = renderHtmlTable(meta);
        // Strip HTML tags to get only text content, then verify no raw special chars
        const textContent = html.replace(/<[^>]+>/g, '\n');
        for (const segment of textContent.split('\n')) {
          if (segment.length === 0) continue;
          // No raw < or > should appear in text content
          expect(segment).not.toMatch(/[<>]/);
          // All & should be part of an entity
          expect(segment).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[\da-fA-F]+;)/);
        }
      }),
      { numRuns: 200 },
    );
  });
});
