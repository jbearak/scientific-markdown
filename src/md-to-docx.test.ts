import { describe, it, expect, afterEach } from 'bun:test';
import * as fc from 'fast-check';
import {
  generateRPr,
  generateRun,
  generateRuns,
  generateParagraph,
  generateTable,
  convertMdToDocx,
  parseMd,
  extractFootnoteDefinitions,
  preprocessCriticMarkup,
  preprocessGridTables,
  stylesXml,
  applyAlertColorsToTemplate,
  type MdRun,
  type MdToken,
  type MdTableRow,
  type DocxGenState
} from './md-to-docx';
import { type GfmAlertType } from './gfm';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { alertColorsByScheme, setDefaultColorScheme, getDefaultColorScheme, GITHUB_ALERT_COLORS, GUTTMACHER_ALERT_COLORS } from './alert-colors';

function makeState(): DocxGenState {
  return {
    commentId: 0,
    comments: [],
    commentIdMap: new Map(),
    relationships: new Map(),
    nextRId: 1,
    rIdOffset: 5,
    warnings: [],
    hasList: false,
    hasComments: false,
    hasFootnotes: false,
    hasEndnotes: false,
    footnoteId: 1,
    footnoteEntries: [],
    footnoteLabelToId: new Map(),
    notesMode: 'footnotes',
    missingKeys: new Set(),
    replyRanges: [],
    nextParaId: 1,
    codeBlockIndex: 0,
    codeBlockLanguages: new Map(),
    codeFont: 'Consolas',
    codeShadingMode: false,
    citationIds: new Set(),
    citedKeys: new Set(),
    citationItemIds: new Map(),
    blockquoteGaps: new Map(),
    blockquotePostContentBlankLines: new Map(),
    blockquoteAlertMarkerInlineByGroup: new Map(),
    imageRelationships: new Map(),
    imageMediaPaths: new Map(),
    imageBinaries: new Map(),
    imageFormats: new Map(),
    imageExtensions: new Set(),
    nextImageDocPrId: 1,
    tableIndex: 0,
    tableFormats: new Map(),
    consecutiveReplyParaIds: new Set(),
    htmlCommentGaps: new Map(),
    listIndent: 'spaces',
  };
}

