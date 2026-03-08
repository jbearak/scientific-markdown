#!/usr/bin/env bun
/**
 * Generate a DOCX file that exercises all custom style properties.
 * Usage: bun scripts/generate-custom-styles-docx.ts [output-path]
 *
 * Default output goes to Word's sandbox-accessible container directory.
 * Word on macOS is sandboxed — files in /tmp trigger false dirty flags.
 */
import { convertMdToDocx } from '../src/md-to-docx';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const wordDocsDir = join(homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents');
mkdirSync(wordDocsDir, { recursive: true });
const outputPath = process.argv[2] || join(wordDocsDir, 'custom-styles-test.docx');

const md = `---
styles:
  pullquote:
    font: Georgia
    font-size: 14
    font-style: bold-italic-center
    spacing-before: 12
    spacing-after: 6
  sidebar:
    font: Helvetica Neue
    font-size: 10
    font-style: italic
    spacing-before: 8
    spacing-after: 4
  callout:
    font: Courier New
    font-size: 12
    font-style: bold-underline
    spacing-before: 6
    spacing-after: 6
  small-heading:
    font-style: bold-smallcaps
    font-size: 16
    spacing-before: 18
    spacing-after: 6
  centered:
    font-style: center
    spacing-before: 12
    spacing-after: 12
---

This is a normal paragraph before any custom styles.

<!-- style: pullquote -->

This paragraph uses the pullquote style with Georgia 14pt bold-italic centered, spacing 12/6.

A second pullquote paragraph to test multi-paragraph blocks.

<!-- /style -->

Back to normal text.

<!-- style: sidebar -->

Sidebar text in Helvetica Neue 10pt italic with 8/4 spacing.

<!-- /style -->

Normal paragraph between styles.

<!-- style: callout -->

Callout in Courier New 12pt bold-underline with 6/6 spacing.

<!-- /style -->

<!-- style: small-heading -->

Small heading with bold smallcaps at 16pt.

<!-- /style -->

<!-- style: centered -->

Centered text with 12pt spacing on both sides.

<!-- /style -->

Final normal paragraph.
`;

async function main() {
  const { docx, warnings } = await convertMdToDocx(md);
  if (warnings.length > 0) {
    console.error('Warnings:');
    for (const w of warnings) console.error('  ' + w);
  }
  writeFileSync(outputPath, docx);
  console.log('Written to ' + outputPath + ' (' + docx.length + ' bytes)');
  console.log('Run: osascript scripts/custom-styles-dirty-test.applescript ' + outputPath);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
