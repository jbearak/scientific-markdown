import { describe, expect, it } from 'bun:test';
import { maskFrontmatter } from './frontmatter';
import { scanOrientationDirectives } from './orientation-scan';

describe('maskFrontmatter', () => {
  it('masks directive-like comments in YAML frontmatter while preserving body offsets', () => {
    const markdown = '---\nabstract: |\n  <!-- portrait -->\n---\n\nBody\n<!-- landscape -->';
    const masked = maskFrontmatter(markdown);

    expect(masked).toHaveLength(markdown.length);
    expect(masked.endsWith('Body\n<!-- landscape -->')).toBe(true);
    expect(scanOrientationDirectives(masked)).toEqual([
      expect.objectContaining({ kind: 'unclosed', directiveName: 'landscape' }),
    ]);
  });

  it('returns the original text when no frontmatter is present', () => {
    const markdown = 'Body\n<!-- landscape -->';
    expect(maskFrontmatter(markdown)).toBe(markdown);
  });
});