describe('generateRPr', () => {
  it('returns empty string for no formatting', () => {
    const run: MdRun = { type: 'text', text: 'hello' };
    expect(generateRPr(run)).toBe('');
  });

  it('generates code style', () => {
    const run: MdRun = { type: 'text', text: 'code', code: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:rStyle w:val="CodeChar"/></w:rPr>');
  });

  it('generates bold', () => {
    const run: MdRun = { type: 'text', text: 'bold', bold: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:b/></w:rPr>');
  });

  it('generates italic', () => {
    const run: MdRun = { type: 'text', text: 'italic', italic: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:i/></w:rPr>');
  });

  it('generates strikethrough', () => {
    const run: MdRun = { type: 'text', text: 'strike', strikethrough: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:strike/></w:rPr>');
  });

  it('generates underline', () => {
    const run: MdRun = { type: 'text', text: 'underline', underline: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:u w:val="single"/></w:rPr>');
  });

  it('generates highlight with default color', () => {
    const run: MdRun = { type: 'text', text: 'highlight', highlight: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:highlight w:val="yellow"/></w:rPr>');
  });

  it('generates highlight with custom color', () => {
    const run: MdRun = { type: 'text', text: 'highlight', highlight: true, highlightColor: 'green' };
    expect(generateRPr(run)).toBe('<w:rPr><w:highlight w:val="green"/></w:rPr>');
  });

  it('generates superscript', () => {
    const run: MdRun = { type: 'text', text: 'super', superscript: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>');
  });

  it('generates subscript', () => {
    const run: MdRun = { type: 'text', text: 'sub', subscript: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:vertAlign w:val="subscript"/></w:rPr>');
  });

  it('prioritizes superscript over subscript', () => {
    const run: MdRun = { type: 'text', text: 'both', superscript: true, subscript: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>');
  });

  it('combines multiple formatting options in correct order', () => {
    const run: MdRun = { 
      type: 'text', 
      text: 'formatted', 
      code: true,
      bold: true, 
      italic: true, 
      strikethrough: true,
      underline: true,
      highlight: true,
      highlightColor: 'blue',
      superscript: true
    };
    expect(generateRPr(run)).toBe('<w:rPr><w:rStyle w:val="CodeChar"/><w:b/><w:i/><w:strike/><w:u w:val="single"/><w:highlight w:val="blue"/><w:vertAlign w:val="superscript"/></w:rPr>');
  });
});

describe('GFM support in Markdown→DOCX parser', () => {
  it('parses bare URLs as links (autolink literals)', () => {
    const tokens = parseMd('Visit https://example.com for docs.');
    const hrefRun = tokens[0].runs.find(run => run.href === 'https://example.com');
    expect(hrefRun).toBeDefined();
    expect(hrefRun?.text).toBe('https://example.com');
  });

  it('parses task list markers semantically and strips literal marker text', () => {
    const tokens = parseMd('- [x] done\n- [ ] todo');
    const listItems = tokens.filter(t => t.type === 'list_item');
    expect(listItems).toHaveLength(2);
    expect(listItems[0].taskChecked).toBe(true);
    expect(listItems[1].taskChecked).toBe(false);
    expect(listItems[0].runs.map(r => r.text).join('')).toContain('done');
    expect(listItems[0].runs.map(r => r.text).join('')).not.toContain('[x]');
    expect(listItems[1].runs.map(r => r.text).join('')).toContain('todo');
    expect(listItems[1].runs.map(r => r.text).join('')).not.toContain('[ ]');
  });

  it('does not promote nested sublist paragraph to parent list item', () => {
    // Parent has no direct text — only a nested sublist.
    // The child's paragraph must NOT be captured as the parent's runs.
    const tokens = parseMd('- parent\n  - child text\n');
    const items = tokens.filter(t => t.type === 'list_item');
    expect(items).toHaveLength(2);
    expect(items[0].runs.map(r => r.text).join('')).toBe('parent');
    expect(items[1].runs.map(r => r.text).join('')).toBe('child text');
  });

  it('parent list item with only a nested sublist gets empty runs', () => {
    // A list item whose only content is a nested sublist should have empty runs.
    const md = '- - child only\n';
    const tokens = parseMd(md);
    const items = tokens.filter(t => t.type === 'list_item');
    // The outer item should have no text runs (it has no direct paragraph)
    const outerItem = items.find(i => i.level === 1);
    expect(outerItem).toBeDefined();
    expect(outerItem!.runs.map(r => r.text).join('')).toBe('');
    // The nested child item should exist and contain the expected text
    const childItem = items.find(i => i.level === 2);
    expect(childItem).toBeDefined();
    expect(childItem!.runs.map(r => r.text).join('')).toBe('child only');
  });

  it('escapes GFM-disallowed raw HTML tags into literal text runs', () => {
    const tokens = parseMd('<script>alert(1)</script>');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('paragraph');
    expect(tokens[0].runs[0]).toMatchObject({ type: 'text', text: '<script>alert(1)</script>' });
  });

  it('preserves inline HTML-like text tokens as literal text runs', () => {
    const tokens = parseMd('A <tag> B');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].runs.map(r => r.text).join('')).toBe('A <tag> B');
  });

  it('preserves non-table HTML blocks as literal text', () => {
    const tokens = parseMd('<div>alpha</div>');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('paragraph');
    expect(tokens[0].runs[0]).toMatchObject({ type: 'text', text: '<div>alpha</div>' });
  });

  it('parses alert blockquotes and strips raw [!TYPE] marker text', () => {
    const tokens = parseMd('> [!WARNING]\n> Heads up');
    const blockquoteTokens = tokens.filter(t => t.type === 'blockquote');
    expect(blockquoteTokens.length).toBeGreaterThan(0);
    expect(blockquoteTokens[0].alertType).toBe('warning');
    expect(blockquoteTokens[0].alertLead).toBe(true);
    expect(blockquoteTokens.map(t => t.runs.map(r => r.text).join('')).join('\n')).not.toContain('[!WARNING]');
  });

  it('splits merged blockquotes with multiple alert markers into separate tokens', () => {
    const md = '> [!NOTE]\n> A note.\n> [!WARNING]\n> A warning.\n> [!TIP]\n> A tip.';
    const tokens = parseMd(md);
    const bqTokens = tokens.filter(t => t.type === 'blockquote');
    const noteTokens = bqTokens.filter(t => t.alertType === 'note');
    const warningTokens = bqTokens.filter(t => t.alertType === 'warning');
    const tipTokens = bqTokens.filter(t => t.alertType === 'tip');
    expect(noteTokens.length).toBeGreaterThan(0);
    expect(warningTokens.length).toBeGreaterThan(0);
    expect(tipTokens.length).toBeGreaterThan(0);
    expect(noteTokens[0].alertLead).toBe(true);
    expect(warningTokens[0].alertLead).toBe(true);
    expect(tipTokens[0].alertLead).toBe(true);
  });

  it('marks alertFirst/alertLast boundaries on contiguous alert blockquotes', () => {
    const md = '> [!NOTE]\n> Line one.\n>\n> Line two.';
    const tokens = parseMd(md);
    const bqTokens = tokens.filter(t => t.type === 'blockquote');
    expect(bqTokens.length).toBeGreaterThanOrEqual(2);
    expect(bqTokens[0].alertFirst).toBe(true);
    expect(bqTokens[bqTokens.length - 1].alertLast).toBe(true);
  });

  it('marks alertFirst/alertLast on plain blockquotes too', () => {
    const md = '> Plain quote.';
    const tokens = parseMd(md);
    const bqTokens = tokens.filter(t => t.type === 'blockquote');
    expect(bqTokens.length).toBeGreaterThan(0);
    expect(bqTokens[0].alertFirst).toBe(true);
    expect(bqTokens[bqTokens.length - 1].alertLast).toBe(true);
  });
});

describe('parseMd HTML tables', () => {
  it('parses HTML table blocks into table tokens', () => {
    const markdown = '<table><tr><th>H1</th><th>H2</th></tr><tr><td>A</td><td>B</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');

    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows?.[0].header).toBe(true);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('H1');
    expect(table?.rows?.[1].cells[1].runs[0].text).toBe('B');
  });

  it('decodes entities and preserves inline formatting inside HTML table cells', () => {
    const markdown = '<table><tr><td><strong>A &amp; B</strong><br/>line</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    const cellRuns = table?.rows?.[0].cells[0].runs;

    // Should produce: bold "A & B", softbreak, plain "line"
    expect(cellRuns).toHaveLength(3);
    expect(cellRuns?.[0]).toMatchObject({ type: 'text', text: 'A & B', bold: true });
    expect(cellRuns?.[1]).toMatchObject({ type: 'softbreak' });
    expect(cellRuns?.[2]).toMatchObject({ type: 'text', text: 'line' });
  });

  it('does not over-decode double-encoded entities inside HTML table cells', () => {
    const markdown = '<table><tr><td>&amp;lt;tag&amp;gt;</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    const text = table?.rows?.[0].cells[0].runs[0].text;

    expect(text).toBe('&lt;tag&gt;');
  });

  it('decodes decimal and hex numeric entities beyond U+FFFF in HTML table cells', () => {
    const markdown = '<table><tr><td>&#128512; &#x1F600;</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    const text = table?.rows?.[0].cells[0].runs[0].text;

    expect(text).toBe('😀 😀');
  });

  it('parses colspan from HTML table cells', () => {
    const markdown = '<table><tr><td colspan="2">Span</td></tr><tr><td>A</td><td>B</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].colspan).toBe(2);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('Span');
    expect(table?.rows?.[1].cells[0].colspan).toBeUndefined();
  });

  it('parses rowspan from HTML table cells', () => {
    const markdown = '<table><tr><td rowspan="3">Tall</td><td>R1</td></tr><tr><td>R2</td></tr><tr><td>R3</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].rowspan).toBe(3);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('Tall');
    expect(table?.rows?.[0].cells[1].rowspan).toBeUndefined();
  });

  it('parses combined colspan and rowspan', () => {
    const markdown = '<table><tr><td colspan="2" rowspan="2">Big</td><td>C</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].colspan).toBe(2);
    expect(table?.rows?.[0].cells[0].rowspan).toBe(2);
  });

  it('ignores colspan=1 and rowspan=1', () => {
    const markdown = '<table><tr><td colspan="1" rowspan="1">Normal</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].colspan).toBeUndefined();
    expect(table?.rows?.[0].cells[0].rowspan).toBeUndefined();
  });
});

describe('parseMd grid tables', () => {
  it('parses a grid table with header', () => {
    const markdown = [
      '+------+------+',
      '| H1   | H2   |',
      '+======+======+',
      '| A    | B    |',
      '+------+------+',
    ].join('\n');
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');

    expect(table).toBeDefined();
    expect(table?.sourceFormat).toBe('grid');
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows?.[0].header).toBe(true);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('H1');
    expect(table?.rows?.[1].header).toBe(false);
    expect(table?.rows?.[1].cells[1].runs[0].text).toBe('B');
  });

  it('parses multi-line cells in grid tables', () => {
    const markdown = [
      '+----------+----------+',
      '| Header 1 | Header 2 |',
      '+==========+==========+',
      '| Cell 1   | Cell 2   |',
      '|          | line 2   |',
      '+----------+----------+',
    ].join('\n');
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');

    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);
    // Multi-line cell: runs should contain the text
    const bodyRow = table?.rows?.[1];
    expect(bodyRow?.cells).toHaveLength(2);
  });

  it('preprocessGridTables replaces grid tables with placeholders', () => {
    const markdown = 'Before\n\n+------+------+\n| H1   | H2   |\n+======+======+\n| A    | B    |\n+------+------+\n\nAfter';
    const result = preprocessGridTables(markdown);
    expect(result).toContain('<!-- MANUSCRIPT_GRID_TABLE:');
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('+------+');
  });

  it('leaves non-grid-table content unchanged', () => {
    const markdown = '| H1 | H2 |\n| --- | --- |\n| A | B |';
    const result = preprocessGridTables(markdown);
    expect(result).toBe(markdown);
  });
});

describe('generateRun', () => {
  it('generates basic run', () => {
    const result = generateRun('hello', '');
    expect(result).toBe('<w:r><w:t xml:space="preserve">hello</w:t></w:r>');
  });

  it('generates run with formatting', () => {
    const result = generateRun('bold', '<w:rPr><w:b/></w:rPr>');
    expect(result).toBe('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold</w:t></w:r>');
  });

  it('escapes XML characters', () => {
    const result = generateRun('<test> & "quotes"', '');
    expect(result).toBe('<w:r><w:t xml:space="preserve">&lt;test&gt; &amp; &quot;quotes&quot;</w:t></w:r>');
  });
});

describe('generateParagraph', () => {
  const createState = () => ({ ...makeState(), rIdOffset: 3 });

  it('generates basic paragraph', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'text', text: 'Hello world' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:r><w:t xml:space="preserve">Hello world</w:t></w:r></w:p>');
  });

  it('generates heading level 1', () => {
    const token: MdToken = {
      type: 'heading',
      level: 1,
      runs: [{ type: 'text', text: 'Title' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Title</w:t></w:r></w:p>');
  });

  it('generates heading level 6', () => {
    const token: MdToken = {
      type: 'heading',
      level: 6,
      runs: [{ type: 'text', text: 'Subtitle' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Heading6"/></w:pPr><w:r><w:t xml:space="preserve">Subtitle</w:t></w:r></w:p>');
  });

  it('generates bullet list item', () => {
    const token: MdToken = {
      type: 'list_item',
      ordered: false,
      level: 1,
      runs: [{ type: 'text', text: 'Item 1' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item 1</w:t></w:r></w:p>');
    expect(state.hasList).toBe(true);
  });

  it('generates ordered list item', () => {
    const token: MdToken = {
      type: 'list_item',
      ordered: true,
      level: 2,
      runs: [{ type: 'text', text: 'Item 2' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item 2</w:t></w:r></w:p>');
    expect(state.hasList).toBe(true);
  });

  it('generates unchecked task list item with indent and checkbox prefix', () => {
    const token: MdToken = {
      type: 'list_item',
      level: 1,
      taskChecked: false,
      runs: [{ type: 'text', text: 'todo item' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve">☐ </w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">todo item</w:t></w:r></w:p>'
    );
    expect(state.hasList).toBe(false);
  });

  it('generates checked task list item with indent and checkbox prefix', () => {
    const token: MdToken = {
      type: 'list_item',
      level: 1,
      taskChecked: true,
      runs: [{ type: 'text', text: 'done item' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve">☒ </w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">done item</w:t></w:r></w:p>'
    );
    expect(state.hasList).toBe(false);
  });

  it('generates blockquote', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      runs: [{ type: 'text', text: 'Quote text' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="GitHub"/><w:spacing w:before="0" w:after="0"/><w:ind w:left="240"/></w:pPr><w:r><w:t xml:space="preserve">Quote text</w:t></w:r></w:p>');
  });

  it('generates nested blockquote', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 3,
      runs: [{ type: 'text', text: 'Nested quote' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="GitHub"/><w:spacing w:before="0" w:after="0"/><w:ind w:left="720"/></w:pPr><w:r><w:t xml:space="preserve">Nested quote</w:t></w:r></w:p>');
  });

  it('generates alert blockquote with GitHub alert style and title prefix', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertType: 'caution',
      alertLead: true,
      runs: [{ type: 'text', text: 'Watch out' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toContain('w:pStyle w:val=\"GitHubCaution\"');
    expect(result).toContain('⛒ Caution ');
    expect(result).toContain('Watch out');
  });

  it('generates bold colored alert title prefix', () => {
    for (const [type, color] of Object.entries(GITHUB_ALERT_COLORS)) {
      const token: MdToken = {
        type: 'blockquote',
        level: 1,
        alertType: type as GfmAlertType,
        alertLead: true,
        runs: [{ type: 'text', text: 'Content' }]
      };
      const result = generateParagraph(token, createState(), { colors: 'github' });
      expect(result).toContain('<w:b/>');
      expect(result).toContain('w:color w:val="' + color + '"');
    }
  });

  it('emits spacer paragraphs for alertFirst/alertLast blockquotes', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertType: 'note',
      alertLead: true,
      alertFirst: true,
      alertLast: true,
      runs: [{ type: 'text', text: 'Note text' }]
    };
    const result = generateParagraph(token, createState(), { colors: 'github' });
    // Should contain two spacer paragraphs (before and after)
    const spacerPattern = /w:line="1" w:lineRule="exact"/g;
    const spacers = result.match(spacerPattern);
    expect(spacers).toHaveLength(2);
    // Spacers carry inline pBdr with alert border color, not pStyle
    expect(result).toContain('w:color="' + GITHUB_ALERT_COLORS.note + '"');
    // The content paragraph should NOT have a spacer style
    expect((result.match(/w:pStyle/g) || []).length).toBe(1);
  });

  it('spacer paragraphs use correct border color for plain blockquotes', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertFirst: true,
      alertLast: true,
      runs: [{ type: 'text', text: 'Plain quote' }]
    };
    const result = generateParagraph(token, createState());
    expect(result).toContain('w:color="D0D7DE"');
  });

  it('generates code block with multiple lines', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'line1\nline2\nline3' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">line1</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">line2</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="0" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">line3</w:t></w:r></w:p>'
    );
  });

  it('generates single-line code block with before and after spacing', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'solo line' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">solo line</w:t></w:r></w:p>'
    );
  });

  it('generates two-line code block with first and last spacing', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'first\nsecond' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">first</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="0" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">second</w:t></w:r></w:p>'
    );
  });

  it('generates empty code block with before and after spacing', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: '' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve"></w:t></w:r></w:p>'
    );
  });

  it('generates horizontal rule', () => {
    const token: MdToken = {
      type: 'hr',
      runs: []
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>');
  });

  it('generates hyperlink', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'text', text: 'Link text', href: 'https://example.com' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:hyperlink r:id="rId4"><w:r><w:t xml:space="preserve">Link text</w:t></w:r></w:hyperlink></w:p>');
    expect(state.relationships.get('https://example.com')).toBe('rId4');
  });

  it('generates softbreak', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'Line 1' },
        { type: 'softbreak', text: '\n' },
        { type: 'text', text: 'Line 2' }
      ]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:r><w:t xml:space="preserve">Line 1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">Line 2</w:t></w:r></w:p>');
  });
});

describe('generateTable', () => {
  it('generates basic table', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          { runs: [{ type: 'text', text: 'Header 1' }] },
          { runs: [{ type: 'text', text: 'Header 2' }] }
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Cell 1' }] },
          { runs: [{ type: 'text', text: 'Cell 2' }] }
        ]
      }
    ];
    
    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };
    
    const result = generateTable(token, makeState());
    
    expect(result).toContain('<w:tbl>');
    expect(result).toContain('<w:tblBorders>');
    expect(result).toContain('<w:tr>');
    expect(result).toContain('<w:tc>');
    expect(result).toContain('Header 1');
    expect(result).toContain('Header 2');
    expect(result).toContain('Cell 1');
    expect(result).toContain('Cell 2');
    expect(result).toContain('</w:tbl>');
  });

  it('makes header cells bold', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          { runs: [{ type: 'text', text: 'Header' }] }
        ]
      }
    ];

    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };

    const result = generateTable(token, makeState());

    expect(result).toContain('<w:b/>');
  });

  it('emits tblLook firstRow when table has header rows', () => {
    const rows: MdTableRow[] = [
      { header: true, cells: [{ runs: [{ type: 'text', text: 'H' }] }] },
      { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());
    expect(result).toContain('<w:tblLook w:firstRow="1"/>');
  });

  it('does not emit tblLook firstRow when no header rows', () => {
    const rows: MdTableRow[] = [
      { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());
    expect(result).not.toContain('<w:tblLook');
  });

  it('emits tblHeader on header rows', () => {
    const rows: MdTableRow[] = [
      { header: true, cells: [{ runs: [{ type: 'text', text: 'H' }] }] },
      { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());
    // Header row should have tblHeader
    expect(result).toContain('<w:trPr><w:tblHeader/></w:trPr>');
    // Only one tblHeader (not on the data row)
    const matches = result.match(/<w:tblHeader\/>/g);
    expect(matches?.length).toBe(1);
  });

  it('preserves existing bold formatting in header cells', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          { runs: [{ type: 'text', text: 'Bold Header', bold: true }] }
        ]
      }
    ];
    
    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };
    
    const result = generateTable(token, makeState());
    
    // Should only have one <w:b/> tag
    const boldMatches = result.match(/<w:b\/>/g);
    expect(boldMatches?.length).toBe(1);
  });

  it('generates gridSpan for colspan', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Span' }], colspan: 2 },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'A' }] },
          { runs: [{ type: 'text', text: 'B' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:gridSpan w:val="2"/>');
    expect(result).toContain('<w:tblGrid>');
    expect(result).toContain('<w:gridCol/>');
    expect(result).toContain('Span');
  });

  it('generates vMerge for rowspan', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Tall' }], rowspan: 2 },
          { runs: [{ type: 'text', text: 'R1' }] },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'R2' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:vMerge w:val="restart"/>');
    expect(result).toContain('<w:vMerge/>');
    expect(result).toContain('Tall');
    expect(result).toContain('R1');
    expect(result).toContain('R2');
  });

  it('generates combined colspan+rowspan', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Big' }], colspan: 2, rowspan: 2 },
          { runs: [{ type: 'text', text: 'C' }] },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'D' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:vMerge w:val="restart"/>');
    expect(result).toContain('<w:gridSpan w:val="2"/>');
    // Continuation row should have gridSpan + vMerge (ECMA-376 element order)
    expect(result).toContain('<w:gridSpan w:val="2"/><w:vMerge/>');
    expect(result).toContain('Big');
    expect(result).toContain('C');
    expect(result).toContain('D');
  });

  it('accounts for rowspan-occupied columns when computing grid width', () => {
    // Row 1 has 2 explicit cells, but row 0's rowspan occupies col 0 in row 1,
    // so the true grid has 3 columns.
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'A' }], rowspan: 2 },
          { runs: [{ type: 'text', text: 'B' }] },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'C' }] },
          { runs: [{ type: 'text', text: 'D' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    // All four cells must be present
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
    expect(result).toContain('D');
    // Grid should have 3 columns
    expect((result.match(/<w:gridCol\/>/g) || []).length).toBe(3);
    // 3 w:tr rows (2 explicit + vMerge continuation is implicit within the 2 rows)
    expect((result.match(/<w:tr>/g) || []).length).toBe(2);
  });

  it('does not emit tblGrid when no spans are present', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'A' }] },
          { runs: [{ type: 'text', text: 'B' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).not.toContain('<w:tblGrid>');
    expect(result).not.toContain('<w:gridSpan');
    expect(result).not.toContain('<w:vMerge');
  });

  it('renders hyperlinks in table cells', () => {
    const state = makeState();
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'click here', href: 'https://example.com' }] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, state);

    expect(result).toContain('<w:hyperlink r:id=');
    expect(result).toContain('click here');
    expect(state.relationships.has('https://example.com')).toBe(true);
  });

  it('renders softbreaks in table cells', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [
            { type: 'text', text: 'line1' },
            { type: 'softbreak', text: '\n' },
            { type: 'text', text: 'line2' },
          ] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('line1');
    expect(result).toContain('<w:r><w:br/></w:r>');
    expect(result).toContain('line2');
  });

  it('renders bold and italic formatting in table cells', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [
            { type: 'text', text: 'bold', bold: true },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'italic', italic: true },
          ] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:rPr><w:b/></w:rPr>');
    expect(result).toContain('bold');
    expect(result).toContain('<w:rPr><w:i/></w:rPr>');
    expect(result).toContain('italic');
  });

  it('renders critic_add runs in table cells', () => {
    const state = makeState();
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'critic_add', text: 'inserted', author: 'Tester', date: '2024-01-01T00:00:00Z' }] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, state, { authorName: 'Default' });

    expect(result).toContain('<w:ins');
    expect(result).toContain('w:author="Tester"');
    expect(result).toContain('inserted');
  });

  it('renders math runs in table cells', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'math', text: 'x^2' }] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    // Math runs produce OMML, check for the math namespace element
    expect(result).toContain('m:oMath');
  });
});

