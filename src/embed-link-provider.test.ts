import { describe, it, expect } from 'bun:test';
import { findEmbedPathRanges } from './embed-link-provider';

describe('findEmbedPathRanges', () => {
  it('finds a bare path', () => {
    const text = '<!-- embed: data/table.csv -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/table.csv');
  });

  it('finds a double-quoted path', () => {
    const text = '<!-- embed: "my data/table.csv" -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('my data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('my data/table.csv');
  });

  it('finds a single-quoted path', () => {
    const text = "<!-- embed: 'my data/table.csv' -->";
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('my data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('my data/table.csv');
  });

  it('finds path with XLSX params (only path portion)', () => {
    const text = '<!-- embed: data/results.xlsx sheet=Demographics range=A1:F20 -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('data/results.xlsx');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/results.xlsx');
  });

  it('finds multiple directives across lines', () => {
    const text = [
      'Some text',
      '<!-- embed: one.csv -->',
      '',
      '<!-- embed: two.tsv -->',
    ].join('\n');
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].path).toBe('one.csv');
    expect(ranges[1].path).toBe('two.tsv');
    // Verify columns by slicing the individual lines
    const lines = text.split('\n');
    expect(lines[ranges[0].line].slice(ranges[0].startCol, ranges[0].endCol)).toBe('one.csv');
    expect(lines[ranges[1].line].slice(ranges[1].startCol, ranges[1].endCol)).toBe('two.tsv');
  });

  it('skips directives inside fenced code blocks', () => {
    const text = [
      '```',
      '<!-- embed: inside-fence.csv -->',
      '```',
      '<!-- embed: outside.csv -->',
    ].join('\n');
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('outside.csv');
  });

  it('handles indented directive', () => {
    const text = '  <!-- embed: data/table.csv -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/table.csv');
  });

  it('returns empty for non-embed comments', () => {
    const text = '<!-- table-font: Arial -->';
    expect(findEmbedPathRanges(text)).toEqual([]);
  });

  it('returns empty for text with no directives', () => {
    expect(findEmbedPathRanges('just some text')).toEqual([]);
    expect(findEmbedPathRanges('')).toEqual([]);
  });

  it('handles extra whitespace around embed keyword', () => {
    const text = '<!--   embed:   data/table.csv   -->';
    const ranges = findEmbedPathRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].path).toBe('data/table.csv');
    expect(text.slice(ranges[0].startCol, ranges[0].endCol)).toBe('data/table.csv');
  });
});
