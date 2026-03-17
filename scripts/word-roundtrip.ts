#!/usr/bin/env bun
/**
 * Word round-trip test suite
 *
 * Verifies that opening and re-saving a DOCX in Microsoft Word doesn't
 * corrupt the Markdown round-trip. Compares:
 *   programmatic: md → docx → md
 *   word:         md → docx → [Word open+save] → docx → md
 *
 * Run: bun scripts/word-roundtrip.ts
 * Options:
 *   --keep      Don't delete DOCX files from Word container after run
 *   --only <n>  Run only the named test case
 *   --verbose   Print markdown and warnings for each case
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { convertMdToDocx } from '../src/md-to-docx';
import { convertDocx } from '../src/converter';
import { ensureWordDocsDir, openAndSaveInWord, wordDocsDir } from '../src/word-automation';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const keepFiles = args.includes('--keep');
const verbose = args.includes('--verbose');
const onlyIdx = args.indexOf('--only');
const onlyName = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

const outDir = join(__dirname, 'word-roundtrip-output');

mkdirSync(outDir, { recursive: true });
ensureWordDocsDir();

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const testCases: Array<{ name: string; md: string }> = [
  {
    name: 'plain-text',
    md: [
      '# Heading 1',
      '',
      '## Heading 2',
      '',
      '### Heading 3',
      '',
      '#### Heading 4',
      '',
      '##### Heading 5',
      '',
      '###### Heading 6',
      '',
      'This is a plain paragraph of text. It has multiple sentences. Nothing fancy here.',
      '',
      'Another paragraph to verify spacing between paragraphs is preserved.',
      '',
      '---',
      '',
      'Text after a horizontal rule.',
    ].join('\n'),
  },
  {
    name: 'inline-formatting',
    md: [
      '# Inline Formatting',
      '',
      'This has **bold** and *italic* and ***bold italic*** text.',
      '',
      'This has __underline__ and ~~strikethrough~~ text.',
      '',
      'This has ^superscript^ and ~subscript~ text.',
      '',
      'This has `inline code` in a sentence.',
      '',
      'This has ==highlighted text== and ==red highlight=={red} and ==blue highlight=={blue}.',
    ].join('\n'),
  },
  {
    name: 'lists',
    md: [
      '# Lists',
      '',
      '- Item one',
      '- Item two',
      '  - Nested item A',
      '  - Nested item B',
      '- Item three',
      '',
      '1. First',
      '2. Second',
      '   1. Sub-first',
      '   2. Sub-second',
      '3. Third',
      '',
      '- [ ] Unchecked task',
      '- [x] Checked task',
      '- [ ] Another unchecked task',
    ].join('\n'),
  },
  {
    name: 'pipe-tables',
    md: [
      '# Pipe Tables',
      '',
      '| Left | Center | Right |',
      '| :--- | :----: | ----: |',
      '| A1   |   B1   |    C1 |',
      '| A2   |   B2   |    C2 |',
      '| A3   |   B3   |    C3 |',
    ].join('\n'),
  },
  {
    name: 'html-tables',
    md: [
      '# HTML Tables',
      '',
      '<table>',
      '<tr><th>Header 1</th><th colspan="2">Merged Header</th></tr>',
      '<tr><td rowspan="2">Span</td><td>B1</td><td>C1</td></tr>',
      '<tr><td>B2</td><td>C2</td></tr>',
      '</table>',
    ].join('\n'),
  },
  {
    name: 'code-blocks',
    md: [
      '# Code Blocks',
      '',
      '```js',
      'function hello() {',
      '  console.log("Hello, world!");',
      '}',
      '```',
      '',
      '```python',
      'def greet(name):',
      '    print(f"Hello, {name}")',
      '```',
      '',
      '```',
      'Plain code block with no language tag.',
      '```',
    ].join('\n'),
  },
  {
    name: 'blockquotes-alerts',
    md: [
      '# Blockquotes and Alerts',
      '',
      '> A simple blockquote.',
      '>',
      '> > A nested blockquote.',
      '',
      '> [!NOTE]',
      '> This is a note alert.',
      '',
      '> [!TIP]',
      '> This is a tip alert.',
      '',
      '> [!IMPORTANT]',
      '> This is an important alert.',
      '',
      '> [!WARNING]',
      '> This is a warning alert.',
      '',
      '> [!CAUTION]',
      '> This is a caution alert.',
    ].join('\n'),
  },
  {
    name: 'links',
    md: [
      '# Links',
      '',
      'Visit [Example](https://example.com) for more info.',
      '',
      'Visit [Example with title](https://example.com "Example Title") for more info.',
      '',
      'A plain URL: https://example.com/plain',
    ].join('\n'),
  },
  {
    name: 'footnotes',
    md: [
      '# Footnotes',
      '',
      'This sentence has a footnote.[^1] And another.[^second]',
      '',
      'More text with a third footnote.[^3]',
      '',
      '[^1]: First footnote definition.',
      '',
      '[^second]: Second footnote with a longer explanation that spans a bit.',
      '',
      '[^3]: Third footnote.',
    ].join('\n'),
  },
  {
    name: 'math',
    md: [
      '# Math',
      '',
      // Avoid $$ in template literals per CLAUDE.md — use concatenation
      'Inline math: $E = mc^2$ and $\\alpha + \\beta = \\gamma$.',
      '',
      'Display math:',
      '',
    ].join('\n') + '$$\n\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}\n$$\n',
  },
  {
    name: 'criticmarkup',
    md: [
      '# CriticMarkup',
      '',
      'This is {++an addition++} in text.',
      '',
      'This is {--a deletion--} in text.',
      '',
      'This is {~~old~>new~~} a substitution.',
      '',
      'This is {==a highlight==} in text.',
      '',
      'This is {>>a comment<<} in text.',
    ].join('\n'),
  },
  {
    name: 'custom-styles',
    md: [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '    font-size: 14',
      '    font-style: bold-italic-center',
      '    spacing-before: 12',
      '    spacing-after: 6',
      '---',
      '',
      'Normal paragraph.',
      '',
      '<!-- style: pullquote -->',
      '',
      'This is a pullquote with custom styling.',
      '',
      '<!-- /style -->',
      '',
      'Back to normal.',
    ].join('\n'),
  },
  {
    name: 'landscape-portrait',
    md: [
      '# Landscape and Portrait',
      '',
      'Text in default orientation.',
      '',
      '<!-- landscape -->',
      '',
      'This section is in landscape orientation.',
      '',
      '<!-- /landscape -->',
      '',
      'Back to portrait orientation.',
    ].join('\n'),
  },
  {
    name: 'frontmatter',
    md: [
      '---',
      'font: Palatino',
      'font-size: 12',
      'header-font: Helvetica Neue',
      'header-font-style: bold',
      'title-font: Georgia',
      'code-font: Fira Code',
      'code-background: "#f5f5f5"',
      '---',
      '',
      '# Heading with Header Font',
      '',
      'Body text in Palatino 12pt.',
      '',
      '```',
      'Code in Fira Code with background.',
      '```',
    ].join('\n'),
  },
  {
    name: 'combined',
    md: [
      '---',
      'styles:',
      '  note-style:',
      '    font-style: italic',
      '    spacing-before: 6',
      '    spacing-after: 6',
      '---',
      '',
      '# Combined Features',
      '',
      'This has **bold**, *italic*, and `code`.',
      '',
      '| Col A | Col B |',
      '| ----- | ----- |',
      '| 1     | 2     |',
      '',
      'A footnote reference.[^combo]',
      '',
      '> [!NOTE]',
      '> An alert inside the combined test.',
      '',
      '<!-- style: note-style -->',
      '',
      'Custom-styled paragraph.',
      '',
      '<!-- /style -->',
      '',
      '```js',
      'const x = 42;',
      '```',
      '',
      'Inline math: $a^2 + b^2 = c^2$.',
      '',
      'CriticMarkup: {++added++} and {--removed--}.',
      '',
      '[^combo]: Combined footnote definition.',
    ].join('\n'),
  },
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type ResultTier = 'PASS' | 'WARN' | 'FAIL' | 'ERROR';

interface TestResult {
  name: string;
  tier: ResultTier;
  diff?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Whitespace normalizer for WARN tier
// ---------------------------------------------------------------------------

function normalizeWhitespace(s: string): string {
  return s
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Word round-trip test');
  console.log('====================');
  console.log('Output dir: ' + outDir + '/');
  console.log('');

  const cases = onlyName
    ? testCases.filter(tc => tc.name === onlyName)
    : testCases;

  if (cases.length === 0) {
    console.error('No test case found with name: ' + onlyName);
    process.exit(1);
  }

  const results: TestResult[] = [];
  const docxPaths: string[] = [];
  let isFirst = true;

  for (const tc of cases) {
    process.stdout.write('Running: ' + tc.name + ' ... ');

    try {
      // 1. Programmatic round-trip: md → docx → md
      const { docx, warnings } = await convertMdToDocx(tc.md);
      if (verbose && warnings.length > 0) {
        console.log('\n  Warnings: ' + warnings.join(', '));
      }
      const progResult = await convertDocx(docx);
      const programmaticMd = progResult.markdown;

      // Write programmatic intermediates
      writeFileSync(join(outDir, tc.name + '-programmatic.md'), programmaticMd);
      writeFileSync(join(outDir, tc.name + '-programmatic.docx'), docx);

      if (verbose) {
        console.log('\n  Programmatic MD:\n' + programmaticMd.slice(0, 200) + '...');
      }

      // 2. Word round-trip: md → docx → [Word] → docx → md
      const wordDocxPath = join(wordDocsDir, 'word-rt-' + tc.name + '.docx');
      writeFileSync(wordDocxPath, docx);
      docxPaths.push(wordDocxPath);

      openAndSaveInWord(wordDocxPath, {
        activateDelaySeconds: isFirst ? 5 : 3,
        openDelaySeconds: 3,
        saveDelaySeconds: 2,
      });
      isFirst = false;

      const savedDocx = readFileSync(wordDocxPath) as unknown as Uint8Array;
      const wordResult = await convertDocx(new Uint8Array(savedDocx));
      const wordMd = wordResult.markdown;

      // Write word intermediates
      writeFileSync(join(outDir, tc.name + '-word.md'), wordMd);
      writeFileSync(join(outDir, tc.name + '-word.docx'), savedDocx);

      if (verbose) {
        console.log('  Word MD:\n' + wordMd.slice(0, 200) + '...');
      }

      // 3. Compare
      const progTrimmed = programmaticMd.trimEnd();
      const wordTrimmed = wordMd.trimEnd();

      if (progTrimmed === wordTrimmed) {
        console.log('PASS');
        results.push({ name: tc.name, tier: 'PASS' });
      } else if (normalizeWhitespace(progTrimmed) === normalizeWhitespace(wordTrimmed)) {
        console.log('WARN');
        results.push({ name: tc.name, tier: 'WARN' });
      } else {
        console.log('FAIL');

        // Generate unified diff
        const progFile = join(outDir, tc.name + '-programmatic.md');
        const wordFile = join(outDir, tc.name + '-word.md');
        const diffResult = spawnSync('diff', [
          '-u',
          '--label', 'programmatic',
          '--label', 'word',
          progFile,
          wordFile,
        ], { encoding: 'utf-8' });
        const patch = diffResult.stdout;
        writeFileSync(join(outDir, tc.name + '-diff.patch'), patch);

        results.push({ name: tc.name, tier: 'FAIL', diff: patch });
      }
    } catch (err: any) {
      console.log('ERROR');
      results.push({ name: tc.name, tier: 'ERROR', error: err.message || String(err) });
    }
  }

  // Cleanup DOCX from Word container (unless --keep)
  if (!keepFiles) {
    for (const p of docxPaths) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {}
    }
  }

  // Report
  console.log('\n--- Results ---\n');

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let errorCount = 0;

  for (const r of results) {
    switch (r.tier) {
      case 'PASS':
        passCount++;
        console.log('  \u2713 ' + r.name);
        break;
      case 'WARN':
        warnCount++;
        console.log('  ~ ' + r.name + ' (whitespace only)');
        break;
      case 'FAIL':
        failCount++;
        console.log('  \u2717 ' + r.name);
        if (r.diff) console.log(r.diff);
        break;
      case 'ERROR':
        errorCount++;
        console.log('  ! ' + r.name + ' — ' + r.error);
        break;
    }
  }

  const total = results.length;
  console.log(
    '\n' + passCount + '/' + total + ' passed, ' +
    warnCount + ' warnings, ' +
    failCount + ' failed' +
    (errorCount > 0 ? ', ' + errorCount + ' errors' : '')
  );

  if (failCount > 0 || errorCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
