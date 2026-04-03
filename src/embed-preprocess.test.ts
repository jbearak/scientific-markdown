import { describe, it, expect } from 'bun:test';
import { parseEmbedDirective, preprocessEmbeds, type EmbedResolver } from './embed-preprocess';

// ---------------------------------------------------------------------------
// parseEmbedDirective
// ---------------------------------------------------------------------------

describe('parseEmbedDirective', () => {
  it('parses a bare path with no params', () => {
    const result = parseEmbedDirective('<!-- embed: data/table.csv -->');
    expect(result).toEqual({ path: 'data/table.csv' });
  });

  it('parses a double-quoted path', () => {
    const result = parseEmbedDirective('<!-- embed: "my data/table.csv" -->');
    expect(result).toEqual({ path: 'my data/table.csv' });
  });

  it('parses a single-quoted path', () => {
    const result = parseEmbedDirective("<!-- embed: 'my data/table.csv' -->");
    expect(result).toEqual({ path: 'my data/table.csv' });
  });

  it('parses path with all XLSX params', () => {
    const result = parseEmbedDirective('<!-- embed: data/results.xlsx sheet=Demographics range=A1:F20 headers=2 -->');
    expect(result).toEqual({
      path: 'data/results.xlsx',
      sheet: 'Demographics',
      range: 'A1:F20',
      headers: 2,
    });
  });

  it('parses quoted sheet name', () => {
    const result = parseEmbedDirective('<!-- embed: data/results.xlsx sheet="Sheet One" -->');
    expect(result).toEqual({
      path: 'data/results.xlsx',
      sheet: 'Sheet One',
    });
  });

  it('parses single-quoted sheet name', () => {
    const result = parseEmbedDirective("<!-- embed: data/results.xlsx sheet='Sheet One' -->");
    expect(result).toEqual({
      path: 'data/results.xlsx',
      sheet: 'Sheet One',
    });
  });

  it('parses named range', () => {
    const result = parseEmbedDirective('<!-- embed: data/results.xlsx range=MyNamedRange -->');
    expect(result).toEqual({
      path: 'data/results.xlsx',
      range: 'MyNamedRange',
    });
  });

  it('parses headers param for CSV', () => {
    const result = parseEmbedDirective('<!-- embed: data/table.csv headers=3 -->');
    expect(result).toEqual({
      path: 'data/table.csv',
      headers: 3,
    });
  });

  it('parses headers=0', () => {
    const result = parseEmbedDirective('<!-- embed: data/table.csv headers=0 -->');
    expect(result).toEqual({
      path: 'data/table.csv',
      headers: 0,
    });
  });

  it('handles extra whitespace', () => {
    const result = parseEmbedDirective('<!--   embed:   data/table.csv   headers=1   -->');
    expect(result).toEqual({
      path: 'data/table.csv',
      headers: 1,
    });
  });

  it('returns null for non-embed comments', () => {
    expect(parseEmbedDirective('<!-- table-font-size: 12 -->')).toBeNull();
    expect(parseEmbedDirective('<!-- landscape -->')).toBeNull();
    expect(parseEmbedDirective('not a comment')).toBeNull();
  });

  it('returns null for empty embed path', () => {
    expect(parseEmbedDirective('<!-- embed: -->')).toBeNull();
  });

  it('handles quoted path with all quoted params', () => {
    const result = parseEmbedDirective('<!-- embed: "data/file.xlsx" sheet="My Sheet" range="A1:Z100" headers="2" -->');
    expect(result).toEqual({
      path: 'data/file.xlsx',
      sheet: 'My Sheet',
      range: 'A1:Z100',
      headers: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// preprocessEmbeds
// ---------------------------------------------------------------------------

/** In-memory resolver for testing. */
function makeTestResolver(files: Record<string, string | Uint8Array>): EmbedResolver {
  return {
    readFile(absolutePath: string): Uint8Array | null {
      const content = files[absolutePath];
      if (content === undefined) return null;
      if (typeof content === 'string') return new TextEncoder().encode(content);
      return content;
    },
    resolveRelative(basePath: string, relativePath: string): string {
      // Simple path join for testing
      const baseDir = basePath.replace(/\/[^/]*$/, '');
      return baseDir + '/' + relativePath;
    },
  };
}

describe('preprocessEmbeds', () => {
  it('replaces a CSV embed with an HTML table', () => {
    const resolver = makeTestResolver({
      '/doc/data.csv': 'Name,Age\nAlice,30\nBob,25',
    });
    const input = '# Title\n\n<!-- embed: data.csv -->\n\nMore text';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('<table>');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
    expect(result).not.toContain('<!-- embed:');
    // Should still have surrounding content
    expect(result).toContain('# Title');
    expect(result).toContain('More text');
  });

  it('replaces a TSV embed with an HTML table', () => {
    const resolver = makeTestResolver({
      '/doc/data.tsv': 'Name\tAge\nAlice\t30',
    });
    const input = '<!-- embed: data.tsv -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('<table>');
    expect(result).toContain('Alice');
  });

  it('replaces an .md embed with extracted table content', () => {
    const resolver = makeTestResolver({
      '/doc/table.md': 'Some text\n\n<table><tr><th>A</th></tr><tr><td>1</td></tr></table>\n\nMore text',
    });
    const input = '<!-- embed: table.md -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('<table>');
    // Non-table content should be dropped
    expect(result).not.toContain('Some text');
    expect(result).not.toContain('More text');
  });

  it('preserves table directives from embedded .md files', () => {
    const resolver = makeTestResolver({
      '/doc/table.md': '<!-- table-font-size: 9 -->\n\n<table><tr><th>A</th></tr><tr><td>1</td></tr></table>',
    });
    const input = '<!-- embed: table.md -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('table-font-size: 9');
    expect(result).toContain('<table>');
  });

  it('respects the headers parameter for CSV', () => {
    const resolver = makeTestResolver({
      '/doc/data.csv': 'A,B\nC,D\n1,2',
    });
    const input = '<!-- embed: data.csv headers=2 -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('<th>');
    // Both A and C rows should be headers
    const thMatches = result.match(/<th>/g);
    expect(thMatches?.length).toBe(4); // 2 headers x 2 columns
  });

  it('emits an error placeholder for missing files', () => {
    const resolver = makeTestResolver({});
    const input = '<!-- embed: missing.csv -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('Error');
    expect(result).toContain('missing.csv');
    expect(result).not.toContain('<table>');
  });

  it('skips embed directives inside fenced code blocks', () => {
    const resolver = makeTestResolver({
      '/doc/data.csv': 'a,b\n1,2',
    });
    const input = '```\n<!-- embed: data.csv -->\n```';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    // Should remain unchanged
    expect(result).toBe(input);
  });

  it('handles multiple embeds in one document', () => {
    const resolver = makeTestResolver({
      '/doc/a.csv': 'x,y\n1,2',
      '/doc/b.csv': 'p,q\n3,4',
    });
    const input = '<!-- embed: a.csv -->\n\nSome text\n\n<!-- embed: b.csv -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('1');
    expect(result).toContain('3');
    expect(result).toContain('Some text');
  });

  it('ensures blank lines around the replacement', () => {
    const resolver = makeTestResolver({
      '/doc/data.csv': 'a,b\n1,2',
    });
    const input = 'Before\n<!-- embed: data.csv -->\nAfter';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');
    const lines = result.split('\n');

    // Find the table start
    const tableIdx = lines.findIndex(l => l.includes('<table>'));
    expect(tableIdx).toBeGreaterThan(0);
    // Line before table should be blank
    expect(lines[tableIdx - 1].trim()).toBe('');
    // Find end of table
    const tableEndIdx = lines.findIndex(l => l.includes('</table>'));
    // Line after table should be blank
    if (tableEndIdx < lines.length - 1) {
      expect(lines[tableEndIdx + 1].trim()).toBe('');
    }
  });

  it('handles quoted path with spaces', () => {
    const resolver = makeTestResolver({
      '/doc/my data/table.csv': 'a,b\n1,2',
    });
    const input = '<!-- embed: "my data/table.csv" -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).toContain('<table>');
  });

  it('handles CSV with headers=0 (no header rows)', () => {
    const resolver = makeTestResolver({
      '/doc/data.csv': 'a,b\n1,2',
    });
    const input = '<!-- embed: data.csv headers=0 -->';
    const result = preprocessEmbeds(input, resolver, '/doc/file.md');

    expect(result).not.toContain('<th>');
    expect(result).toContain('<td>');
  });

  it('resolves paths relative to the markdown file', () => {
    const resolver = makeTestResolver({
      '/project/docs/data/table.csv': 'a,b\n1,2',
    });
    const input = '<!-- embed: data/table.csv -->';
    const result = preprocessEmbeds(input, resolver, '/project/docs/file.md');

    expect(result).toContain('<table>');
  });
});
