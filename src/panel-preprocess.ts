// Confluence-style panel fence preprocessing. Mirrors the grid-table
// preprocessor: source-text transformation into base64 HTML-comment
// placeholders that markdown-it tokenizes as html_block. Downstream
// consumers (md-to-docx.ts `convertTokens` and the preview plugin's
// block rule) decode the placeholder and re-parse the body.

import { ALL_CALLOUT_TYPES } from './callouts';

export const PANEL_PLACEHOLDER_PREFIX = '<!-- MANUSCRIPT_PANEL:';
export const PANEL_PLACEHOLDER_SUFFIX = ' -->';

export interface PanelFenceData {
  /** Lowercase type name as written in the source (e.g. "info", "note"). */
  type: string;
  /** Raw markdown body between the opening and closing fences, trailing newline stripped. */
  body: string;
}

const PANEL_FENCE_OPEN_RE = /^ {0,3}(~{3,})\s*panel(?:\s+(.*))?$/i;
const PANEL_TYPE_ATTR_RE = /\btype\s*=\s*([A-Za-z][A-Za-z0-9_-]*)/i;
const KNOWN_TYPE_SET = new Set<string>(ALL_CALLOUT_TYPES);

/**
 * Detect `~~~panel type=X` ... `~~~` fenced blocks and replace them with
 * HTML-comment placeholders carrying base64-encoded JSON.
 * This runs before markdown-it tokenization.
 */
export function preprocessPanelFences(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let i = 0;

  // Track an outer code fence so we don't treat `~~~panel` inside a code block
  // as a panel fence.
  let outerFenceChar: '`' | '~' | null = null;
  let outerFenceLen = 0;

  while (i < lines.length) {
    const line = lines[i];

    // If we're inside an outer code fence, only watch for the matching closer.
    if (outerFenceChar) {
      result.push(line);
      const closerMatch = line.match(/^ {0,3}([`~]+)\s*$/);
      if (closerMatch) {
        const run = closerMatch[1];
        if (run[0] === outerFenceChar && run.length >= outerFenceLen) {
          outerFenceChar = null;
          outerFenceLen = 0;
        }
      }
      i++;
      continue;
    }

    // Outside any fence — check for a panel opener.
    const openMatch = line.match(PANEL_FENCE_OPEN_RE);
    if (openMatch) {
      const openRun = openMatch[1];
      const attrs = openMatch[2] || '';
      const typeMatch = attrs.match(PANEL_TYPE_ATTR_RE);
      const rawType = (typeMatch ? typeMatch[1] : '').toLowerCase();
      if (KNOWN_TYPE_SET.has(rawType)) {
        // Scan for the panel's closing fence: a bare `~~~` on its own line at
        // nesting depth 0. Track nested backtick/tilde fences inside the body
        // so a nested ``~~~lang``…``~~~`` pair doesn't terminate the outer
        // panel prematurely. Per CommonMark, fenced code blocks can only open
        // at a block boundary, so only treat a line as a nested fence opener
        // when the previous line was blank (or we're at the start of the body).
        const bodyStart = i + 1;
        let bodyEnd = -1;
        let nestedChar: '`' | '~' | null = null;
        let nestedLen = 0;
        let prevBlank = true; // start of body is a block boundary
        for (let j = i + 1; j < lines.length; j++) {
          const nestedLine = lines[j];
          const isBlank = nestedLine.trim() === '';
          if (nestedChar !== null) {
            const close = nestedLine.match(/^ {0,3}([`~]{3,})\s*$/);
            if (close && close[1][0] === nestedChar && close[1].length >= nestedLen) {
              nestedChar = null;
              nestedLen = 0;
            }
            prevBlank = isBlank;
            continue;
          }
          // At nesting depth 0: a bare `~~~` (length ≥ opener) closes the panel,
          // regardless of preceding blank (the `~~~panel type=…` opener itself
          // is a block-level construct, so its closer has the same privilege).
          const bare = nestedLine.match(/^ {0,3}(~{3,})\s*$/);
          if (bare && bare[1].length >= openRun.length) {
            bodyEnd = j;
            break;
          }
          // Any other fenced opener enters a nested fence — but only at a
          // block boundary (preceded by a blank line or start-of-body).
          if (prevBlank) {
            const open = nestedLine.match(/^ {0,3}([`~]{3,})(.*)$/);
            if (open) {
              nestedChar = open[1][0] as '`' | '~';
              nestedLen = open[1].length;
            }
          }
          prevBlank = isBlank;
        }
        if (bodyEnd !== -1) {
          const body = lines.slice(bodyStart, bodyEnd).join('\n');
          const data: PanelFenceData = { type: rawType, body };
          const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
          // Ensure blank lines around the placeholder so markdown-it treats it
          // as an html_block (Type 2: HTML comment).
          if (result.length > 0 && result[result.length - 1].trim() !== '') {
            result.push('');
          }
          result.push(PANEL_PLACEHOLDER_PREFIX + encoded + PANEL_PLACEHOLDER_SUFFIX);
          result.push('');
          i = bodyEnd + 1;
          continue;
        }
        // Unclosed panel fence — emit as-is.
      }
      // Unknown type or unclosed — treat the opener line as a plain code fence
      // start. Record the outer fence state so we skip until the matching close.
      outerFenceChar = '~';
      outerFenceLen = openRun.length;
      result.push(line);
      i++;
      continue;
    }

    // Track entry into a regular code fence (so that a `~~~panel` that happens
    // to appear inside a ``` code block is not detected).
    const fenceMatch = line.match(/^ {0,3}([`~]{3,})/);
    if (fenceMatch) {
      const run = fenceMatch[1];
      outerFenceChar = run[0] as '`' | '~';
      outerFenceLen = run.length;
      result.push(line);
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n');
}

/** Decode a panel placeholder line's payload. Returns null on failure. */
export function decodePanelPlaceholder(placeholderLine: string): PanelFenceData | null {
  const trimmed = placeholderLine.trim();
  if (!trimmed.startsWith(PANEL_PLACEHOLDER_PREFIX)) return null;
  if (!trimmed.endsWith(PANEL_PLACEHOLDER_SUFFIX)) return null;
  const encoded = trimmed.slice(PANEL_PLACEHOLDER_PREFIX.length, trimmed.length - PANEL_PLACEHOLDER_SUFFIX.length).trim();
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    const data = JSON.parse(json);
    if (typeof data?.type !== 'string' || typeof data?.body !== 'string') return null;
    return data as PanelFenceData;
  } catch {
    return null;
  }
}
