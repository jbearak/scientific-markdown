#!/usr/bin/env bun
/**
 * Word dirty-flag discovery and diagnosis.
 *
 * Usage:
 *   bun scripts/dirty-flag-diagnose.ts
 *   bun scripts/dirty-flag-diagnose.ts --verify
 *   bun scripts/dirty-flag-diagnose.ts --fixture <id>
 *   bun scripts/dirty-flag-diagnose.ts <path-to-md>
 *
 * Options:
 *   --verify   Check the committed dirty-frontier baseline
 *   --fixture  Run discovery for one named built-in fixture
 *   --bisect   For dirty cases, test each changed part individually
 *   --keep     Keep temporary DOCX files in Word's sandbox directory
 */

import {
  WORD_DIRTY_FIXTURES,
  diagnoseMarkdownPath,
  discoverWordDirtyFrontier,
  getExpectedWordDirtyFrontier,
  verifyWordDirtyBaseline,
} from '../src/word-dirty';

const args = process.argv.slice(2);
const keepWordCopies = args.includes('--keep');
const verify = args.includes('--verify');
const bisect = args.includes('--bisect');
const fixtureIndex = args.indexOf('--fixture');
const fixtureId = fixtureIndex !== -1 ? args[fixtureIndex + 1] : undefined;
const mdPathArg = args.find(arg => !arg.startsWith('--') && arg !== fixtureId);

function printUsage(): void {
  console.log('Dirty-flag frontier');
  console.log('===================');
  console.log('');
  console.log('Built-in fixtures:');
  for (const fixture of WORD_DIRTY_FIXTURES) {
    console.log('  - ' + fixture.id + ' [' + fixture.expectedState + ']');
  }
  console.log('');
  console.log('Examples:');
  console.log('  bun scripts/dirty-flag-diagnose.ts');
  console.log('  bun scripts/dirty-flag-diagnose.ts --verify');
  console.log('  bun scripts/dirty-flag-diagnose.ts --fixture single-paragraph');
  console.log('  bun scripts/dirty-flag-diagnose.ts test/fixtures/draft.md --bisect');
}

function printSummary(
  title: string,
  summary: Awaited<ReturnType<typeof discoverWordDirtyFrontier>>
): void {
  console.log(title);
  console.log('='.repeat(title.length));
  console.log('');
  if (summary.actualFrontierFixtureId) {
    console.log('Actual frontier: ' + summary.actualFrontierFixtureId);
  } else {
    console.log('Actual frontier: none found');
  }
  console.log('');
  for (const result of summary.results) {
    console.log(result.fixtureId + ': ' + result.status);
    if (result.note) console.log('  note: ' + result.note);
    if (result.changedParts.length > 0) console.log('  changed: ' + result.changedParts.join(', '));
    if (result.addedParts.length > 0) console.log('  added: ' + result.addedParts.join(', '));
    if (result.removedParts.length > 0) console.log('  removed: ' + result.removedParts.join(', '));
    if (result.warnings.length > 0) console.log('  warnings: ' + result.warnings.join('; '));
    console.log('  artifacts: ' + result.artifactDir);
  }
}

async function main() {
  if (args.includes('--help')) {
    printUsage();
    return;
  }

  if (verify && mdPathArg) {
    throw new Error('Use either --verify or a markdown path, not both.');
  }

  if (verify) {
    const expectedFrontier = getExpectedWordDirtyFrontier();
    console.log('Expected frontier: ' + expectedFrontier.id);
    const summary = await verifyWordDirtyBaseline({ keepWordCopies, bisect });
    printSummary('Dirty-flag verify', summary);
    return;
  }

  if (mdPathArg) {
    const summary = await diagnoseMarkdownPath(mdPathArg, { keepWordCopies, bisect });
    printSummary('Dirty-flag diagnose', summary);
    return;
  }

  const summary = await discoverWordDirtyFrontier({ fixtureId, keepWordCopies, bisect });
  printSummary('Dirty-flag discovery', summary);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
