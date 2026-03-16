#!/usr/bin/env bun
/**
 * Dirty-flag diagnostic for a specific markdown file.
 *
 * Exports the given markdown to .docx, opens in Word, checks if Word marks it
 * dirty, and if so, saves Word's version and diffs every XML part to identify
 * what Word normalizes.
 *
 * Usage:
 *   bun scripts/dirty-flag-diagnose.ts [path-to-md] [--bisect] [--keep]
 *
 * Defaults to /Users/jmb/repos/ai-tools/ai-tools-internal-ai.md
 *
 * Options:
 *   --bisect   After diffing, test each changed part individually to isolate
 *              which replacement(s) make the file clean
 *   --keep     Don't delete DOCX files from Word container after run
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { convertMdToDocx } from '../src/md-to-docx';

const args = process.argv.slice(2);
const bisect = args.includes('--bisect');
const keep = args.includes('--keep');
const mdPath = args.find(a => !a.startsWith('--')) || '/Users/jmb/repos/ai-tools/ai-tools-internal-ai.md';

const wordDocsDir = join(homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents');
const diagDocx = join(wordDocsDir, 'dirty-diag.docx');
const savedDocx = join(wordDocsDir, 'dirty-diag-saved.docx');

// ---------------------------------------------------------------------------
// AppleScript helpers
// ---------------------------------------------------------------------------

function runAppleScript(lines: string[]): string {
  const cmdArgs = lines.flatMap(line => ['-e', line]);
  const result = spawnSync('osascript', cmdArgs, {
    timeout: 120_000,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error('osascript failed: ' + (result.stderr || 'status ' + result.status));
  }
  return (result.stdout + '\n' + result.stderr).trim();
}

function checkDirtyFlag(filePath: string): 'DIRTY' | 'CLEAN' {
  const output = runAppleScript([
    'tell application "Microsoft Word"',
    '  activate',
    '  delay 5',
    '  open POSIX file "' + filePath + '"',
    '  delay 5',
    '  set maxChecks to 10',
    '  set allClean to true',
    '  repeat maxChecks times',
    '    delay 1',
    '    if not (saved of active document) then',
    '      set allClean to false',
    '      exit repeat',
    '    end if',
    '  end repeat',
    '  if allClean then',
    '    log "CLEAN"',
    '  else',
    '    log "DIRTY"',
    '  end if',
    '  close active document saving no',
    'end tell',
  ]);
  return output.includes('DIRTY') ? 'DIRTY' : 'CLEAN';
}

function saveAndClose(filePath: string): void {
  runAppleScript([
    'tell application "Microsoft Word"',
    '  activate',
    '  delay 3',
    '  open POSIX file "' + filePath + '"',
    '  delay 5',
    '  save active document',
    '  delay 3',
    '  close active document saving no',
    'end tell',
  ]);
}

// ---------------------------------------------------------------------------
// XML diff helpers
// ---------------------------------------------------------------------------

async function unpackZip(data: Uint8Array): Promise<Map<string, string>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const entries = new Map<string, string>();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    // Try text; fall back to hex summary for binary
    try {
      entries.set(path, await file.async('string'));
    } catch {
      const bin = await file.async('uint8array');
      entries.set(path, '[binary ' + bin.length + ' bytes]');
    }
  }
  return entries;
}

function diffStrings(a: string, b: string, label: string): string | null {
  if (a === b) return null;
  // Use system diff for unified output
  const tmpA = join(wordDocsDir, 'diff-a.tmp');
  const tmpB = join(wordDocsDir, 'diff-b.tmp');
  writeFileSync(tmpA, a);
  writeFileSync(tmpB, b);
  const result = spawnSync('diff', [
    '-u',
    '--label', 'original/' + label,
    '--label', 'word/' + label,
    tmpA, tmpB,
  ], { encoding: 'utf-8' });
  try { unlinkSync(tmpA); } catch {}
  try { unlinkSync(tmpB); } catch {}
  return result.stdout || null;
}

async function replacePartInZip(
  originalData: Uint8Array,
  partPath: string,
  replacementContent: string
): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(originalData);
  zip.file(partPath, replacementContent);
  // Remove directory entries per invariant #2
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path]?.dir) delete (zip.files as Record<string, unknown>)[path];
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Dirty-flag diagnostic');
  console.log('=====================');

  // Step 1: Read inputs and export
  console.log('\nReading: ' + mdPath);
  if (!existsSync(mdPath)) {
    console.error('File not found: ' + mdPath);
    process.exit(1);
  }

  const md = readFileSync(mdPath, 'utf-8');
  const bibPath = mdPath.replace(/\.md$/, '.bib');
  const bib = existsSync(bibPath) ? readFileSync(bibPath, 'utf-8') : undefined;
  if (bib) console.log('BibTeX: ' + bibPath);

  console.log('\nConverting to DOCX...');
  const { docx, warnings } = await convertMdToDocx(md, {
    bibtex: bib,
    sourceDir: dirname(mdPath),
  });
  if (warnings.length > 0) {
    console.log('Warnings: ' + warnings.join('; '));
  }

  writeFileSync(diagDocx, docx);
  console.log('Wrote: ' + diagDocx);

  // Step 2: Check dirty flag
  console.log('\nOpening in Word and checking dirty flag...');
  const flag = checkDirtyFlag(diagDocx);
  console.log('Result: ' + flag);

  if (flag === 'CLEAN') {
    console.log('\nFile is clean — no dirty flag detected.');
    if (!keep) cleanup();
    return;
  }

  // Step 3: Save Word's version and diff
  console.log('\nFile is dirty. Saving Word\'s version for comparison...');

  // Copy original to a safe name, then open+save the original path
  const originalDocx = new Uint8Array(readFileSync(diagDocx));
  saveAndClose(diagDocx);

  // Read back Word's saved version
  const wordSavedDocx = new Uint8Array(readFileSync(diagDocx));
  writeFileSync(savedDocx, wordSavedDocx);

  console.log('\nUnpacking and diffing XML parts...\n');
  const originalParts = await unpackZip(originalDocx);
  const wordParts = await unpackZip(wordSavedDocx);

  // Find parts only in one version
  const allPaths = new Set([...originalParts.keys(), ...wordParts.keys()]);
  const changedParts: string[] = [];
  const addedParts: string[] = [];
  const removedParts: string[] = [];

  for (const path of [...allPaths].sort()) {
    const orig = originalParts.get(path);
    const word = wordParts.get(path);

    if (orig === undefined) {
      addedParts.push(path);
      console.log('+ ADDED by Word: ' + path);
    } else if (word === undefined) {
      removedParts.push(path);
      console.log('- REMOVED by Word: ' + path);
    } else if (orig !== word) {
      changedParts.push(path);
      console.log('~ CHANGED: ' + path);
      const diff = diffStrings(orig, word, path);
      if (diff) console.log(diff);
    }
  }

  if (changedParts.length === 0 && addedParts.length === 0 && removedParts.length === 0) {
    console.log('No XML differences found — dirty flag may be caused by zip-level differences.');
    if (!keep) cleanup();
    return;
  }

  console.log('\nSummary: ' + changedParts.length + ' changed, ' +
    addedParts.length + ' added, ' + removedParts.length + ' removed');

  // Step 4: Bisect (if requested)
  if (bisect && changedParts.length > 0) {
    console.log('\n--- Bisect mode ---');
    console.log('Testing each changed part individually...\n');

    for (const partPath of changedParts) {
      const wordContent = wordParts.get(partPath)!;
      const variant = await replacePartInZip(originalDocx, partPath, wordContent);
      const variantPath = join(wordDocsDir, 'dirty-diag-bisect.docx');
      writeFileSync(variantPath, variant);

      process.stdout.write('  Testing with Word\'s ' + partPath + ' ... ');
      const result = checkDirtyFlag(variantPath);
      console.log(result);

      if (!keep) {
        try { unlinkSync(variantPath); } catch {}
      }
    }

    // Also test with ALL changed parts replaced at once
    if (changedParts.length > 1) {
      let allFixed: Uint8Array = originalDocx;
      for (const partPath of changedParts) {
        allFixed = await replacePartInZip(allFixed, partPath, wordParts.get(partPath)!) as Uint8Array<ArrayBuffer>;
      }
      const allFixedPath = join(wordDocsDir, 'dirty-diag-bisect-all.docx');
      writeFileSync(allFixedPath, allFixed);
      process.stdout.write('  Testing with ALL changed parts from Word ... ');
      const result = checkDirtyFlag(allFixedPath);
      console.log(result);
      if (!keep) {
        try { unlinkSync(allFixedPath); } catch {}
      }
    }
  }

  if (!keep) cleanup();
}

function cleanup() {
  for (const p of [diagDocx, savedDocx]) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