describe('parseHtmlCellRuns via parseMd', () => {
  it('preserves bold formatting from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><b>bold text</b></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'bold text', bold: true });
  });

  it('preserves italic formatting from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><em>italic</em></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'italic', italic: true });
  });

  it('preserves hyperlinks from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><a href="https://example.com">link</a></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'link', href: 'https://example.com' });
  });

  it('preserves nested formatting (bold + italic) from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><strong><em>both</em></strong></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'both', bold: true, italic: true });
  });

  it('preserves mixed content with plain and formatted text', () => {
    const tokens = parseMd('<table><tr><td>plain <b>bold</b> plain</td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(3);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'plain ' });
    expect(runs?.[1]).toMatchObject({ type: 'text', text: 'bold', bold: true });
    expect(runs?.[2]).toMatchObject({ type: 'text', text: ' plain' });
  });

  it('preserves strikethrough from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><s>deleted</s></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'deleted', strikethrough: true });
  });

  it('preserves code formatting from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><code>x = 1</code></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'x = 1', code: true });
  });

  it('preserves superscript and subscript from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td>H<sub>2</sub>O is x<sup>2</sup></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs?.find(r => r.text === '2' && (r as any).subscript)).toBeDefined();
    expect(runs?.find(r => r.text === '2' && (r as any).superscript)).toBeDefined();
  });
});

