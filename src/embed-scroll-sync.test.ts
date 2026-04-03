import { describe, it, expect } from 'bun:test';
import { preprocessEmbedsWithMap, type EmbedResolver } from './embed-preprocess';

/** In-memory resolver for testing. */
function makeTestResolver(files: Record<string, string>): EmbedResolver {
  return {
    readFile(absolutePath: string): Uint8Array | null {
      const content = files[absolutePath];
      if (content === undefined) return null;
      return new TextEncoder().encode(content);
    },
    resolveRelative(basePath: string, relativePath: string): string {
      const baseDir = basePath.replace(/\/[^/]*$/, '');
      return baseDir + '/' + relativePath;
    },
  };
}

describe('preprocessEmbedsWithMap', () => {
  it('returns identity map when no embeds present', () => {
    const resolver = makeTestResolver({});
    const src = 'Hello\n\nWorld\n';
    const { output, map } = preprocessEmbedsWithMap(src, resolver, '/doc/file.md');
    expect(output).toBe(src);
    expect(map.isIdentity).toBe(true);
  });

  it('remaps lines after an expanded embed to correct original positions', () => {
    const resolver = makeTestResolver({
      '/doc/data.csv': 'Name,Age\nAlice,30\nBob,25',
    });
    const src = [
      'Before line 0',            // 0
      '',                          // 1
      '<!-- embed: data.csv -->', // 2  (1 line → expands to multi-line table)
      '',                          // 3
      'After line 4',             // 4
    ].join('\n');

    const { output, map } = preprocessEmbedsWithMap(src, resolver, '/doc/file.md');
    const outLines = output.split('\n');

    // "Before line 0" should still be on preprocessed line 0
    expect(map.remap(0)).toBe(0);

    // Find "After line 4" in the output
    const afterIdx = outLines.indexOf('After line 4');
    expect(afterIdx).toBeGreaterThan(-1);
    // It should remap to original line 4
    expect(map.remap(afterIdx)).toBe(4);
  });

  it('remaps correctly with multiple embeds', () => {
    const resolver = makeTestResolver({
      '/doc/a.csv': 'x,y\n1,2',
      '/doc/b.csv': 'p,q\n3,4',
    });
    const src = [
      'Before',                     // 0
      '',                            // 1
      '<!-- embed: a.csv -->',      // 2
      '',                            // 3
      'Middle',                      // 4
      '',                            // 5
      '<!-- embed: b.csv -->',      // 6
      '',                            // 7
      'After',                       // 8
    ].join('\n');

    const { output, map } = preprocessEmbedsWithMap(src, resolver, '/doc/file.md');
    const outLines = output.split('\n');

    expect(map.remap(0)).toBe(0);

    const middleIdx = outLines.indexOf('Middle');
    expect(middleIdx).toBeGreaterThan(-1);
    expect(map.remap(middleIdx)).toBe(4);

    const afterIdx = outLines.indexOf('After');
    expect(afterIdx).toBeGreaterThan(-1);
    expect(map.remap(afterIdx)).toBe(8);
  });

  it('handles missing file without disrupting line mapping', () => {
    const resolver = makeTestResolver({});
    const src = [
      'Before',                           // 0
      '',                                  // 1
      '<!-- embed: missing.csv -->',      // 2
      '',                                  // 3
      'After',                             // 4
    ].join('\n');

    const { output, map } = preprocessEmbedsWithMap(src, resolver, '/doc/file.md');
    const outLines = output.split('\n');

    const afterIdx = outLines.indexOf('After');
    expect(afterIdx).toBeGreaterThan(-1);
    expect(map.remap(afterIdx)).toBe(4);
  });
});
