import { parseEmbedDirective } from './embed-preprocess';
import { computeCodeRegions, overlapsCodeRegion } from './code-regions';

// ---------------------------------------------------------------------------
// Pure helper — testable without VS Code
// ---------------------------------------------------------------------------

export interface EmbedPathRange {
  /** The unquoted file path */
  path: string;
  /** 0-based line number */
  line: number;
  /** Start column (inclusive) of the path text within the line */
  startCol: number;
  /** End column (exclusive) of the path text within the line */
  endCol: number;
}

/**
 * Regex to locate the path token (first non-whitespace token after `embed:`)
 * inside a validated embed directive line.  Captures:
 *   [1] double-quoted path  OR
 *   [2] single-quoted path  OR
 *   [3] unquoted path
 */
const PATH_RE = /<!--\s*embed:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/;

/**
 * Scan document text and return the location of each embed-directive file path.
 * Skips directives inside fenced code blocks / inline code spans.
 */
export function findEmbedPathRanges(text: string): EmbedPathRange[] {
  const results: EmbedPathRange[] = [];
  const codeRegions = computeCodeRegions(text);
  const lines = text.split('\n');

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = offset + line.length;

    if (!overlapsCodeRegion(offset, lineEnd, codeRegions)) {
      const trimmed = line.trim();
      const directive = parseEmbedDirective(trimmed);
      if (directive) {
        const m = line.match(PATH_RE);
        if (m) {
          // Determine which capture group matched
          const pathText = m[1] ?? m[2] ?? m[3];
          if (pathText) {
            // m.index is the start of the full match in the line.
            // The path text is inside the match — find its position.
            const fullMatch = m[0];
            const pathInMatch = fullMatch.lastIndexOf(pathText);
            const startCol = m.index! + pathInMatch;
            const endCol = startCol + pathText.length;
            results.push({ path: directive.path, line: i, startCol, endCol });
          }
        }
      }
    }

    offset = lineEnd + 1; // +1 for newline
  }

  return results;
}