describe('convertMdToDocx', () => {
  it('generates valid zip for empty document', async () => {
    const result = await convertMdToDocx('');
    expect(result.docx).toBeInstanceOf(Uint8Array);
    expect(result.warnings).toEqual([]);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    expect(zip.files['[Content_Types].xml']).toBeDefined();
    expect(zip.files['_rels/.rels']).toBeDefined();
    expect(zip.files['word/document.xml']).toBeDefined();
    expect(zip.files['word/styles.xml']).toBeDefined();
  });

  it('includes numbering.xml for lists', async () => {
    const markdown = '- Item 1\n- Item 2';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    expect(zip.files['word/numbering.xml']).toBeDefined();
    
    const contentTypes = await zip.files['[Content_Types].xml'].async('string');
    expect(contentTypes).toContain('numbering.xml');
  });

  it('includes document.xml.rels for hyperlinks', async () => {
    const markdown = '[Link](https://example.com)';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    expect(zip.files['word/_rels/document.xml.rels']).toBeDefined();
    
    const rels = await zip.files['word/_rels/document.xml.rels'].async('string');
    expect(rels).toContain('https://example.com');
    expect(rels).toContain('TargetMode="External"');
  });

  it('generates correct heading styles', async () => {
    const markdown = '# Heading 1\n## Heading 2';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    const document = await zip.files['word/document.xml'].async('string');
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:pStyle w:val="Heading2"/>');
  });

  it('generates correct formatting', async () => {
    const markdown = '**bold** *italic* `code`';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    const document = await zip.files['word/document.xml'].async('string');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('<w:i/>');
    expect(document).toContain('<w:rStyle w:val="CodeChar"/>');
  });

  it('handles complex document structure', async () => {
    const markdown = `# Title

This is a paragraph with **bold** and *italic* text.

- List item 1
- List item 2

> Blockquote text

\`\`\`javascript
console.log('code');
\`\`\`

| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |

---`;

    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    // Verify all expected files are present
    expect(zip.files['[Content_Types].xml']).toBeDefined();
    expect(zip.files['_rels/.rels']).toBeDefined();
    expect(zip.files['word/document.xml']).toBeDefined();
    expect(zip.files['word/styles.xml']).toBeDefined();
    expect(zip.files['word/numbering.xml']).toBeDefined();
    
    const document = await zip.files['word/document.xml'].async('string');
    
    // Verify content structure
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('<w:i/>');
    expect(document).toContain('<w:numId w:val="1"/>');
    expect(document).toContain('<w:pStyle w:val="GitHub"/>');
    expect(document).toContain('<w:pStyle w:val="CodeBlock"/>');
    expect(document).toContain('<w:tbl>');
    expect(document).toContain('<w:pBdr>');
  });

  it('verifies zip contains expected file count', async () => {
    const markdown = '# Test\n\n- List item\n\n[Link](https://example.com)';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    const fileNames = Object.keys(zip.files);
    expect(fileNames).toContain('[Content_Types].xml');
    expect(fileNames).toContain('_rels/.rels');
    expect(fileNames).toContain('word/document.xml');
    expect(fileNames).toContain('word/styles.xml');
    expect(fileNames).toContain('word/numbering.xml');
    expect(fileNames).toContain('word/_rels/document.xml.rels');
    
    // JSZip includes directory entries, so we expect more than just the 6 files
    expect(fileNames.length).toBeGreaterThanOrEqual(6);
  });

  it('exports HTML table blocks to DOCX tables', async () => {
    const markdown = '<table><tr><th>H1</th><th>H2</th></tr><tr><td>A</td><td>B</td></tr></table>';
    const result = await convertMdToDocx(markdown);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const document = await zip.files['word/document.xml'].async('string');

    expect(document).toContain('<w:tbl>');
    expect(document).toContain('H1');
    expect(document).toContain('H2');
    expect(document).toContain('A');
    expect(document).toContain('B');
  });

  it('exports HTML tables with thead/tbody structure', async () => {
    const markdown = '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Val</td></tr></tbody></table>';
    const result = await convertMdToDocx(markdown);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const document = await zip.files['word/document.xml'].async('string');

    expect(document).toContain('<w:tbl>');
    expect(document).toContain('Col');
    expect(document).toContain('Val');
  });

  it('exports HTML tables with colspan/rowspan to correct OOXML', async () => {
    const markdown = '<table><tr><td colspan="2">Span</td></tr><tr><td rowspan="2">Left</td><td>Right</td></tr><tr><td>Bottom</td></tr></table>';
    const result = await convertMdToDocx(markdown);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const document = await zip.files['word/document.xml'].async('string');

    expect(document).toContain('<w:tbl>');
    expect(document).toContain('<w:tblGrid>');
    expect(document).toContain('<w:gridSpan w:val="2"/>');
    expect(document).toContain('<w:vMerge w:val="restart"/>');
    expect(document).toContain('<w:vMerge/>');
    expect(document).toContain('Span');
    expect(document).toContain('Left');
    expect(document).toContain('Right');
    expect(document).toContain('Bottom');
  });
});

describe('CriticMarkup OOXML generation', () => {
  const createState = () => ({ ...makeState(), rIdOffset: 3 });

  it('generates w:ins for additions', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_add', text: 'added text', author: 'John', date: '2024-01-01T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:ins w:id="0" w:author="John" w:date="2024-01-01T00:00:00Z">');
    expect(result).toContain('added text');
    expect(result).toContain('</w:ins>');
  });

  it('generates w:del with w:delText for deletions', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_del', text: 'deleted text', author: 'Jane', date: '2024-01-02T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del w:id="0" w:author="Jane" w:date="2024-01-02T00:00:00Z">');
    expect(result).toContain('<w:delText xml:space="preserve">deleted text</w:delText>');
    expect(result).toContain('</w:del>');
  });

  it('generates w:del + w:ins for substitutions', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_sub', text: 'old text', newText: 'new text', author: 'Bob', date: '2024-01-03T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del w:id="0" w:author="Bob" w:date="2024-01-03T00:00:00Z">');
    expect(result).toContain('<w:delText xml:space="preserve">old text</w:delText>');
    expect(result).toContain('<w:ins w:id="1" w:author="Bob" w:date="2024-01-03T00:00:00Z">');
    expect(result).toContain('new text');
  });

  it('generates comment anchors and comments.xml entries', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_comment', text: 'highlighted text', commentText: 'This is a comment', author: 'Alice', date: '2024-01-04T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:commentRangeStart w:id="0"/>');
    expect(result).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(result).toContain('<w:commentReference w:id="0"/>');
    expect(result).toContain('highlighted text');
    expect(state.hasComments).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]).toMatchObject({
      id: 0,
      author: 'Alice',
      date: '2024-01-04T00:00:00Z',
      text: 'This is a comment'
    });
    expect(state.comments[0].paraId).toMatch(/^[0-9A-F]{8}$/);
  });

  it('generates zero-width comment range for standalone comments', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_comment', text: '', commentText: 'Standalone comment', author: 'Charlie', date: '2024-01-05T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:commentRangeStart w:id="0"/>');
    expect(result).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(result).toContain('<w:commentReference w:id="0"/>');
    expect(state.comments[0].text).toBe('Standalone comment');
  });

  it('uses author attribution from CriticMarkup', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_add', text: 'text', author: 'SpecificAuthor' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'DefaultAuthor' });
    expect(result).toContain('w:author="SpecificAuthor"');
  });

  it('falls back to options.authorName', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_add', text: 'text' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'FallbackAuthor' });
    expect(result).toContain('w:author="FallbackAuthor"');
  });

  it('generates highlighted text for critic_highlight', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_highlight', text: 'highlighted text', highlightColor: 'green' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:highlight w:val="green"/>');
    expect(result).toContain('highlighted text');
    expect(result).not.toContain('<w:ins');
    expect(result).not.toContain('<w:del');
  });

  it('renders recursive formatting inside critic additions', () => {
    const token = parseMd('{++**bold** and *italic*++}')[0];
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:ins');
    expect(result).toContain('<w:b/>');
    expect(result).toContain('<w:i/>');
    expect(result).not.toContain('**bold**');
    expect(result).not.toContain('*italic*');
  });

  it('renders recursive formatting inside critic substitutions', () => {
    const token = parseMd('{~~**old**~>*new*~~}')[0];
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del');
    expect(result).toContain('<w:ins');
    expect(result).toContain('<w:b/>');
    expect(result).toContain('<w:i/>');
    expect(result).not.toContain('**old**');
    expect(result).not.toContain('*new*');
  });

  it('renders recursive formatting in critic highlight with attached comment', () => {
    const token = parseMd('{==**bold** ==highlighted== text==}{>>comment<<}')[0];
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:commentRangeStart w:id="0"/>');
    expect(result).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(result).toContain('<w:commentReference w:id="0"/>');
    expect(result).toContain('<w:b/>');
    expect(result).toContain('<w:highlight w:val="yellow"/>');
    expect(result).not.toContain('**bold**');
    expect(result).not.toContain('==highlighted==');
  });
});

