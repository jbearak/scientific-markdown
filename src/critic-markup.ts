// Placeholder used to preserve paragraph breaks inside CriticMarkup spans.
// Uses Private Use Area characters to avoid markdown-it's normalize step
// which replaces \u0000 with \uFFFD.
export const PARA_PLACEHOLDER = '\uE000PARA\uE000';

/**
 * Find the matching close marker for `<<}` accounting for nested `{>>...<<}` pairs.
 * Returns the index of the matching `<<}` or -1 if not found.
 */
export function findMatchingClose(src: string, startPos: number): number {
  let depth = 1;
  let pos = startPos;
  while (pos < src.length && depth > 0) {
    const nextPlainOpen = src.indexOf('{>>', pos);
    const nextIdOpen = findNextIdOpener(src, pos);
    // Pick whichever opener comes first
    let nextOpen = -1;
    let openLen = 3;
    if (nextPlainOpen !== -1 && (nextIdOpen === -1 || nextPlainOpen <= nextIdOpen.index)) {
      nextOpen = nextPlainOpen;
    } else if (nextIdOpen !== -1) {
      nextOpen = nextIdOpen.index;
      openLen = nextIdOpen.length;
    }
    const nextClose = src.indexOf('<<}', pos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + openLen;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + 3;
    }
  }
  return -1;
}

/** Find next `{#id>>` opener at or after pos. Returns index and length, or -1. */
function findNextIdOpener(src: string, pos: number): { index: number; length: number } | -1 {
  let i = pos;
  while (i < src.length - 4) { // minimum: {#x>>
    i = src.indexOf('{#', i);
    if (i === -1) return -1;
    let j = i + 2;
    // scan id chars: [a-zA-Z0-9_-]
    while (j < src.length) {
      const ch = src.charCodeAt(j);
      if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) ||
          (ch >= 0x61 && ch <= 0x7A) || ch === 0x5F || ch === 0x2D) {
        j++;
      } else {
        break;
      }
    }
    if (j > i + 2 && j + 1 < src.length && src.charCodeAt(j) === 0x3E && src.charCodeAt(j + 1) === 0x3E) {
      return { index: i, length: j + 2 - i };
    }
    i = j;
  }
  return -1;
}

/**
 * Preprocess markdown source: replace \n\n inside CriticMarkup spans with a
 * placeholder so markdown-it's block parser doesn't split them into separate
 * paragraphs.
 */
export function preprocessCriticMarkup(markdown: string): string {
  // Fast path: if no CriticMarkup opening markers, return unchanged
  if (!markdown.includes('{++') && !markdown.includes('{--') &&
      !markdown.includes('{~~') && !markdown.includes('{>>') &&
      !markdown.includes('{==') && !markdown.includes('{#')) {
    return markdown;
  }

  const markers: Array<{ open: string; close: string; nested?: boolean }> = [
    { open: '{++', close: '++}' },
    { open: '{--', close: '--}' },
    { open: '{~~', close: '~~}' },
    { open: '{>>', close: '<<}', nested: true },
    { open: '{==', close: '==}' },
  ];

  let result = markdown;
  for (const { open, close, nested } of markers) {
    const segments: string[] = [];
    let lastPos = 0;
    let searchFrom = 0;
    while (true) {
      const openIdx = result.indexOf(open, searchFrom);
      if (openIdx === -1) break;
      const contentStart = openIdx + open.length;
      let closeIdx: number;
      if (nested) {
        // Use depth-aware matching for {>>...<<} which may contain nested replies
        closeIdx = findMatchingClose(result, contentStart);
      } else {
        closeIdx = result.indexOf(close, contentStart);
      }
      if (closeIdx === -1) {
        searchFrom = contentStart;
        continue;
      }
      const content = result.slice(contentStart, closeIdx);
      if (content.includes('\n\n')) {
        segments.push(result.slice(lastPos, contentStart));
        segments.push(content.replace(/\n\n/g, PARA_PLACEHOLDER));
        lastPos = closeIdx;
        searchFrom = closeIdx + close.length;
      } else {
        searchFrom = closeIdx + close.length;
      }
    }
    if (segments.length > 0) {
      segments.push(result.slice(lastPos));
      result = segments.join('');
    }
  }

  // Handle {#id>>...<<} comment bodies with IDs (variable-length open marker)
  {
    const segments: string[] = [];
    let lastPos = 0;
    let searchFrom = 0;
    const idCommentRe = /\{#[a-zA-Z0-9_-]+>>/;
    while (true) {
      const match = idCommentRe.exec(result.slice(searchFrom));
      if (!match) break;
      const matchIndex = searchFrom + match.index;
      const contentStart = matchIndex + match[0].length;
      // Use depth-aware matching for nested replies
      const closeIdx = findMatchingClose(result, contentStart);
      if (closeIdx === -1) {
        searchFrom = contentStart;
        continue;
      }
      const content = result.slice(contentStart, closeIdx);
      if (content.includes('\n\n')) {
        segments.push(result.slice(lastPos, contentStart));
        segments.push(content.replace(/\n\n/g, PARA_PLACEHOLDER));
        lastPos = closeIdx;
        searchFrom = closeIdx + 3;
      } else {
        searchFrom = closeIdx + 3;
      }
    }
    if (segments.length > 0) {
      segments.push(result.slice(lastPos));
      result = segments.join('');
    }
  }

  return result;
}
