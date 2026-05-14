import { describe, test, expect } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

async function readStylesXml(docx: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  return (await zip.file('word/styles.xml')!.async('string'));
}

async function readDocumentXml(docx: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  return (await zip.file('word/document.xml')!.async('string'));
}

async function readCustomXml(docx: Uint8Array): Promise<string | null> {
  const zip = await JSZip.loadAsync(docx);
  const file = zip.file('docProps/custom.xml');
  return file ? await file.async('string') : null;
}

describe('Confluence panel round-trip', () => {
  test('defines Confluence panel Word styles', async () => {
    const md = '~~~panel type=info\nHello\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const stylesXml = await readStylesXml(buffer);
    expect(stylesXml).toContain('w:styleId="PanelInfo"');
    expect(stylesXml).toContain('w:styleId="PanelError"');
    expect(stylesXml).toContain('w:styleId="PanelSuccess"');
    expect(stylesXml).toContain('w:styleId="PanelNote"');
  });

  test('panel fence produces PanelInfo Word paragraph style', async () => {
    const md = '~~~panel type=info\nHello world\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const docXml = await readDocumentXml(buffer);
    expect(docXml).toContain('<w:pStyle w:val="PanelInfo"/>');
  });

  test('writes MANUSCRIPT_CALLOUT_SYNTAX_ custom prop for panel groups', async () => {
    const md = '~~~panel type=success\nDone\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const customXml = await readCustomXml(buffer);
    expect(customXml).not.toBeNull();
    expect(customXml).toContain('MANUSCRIPT_CALLOUT_SYNTAX_');
  });

  test('round-trip: panel fence preserved through docx import', async () => {
    const md = '~~~panel type=info\nHello\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(buffer);
    expect(markdown).toContain('~~~panel type=info');
    expect(markdown).toContain('~~~');
    expect(markdown).not.toContain('> [!INFO]');
  });

  test('round-trip: GFM blockquote alert still emits blockquote form', async () => {
    const md = '> [!NOTE]\n> Body\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(buffer);
    expect(markdown).toContain('> [!NOTE]');
    expect(markdown).not.toContain('~~~panel');
  });

  test('round-trip: panel type=note with callout-style: confluence uses PanelNote (purple)', async () => {
    const md = '---\ncallout-style: confluence\n---\n\n~~~panel type=note\nPurple note\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const docXml = await readDocumentXml(buffer);
    expect(docXml).toContain('<w:pStyle w:val="PanelNote"/>');
  });

  test('round-trip: panel type=note with default (github) style uses GitHubNote', async () => {
    const md = '~~~panel type=note\nNote content\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const docXml = await readDocumentXml(buffer);
    expect(docXml).toContain('<w:pStyle w:val="GitHubNote"/>');
  });

  test('recognizes [!INFO] blockquote marker', async () => {
    const md = '> [!INFO]\n> Informational\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const docXml = await readDocumentXml(buffer);
    expect(docXml).toContain('<w:pStyle w:val="PanelInfo"/>');
  });

  test('persists callout-style frontmatter through docx → md', async () => {
    const md = '---\ncallout-style: confluence\n---\n\n~~~panel type=note\nPurple note\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const customXml = await readCustomXml(buffer);
    expect(customXml).toContain('MANUSCRIPT_CALLOUT_STYLE_');
    const { markdown } = await convertDocx(buffer);
    expect(markdown).toContain('callout-style: confluence');
  });

  test('two full round-trips keep PanelNote (purple) under callout-style: confluence', async () => {
    const md = '---\ncallout-style: confluence\n---\n\n~~~panel type=note\nPurple note\n~~~\n';
    const first = await convertMdToDocx(md);
    const { markdown: round1 } = await convertDocx(first.docx);
    const second = await convertMdToDocx(round1);
    const docXml = await readDocumentXml(second.docx);
    expect(docXml).toContain('<w:pStyle w:val="PanelNote"/>');
    expect(docXml).not.toContain('<w:pStyle w:val="GitHubNote"/>');
  });

  test('panel containing a bullet list preserves the list (numPr emitted)', async () => {
    const md = '~~~panel type=info\nLead paragraph\n\n- item one\n- item two\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const docXml = await readDocumentXml(buffer);
    // The lead paragraph still has the panel style.
    expect(docXml).toContain('<w:pStyle w:val="PanelInfo"/>');
    // And the list items carry numPr (bullet) instead of being flattened.
    expect(docXml).toContain('<w:numPr>');
  });

  test('panel containing a fenced code block preserves the CodeBlock style', async () => {
    const md = '~~~panel type=info\nLead paragraph\n\n```js\nconsole.log(1)\n```\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const docXml = await readDocumentXml(buffer);
    expect(docXml).toContain('<w:pStyle w:val="PanelInfo"/>');
    expect(docXml).toContain('<w:pStyle w:val="CodeBlock"/>');
  });

  test('GFM alert containing a bullet list preserves list numbering (unified fix)', async () => {
    const md = '> [!NOTE]\n> Lead line\n>\n> - item1\n> - item2\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const docXml = await readDocumentXml(buffer);
    expect(docXml).toContain('<w:pStyle w:val="GitHubNote"/>');
    expect(docXml).toContain('<w:numPr>');
  });

  test('default callout-style: github is not persisted', async () => {
    const md = '~~~panel type=info\nHi\n~~~\n';
    const { docx: buffer } = await convertMdToDocx(md);
    const customXml = await readCustomXml(buffer);
    // Absent or not mentioning MANUSCRIPT_CALLOUT_STYLE_ since github is default.
    if (customXml) {
      expect(customXml).not.toContain('MANUSCRIPT_CALLOUT_STYLE_');
    }
  });
});