describe('preprocessCriticMarkup', () => {
  it('returns unchanged text when no CriticMarkup markers present', () => {
    const input = 'Hello world\n\nSecond paragraph';
    expect(preprocessCriticMarkup(input)).toBe(input);
  });

  it('returns unchanged text for single-line CriticMarkup', () => {
    const input = 'Some {>>comment<<} here';
    expect(preprocessCriticMarkup(input)).toBe(input);
  });

  it('replaces \\n\\n inside a multi-paragraph comment', () => {
    const input = '{>>para 1\n\npara 2<<}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
    expect(result).toContain('{>>');
    expect(result).toContain('<<}');
  });

  it('replaces \\n\\n inside a multi-paragraph highlight', () => {
    const input = '{==text\n\nmore text==}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('replaces \\n\\n inside a multi-paragraph addition', () => {
    const input = '{++added\n\nmore++}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('replaces \\n\\n inside a multi-paragraph deletion', () => {
    const input = '{--deleted\n\nmore--}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('replaces \\n\\n inside a multi-paragraph substitution', () => {
    const input = '{~~old\n\ntext~>new\n\ntext~~}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('handles mid-line multi-paragraph span', () => {
    const input = 'some text {>>comment\n\npara 2<<} more text';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
    expect(result).toStartWith('some text {>>');
    expect(result).toEndWith('<<} more text');
  });
});

describe('parseMd multi-paragraph CriticMarkup', () => {
  it('parses multi-paragraph comment as single token', () => {
    const tokens = parseMd('{>>para 1\n\npara 2<<}');
    // Should produce a single paragraph (not split across multiple)
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
  });

  it('parses multi-paragraph highlight as single token', () => {
    const tokens = parseMd('{==text\n\nmore text==}');
    const highlightRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_highlight');
    expect(highlightRuns.length).toBe(1);
  });

  it('parses mid-line multi-paragraph comment', () => {
    const tokens = parseMd('some text {>>comment\n\npara 2<<} more text');
    const allRuns = tokens.flatMap(t => t.runs);
    const commentRuns = allRuns.filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
    const textRuns = allRuns.filter(r => r.type === 'text');
    expect(textRuns.some(r => r.text.includes('some text'))).toBe(true);
    expect(textRuns.some(r => r.text.includes('more text'))).toBe(true);
  });

  it('parses highlight + multi-paragraph comment', () => {
    const tokens = parseMd('{==highlighted==}{>>para 1\n\npara 2<<}');
    const allRuns = tokens.flatMap(t => t.runs);
    const highlightRuns = allRuns.filter(r => r.type === 'critic_highlight');
    const commentRuns = allRuns.filter(r => r.type === 'critic_comment');
    expect(highlightRuns.length).toBe(1);
    expect(commentRuns.length).toBe(1);
  });

  it('does not treat adjacent Critic deletion as a highlight color suffix', () => {
    const tokens = parseMd('==a=={--a--}');
    const allRuns = tokens.flatMap(t => t.runs);
    const highlightRuns = allRuns.filter(r => r.type === 'critic_highlight');
    const deletionRuns = allRuns.filter(r => r.type === 'critic_del');
    expect(highlightRuns.length).toBe(1);
    expect(highlightRuns[0].text).toBe('a');
    expect(highlightRuns[0].highlightColor).toBeUndefined();
    expect(deletionRuns.length).toBe(1);
    expect(deletionRuns[0].text).toBe('a');
  });

  it('parses multi-paragraph addition', () => {
    const tokens = parseMd('{++added\n\nmore++}');
    const addRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_add');
    expect(addRuns.length).toBe(1);
  });

  it('parses multi-paragraph deletion', () => {
    const tokens = parseMd('{--deleted\n\nmore--}');
    const delRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_del');
    expect(delRuns.length).toBe(1);
  });

  it('parses multi-paragraph substitution', () => {
    const tokens = parseMd('{~~old\n\ntext~>new\n\ntext~~}');
    const subRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_sub');
    expect(subRuns.length).toBe(1);
  });

  it('parses multi-paragraph comment with author attribution', () => {
    const tokens = parseMd('{>>@Alice (2024-01-15T10:00:00Z) | para 1\n\npara 2<<}');
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
    expect(commentRuns[0].author).toBe('Alice');
    expect(commentRuns[0].date).toBe('2024-01-15T10:00:00Z');
  });

  it('treats text without @ prefix as plain comment text, not author attribution', () => {
    const prose = 'Right now the section starts with detailed distributions (early 2020s, then early 2000s), and the reader has to work through several paragraphs before the big picture is clear. Giving that big picture first would help a lot: for example';
    const tokens = parseMd('{>>' + prose + '<<}');
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
    expect(commentRuns[0].author).toBeUndefined();
    expect(commentRuns[0].commentText).toBe(prose);
  });

  it('does not leak placeholder into comment text', () => {
    const tokens = parseMd('{>>@Alice (2024-01-15T10:00:00Z) | para 1\n\npara 2<<}');
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns[0].commentText).not.toContain('\u0000');
    expect(commentRuns[0].commentText).not.toContain('PARA');
    expect(commentRuns[0].commentText).toContain('para 1\n\npara 2');
  });

  it('does not leak placeholder into addition text', () => {
    const tokens = parseMd('{++added\n\nmore++}');
    const addRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_add');
    expect(addRuns[0].text).not.toContain('\u0000');
    expect(addRuns[0].text).not.toContain('PARA');
    expect(addRuns[0].text).toContain('added\n\nmore');
  });

  it('parses recursive formatting inside critic additions', () => {
    const tokens = parseMd('{++**bold** and *italic*++}');
    const addRun = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_add');
    expect(addRun).toBeDefined();
    expect(addRun?.innerRuns?.some(r => r.type === 'text' && r.bold && r.text === 'bold')).toBe(true);
    expect(addRun?.innerRuns?.some(r => r.type === 'text' && r.italic && r.text === 'italic')).toBe(true);
  });

  it('parses recursive formatting inside critic deletions with nested highlights', () => {
    const tokens = parseMd('{--*italic* and ==highlight==--}');
    const delRun = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_del');
    expect(delRun).toBeDefined();
    expect(delRun?.innerRuns?.some(r => r.type === 'text' && r.italic && r.text === 'italic')).toBe(true);
    expect(delRun?.innerRuns?.some(r => r.type === 'text' && r.highlight && r.text === 'highlight')).toBe(true);
  });

  it('parses recursive formatting on both sides of critic substitutions', () => {
    const tokens = parseMd('{~~**old**~>*new*~~}');
    const subRun = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_sub');
    expect(subRun).toBeDefined();
    expect(subRun?.oldRuns?.some(r => r.type === 'text' && r.bold && r.text === 'old')).toBe(true);
    expect(subRun?.newRuns?.some(r => r.type === 'text' && r.italic && r.text === 'new')).toBe(true);
  });

  it('parses recursive formatting in critic highlight with attached comment', () => {
    const tokens = parseMd('{==**bold** ==highlighted== text==}{>>comment<<}');
    const runs = tokens.flatMap(t => t.runs);
    const highlightRun = runs.find(r => r.type === 'critic_highlight');
    const commentRun = runs.find(r => r.type === 'critic_comment');
    expect(highlightRun).toBeDefined();
    expect(commentRun).toBeDefined();
    expect(highlightRun?.innerRuns?.some(r => r.type === 'text' && r.bold && r.text === 'bold')).toBe(true);
    expect(highlightRun?.innerRuns?.some(r => r.type === 'text' && r.highlight && r.text === 'highlighted')).toBe(true);
  });
});

