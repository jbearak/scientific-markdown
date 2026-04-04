import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import * as XLSX from '@e965/xlsx';
import { parseXlsx } from './xlsx-parser';

/** Build a simple XLSX from a 2D string array. */
function buildXlsx(data: string[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

// Generator: simple cell value (avoid characters that confuse XLSX serialization)
const cellArb = fc.string({ minLength: 0, maxLength: 15 })
  .filter(s => !s.includes('\x00') && !s.includes('\r'));

// Generator: rectangular table with consistent column count
const xlsxTableArb = fc.integer({ min: 1, max: 5 }).chain(numCols =>
  fc.array(
    fc.array(cellArb, { minLength: numCols, maxLength: numCols }),
    { minLength: 1, maxLength: 8 },
  ).map(rows => ({ rows, numCols }))
);

/**
 * Feature: embedded-tables
 * Property 1: parseXlsx preserves row and column counts from the source data.
 */

describe('Feature: embedded-tables, Property 1: XLSX row/column count preservation', () => {
  it('parseXlsx output has the same number of rows and columns as the input', () => {
    fc.assert(
      fc.property(xlsxTableArb, ({ rows, numCols }) => {
        const buf = buildXlsx(rows);
        const meta = parseXlsx(buf, { headers: 0 });

        expect(meta.rows.length).toBe(rows.length);
        for (const row of meta.rows) {
          expect(row.cells.length).toBe(numCols);
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: embedded-tables
 * Property 2: header count parameter is respected — exactly the first N rows
 * are marked as header.
 */

describe('Feature: embedded-tables, Property 2: XLSX header count', () => {
  it('marks exactly the first headerCount rows as headers', () => {
    fc.assert(
      fc.property(xlsxTableArb, ({ rows }) => {
        const headerCount = Math.min(rows.length, Math.floor(rows.length / 2) + 1);
        const buf = buildXlsx(rows);
        const meta = parseXlsx(buf, { headers: headerCount });

        for (let i = 0; i < meta.rows.length; i++) {
          expect(meta.rows[i].header).toBe(i < headerCount);
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: embedded-tables
 * Property 3: cell text content is recoverable — for simple (non-merged)
 * tables, each cell's text matches the original data coerced to string.
 */

describe('Feature: embedded-tables, Property 3: XLSX cell text fidelity', () => {
  it('cell text matches the original string data', () => {
    // Use only non-empty cells without HTML special chars to avoid escaping mismatch
    const nonEmptyCellArb = fc.string({ minLength: 1, maxLength: 15 })
      .filter(s => !s.includes('\x00') && !s.includes('\r') && !s.includes('<') && !s.includes('>') && !s.includes('&') && !s.includes('"'));

    const nonEmptyTableArb = fc.integer({ min: 1, max: 4 }).chain(numCols =>
      fc.array(
        fc.array(nonEmptyCellArb, { minLength: numCols, maxLength: numCols }),
        { minLength: 1, maxLength: 6 },
      ).map(rows => ({ rows, numCols }))
    );

    fc.assert(
      fc.property(nonEmptyTableArb, ({ rows }) => {
        const buf = buildXlsx(rows);
        const meta = parseXlsx(buf, { headers: 0 });

        for (let r = 0; r < rows.length; r++) {
          for (let c = 0; c < rows[r].length; c++) {
            const cellText = meta.rows[r].cells[c].runs.map(run => run.text).join('');
            expect(cellText).toBe(rows[r][c]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: embedded-tables
 * Property 4: parseXlsx never throws for valid XLSX buffers,
 * regardless of header count.
 */

describe('Feature: embedded-tables, Property 4: parseXlsx robustness', () => {
  it('does not throw for any valid XLSX with any header count', () => {
    fc.assert(
      fc.property(xlsxTableArb, fc.integer({ min: 0, max: 20 }), ({ rows }, headers) => {
        const buf = buildXlsx(rows);
        // Should not throw even if headers > row count
        const meta = parseXlsx(buf, { headers });
        expect(meta.rows.length).toBe(rows.length);
      }),
      { numRuns: 100 },
    );
  });
});
