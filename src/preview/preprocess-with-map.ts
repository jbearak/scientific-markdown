/**
 * Wrapper functions that run each preprocessor and compute a LineMap
 * tracking how preprocessed line numbers correspond to original line numbers.
 *
 * These wrappers call the original preprocessor to get the output, then
 * diff the original and output line arrays to build the mapping. This avoids
 * modifying the original preprocessors (which are also used by md-to-docx).
 *
 * Invariant: the line-walk logic in preprocessGridTablesWithMap must stay in
 * sync with preprocessGridTables in ../grid-table-preprocess.ts if the grid
 * table format ever changes.
 */

import { LineMap, type LineMapSegment } from './line-map';
import { preprocessGridTables } from '../grid-table-preprocess';
import { preprocessPanelFences } from '../panel-preprocess';
import { wrapBareLatexEnvironments } from '../latex-env-preprocess';
import { preprocessCriticMarkup } from '../critic-markup';

/**
 * Build a LineMap by comparing original and output line arrays.
 *
 * Scans both arrays in parallel. Unchanged lines (exact string match) get 1:1
 * segments. When lines diverge, we skip ahead in both arrays to find the next
 * matching anchor point, recording the divergent region as a gap.
 *
 * This is a simplified diff that works well for our preprocessors, which make
 * isolated, non-overlapping replacements with unique surrounding context.
 */
function buildMapFromLines(origLines: string[], outLines: string[]): LineMap {
  if (origLines.length === outLines.length) {
    // Quick check: if all lines match, return identity
    let allMatch = true;
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== outLines[i]) { allMatch = false; break; }
    }
    if (allMatch) return LineMap.identity();
  }

  const segments: LineMapSegment[] = [];
  let oi = 0; // original index
  let pi = 0; // preprocessed (output) index

  while (oi < origLines.length && pi < outLines.length) {
    // Find a run of matching lines
    if (origLines[oi] === outLines[pi]) {
      const segStart = pi;
      const origStart = oi;
      while (oi < origLines.length && pi < outLines.length && origLines[oi] === outLines[pi]) {
        oi++;
        pi++;
      }
      segments.push({ preprocessedStart: segStart, originalStart: origStart, length: pi - segStart });
      continue;
    }

    // Lines diverge — find the next anchor point.
    // Look for the next output line that matches some original line ahead.
    let foundAnchor = false;
    // Build an index of non-blank original lines to their first occurrence
    // from oi onward, then do a single O(n) scan of output lines.
    const origIndex = new Map<string, number>();
    for (let oScan = oi; oScan < origLines.length; oScan++) {
      const line = origLines[oScan];
      if (line.trim() !== '' && !origIndex.has(line)) {
        origIndex.set(line, oScan);
      }
    }
    for (let pScan = pi; pScan < outLines.length; pScan++) {
      if (outLines[pScan].trim() === '') continue;
      const oMatch = origIndex.get(outLines[pScan]);
      if (oMatch !== undefined) {
        oi = oMatch;
        pi = pScan;
        foundAnchor = true;
        break;
      }
    }

    if (!foundAnchor) {
      // No anchor found — the rest is a single divergent region.
      // Map remaining output lines to the current original position.
      break;
    }
  }

  // If there are remaining output lines after all original lines, they don't
  // need mapping (they're synthetic). If there are remaining original lines
  // after all output lines, they were deleted. Neither case needs segments.

  if (segments.length === 0) return LineMap.identity();
  return LineMap.fromSegments(segments);
}

/** Preprocess grid tables and return the output with a line map. */
export function preprocessGridTablesWithMap(src: string): { output: string; map: LineMap } {
  const output = preprocessGridTables(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: buildMapFromLines(src.split('\n'), output.split('\n')) };
}

/** Preprocess Confluence-style panel fences and return the output with a line map. */
export function preprocessPanelFencesWithMap(src: string): { output: string; map: LineMap } {
  const output = preprocessPanelFences(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: buildMapFromLines(src.split('\n'), output.split('\n')) };
}

/** Preprocess bare LaTeX environments and return the output with a line map. */
export function wrapBareLatexEnvironmentsWithMap(src: string): { output: string; map: LineMap } {
  const output = wrapBareLatexEnvironments(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: buildMapFromLines(src.split('\n'), output.split('\n')) };
}

/** Preprocess CriticMarkup and return the output with a line map. */
export function preprocessCriticMarkupWithMap(src: string): { output: string; map: LineMap } {
  const output = preprocessCriticMarkup(src);
  if (output === src) return { output, map: LineMap.identity() };
  return { output, map: buildMapFromLines(src.split('\n'), output.split('\n')) };
}