describe('Nested critic runs in deletions and formatting propagation', () => {
  const createState = () => ({ ...makeState(), rIdOffset: 3 });

  it('renders nested addition inside deletion as delText', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_del', text: 'text added more', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'text ' },
          { type: 'critic_add', text: 'added', innerRuns: [{ type: 'text', text: 'added' }] },
          { type: 'text', text: ' more' }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del');
    expect(result).toContain('<w:delText xml:space="preserve">text </w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve">added</w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve"> more</w:delText>');
    // Must NOT contain <w:ins> inside the deletion
    const delMatch = result.match(/<w:del[^>]*>([\s\S]*?)<\/w:del>/);
    expect(delMatch).toBeTruthy();
    expect(delMatch![1]).not.toContain('<w:ins');
  });

  it('renders nested deletion inside deletion as delText', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_del', text: 'outer inner text', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'outer ' },
          { type: 'critic_del', text: 'inner', innerRuns: [{ type: 'text', text: 'inner' }] },
          { type: 'text', text: ' text' }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:delText xml:space="preserve">outer </w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve">inner</w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve"> text</w:delText>');
  });

  it('renders substitution inside deletion as delText', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_del', text: 'before old after', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'before ' },
          { type: 'critic_sub', text: 'old', newText: 'new', oldRuns: [{ type: 'text', text: 'old' }], newRuns: [{ type: 'text', text: 'new' }] },
          { type: 'text', text: ' after' }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:delText xml:space="preserve">before </w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve">old</w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve">new</w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve"> after</w:delText>');
  });

  it('propagates bold formatting into nested critic innerRuns', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_add', text: 'bold deleted', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'bold ', bold: true },
          { type: 'critic_del', text: 'deleted', bold: true, innerRuns: [{ type: 'text', text: 'deleted' }] }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    // The nested deletion should have bold formatting propagated to its inner text
    expect(result).toContain('<w:del');
    expect(result).toContain('<w:delText xml:space="preserve">deleted</w:delText>');
    // The deleted run should include bold rPr
    const delMatch = result.match(/<w:del[^>]*>([\s\S]*?)<\/w:del>/);
    expect(delMatch).toBeTruthy();
    expect(delMatch![1]).toContain('<w:b/>');
  });
});

describe('Footnote parsing', () => {
  it('parseMd produces footnote_ref runs for [^1]', () => {
    const tokens = parseMd('Hello[^1] world');
    const runs = tokens.flatMap(t => t.runs);
    const fnRef = runs.find(r => r.type === 'footnote_ref');
    expect(fnRef).toBeDefined();
    expect(fnRef!.footnoteLabel).toBe('1');
  });

  it('parseMd produces footnote_ref runs for named labels', () => {
    const tokens = parseMd('Text[^my-note] more');
    const runs = tokens.flatMap(t => t.runs);
    const fnRef = runs.find(r => r.type === 'footnote_ref');
    expect(fnRef).toBeDefined();
    expect(fnRef!.footnoteLabel).toBe('my-note');
  });

  it('does not parse [^label]: as a footnote reference', () => {
    // Definition lines are stripped by extractFootnoteDefinitions, not parsed as refs
    const input = 'Some text.\n\n[^1]: This is a definition.';
    const { cleaned } = extractFootnoteDefinitions(input);
    const tokens = parseMd(cleaned);
    const runs = tokens.flatMap(t => t.runs);
    const fnRef = runs.find(r => r.type === 'footnote_ref');
    expect(fnRef).toBeUndefined();
  });
});

describe('extractFootnoteDefinitions', () => {
  it('extracts single-line definition', () => {
    const input = 'Body text.\n\n[^1]: This is a footnote.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('This is a footnote.');
    expect(cleaned).toBe('Body text.\n');
  });

  it('extracts multi-paragraph definition', () => {
    const input = 'Text.\n\n[^1]: First paragraph.\n\n    Second paragraph.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('First paragraph.\n\nSecond paragraph.');
    expect(cleaned).toBe('Text.\n');
  });

  it('extracts multiple definitions', () => {
    const input = 'Text.\n\n[^1]: Note one.\n[^2]: Note two.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.size).toBe(2);
    expect(definitions.get('1')).toBe('Note one.');
    expect(definitions.get('2')).toBe('Note two.');
  });

  it('extracts named label definitions', () => {
    const input = 'Text.\n\n[^my-note]: Named footnote.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('my-note')).toBe('Named footnote.');
  });

  it('returns empty definitions for no footnotes', () => {
    const input = 'Just plain text.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.size).toBe(0);
    expect(cleaned).toBe('Just plain text.');
  });

  it('keeps indented fenced code blocks inside footnote bodies', () => {
    const input = 'Body text.\n\n[^1]: Here is code:\n\n    ```python\n    print(\"hello\")\n    ```';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('Here is code:\n\n```python\nprint(\"hello\")\n```');
    expect(cleaned).toBe('Body text.\n');
  });
});

describe('Footnote OOXML generation', () => {
  it('generateRuns emits footnoteReference for footnote_ref runs', () => {
    const state = makeState();
    const runs: MdRun[] = [{ type: 'footnote_ref', text: '', footnoteLabel: '1' }];
    const xml = generateRuns(runs, state);
    expect(xml).toContain('w:footnoteReference');
    expect(xml).toContain('FootnoteReference');
    expect(state.hasFootnotes).toBe(true);
    expect(state.footnoteLabelToId.get('1')).toBe(1);
  });

  it('generateRuns emits endnoteReference in endnote mode', () => {
    const state = makeState();
    state.notesMode = 'endnotes';
    const runs: MdRun[] = [{ type: 'footnote_ref', text: '', footnoteLabel: '1' }];
    const xml = generateRuns(runs, state);
    expect(xml).toContain('w:endnoteReference');
    expect(xml).toContain('EndnoteReference');
    expect(state.hasEndnotes).toBe(true);
  });
});

describe('Full MD→DOCX footnote generation', () => {
  it('convertMdToDocx produces DOCX with word/footnotes.xml', async () => {
    const md = 'Hello[^1] world.\n\n[^1]: A footnote.';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const footnotesFile = zip.file('word/footnotes.xml');
    expect(footnotesFile).not.toBeNull();
    const footnotesXml = await footnotesFile!.async('string');
    expect(footnotesXml).toContain('xmlns:w14=');
    expect(footnotesXml).toContain('w:footnoteRef');
    expect(footnotesXml).toContain('A footnote.');
  });

  it('endnote mode via notes: endnotes frontmatter', async () => {
    const md = '---\nnotes: endnotes\n---\n\nHello[^1] world.\n\n[^1]: An endnote.';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const endnotesFile = zip.file('word/endnotes.xml');
    expect(endnotesFile).not.toBeNull();
    expect(zip.file('word/footnotes.xml')).toBeNull();
    const endnotesXml = await endnotesFile!.async('string');
    expect(endnotesXml).toContain('xmlns:w14=');
    expect(endnotesXml).toContain('w:endnoteRef');
    expect(endnotesXml).toContain('An endnote.');
  });

  it('warns for orphaned footnote reference', async () => {
    const md = 'Text[^1] without definition.';
    const { warnings } = await convertMdToDocx(md);
    expect(warnings.some(w => w.includes('[^1]') && w.includes('no matching definition'))).toBe(true);
  });

  it('warns for orphaned footnote definition', async () => {
    const md = 'Text without reference.\n\n[^1]: Orphaned definition.';
    const { warnings } = await convertMdToDocx(md);
    expect(warnings.some(w => w.includes('[^1]') && w.includes('no matching reference'))).toBe(true);
  });

  it('ignores trailing semicolon in citation group', async () => {
    const bib = `@article{smith2020,\n  author = {Smith, John},\n  title = {Title},\n  year = {2020},\n}`;
    const md = 'Text [@smith2020;].';
    const { warnings } = await convertMdToDocx(md, { bibtex: bib });
    expect(warnings).toEqual([]);
  });

  it('stores MANUSCRIPT_FOOTNOTE_IDS for named labels', async () => {
    const md = 'Text[^my-note] here.\n\n[^my-note]: Named note.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customFile = zip.file('docProps/custom.xml');
    expect(customFile).not.toBeNull();
    const customXml = await customFile!.async('string');
    expect(customXml).toContain('MANUSCRIPT_FOOTNOTE_IDS');
    expect(customXml).toContain('my-note');
  });

  it('does not store MANUSCRIPT_FOOTNOTE_IDS for numeric-only labels', async () => {
    const md = 'Text[^1] here.\n\n[^1]: Numeric note.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customFile = zip.file('docProps/custom.xml');
    if (customFile) {
      const customXml = await customFile.async('string');
      expect(customXml).not.toContain('MANUSCRIPT_FOOTNOTE_IDS');
    }
  });
});

describe('Footnote round-trip', () => {
  it('MD→DOCX→MD preserves footnotes', async () => {
    const md = 'Hello[^1] world.\n\n[^1]: A footnote.';
    const { docx } = await convertMdToDocx(md);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('[^1]');
    expect(result.markdown).toContain('[^1]: A footnote.');
  });

  it('MD→DOCX→MD preserves named labels via MANUSCRIPT_FOOTNOTE_IDS', async () => {
    const md = 'Text[^my-note] here.\n\n[^my-note]: Named note content.';
    const { docx } = await convertMdToDocx(md);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('[^my-note]');
    expect(result.markdown).toContain('[^my-note]: Named note content.');
  });
});
describe('parseMd list levels with blockquotes', () => {
  it('resets list level inside blockquote and preserves quote level', () => {
    const tokens = parseMd('- outer item\n> - quoted item');
    expect(tokens).toHaveLength(2);

    expect(tokens[0]).toMatchObject({
      type: 'list_item',
      level: 1,
      ordered: false,
    });

    expect(tokens[1]).toMatchObject({
      type: 'blockquote',
      level: 1,
      ordered: false,
    });
  });
});

