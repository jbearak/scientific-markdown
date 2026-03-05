import { describe, it, expect } from 'bun:test';
import {
  stylesXml,
  resolveFontOverrides,
  applyFontOverridesToTemplate,
  convertMdToDocx,
  parseMd,
  type FontOverrides,
} from './md-to-docx';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { extractHtmlTables } from './html-table-parser';

// Helper: extract a <w:style ...styleId="X"...>...</w:style> block from styles XML
function extractStyleBlock(xml: string, styleId: string): string | null {
  const re = new RegExp(
    '<w:style\\b[^>]*\\bw:styleId="' + styleId + '"[^>]*>[\\s\\S]*?</w:style>'
  );
  const m = re.exec(xml);
  return m ? m[0] : null;
}

// Helper: extract w:sz val from a style block
function extractSzVal(block: string): number | null {
  const m = /w:sz w:val="(\d+)"/.exec(block);
  return m ? parseInt(m[1], 10) : null;
}

// Helper: extract w:rFonts ascii from a style block
function extractRFontsAscii(block: string): string | null {
  const m = /w:rFonts w:ascii="([^"]*)"/.exec(block);
  return m ? m[1] : null;
}

describe('Font customization unit tests', () => {
  // ---------------------------------------------------------------
  // 1. Default behavior: no font fields → styles identical to current output
  // Validates: Requirement 3.6
  // ---------------------------------------------------------------
  describe('default behavior (no overrides)', () => {
    it('produces default styles when no overrides are given', () => {
      const xml = stylesXml();
      const xmlWithUndefined = stylesXml(undefined);
      expect(xml).toBe(xmlWithUndefined);

      // Normal: sz=22
      const normal = extractStyleBlock(xml, 'Normal')!;
      expect(normal).toBeDefined();
      expect(extractSzVal(normal)).toBe(22);

      // Heading1: sz=32
      const h1 = extractStyleBlock(xml, 'Heading1')!;
      expect(extractSzVal(h1)).toBe(32);

      // CodeBlock: sz=20, font=Consolas
      const codeBlock = extractStyleBlock(xml, 'CodeBlock')!;
      expect(extractSzVal(codeBlock)).toBe(20);
      expect(extractRFontsAscii(codeBlock)).toBe('Consolas');

      // CodeChar: font=Consolas, no explicit size
      const codeChar = extractStyleBlock(xml, 'CodeChar')!;
      expect(extractRFontsAscii(codeChar)).toBe('Consolas');
    });
  });

  // ---------------------------------------------------------------
  // 2. Specific example: font-size: 14 → Normal=28hp, H1=41hp, CodeBlock=26hp
  // Validates: Requirements 2.1, 3.3, 3.5
  // ---------------------------------------------------------------
  describe('font-size: 14 example', () => {
    it('resolves correct half-point sizes', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: 14\n---\n');
      expect(metadata.fontSize).toBe(14);

      const overrides = resolveFontOverrides(metadata)!;
      expect(overrides).toBeDefined();
      expect(overrides.bodySizeHp).toBe(28);
      // Inferred code size: 28 - 2 = 26
      expect(overrides.codeSizeHp).toBe(26);
    });

    it('generates correct style sizes in XML', () => {
      const overrides = resolveFontOverrides({ fontSize: 14 })!;
      const xml = stylesXml(overrides);

      const normal = extractStyleBlock(xml, 'Normal')!;
      expect(extractSzVal(normal)).toBe(28);

      // H1: Math.round(32 / 22 * 28) = Math.round(40.727...) = 41
      const h1 = extractStyleBlock(xml, 'Heading1')!;
      expect(extractSzVal(h1)).toBe(41);

      const codeBlock = extractStyleBlock(xml, 'CodeBlock')!;
      expect(extractSzVal(codeBlock)).toBe(26);
    });
  });

  // ---------------------------------------------------------------
  // 3. Edge cases: invalid font-size values → ignored
  // Validates: Requirements 1.5, 1.6
  // ---------------------------------------------------------------
  describe('invalid font-size values', () => {
    it('font-size: abc → fontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: abc\n---\n');
      expect(metadata.fontSize).toBeUndefined();
    });

    it('font-size: -5 → fontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: -5\n---\n');
      expect(metadata.fontSize).toBeUndefined();
    });

    it('font-size: 0 → fontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: 0\n---\n');
      expect(metadata.fontSize).toBeUndefined();
    });

    it('code-font-size: abc → codeFontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\ncode-font-size: abc\n---\n');
      expect(metadata.codeFontSize).toBeUndefined();
    });

    it('code-font-size: -5 → codeFontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\ncode-font-size: -5\n---\n');
      expect(metadata.codeFontSize).toBeUndefined();
    });

    it('code-font-size: 0 → codeFontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\ncode-font-size: 0\n---\n');
      expect(metadata.codeFontSize).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // 4. Edge case: font-size: 1 → code-font-size clamped to minimum
  // Validates: Requirement 2.1 (clamping)
  // ---------------------------------------------------------------
  describe('font-size: 1 clamping', () => {
    it('clamps inferred codeSizeHp to minimum 1', () => {
      const overrides = resolveFontOverrides({ fontSize: 1 })!;
      expect(overrides).toBeDefined();
      // bodySizeHp = 1 * 2 = 2
      expect(overrides.bodySizeHp).toBe(2);
      // codeSizeHp = Math.max(1, 2 - 2) = Math.max(1, 0) = 1
      expect(overrides.codeSizeHp).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // 5. Template passthrough: no overrides → unmodified
  // Validates: Requirement 4.2
  // ---------------------------------------------------------------
  describe('template passthrough', () => {
    it('returns undefined overrides when no font fields set', () => {
      const overrides = resolveFontOverrides({});
      expect(overrides).toBeUndefined();
    });

    it('leaves template unmodified when overrides have no applicable values', () => {
      const templateXml =
        '<?xml version="1.0"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:styleId="Normal">' +
        '<w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
        '</w:style>' +
        '</w:styles>';
      const bytes = new TextEncoder().encode(templateXml);

      // Override with only codeFont set — Normal is not a code style, so it won't be modified
      const codeFontOnlyOverrides: FontOverrides = {
        codeFont: 'Courier',
      };
      const result = applyFontOverridesToTemplate(bytes, codeFontOnlyOverrides);
      // Normal is not a code style, so codeFont doesn't affect it → template unchanged
      expect(result).toBe(templateXml);
    });

    it('modifies the style-level rPr, not the one nested inside pPr', () => {
      const templateXml =
        '<?xml version="1.0"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:styleId="Normal">' +
        '<w:pPr><w:keepNext/><w:rPr><w:b/></w:rPr></w:pPr>' +
        '<w:rPr><w:rFonts w:ascii="Times" w:hAnsi="Times"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
        '</w:style>' +
        '</w:styles>';
      const bytes = new TextEncoder().encode(templateXml);
      const overrides: FontOverrides = { bodyFont: 'Georgia', bodySizeHp: 28 };
      const result = applyFontOverridesToTemplate(bytes, overrides);
      // pPr-level rPr must be untouched
      expect(result).toContain('<w:pPr><w:keepNext/><w:rPr><w:b/></w:rPr></w:pPr>');
      // Style-level rPr must have the new font and size (old font removed)
      expect(result).toContain('<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>');
      expect(result).not.toContain('w:ascii="Times"');
      expect(result).toContain('<w:sz w:val="28"/>');
      expect(result).toContain('<w:szCs w:val="28"/>');
    });
  });

  // ---------------------------------------------------------------
  // 6. Integration: full convertMdToDocx with font frontmatter
  // Validates: Requirements 3.3, 3.5, 3.6
  // ---------------------------------------------------------------
  describe('integration: convertMdToDocx with font frontmatter', () => {
    it('applies font and size overrides to output DOCX styles', async () => {
      const markdown = '---\nfont: Georgia\nfont-size: 14\n---\nHello world';
      const result = await convertMdToDocx(markdown);
      expect(result.docx).toBeInstanceOf(Uint8Array);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);

      const stylesFile = zip.file('word/styles.xml');
      expect(stylesFile).toBeDefined();
      const stylesContent = await stylesFile!.async('string');

      // Normal: font=Georgia, sz=28
      const normal = extractStyleBlock(stylesContent, 'Normal')!;
      expect(normal).toBeDefined();
      expect(extractRFontsAscii(normal)).toBe('Georgia');
      expect(extractSzVal(normal)).toBe(28);

      // Heading1: font=Georgia, sz=41
      const h1 = extractStyleBlock(stylesContent, 'Heading1')!;
      expect(h1).toBeDefined();
      expect(extractRFontsAscii(h1)).toBe('Georgia');
      expect(extractSzVal(h1)).toBe(41);

      // CodeBlock: font=Consolas (default code font), sz=26 (inferred)
      const codeBlock = extractStyleBlock(stylesContent, 'CodeBlock')!;
      expect(codeBlock).toBeDefined();
      expect(extractRFontsAscii(codeBlock)).toBe('Consolas');
      expect(extractSzVal(codeBlock)).toBe(26);
    });

    it('uses default styles when no font frontmatter is present', async () => {
      const markdown = 'Just plain text';
      const result = await convertMdToDocx(markdown);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const stylesContent = await zip.file('word/styles.xml')!.async('string');

      // Should match default stylesXml() output
      const defaultXml = stylesXml();
      expect(stylesContent).toBe(defaultXml);
    });

    it('applies code-font override to code styles', async () => {
      const markdown = '---\ncode-font: Fira Code\n---\nSome text';
      const result = await convertMdToDocx(markdown);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const stylesContent = await zip.file('word/styles.xml')!.async('string');

      const codeBlock = extractStyleBlock(stylesContent, 'CodeBlock')!;
      expect(extractRFontsAscii(codeBlock)).toBe('Fira Code');

      const codeChar = extractStyleBlock(stylesContent, 'CodeChar')!;
      expect(extractRFontsAscii(codeChar)).toBe('Fira Code');
    });

    it('applies code-font override to code block run properties in document body', async () => {
      const markdown = '---\ncode-font: Fira Code\n---\n\n```\nhello\n```';
      const result = await convertMdToDocx(markdown);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');

      expect(docContent).toContain('w:ascii="Fira Code"');
      expect(docContent).toContain('w:hAnsi="Fira Code"');
      expect(docContent).not.toContain('w:ascii="Consolas"');
    });
  });

  // ---------------------------------------------------------------
  // 7. Table font frontmatter parsing
  // ---------------------------------------------------------------
  describe('table font frontmatter', () => {
    it('parses table-font and table-font-size', () => {
      const { metadata } = parseFrontmatter('---\ntable-font: Arial\ntable-font-size: 9\n---\n');
      expect(metadata.tableFont).toBe('Arial');
      expect(metadata.tableFontSize).toBe(9);
    });

    it('ignores invalid table-font-size', () => {
      const { metadata } = parseFrontmatter('---\ntable-font-size: abc\n---\n');
      expect(metadata.tableFontSize).toBeUndefined();
    });

    it('serializes table-font and table-font-size', () => {
      const fm = serializeFrontmatter({ tableFont: 'Arial', tableFontSize: 9 });
      expect(fm).toContain('table-font: Arial');
      expect(fm).toContain('table-font-size: 9');
    });
  });

  // ---------------------------------------------------------------
  // 8. resolveFontOverrides with table fields
  // ---------------------------------------------------------------
  describe('resolveFontOverrides table fields', () => {
    it('sets tableSizeHp from explicit table-font-size', () => {
      const overrides = resolveFontOverrides({ tableFontSize: 9 })!;
      expect(overrides).toBeDefined();
      expect(overrides.tableSizeHp).toBe(18);
    });

    it('sets tableFont from table-font', () => {
      const overrides = resolveFontOverrides({ tableFont: 'Arial' })!;
      expect(overrides).toBeDefined();
      expect(overrides.tableFont).toBe('Arial');
    });

    it('auto-shrinks: body - 2pt when only font-size is set', () => {
      const overrides = resolveFontOverrides({ fontSize: 12 })!;
      expect(overrides).toBeDefined();
      // body = 24hp, auto-shrink = 24 - 4 = 20hp = 10pt
      expect(overrides.tableSizeHp).toBe(20);
    });

    it('does not auto-shrink when table-font-size is explicit', () => {
      const overrides = resolveFontOverrides({ fontSize: 12, tableFontSize: 11 })!;
      expect(overrides.tableSizeHp).toBe(22);
    });

    it('does not auto-shrink when table-font is set without table-font-size', () => {
      const overrides = resolveFontOverrides({ fontSize: 12, tableFont: 'Arial' })!;
      // tableFont is set, so auto-shrink is skipped
      expect(overrides.tableSizeHp).toBeUndefined();
    });

    it('clamps auto-shrink to minimum 1hp', () => {
      const overrides = resolveFontOverrides({ fontSize: 1 })!;
      // body = 2hp, auto-shrink = max(1, 2 - 4) = 1
      expect(overrides.tableSizeHp).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // 9. stylesXml TableParagraph style output
  // ---------------------------------------------------------------
  describe('stylesXml TableParagraph', () => {
    it('includes TableParagraph when table overrides exist', () => {
      const overrides = resolveFontOverrides({ tableFontSize: 9 })!;
      const xml = stylesXml(overrides);
      const block = extractStyleBlock(xml, 'TableParagraph');
      expect(block).toBeDefined();
      expect(extractSzVal(block!)).toBe(18);
    });

    it('includes tableFont in TableParagraph', () => {
      const overrides = resolveFontOverrides({ tableFont: 'Arial', tableFontSize: 9 })!;
      const xml = stylesXml(overrides);
      const block = extractStyleBlock(xml, 'TableParagraph')!;
      expect(extractRFontsAscii(block)).toBe('Arial');
    });

    it('omits TableParagraph when no table overrides', () => {
      const xml = stylesXml();
      const block = extractStyleBlock(xml, 'TableParagraph');
      expect(block).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // 10. Per-table directive comment parsing in parseMd
  // ---------------------------------------------------------------
  describe('per-table directive parsing', () => {
    it('transfers table-font-size directive to table token', () => {
      const tokens = parseMd('<!-- table-font-size: 8 -->\n\n| A | B |\n|---|---|\n| 1 | 2 |');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFontSize).toBe(8);
      // Directive comment should be spliced out
      expect(tokens.filter(t => t.runs.some(r => r.type === 'html_comment' && r.text.includes('table-font-size')))).toHaveLength(0);
    });

    it('transfers table-font directive to table token', () => {
      const tokens = parseMd('<!-- table-font: Times New Roman -->\n\n| A |\n|---|\n| 1 |');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFont).toBe('Times New Roman');
    });

    it('ignores directives not followed by a table', () => {
      const tokens = parseMd('<!-- table-font-size: 8 -->\n\nHello');
      expect(tokens.filter(t => t.runs.some(r => r.type === 'html_comment'))).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------
  // 11. HTML table data-font-size / data-font attribute parsing
  // ---------------------------------------------------------------
  describe('HTML table font attributes', () => {
    it('extracts data-font-size from <table> tag', () => {
      const tables = extractHtmlTables('<table data-font-size="8"><tr><td>A</td></tr></table>');
      expect(tables).toHaveLength(1);
      expect(tables[0].fontSize).toBe(8);
    });

    it('extracts data-font from <table> tag', () => {
      const tables = extractHtmlTables('<table data-font="Arial"><tr><td>A</td></tr></table>');
      expect(tables).toHaveLength(1);
      expect(tables[0].font).toBe('Arial');
    });

    it('parseMd transfers HTML table data attributes to MdToken', () => {
      const tokens = parseMd('<table data-font-size="8" data-font="Arial"><tr><td>A</td></tr></table>');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFontSize).toBe(8);
      expect(tables[0].tableFont).toBe('Arial');
    });
  });

  // ---------------------------------------------------------------
  // 12. Integration: table cell paragraphs get font styling in docx
  // ---------------------------------------------------------------
  describe('integration: table font in docx output', () => {
    it('applies table-font-size to table cell paragraphs', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');
      // Should have TableParagraph style reference and size 18hp (9pt)
      expect(docContent).toContain('w:val="TableParagraph"');
      const stylesContent = await zip.file('word/styles.xml')!.async('string');
      const block = extractStyleBlock(stylesContent, 'TableParagraph')!;
      expect(block).toBeDefined();
      expect(extractSzVal(block)).toBe(18);
    });

    it('auto-shrinks table font when font-size is set', async () => {
      const markdown = '---\nfont-size: 12\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const stylesContent = await zip.file('word/styles.xml')!.async('string');
      const block = extractStyleBlock(stylesContent, 'TableParagraph')!;
      expect(block).toBeDefined();
      // 12pt body = 24hp, auto-shrink = 20hp = 10pt
      expect(extractSzVal(block)).toBe(20);
    });

    it('per-table directive overrides document-level table font', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n<!-- table-font-size: 7 -->\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');
      // Per-table override: 7pt = 14hp, should appear as inline rPr
      expect(docContent).toContain('w:val="14"');
    });

    it('HTML table data-font-size applies to cell paragraphs', async () => {
      const markdown = '<table data-font-size="8"><tr><td>A</td></tr></table>';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');
      // 8pt = 16hp
      expect(docContent).toContain('w:val="16"');
    });
  });

  // ---------------------------------------------------------------
  // 13. Round-trip: md → docx → md
  // ---------------------------------------------------------------
  describe('round-trip table font', () => {
    it('round-trips document-level table-font-size', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      expect(metadata.tableFontSize).toBe(9);
    });

    it('round-trips document-level table-font', async () => {
      const markdown = '---\ntable-font: Arial\ntable-font-size: 9\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      expect(metadata.tableFont).toBe('Arial');
      expect(metadata.tableFontSize).toBe(9);
    });

    it('auto-shrink does not emit table-font-size in round-trip', async () => {
      const markdown = '---\nfont-size: 12\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      // Auto-shrink = body - 2pt. Should NOT be emitted since it matches the default.
      expect(metadata.tableFontSize).toBeUndefined();
    });

    it('round-trips per-table font-size directive for pipe tables', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n<!-- table-font-size: 7 -->\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('<!-- table-font-size: 7 -->');
    });

    it('round-trips per-table font-size for HTML tables via data-font-size', async () => {
      const markdown = '---\ntable-font-size: 9\npipe-table-max-line-width: 0\n---\n\n<table data-font-size="7">\n  <tr>\n    <td>\n      <p>A</p>\n    </td>\n  </tr>\n</table>';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('data-font-size="7"');
    });
  });
});
