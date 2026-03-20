import { type CodeRegion, computeCodeRegions, isInsideCodeRegion } from './code-regions';

export interface OrientationDiagnostic {
  kind: 'unclosed' | 'orphaned' | 'nested' | 'crossed';
  /** The directive name that triggered the diagnostic (e.g. 'landscape') */
  directiveName: string;
  /** Character (UTF-16 code unit) offset of the diagnostic directive, suitable for use with LSP positionAt() */
  start: number;
  /** Character (UTF-16 code unit) end offset of the diagnostic directive */
  end: number;
  /** For nested/crossed: the name of the conflicting opener */
  relatedName?: string;
  /** For nested/crossed: character (UTF-16 code unit) offset of the conflicting opener */
  relatedStart?: number;
  /** For nested/crossed: character (UTF-16 code unit) end offset of the conflicting opener */
  relatedEnd?: number;
}

/**
 * Scan text for orientation directive errors: unclosed opens, orphaned closes,
 * nested opens, and crossed (out-of-order) closes. Skips directives inside
 * code regions (fenced code blocks, inline code).
 *
 * Only one orientation can be active at a time — opening `<!-- portrait -->`
 * while `<!-- landscape -->` is active (or vice versa) is reported as nested.
 */
export function scanOrientationDirectives(text: string, codeRegions?: CodeRegion[]): OrientationDiagnostic[] {
  const regions = codeRegions ?? computeCodeRegions(text);
  const directiveRe = /<!--\s*(\/?)(landscape|portrait)\s*-->/gi;
  const openStack: { name: string; start: number; end: number }[] = [];
  const results: OrientationDiagnostic[] = [];

  let m: RegExpExecArray | null;
  while ((m = directiveRe.exec(text)) !== null) {
    if (isInsideCodeRegion(m.index, regions)) continue;
    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    const start = m.index;
    const end = start + m[0].length;

    if (!isClose) {
      if (openStack.length > 0) {
        const existing = openStack[openStack.length - 1];
        results.push({
          kind: 'nested',
          directiveName: name,
          start,
          end,
          relatedName: existing.name,
          relatedStart: existing.start,
          relatedEnd: existing.end,
        });
        // Don't push — keep original opener so "unclosed" points to the root.
        // The converter in md-to-docx.ts handles graceful recovery (close + reopen)
        // independently; this scanner's job is accurate diagnostics.
      } else {
        openStack.push({ name, start, end });
      }
    } else {
      if (openStack.length > 0) {
        const top = openStack[openStack.length - 1];
        if (top.name === name) {
          openStack.pop();
        } else {
          // Crossed close: <!-- /portrait --> while <!-- landscape --> is active
          results.push({
            kind: 'crossed',
            directiveName: name,
            start,
            end,
            relatedName: top.name,
            relatedStart: top.start,
            relatedEnd: top.end,
          });
          // Don't pop — the wrong opener stays active
        }
      } else {
        results.push({
          kind: 'orphaned',
          directiveName: name,
          start,
          end,
        });
      }
    }
  }

  for (const entry of openStack) {
    results.push({
      kind: 'unclosed',
      directiveName: entry.name,
      start: entry.start,
      end: entry.end,
    });
  }

  return results;
}