describe('generateParagraph blockquoteStyle option', () => {
  it('uses GitHub style by default', () => {
    const token: MdToken = { type: 'blockquote', level: 1, runs: [{ type: 'text', text: 'hello' }] };
    const state = makeState();
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:pStyle w:val="GitHub"');
  });

  it('uses IntenseQuote style when specified', () => {
    const token: MdToken = { type: 'blockquote', level: 1, runs: [{ type: 'text', text: 'hello' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'IntenseQuote' });
    expect(xml).toContain('w:pStyle w:val="IntenseQuote"');
    expect(xml).not.toContain('w:pStyle w:val="Quote"');
  });

  it('uses GitHub style when specified', () => {
    const token: MdToken = { type: 'blockquote', level: 1, runs: [{ type: 'text', text: 'hello' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'GitHub' });
    expect(xml).toContain('w:pStyle w:val="GitHub"');
  });

  it('GitHub nested blockquote uses 240-twip indent unit', () => {
    const token: MdToken = { type: 'blockquote', level: 2, runs: [{ type: 'text', text: 'nested' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'GitHub' });
    expect(xml).toContain('w:ind w:left="480"');
    expect(xml).toContain('w:pStyle w:val="GitHub"');
  });

  it('Quote style uses 720-twip indent unit for nesting', () => {
    const token: MdToken = { type: 'blockquote', level: 2, runs: [{ type: 'text', text: 'nested' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'Quote' });
    expect(xml).toContain('w:ind w:left="1440"');
  });
});

describe('blockquote-style frontmatter', () => {
  it('parseFrontmatter parses blockquote-style: GitHub', () => {
    const md = '---\nblockquote-style: GitHub\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.blockquoteStyle).toBe('GitHub');
  });

  it('parseFrontmatter is case-insensitive', () => {
    const md = '---\nblockquote-style: github\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.blockquoteStyle).toBe('GitHub');
  });

  it('parseFrontmatter rejects invalid value', () => {
    const md = '---\nblockquote-style: invalid\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.blockquoteStyle).toBeUndefined();
  });

  it('serializeFrontmatter includes blockquote-style', () => {
    const yaml = serializeFrontmatter({ blockquoteStyle: 'GitHub' });
    expect(yaml).toContain('blockquote-style: GitHub');
  });

  it('blockquote-style round-trips through serialize → parse', () => {
    for (const style of ['Quote', 'IntenseQuote', 'GitHub'] as const) {
      const yaml = serializeFrontmatter({ blockquoteStyle: style });
      const { metadata } = parseFrontmatter(yaml + '\nBody text');
      expect(metadata.blockquoteStyle).toBe(style);
    }
  });

  it('frontmatter blockquote-style overrides options in convertMdToDocx', async () => {
    const md = '---\nblockquote-style: IntenseQuote\n---\n\n> quoted text';
    const { docx } = await convertMdToDocx(md, { blockquoteStyle: 'Quote' });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:pStyle w:val="IntenseQuote"');
    expect(docXml).not.toContain('w:pStyle w:val="Quote"');
  });

  it('defaults to GitHub style when no frontmatter or options', async () => {
    const md = '> quoted text';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:pStyle w:val="GitHub"');
  });

  it('convertMdToDocx emits alert styles and monochrome title prefixes', async () => {
    const md = '> [!TIP]\n> Helpful advice';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:pStyle w:val=\"GitHubTip\"');
    expect(docXml).toContain('◈ Tip ');
    expect(docXml).not.toContain('[!TIP]');
  });
});

describe('Code block language tracking', () => {
  it('records language in state when present', () => {
    const token: MdToken = {
      type: 'code_block',
      language: 'stata',
      runs: [{ type: 'text', text: 'display "hello"' }]
    };
    const state = makeState();
    generateParagraph(token, state);
    expect(state.codeBlockIndex).toBe(1);
    expect(state.codeBlockLanguages.get(0)).toBe('stata');
  });

  it('increments index without recording when no language', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'some code' }]
    };
    const state = makeState();
    generateParagraph(token, state);
    expect(state.codeBlockIndex).toBe(1);
    expect(state.codeBlockLanguages.size).toBe(0);
  });

  it('tracks multiple code blocks with mixed languages', () => {
    const state = makeState();
    generateParagraph({ type: 'code_block', language: 'python', runs: [{ type: 'text', text: 'print("hi")' }] }, state);
    generateParagraph({ type: 'code_block', runs: [{ type: 'text', text: 'plain code' }] }, state);
    generateParagraph({ type: 'code_block', language: 'r', runs: [{ type: 'text', text: 'cat("hi")' }] }, state);
    expect(state.codeBlockIndex).toBe(3);
    expect(state.codeBlockLanguages.get(0)).toBe('python');
    expect(state.codeBlockLanguages.has(1)).toBe(false);
    expect(state.codeBlockLanguages.get(2)).toBe('r');
  });
});

describe('Code block language custom properties', () => {
  it('stores language mapping in MANUSCRIPT_CODE_BLOCK_LANGS custom property', async () => {
    const md = '```stata\ndisplay "hello"\n```';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toBeDefined();
    expect(customXml).toContain('MANUSCRIPT_CODE_BLOCK_LANGS_1');
    expect(customXml).toContain('stata');
  });

  it('does not create custom property when no code block languages', async () => {
    const md = '```\nplain code\n```';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    // No custom.xml at all, or no code block langs property
    if (customXml) {
      expect(customXml).not.toContain('MANUSCRIPT_CODE_BLOCK_LANGS');
    }
  });
});

describe('Code block separator between consecutive blocks', () => {
  it('inserts empty paragraph between consecutive code blocks', async () => {
    const md = '```python\nprint("a")\n```\n\n```r\ncat("b")\n```';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).toBeDefined();
    // The separator should be an empty <w:p .../> between the two code block groups
    expect(docXml).toMatch(/<w:p w14:paraId="[0-9A-F]+" w14:textId="[0-9A-F]+"\/>/);
  });
});

describe('Blockquote to paragraph separators in DOCX export', () => {
  const separatorRe = /<w:p\s[^>]*><w:pPr><w:spacing w:before="0" w:after="0" w:line="276" w:lineRule="auto"\/><\/w:pPr><\/w:p>/g;
  it('inserts empty paragraph after callout when source has blank line before paragraph', async () => {
    const md = '> [!NOTE]\n> This is a note.\n\nThis is a paragraph.';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).toBeDefined();
    expect(docXml).toContain('This is a note.');
    expect(docXml).toContain('This is a paragraph.');
    const separatorCount = (docXml!.match(separatorRe) || []).length;
    expect(separatorCount).toBe(1);
  });

  it('does not insert empty paragraph after callout when source has no blank line before paragraph', async () => {
    const md = '> [!NOTE]\n> This is a note.\nThis is a paragraph.';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).toBeDefined();
    expect(docXml).toContain('This is a note.');
    expect(docXml).toContain('This is a paragraph.');
    const separatorCount = (docXml!.match(separatorRe) || []).length;
    expect(separatorCount).toBe(0);
  });
});

// Feature: code-region-inert-zones, Task 8.2: Verify MD→DOCX converter handles code regions correctly
// Confirms that processInlineChildren handles code_inline tokens as { type: 'text', code: true } runs
// without CriticMarkup interpretation, and convertTokens handles fence tokens at block level with plain text.
// No code changes needed — markdown-it's token architecture provides sufficient protection.
describe('Code region inertness in MD→DOCX', () => {
  it('parses inline code with CriticMarkup addition as plain code run', () => {
    const tokens = parseMd('`{++added++}`');
    expect(tokens.length).toBe(1);
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{++added++}');
    expect(codeRun!.type).toBe('text');
    // No critic_add runs should exist
    expect(runs.filter(r => r.type === 'critic_add')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup deletion as plain code run', () => {
    const tokens = parseMd('`{--deleted--}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{--deleted--}');
    expect(runs.filter(r => r.type === 'critic_del')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup highlight as plain code run', () => {
    const tokens = parseMd('`{==highlighted==}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{==highlighted==}');
    expect(runs.filter(r => r.type === 'critic_highlight')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup comment as plain code run', () => {
    const tokens = parseMd('`{>>comment<<}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{>>comment<<}');
    expect(runs.filter(r => r.type === 'critic_comment')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup substitution as plain code run', () => {
    const tokens = parseMd('`{~~old~>new~~}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{~~old~>new~~}');
    expect(runs.filter(r => r.type === 'critic_sub')).toHaveLength(0);
  });

  it('parses inline code with format highlight as plain code run', () => {
    const tokens = parseMd('`==highlighted==`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('==highlighted==');
    expect(runs.filter(r => r.type === 'critic_highlight')).toHaveLength(0);
  });

  it('parses inline code with citation as plain code run', () => {
    const tokens = parseMd('`[@smith2020]`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('[@smith2020]');
    expect(runs.filter(r => r.type === 'citation')).toHaveLength(0);
  });

  it('parses fenced code block with CriticMarkup as plain text code_block token', () => {
    const tokens = parseMd('```\n{++added++}\n{--deleted--}\n{==highlighted==}\n```');
    const codeBlock = tokens.find(t => t.type === 'code_block');
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.runs.length).toBe(1);
    expect(codeBlock!.runs[0].type).toBe('text');
    expect(codeBlock!.runs[0].text).toContain('{++added++}');
    expect(codeBlock!.runs[0].text).toContain('{--deleted--}');
    expect(codeBlock!.runs[0].text).toContain('{==highlighted==}');
  });

  it('parses fenced code block with language tag as plain text', () => {
    const tokens = parseMd('```python\n{++added++}\nprint("hello")\n```');
    const codeBlock = tokens.find(t => t.type === 'code_block');
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.language).toBe('python');
    expect(codeBlock!.runs[0].text).toContain('{++added++}');
  });

  it('still parses CriticMarkup outside inline code', () => {
    const tokens = parseMd('Before `code` {++after++}');
    const runs = tokens[0].runs;
    // Should have a code run for the inline code
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('code');
    // Should have a critic_add run for the CriticMarkup outside code
    const addRun = runs.find(r => r.type === 'critic_add');
    expect(addRun).toBeDefined();
    expect(addRun!.text).toBe('after');
  });

  it('parses indented code block as code_block token', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter(s => !s.includes('\n') && s.trim().length > 0),
        line => {
          const tokens = parseMd('    ' + line + '\n');
          const codeBlock = tokens.find(t => t.type === 'code_block');
          expect(codeBlock).toBeDefined();
          expect(codeBlock!.runs[0].text).toContain(line);
        }
      ),
      { numRuns: 10 }
    );
  });
});

describe('convertMdToDocx indented code blocks', () => {
  it('preserves indented code block content in docx', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), { minLength: 1, maxLength: 40 }).map(a => a.join('')),
        async line => {
          const markdown = '    ' + line + '\n';
          const result = await convertMdToDocx(markdown);

          const JSZip = (await import('jszip')).default;
          const zip = await JSZip.loadAsync(result.docx);

          const document = await zip.files['word/document.xml'].async('string');
          expect(document).toContain(line);
          expect(document).toContain('CodeBlock');
        }
      ),
      { numRuns: 10 }
    );
  });
});

