import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

const repoRoot = join(__dirname, '..');

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function firstDisplayMathBody(md: string): string {
  const match = md.match(/\$\$\n([\s\S]*?)\n\$\$/);
  return match ? match[1] : '';
}

describe('sample roundtrip regressions', () => {
  it('md→docx→md preserves math whitespace and aligned display line breaks', async () => {
    const sampleMd = readFileSync(join(repoRoot, 'sample.md'), 'utf8');
    const sampleBib = readFileSync(join(repoRoot, 'sample.bib'), 'utf8');
    const { docx, warnings } = await convertMdToDocx(sampleMd, { bibtex: sampleBib });
    expect(warnings).toEqual([]);

    const rt = await convertDocx(docx);
    const body = stripFrontmatter(rt.markdown);

    expect(body).toContain('$n = 74$');
    expect(body).toContain('\\cdot P');
    expect(body).not.toContain('\\cdotP');

    const display = firstDisplayMathBody(body);
    expect(display).toContain('\\begin{aligned}');
    expect(display).toMatch(/\\begin\{aligned\}\n[\s\S]*\\\\\n[\s\S]*\\end\{aligned\}/);
    expect(display).not.toContain('\\begin{aligned} F(');
  });

  it('bare email round-trips without mailto: wrapping (Bug 1)', async () => {
    const md = 'Contact jbearak@guttmacher.org for info.';
    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    const body = stripFrontmatter(rt.markdown);
    expect(body).toContain('jbearak@guttmacher.org');
    expect(body).not.toContain('[jbearak@guttmacher.org](mailto:');
  });

  it('asterisk round-trips escaped (Bug 2)', async () => {
    const md = '<sup>1</sup>\\* Corresponding author';
    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    const body = stripFrontmatter(rt.markdown);
    expect(body).toContain('\\*');
    expect(body).not.toMatch(/(?<!\\)\* Corresponding/);
  });

  it('ordered list start number round-trips (Bug 3)', async () => {
    const md = '2. University of Pittsburgh\n3. Third item';
    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    const body = stripFrontmatter(rt.markdown);
    // First item must start at 2, second at 3
    expect(body).toMatch(/^2\./m);
    expect(body).toMatch(/^3\./m);
  });

  it('custom style blocks preserve inline items (Bug 4)', async () => {
    const md = '<!-- style: MyStyle -->\n\nFirst para\n\n![img](test.png)\n\nSecond para\n\n<!-- /style -->';
    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    const body = stripFrontmatter(rt.markdown);
    expect(body).toContain('<!-- style: mystyle -->');
    expect(body).toContain('<!-- /style -->');
    // The style block should not be closed prematurely by the image
    const styleOpen = body.indexOf('<!-- style: mystyle -->');
    const styleClose = body.indexOf('<!-- /style -->');
    expect(body.substring(styleOpen, styleClose)).toContain('Second para');
  });

  it('bold text containing inline math stays grouped (Bug 5)', async () => {
    const md = '**Ex. 1: $y = Y$ and $k = 1$**';
    const { docx } = await convertMdToDocx(md);
    const rt = await convertDocx(docx);
    const body = stripFrontmatter(rt.markdown);
    expect(body).toContain('**Ex. 1: $y = Y$ and $k = 1$**');
  });

  it('Word-saved DOCX converts without blockquote loss, hidden _bqg leakage, or spurious \\mathrm insertions', async () => {
    const savedPath = join(repoRoot, 'sample_saved.docx');
    if (!existsSync(savedPath)) {
      console.log('SKIP: sample_saved.docx not found (must be created by opening sample.docx in Word and saving)');
      return;
    }
    const savedDocx = new Uint8Array(readFileSync(savedPath));
    const rt = await convertDocx(savedDocx);
    const body = stripFrontmatter(rt.markdown);

    expect(body).toContain('> "We dare not trust our wit for making our house pleasant to our friend, so we buy ice cream."');
    expect(body).not.toContain('_bqg');

    expect(body).toContain('$n = 74$');
    expect(body).toContain('\\cdot P');
    expect(body).not.toContain('\\cdotP');
    expect(body).not.toContain('\\mathrm{');

    const display = firstDisplayMathBody(body);
    expect(display).toContain('\\begin{aligned}');
    expect(display).toMatch(/\\begin\{aligned\}\n[\s\S]*\\\\\n[\s\S]*\\end\{aligned\}/);
  });
});
