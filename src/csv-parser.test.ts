import { describe, it, expect } from 'bun:test';
import { parseCsv, csvToHtmlTableMeta } from './csv-parser';

describe('parseCsv', () => {
  it('parses a simple CSV', () => {
    const input = 'a,b,c\n1,2,3\n4,5,6';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('parses a simple TSV', () => {
    const input = 'a\tb\tc\n1\t2\t3';
    const result = parseCsv(input, '\t');
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields containing the delimiter', () => {
    const input = '"a,b",c\n1,"2,3"';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['a,b', 'c'],
      ['1', '2,3'],
    ]);
  });

  it('handles quoted fields containing newlines', () => {
    const input = '"line1\nline2",b\nc,d';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['line1\nline2', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles escaped double quotes inside quoted fields', () => {
    const input = '"say ""hello""",b\nc,d';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['say "hello"', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles empty fields', () => {
    const input = ',b,\na,,c';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['', 'b', ''],
      ['a', '', 'c'],
    ]);
  });

  it('handles a single row with no trailing newline', () => {
    const input = 'a,b,c';
    const result = parseCsv(input, ',');
    expect(result).toEqual([['a', 'b', 'c']]);
  });

  it('handles trailing newline without creating an extra row', () => {
    const input = 'a,b\nc,d\n';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles CRLF line endings', () => {
    const input = 'a,b\r\nc,d\r\n';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles empty input', () => {
    const result = parseCsv('', ',');
    expect(result).toEqual([]);
  });

  it('handles a quoted field with multiple newlines', () => {
    const input = '"a\nb\nc",d';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['a\nb\nc', 'd'],
    ]);
  });

  it('handles whitespace around quoted fields', () => {
    // RFC 4180 says spaces outside quotes are part of the field,
    // but we preserve them as-is
    const input = ' "a" ,b';
    const result = parseCsv(input, ',');
    // Unquoted: leading/trailing space is part of the value
    expect(result[0][1]).toBe('b');
  });

  it('handles a field that is just double quotes (empty quoted field)', () => {
    const input = '"",b\nc,""';
    const result = parseCsv(input, ',');
    expect(result).toEqual([
      ['', 'b'],
      ['c', ''],
    ]);
  });

  it('handles TSV with tabs inside quoted fields', () => {
    const input = '"a\tb"\tc\n1\t2';
    const result = parseCsv(input, '\t');
    expect(result).toEqual([
      ['a\tb', 'c'],
      ['1', '2'],
    ]);
  });
});

describe('csvToHtmlTableMeta', () => {
  it('converts rows into HtmlTableMeta with 1 header row', () => {
    const rows = [
      ['Name', 'Age'],
      ['Alice', '30'],
      ['Bob', '25'],
    ];
    const meta = csvToHtmlTableMeta(rows, 1);
    expect(meta.rows.length).toBe(3);
    expect(meta.rows[0].header).toBe(true);
    expect(meta.rows[1].header).toBe(false);
    expect(meta.rows[2].header).toBe(false);
    expect(meta.rows[0].cells[0].runs[0].text).toBe('Name');
    expect(meta.rows[0].cells[1].runs[0].text).toBe('Age');
    expect(meta.rows[1].cells[0].runs[0].text).toBe('Alice');
  });

  it('converts rows with 2 header rows', () => {
    const rows = [
      ['Category', 'Value'],
      ['Sub-cat', 'Unit'],
      ['A', '1'],
    ];
    const meta = csvToHtmlTableMeta(rows, 2);
    expect(meta.rows[0].header).toBe(true);
    expect(meta.rows[1].header).toBe(true);
    expect(meta.rows[2].header).toBe(false);
  });

  it('converts rows with 0 header rows', () => {
    const rows = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    const meta = csvToHtmlTableMeta(rows, 0);
    expect(meta.rows[0].header).toBe(false);
    expect(meta.rows[1].header).toBe(false);
  });

  it('converts newlines within cells to hardbreak runs', () => {
    const rows = [
      ['Header'],
      ['line1\nline2\nline3'],
    ];
    const meta = csvToHtmlTableMeta(rows, 1);
    const bodyCell = meta.rows[1].cells[0];
    // Should have: text("line1"), hardbreak, text("line2"), hardbreak, text("line3")
    expect(bodyCell.runs.length).toBe(5);
    expect(bodyCell.runs[0]).toEqual({ type: 'text', text: 'line1' });
    expect(bodyCell.runs[1]).toEqual({ type: 'hardbreak', text: '' });
    expect(bodyCell.runs[2]).toEqual({ type: 'text', text: 'line2' });
    expect(bodyCell.runs[3]).toEqual({ type: 'hardbreak', text: '' });
    expect(bodyCell.runs[4]).toEqual({ type: 'text', text: 'line3' });
  });

  it('handles empty cells', () => {
    const rows = [
      ['Header'],
      [''],
    ];
    const meta = csvToHtmlTableMeta(rows, 1);
    const bodyCell = meta.rows[1].cells[0];
    expect(bodyCell.runs.length).toBe(1);
    expect(bodyCell.runs[0]).toEqual({ type: 'text', text: '' });
  });

  it('HTML-escapes cell content', () => {
    const rows = [
      ['Header'],
      ['<b>bold</b> & "quoted"'],
    ];
    const meta = csvToHtmlTableMeta(rows, 1);
    const text = meta.rows[1].cells[0].runs[0].text;
    expect(text).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;');
  });
});