describe('colors frontmatter', () => {
  afterEach(() => {
    setDefaultColorScheme('guttmacher');
  });

  it('parseFrontmatter parses colors: guttmacher', () => {
    const md = '---\ncolors: guttmacher\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBe('guttmacher');
  });

  it('parseFrontmatter parses colors: github', () => {
    const md = '---\ncolors: github\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBe('github');
  });

  it('parseFrontmatter is case-insensitive for colors', () => {
    const md = '---\ncolors: Guttmacher\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBe('guttmacher');
  });

  it('parseFrontmatter rejects invalid colors value', () => {
    const md = '---\ncolors: rainbow\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBeUndefined();
  });

  it('serializeFrontmatter includes colors', () => {
    const yaml = serializeFrontmatter({ colors: 'guttmacher' });
    expect(yaml).toContain('colors: guttmacher');
  });

  it('colors round-trips through serialize → parse', () => {
    for (const scheme of ['github', 'guttmacher'] as const) {
      const yaml = serializeFrontmatter({ colors: scheme });
      const { metadata } = parseFrontmatter(yaml + '\nBody text');
      expect(metadata.colors).toBe(scheme);
    }
  });

  it('generateParagraph uses guttmacher alert colors when specified', () => {
    const token: MdToken = {
      type: 'blockquote', level: 1, alertType: 'note', alertLead: true,
      runs: [{ type: 'text', text: 'info' }]
    };
    const state = makeState();
    const xml = generateParagraph(token, state, { colors: 'guttmacher' });
    expect(xml).toContain('w:val="' + GUTTMACHER_ALERT_COLORS.note + '"');
    expect(xml).not.toContain('w:val="' + GITHUB_ALERT_COLORS.note + '"');
  });

  it('generateParagraph uses guttmacher alert colors by default', () => {
    const token: MdToken = {
      type: 'blockquote', level: 1, alertType: 'note', alertLead: true,
      runs: [{ type: 'text', text: 'info' }]
    };
    const state = makeState();
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:val="' + GUTTMACHER_ALERT_COLORS.note + '"');
    expect(xml).not.toContain('w:val="' + GITHUB_ALERT_COLORS.note + '"');
  });

  it('guttmacher spacer border uses guttmacher colors', () => {
    const token: MdToken = {
      type: 'blockquote', level: 1, alertType: 'tip', alertFirst: true, alertLast: true,
      runs: [{ type: 'text', text: 'tip text' }]
    };
    const state = makeState();
    const xml = generateParagraph(token, state, { colors: 'guttmacher' });
    expect(xml).toContain('w:color="' + GUTTMACHER_ALERT_COLORS.tip + '"');
    expect(xml).not.toContain('w:color="' + GITHUB_ALERT_COLORS.tip + '"');
  });

  it('stylesXml uses guttmacher colors in alert styles', () => {
    const xml = stylesXml(undefined, undefined, 'guttmacher');
    for (const color of Object.values(GUTTMACHER_ALERT_COLORS)) {
      expect(xml).toContain(color);
    }
    for (const color of Object.values(GITHUB_ALERT_COLORS)) {
      expect(xml).not.toContain(color);
    }
  });

  it('stylesXml uses guttmacher colors by default', () => {
    const xml = stylesXml();
    for (const color of Object.values(GUTTMACHER_ALERT_COLORS)) {
      expect(xml).toContain(color);
    }
    for (const color of Object.values(GITHUB_ALERT_COLORS)) {
      expect(xml).not.toContain(color);
    }
  });

  it('frontmatter colors overrides options in convertMdToDocx', async () => {
    const md = '---\ncolors: guttmacher\n---\n\n> [!NOTE]\n> info text';
    const { docx } = await convertMdToDocx(md, { colors: 'github' });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain(GUTTMACHER_ALERT_COLORS.note);
    expect(docXml).not.toContain(GITHUB_ALERT_COLORS.note);
  });

  it('defaults to guttmacher colors when no frontmatter or options', async () => {
    const md = '> [!NOTE]\n> info text';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain(GUTTMACHER_ALERT_COLORS.note);
    expect(docXml).not.toContain(GITHUB_ALERT_COLORS.note);
  });

  it('applyAlertColorsToTemplate patches border colors for guttmacher', () => {
    // Generate a github styles.xml, then patch to guttmacher
    const original = stylesXml(undefined, undefined, 'github');
    expect(original).toContain(GITHUB_ALERT_COLORS.note);
    const patched = applyAlertColorsToTemplate(original, 'guttmacher');
    for (const color of Object.values(GUTTMACHER_ALERT_COLORS)) {
      expect(patched).toContain(color);
    }
    expect(patched).not.toContain(GITHUB_ALERT_COLORS.note);
  });

  it('applyAlertColorsToTemplate patches from guttmacher back to github', () => {
    const original = stylesXml(undefined, undefined, 'guttmacher');
    expect(original).toContain(GUTTMACHER_ALERT_COLORS.note);
    const patched = applyAlertColorsToTemplate(original, 'github');
    for (const color of Object.values(GITHUB_ALERT_COLORS)) {
      expect(patched).toContain(color);
    }
    expect(patched).not.toContain(GUTTMACHER_ALERT_COLORS.note);
  });

  it('applyAlertColorsToTemplate is a no-op for matching scheme', () => {
    for (const scheme of ['github', 'guttmacher'] as const) {
      const original = stylesXml(undefined, undefined, scheme);
      const patched = applyAlertColorsToTemplate(original, scheme);
      expect(patched).toBe(original);
    }
  });

  it('template-based export applies guttmacher colors to styles.xml', async () => {
    // First, generate a DOCX to use as template (with explicit github colors)
    const templateMd = '> [!NOTE]\n> template note';
    const { docx: templateDocx } = await convertMdToDocx(templateMd, { colors: 'github' });

    // Now convert with guttmacher using that template
    const md = '---\ncolors: guttmacher\n---\n\n> [!TIP]\n> guttmacher tip';
    const { docx } = await convertMdToDocx(md, { templateDocx: new Uint8Array(templateDocx) });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const stylesContent = await zip.file('word/styles.xml')!.async('string');
    // Template styles should have guttmacher colors patched in
    expect(stylesContent).toContain(GUTTMACHER_ALERT_COLORS.note);
    expect(stylesContent).toContain(GUTTMACHER_ALERT_COLORS.tip);
    expect(stylesContent).not.toContain(GITHUB_ALERT_COLORS.note);
  });
});

describe('alert-colors module', () => {
  afterEach(() => {
    setDefaultColorScheme('guttmacher');
  });

  it('alertColorsByScheme falls back to default scheme for unknown value', () => {
    // Default scheme is guttmacher, so unknown values should resolve to guttmacher colors
    expect(alertColorsByScheme('unknown' as any).note).toBe(GUTTMACHER_ALERT_COLORS.note);
  });

  it('setDefaultColorScheme rejects invalid values and falls back to guttmacher', () => {
    setDefaultColorScheme('github');
    setDefaultColorScheme('rainbow' as any);
    expect(getDefaultColorScheme()).toBe('guttmacher');
  });

  it('setDefaultColorScheme accepts valid values', () => {
    setDefaultColorScheme('guttmacher');
    expect(getDefaultColorScheme()).toBe('guttmacher');
    setDefaultColorScheme('github');
    expect(getDefaultColorScheme()).toBe('github');
  });
});
