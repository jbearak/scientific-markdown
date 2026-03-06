import MarkdownIt from 'markdown-it';
import { escapeXml, generateCitation, generateMathXml, createCiteprocEngineLocal, createCiteprocEngineAsync, generateBibliographyXml, generateMissingKeysXml } from './md-to-docx-citations';
import { downloadStyle } from './csl-loader';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve, basename } from 'path';
import { parseBibtex, BibtexEntry } from './bibtex-parser';
import { parseFrontmatter, Frontmatter, noteTypeToNumber, type ColorScheme } from './frontmatter';
import { alertColorsByScheme, getDefaultColorScheme } from './alert-colors';
import { ZoteroBiblData, zoteroStyleFullId } from './converter';
import { isGfmDisallowedRawHtml, parseTaskListMarker, parseGfmAlertMarker, gfmAlertTitle, type GfmAlertType } from './gfm';
import { pixelsToEmu, isSupportedImageFormat, getImageContentType, readImageDimensions, computeMissingDimension, IMAGE_WARNINGS } from './image-utils';
import { preprocessGridTables, GRID_TABLE_PLACEHOLDER_PREFIX, type GridTableData } from './grid-table-preprocess';
import { extractHtmlTables, type HtmlTableRow, type HtmlTableRun, type HtmlTableMeta } from './html-table-parser';
export { preprocessGridTables } from './grid-table-preprocess';
export { extractHtmlTables } from './html-table-parser';

// --- Implementation notes ---
// - decodeHtmlEntities(): decode &amp; after other named entities to avoid over-decoding
// - Numeric entities: use String.fromCodePoint() not String.fromCharCode() for
//   supplementary-plane chars
// - CriticMarkup recursive formatting: parse inner payloads with markdown-it
//   (Critic/comment/citation/math/footnote rules disabled); carry structured
//   inner runs on MdRun (innerRuns / oldRuns / newRuns)

// Types for the parsed token stream
export type TableFormat = 'pipe' | 'html' | 'grid';

export interface MdToken {
  type: 'paragraph' | 'heading' | 'list_item' | 'blockquote' | 'code_block' | 'table' | 'hr';
  level?: number;           // heading level 1-6, blockquote nesting, list nesting
  ordered?: boolean;        // for list items
  taskChecked?: boolean;    // for GFM task list items
  alertType?: GfmAlertType; // for GFM alerts in blockquotes
  alertLead?: boolean;      // first blockquote paragraph carrying alert header
  alertFirst?: boolean;     // first paragraph in an alert block (for spacing)
  alertLast?: boolean;      // last paragraph in an alert block (for spacing)
  blockquoteGroupIndex?: number; // sequential index of the blockquote group this token belongs to
  trailingBlankLine?: boolean;   // for code blocks: blank line follows in source markdown
  blankLinesBefore?: number;     // for HTML comments: blank lines before this token in source
  htmlCommentIndex?: number;     // sequential index of HTML comment paragraphs
  runs: MdRun[];            // inline content
  rows?: MdTableRow[];      // for tables
  language?: string;        // for code blocks
  sourceFormat?: TableFormat; // original table format for round-trip
  tableFontSize?: number;   // per-table font size override (pt)
  tableFont?: string;       // per-table font name override
}

export interface MdTableCell {
  runs: MdRun[];
  colspan?: number;
  rowspan?: number;
}
export interface MdTableRow {
  cells: MdTableCell[];     // each cell has runs + optional span info
  header: boolean;
}

export interface MdRun {
  type: 'text' | 'critic_add' | 'critic_del' | 'critic_sub' | 'critic_highlight' | 'critic_comment' | 'citation' | 'math' | 'softbreak' | 'comment_range_start' | 'comment_range_end' | 'comment_body_with_id' | 'footnote_ref' | 'html_comment' | 'image';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  highlight?: boolean;
  highlightColor?: string;  // for ==text=={color}
  superscript?: boolean;
  subscript?: boolean;
  code?: boolean;           // inline code
  href?: string;            // hyperlink URL
  // CriticMarkup specific
  newText?: string;         // for substitutions: {~~old~>new~~}
  innerRuns?: MdRun[];      // parsed inner formatting for critic_add/del/highlight
  oldRuns?: MdRun[];        // parsed old-side formatting for critic_sub
  newRuns?: MdRun[];        // parsed new-side formatting for critic_sub
  author?: string;          // for comments/revisions
  date?: string;            // for comments/revisions
  commentText?: string;     // for critic_comment: the comment body
  commentId?: string;       // for comment_range_start/end/body_with_id
  footnoteLabel?: string;   // for footnote_ref: the [^label] label
  replies?: Array<{author?: string; date?: string; text: string}>; // nested replies for comment_body_with_id
  // Citation specific
  keys?: string[];          // citation keys for [@key1; @key2]
  locators?: Map<string, string>; // key -> locator for [@key, p. 20]
  suppressAuthorKeys?: Set<string>; // per-key suppress-author: Set of keys with [-@key] form
  // Math specific
  display?: boolean;        // display math ($$...$$) vs inline ($...$)
  // Image specific
  imageSrc?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageSyntax?: 'md' | 'html';
}

function mapHtmlTableRunToMdRun(run: HtmlTableRun): MdRun {
  if (run.type === 'softbreak') {
    return { type: 'softbreak', text: '\n' };
  }
  return {
    type: 'text',
    text: run.text,
    ...(run.bold ? { bold: true } : {}),
    ...(run.italic ? { italic: true } : {}),
    ...(run.underline ? { underline: true } : {}),
    ...(run.strikethrough ? { strikethrough: true } : {}),
    ...(run.code ? { code: true } : {}),
    ...(run.superscript ? { superscript: true } : {}),
    ...(run.subscript ? { subscript: true } : {}),
    ...(run.href ? { href: run.href } : {}),
  };
}

function mapHtmlTableRowsToMdTableRows(rows: HtmlTableRow[]): MdTableRow[] {
  return rows.map(row => ({
    header: row.header,
    cells: row.cells.map(cell => ({
      runs: cell.runs.map(mapHtmlTableRunToMdRun),
      ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
      ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
    })),
  }));
}

// Map Manuscript Markdown color names to OOXML ST_HighlightColor values
const COLOR_TO_OOXML: Record<string, string> = {
  'yellow': 'yellow', 'green': 'green', 'blue': 'blue', 'red': 'red', 'black': 'black',
  'turquoise': 'cyan', 'pink': 'magenta', 'dark-blue': 'darkBlue',
  'teal': 'darkCyan', 'violet': 'darkMagenta', 'dark-red': 'darkRed',
  'dark-yellow': 'darkYellow', 'gray-50': 'darkGray', 'gray-25': 'lightGray',
};

const ALERT_STYLE_BY_TYPE: Record<GfmAlertType, string> = {
  note: 'GitHubNote',
  tip: 'GitHubTip',
  important: 'GitHubImportant',
  warning: 'GitHubWarning',
  caution: 'GitHubCaution',
};

const ALERT_GLYPH_BY_TYPE: Record<GfmAlertType, string> = {
  note: '※',
  tip: '◈',
  important: '‼',
  warning: '▲',
  caution: '⛒',
};

import { PARA_PLACEHOLDER, preprocessCriticMarkup, findMatchingClose } from './critic-markup';
import { wrapBareLatexEnvironments } from './latex-env-preprocess';
export { PARA_PLACEHOLDER, preprocessCriticMarkup };

// Custom inline rules

/** Parse author/date/text from comment content string.
 *
 * Uses `@Author (Date) | text` / `@Author | text` syntax.
 * If content does not start with `@`, the entire string is plain comment text.
 *
 * Whitespace around `(`, `)`, and `|` is flexible: zero or more spaces are
 * accepted so that hand-edited markdown still round-trips correctly.
 */
function parseCommentContent(content: string): { author?: string; date?: string; text: string } {
  if (content.startsWith('@')) {
    // Try @Author (Date) | text  — \s* allows missing/extra whitespace
    const match = content.match(/^@(.+?)\s*\(([^)]+)\)\s*\|\s*([\s\S]*)$/);
    if (match) {
      const author = match[1].trim();
      const date = match[2].trim();
      if (author) return { author, ...(date ? { date } : {}), text: match[3] };
    }
    // Try @Author | text
    const simpleMatch = content.match(/^@([^|]+?)\s*\|\s*([\s\S]*)$/);
    if (simpleMatch) {
      const author = simpleMatch[1].trim();
      if (author) return { author, text: simpleMatch[2] };
    }
  }
  // No @ prefix → entire content is comment text
  if (!content.trim()) return { text: '' };
  return { text: content };
}

/**
 * Extract nested reply blocks from comment content.
 * Splits content into the parent text and an array of reply entries.
 */
function extractReplies(content: string): { parentText: string; replies: Array<{author?: string; date?: string; text: string}> } {
  const replies: Array<{author?: string; date?: string; text: string}> = [];

  // Find the first nested {>> to determine where parent text ends
  const firstReplyIdx = content.indexOf('{>>');
  if (firstReplyIdx === -1) {
    return { parentText: content, replies };
  }

  const parentText = content.slice(0, firstReplyIdx).trimEnd();

  // Extract each {>>...<<} reply block using depth-aware matching
  let pos = firstReplyIdx;
  while (pos < content.length) {
    const openIdx = content.indexOf('{>>', pos);
    if (openIdx === -1) break;
    const innerStart = openIdx + 3;
    const closeIdx = findMatchingClose(content, innerStart);
    if (closeIdx === -1) break;
    const replyContent = content.slice(innerStart, closeIdx);
    const parsed = parseCommentContent(replyContent);
    replies.push(parsed);
    pos = closeIdx + 3;
  }

  return { parentText, replies };
}

/** Parse {#id}, {/id}, and {#id>>...<<} comment range markers */
function commentRangeRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;

  if (start >= max || src.charAt(start) !== '{') return false;

  const next = src.charAt(start + 1);
  if (next === '#') {
    // Could be {#id} range start or {#id>>...<<} comment body
    const idStart = start + 2;
    // Find end of ID: [a-zA-Z0-9_-]+
    let idEnd = idStart;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd === idStart) return false; // empty ID

    const id = src.slice(idStart, idEnd);

    // Check for {#id>>...<<} comment body
    if (idEnd + 1 < max && src.charAt(idEnd) === '>' && src.charAt(idEnd + 1) === '>') {
      // Find matching <<} accounting for nested {>>...<<} replies
      const endPos = findMatchingClose(src, idEnd + 2);
      if (endPos === -1) return false;

      if (!silent) {
        const rawContent = src.slice(idEnd + 2, endPos).replaceAll(PARA_PLACEHOLDER, '\n\n');
        const token = state.push('comment_body_with_id', '', 0);
        token.commentId = id;

        // Check for nested replies
        const { parentText, replies } = extractReplies(rawContent);
        const parsed = parseCommentContent(parentText);
        token.author = parsed.author;
        token.date = parsed.date;
        token.commentText = parsed.text;
        if (replies.length > 0) {
          token.replies = replies;
        }
      }
      state.pos = endPos + 3;
      return true;
    }

    // Check for {#id} range start
    if (idEnd < max && src.charAt(idEnd) === '}') {
      if (!silent) {
        const token = state.push('comment_range_start', '', 0);
        token.commentId = id;
      }
      state.pos = idEnd + 1;
      return true;
    }

    return false;
  }

  if (next === '/') {
    // {/id} range end
    const idStart = start + 2;
    let idEnd = idStart;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd === idStart) return false;

    if (idEnd < max && src.charAt(idEnd) === '}') {
      if (!silent) {
        const token = state.push('comment_range_end', '', 0);
        token.commentId = src.slice(idStart, idEnd);
      }
      state.pos = idEnd + 1;
      return true;
    }

    return false;
  }

  return false;
}

function criticMarkupRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;

  if (start + 3 >= max || state.src.charAt(start) !== '{') return false;

  const marker = state.src.slice(start, start + 3);
  let endMarker: string;
  let type: string;

  switch (marker) {
    case '{++': endMarker = '++}'; type = 'critic_add'; break;
    case '{--': endMarker = '--}'; type = 'critic_del'; break;
    case '{~~': endMarker = '~~}'; type = 'critic_sub'; break;
    case '{==': endMarker = '==}'; type = 'critic_highlight'; break;
    case '{>>': endMarker = '<<}'; type = 'critic_comment'; break;
    default: return false;
  }

  let endPos: number;
  if (type === 'critic_comment') {
    // Use depth-aware matching for {>>...<<} which may contain nested replies
    endPos = findMatchingClose(state.src, start + 3);
  } else {
    endPos = state.src.indexOf(endMarker, start + 3);
  }
  if (endPos === -1) return false;

  if (!silent) {
    // Replace any paragraph placeholders back to real newlines
    const content = state.src.slice(start + 3, endPos).replaceAll(PARA_PLACEHOLDER, '\n\n');
    const token = state.push('critic_markup', '', 0);
    token.markup = marker;
    token.content = content;
    token.criticType = type;

    if (type === 'critic_sub') {
      const sepPos = content.indexOf('~>');
      if (sepPos !== -1) {
        token.oldText = content.slice(0, sepPos);
        token.newText = content.slice(sepPos + 2);
      }
    }

    if (type === 'critic_comment') {
      const { parentText, replies } = extractReplies(content);
      const parsed = parseCommentContent(parentText);
      token.author = parsed.author;
      token.date = parsed.date;
      token.commentText = parsed.text;
      if (replies.length > 0) {
        token.replies = replies;
      }
    }
  }

  state.pos = endPos + endMarker.length;
  return true;
}

function findClosingHighlightMarker(src: string, from: number, max: number): number {
  let depth = 0;
  let pos = from;
  while (pos < max - 1) {
    if (src[pos] === '=' && src[pos + 1] === '=') {
      // Opening {== increases depth
      if (pos > 0 && src[pos - 1] === '{') {
        depth++;
        pos += 2;
        continue;
      }
      // Closing ==} decreases depth (only if inside a {== block)
      if (depth > 0 && pos + 2 < max && src[pos + 2] === '}') {
        depth--;
        pos += 3;
        continue;
      }
      // At depth 0, this is the closing ==
      if (depth === 0) return pos;
    }
    pos++;
  }
  return -1;
}

function coloredHighlightRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  
  if (start + 2 >= max || state.src.slice(start, start + 2) !== '==') return false;
  
  const endPos = findClosingHighlightMarker(state.src, start + 2, max);
  if (endPos === -1) return false;
  
  const afterEnd = endPos + 2;
  if (afterEnd < max && state.src.charAt(afterEnd) === '{') {
    const colorEnd = state.src.indexOf('}', afterEnd + 1);
    if (colorEnd !== -1) {
      const color = state.src.slice(afterEnd + 1, colorEnd);
      // Require identifier-like colors that do not start or end with '-'
      // so adjacent CriticMarkup like {--deleted--} is not misparsed as a color suffix.
      if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(color)) {
        if (!silent) {
          const content = state.src.slice(start + 2, endPos);
          const token = state.push('colored_highlight', '', 0);
          token.content = content;
          token.color = color;
        }
        state.pos = colorEnd + 1;
        return true;
      }
    }
  }
  
  // Plain highlight
  if (!silent) {
    const content = state.src.slice(start + 2, endPos);
    const token = state.push('plain_highlight', '', 0);
    token.content = content;
  }
  state.pos = endPos + 2;
  return true;
}

function footnoteRefRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;

  if (start + 2 >= max || src.charAt(start) !== '[' || src.charAt(start + 1) !== '^') return false;

  // Find closing ]
  let end = start + 2;
  while (end < max && src.charAt(end) !== ']') {
    if (src.charAt(end) === '\n') return false; // no newlines in label
    end++;
  }
  if (end >= max) return false;

  const label = src.slice(start + 2, end);
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) return false;

  // No colon check needed here — start-of-line definitions are already
  // stripped by extractFootnoteDefinitions() before parseMd() is called.

  if (!silent) {
    const token = state.push('footnote_ref', '', 0);
    token.footnoteLabel = label;
  }
  state.pos = end + 1;
  return true;
}

function citationRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;

  // Match [@key] or [-@key] (Pandoc suppress-author form)
  const isNormal = start + 2 < max && state.src.slice(start, start + 2) === '[@';
  const isSuppressed = !isNormal && start + 3 < max && state.src.slice(start, start + 3) === '[-@';
  if (!isNormal && !isSuppressed) return false;

  const contentStart = isSuppressed ? start + 3 : start + 2;
  const endPos = state.src.indexOf(']', contentStart);
  if (endPos === -1) return false;

  if (!silent) {
    const rawContent = state.src.slice(contentStart, endPos);
    const token = state.push('citation', '', 0);
    // Preserve original content for fallback rendering
    token.content = isSuppressed ? '-@' + rawContent : rawContent;

    const keys: string[] = [];
    const locators = new Map<string, string>();
    const suppressAuthorKeys = new Set<string>();

    // Split raw content by `;` and check each part for -@ prefix BEFORE stripping
    const rawParts = rawContent.split(';').map((p: string) => p.trim()).filter(Boolean);
    for (let i = 0; i < rawParts.length; i++) {
      let raw = rawParts[i];
      let suppressed: boolean;
      if (i === 0) {
        // First part: the `[-@` or `[@` prefix was already consumed by the outer match,
        // so `isSuppressed` tells us whether this item is suppressed.
        suppressed = isSuppressed;
        raw = raw.replace(/^@/, '').trim();
      } else {
        // Subsequent parts: check for `-@` prefix to determine per-item suppress
        suppressed = raw.startsWith('-@');
        raw = raw.replace(/^-?@/, '').trim();
      }
      if (!raw) continue;

      const commaPos = raw.indexOf(',');
      if (commaPos !== -1) {
        const key = raw.slice(0, commaPos).trim();
        const locator = raw.slice(commaPos + 1).trim();
        keys.push(key);
        locators.set(key, locator);
        if (suppressed) suppressAuthorKeys.add(key);
      } else {
        keys.push(raw);
        if (suppressed) suppressAuthorKeys.add(raw);
      }
    }

    token.keys = keys;
    token.locators = locators;
    token.suppressAuthorKeys = suppressAuthorKeys.size > 0 ? suppressAuthorKeys : undefined;
  }

  state.pos = endPos + 1;
  return true;
}

function mathRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  
  if (start >= max || state.src.charAt(start) !== '$') return false;
  
  // Check for display math
  if (start + 1 < max && state.src.charAt(start + 1) === '$') {
    const endPos = state.src.indexOf('$$', start + 2);
    if (endPos === -1) return false;
    
    if (!silent) {
      const content = state.src.slice(start + 2, endPos);
      const token = state.push('math', '', 0);
      token.content = content;
      token.display = true;
    }
    state.pos = endPos + 2;
    return true;
  }
  
  // Inline math - don't match $ in middle of words
  if (start > 0 && /\w/.test(state.src.charAt(start - 1))) return false;

  // Don't match currency patterns like $100 (digit(s) followed by whitespace/punctuation/end)
  if (start + 1 < max && /\d/.test(state.src.charAt(start + 1))) {
    const afterDollar = state.src.slice(start + 1);
    if (/^\d[\d,.]*(?:\s|$)/.test(afterDollar)) return false;
  }

  const endPos = state.src.indexOf('$', start + 1);
  if (endPos === -1) return false;

  // Don't match $ at end if followed by word character
  if (endPos + 1 < max && /\w/.test(state.src.charAt(endPos + 1))) return false;
  
  if (!silent) {
    const content = state.src.slice(start + 1, endPos);
    const token = state.push('math', '', 0);
    token.content = content;
    // Don't set display for inline math - leave it undefined
  }
  state.pos = endPos + 1;
  return true;
}

/** Inline rule that converts the paragraph placeholder back into softbreak tokens. */
function paraPlaceholderRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0xE000) return false; // \uE000
  if (!state.src.startsWith(PARA_PLACEHOLDER, start)) return false;

  if (!silent) {
    // Emit two softbreaks to represent the paragraph break
    state.push('softbreak', 'br', 0);
    state.push('softbreak', 'br', 0);
  }
  state.pos = start + PARA_PLACEHOLDER.length;
  return true;
}

function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true });

  md.inline.ruler.before('emphasis', 'para_placeholder', paraPlaceholderRule);
  md.inline.ruler.before('emphasis', 'comment_range', commentRangeRule);
  md.inline.ruler.before('emphasis', 'colored_highlight', coloredHighlightRule);
  md.inline.ruler.before('emphasis', 'critic_markup', criticMarkupRule);
  md.inline.ruler.before('emphasis', 'footnote_ref', footnoteRefRule);
  md.inline.ruler.before('emphasis', 'citation', citationRule);
  md.inline.ruler.before('emphasis', 'math', mathRule);

  return md;
}

/** Create a markdown-it instance for parsing inner formatting within CriticMarkup payloads. */
function createCriticInnerMarkdownIt(): MarkdownIt {
  const md = createMarkdownIt();
  // Inner parsing should recurse into regular inline formatting, but not into
  // other top-level custom syntaxes that carry separate document semantics.
  md.inline.ruler.disable(['comment_range', 'footnote_ref', 'citation']);
  return md;
}

let _cachedCriticInnerMd: MarkdownIt | undefined;
function getCriticInnerMarkdownIt(): MarkdownIt {
  if (!_cachedCriticInnerMd) {
    _cachedCriticInnerMd = createCriticInnerMarkdownIt();
  }
  return _cachedCriticInnerMd;
}

function toTextRunFromInner(run: MdRun, overrides?: Partial<MdRun>): MdRun {
  return {
    type: 'text',
    text: run.text,
    bold: run.bold,
    italic: run.italic,
    underline: run.underline,
    strikethrough: run.strikethrough,
    highlight: run.highlight,
    highlightColor: run.highlightColor,
    superscript: run.superscript,
    subscript: run.subscript,
    code: run.code,
    href: run.href,
    ...overrides,
  };
}

function normalizeCriticInnerRuns(runs: MdRun[]): MdRun[] {
  const normalized: MdRun[] = [];
  for (const run of runs) {
    if (run.type === 'softbreak') {
      normalized.push({ type: 'softbreak', text: '\n' });
      continue;
    }

    if (run.type === 'text') {
      normalized.push(toTextRunFromInner(run));
      continue;
    }

    // Plain/colored `==...==` highlights inside Critic payloads should be
    // preserved as text runs with highlight flags.
    if (run.type === 'critic_highlight') {
      if (run.text) {
        normalized.push(toTextRunFromInner(run, {
          highlight: true,
          highlightColor: run.highlightColor,
        }));
      }
      continue;
    }

    if (run.type === 'math') {
      normalized.push(run);
      continue;
    }

    // Nested critic markup (e.g. {--...--} inside {==...==}) — pass through
    // so generateRuns can emit proper <w:ins>/<w:del> wrappers.
    if (run.type === 'critic_add' || run.type === 'critic_del' || run.type === 'critic_sub' || run.type === 'critic_comment') {
      normalized.push(run);
      continue;
    }

    // Fallback: if any unsupported run type appears, preserve its textual
    // content so we do not silently drop user text.
    if (run.text) {
      normalized.push(toTextRunFromInner(run));
    }
  }
  return normalized;
}

function parseCriticInnerRuns(content: string): MdRun[] {
  if (!content) return [];
  const md = getCriticInnerMarkdownIt();
  const tokens = md.parseInline(content, {});
  return normalizeCriticInnerRuns(convertInlineTokens(tokens));
}

/** Extract footnote definitions from the markdown source and return cleaned markdown. */
export function extractFootnoteDefinitions(markdown: string): { cleaned: string; definitions: Map<string, string> } {
  const definitions = new Map<string, string>();
  const lines = markdown.split('\n');
  const cleanedLines: string[] = [];
  let currentLabel: string | undefined;
  let currentBody: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  function finishDefinition() {
    if (currentLabel !== undefined) {
      definitions.set(currentLabel, currentBody.join('\n'));
      currentLabel = undefined;
      currentBody = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Inside a footnote definition, indented lines are continuation lines (even if they look like fences)
    if (currentLabel !== undefined && (line.startsWith('    ') || line.startsWith('\t'))) {
      currentBody.push(line.replace(/^(?:    |\t)/, ''));
      continue;
    }
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      const markerChar = marker.charAt(0);
      const markerLen = marker.length;
      if (!inFence) {
        inFence = true;
        fenceChar = markerChar;
        fenceLen = markerLen;
      } else if (markerChar === fenceChar && markerLen >= fenceLen) {
        inFence = false;
      }
      cleanedLines.push(line);
      continue;
    }
    if (inFence) {
      cleanedLines.push(line);
      continue;
    }
    const defMatch = line.match(/^\[\^([a-zA-Z0-9_-]+)\]:\s?(.*)/);
    if (defMatch) {
      finishDefinition();
      currentLabel = defMatch[1];
      currentBody = [defMatch[2]];
      continue;
    }

    // Blank line within a multi-paragraph footnote
    if (currentLabel !== undefined && line.trim() === '') {
      // Peek ahead: if next line is indented, this is a paragraph break within the footnote
      if (i + 1 < lines.length && (lines[i + 1].startsWith('    ') || lines[i + 1].startsWith('\t'))) {
        currentBody.push('');
        continue;
      }
    }
    finishDefinition();
    cleanedLines.push(line);
  }
  finishDefinition();

  return { cleaned: cleanedLines.join('\n'), definitions };
}

/** Mark first/last tokens in contiguous runs of blockquotes for spacing.
 *  Learning: when two same-type alerts are adjacent (zero-gap or merged by
 *  markdown-it), each alertLead token starts a new group — the inner loop
 *  must break on alertLead boundaries, not just alertType/level changes. */
function annotateBlockquoteBoundaries(tokens: MdToken[]): void {
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type !== 'blockquote') {
      i++;
      continue;
    }
    const alertType = tokens[i].alertType;
    const level = tokens[i].level;
    const start = i;
    i++;
    // Continue the group while the next token has the same alertType/level
    // AND is not an alertLead (which signals a new [!TYPE] marker group).
    while (i < tokens.length && tokens[i].type === 'blockquote' && tokens[i].alertType === alertType && tokens[i].level === level && !tokens[i].alertLead) {
      i++;
    }
    tokens[start].alertFirst = true;
    tokens[i - 1].alertLast = true;
  }
}

// Blockquote gap metadata: compute blank-line counts between consecutive
// blockquote groups in the original markdown source.  A "blockquote group"
// is a maximal run of lines starting with '>'.  The gap between two groups
// is the number of blank lines separating them (0 means directly adjacent
// with no blank line).
//
// Learning: this function operates on the raw markdown *before* markdown-it
// parsing, because markdown-it merges adjacent blockquotes with zero blank
// lines into a single blockquote_open/close pair, losing the gap info.
// Learning: within a contiguous run of '>' lines, a line matching
// '> [!TYPE]' (where TYPE is a GFM alert keyword) starts a new group —
// this handles zero-gap same-type alerts that have no blank line between them.
/** Detect whether the markdown source uses tab-based list indentation. */
export function detectListIndent(markdown: string): 'tab' | 'spaces' {
  // Look for nested list items (lines starting with tab followed by - or *)
  const tabIndented = /^\t+[-*+] /m.test(markdown) || /^\t+\d+\. /m.test(markdown);
  // Also detect tab after marker at top-level: `-\t` or `1.\t`
  const tabAfterMarker = /^[-*+]\t/m.test(markdown) || /^\d+\.\t/m.test(markdown);
  return (tabIndented || tabAfterMarker) ? 'tab' : 'spaces';
}
function parseBlockquoteLevel(line: string): number {
  const stripped = line.replace(/^ {0,3}/, '');
  let level = 0;
  let j = 0;
  while (j < stripped.length) {
    if (stripped[j] === '>') {
      level++;
      j++;
      if (stripped[j] === ' ') j++;
      continue;
    }
    break;
  }
  return level;
}

export function computeBlockquoteGaps(markdown: string): Map<number, number> {
  const gaps = new Map<number, number>();
  const lines = markdown.split('\n');
  const alertMarkerRe = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

  // Identify blockquote group spans (start/end line indices).
  // A new group starts when: (a) a '>' line follows a non-'>' line, or
  // (b) a '>' line contains an alert [!TYPE] marker (except the very first
  // line of a contiguous '>' run, which already starts a group).
  const groups: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^ {0,3}>/.test(lines[i])) {
      const runStart = i;
      // First line of a contiguous '>' run always starts a group
      let groupStart = i;
      let groupLevel = parseBlockquoteLevel(lines[i]);
      i++;
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        const level = parseBlockquoteLevel(lines[i]);
        const startsAlertGroup = alertMarkerRe.test(lines[i]) && i > runStart;
        const levelChanged = level !== groupLevel;
        if (startsAlertGroup || levelChanged) {
          // New group within the same '>' run when an alert marker starts or
          // the effective nesting level changes.
          groups.push({ start: groupStart, end: i - 1 });
          groupStart = i;
          groupLevel = level;
        }
        i++;
      }
      groups.push({ start: groupStart, end: i - 1 });
    } else {
      i++;
    }
  }

  // Compute blank-line count between each pair of consecutive groups
  for (let g = 0; g < groups.length - 1; g++) {
    const afterEnd = groups[g].end + 1;
    const nextStart = groups[g + 1].start;
    let blankCount = 0;
    for (let li = afterEnd; li < nextStart; li++) {
      if (lines[li].trim() === '') {
        blankCount++;
      } else {
        // Non-blank, non-blockquote content between groups — not a direct
        // blockquote-to-blockquote gap; store -1 as sentinel.
        blankCount = -1;
        break;
      }
    }
    gaps.set(g, blankCount);
  }

  return gaps;
}

// Compute authored blank lines that appear *after* a blockquote group when the
// next non-blank source line is regular (non-blockquote) content. This is used
// only for MD→DOCX visual fidelity so callout→paragraph transitions preserve
// explicit empty lines in Word.
export function computeBlockquotePostContentBlankLines(markdown: string): Map<number, number> {
  const blanksByGroup = new Map<number, number>();
  const lines = markdown.split('\n');
  const alertMarkerRe = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

  const groups: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^ {0,3}>/.test(lines[i])) {
      const runStart = i;
      let groupStart = i;
      let groupLevel = parseBlockquoteLevel(lines[i]);
      i++;
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        const level = parseBlockquoteLevel(lines[i]);
        const startsAlertGroup = alertMarkerRe.test(lines[i]) && i > runStart;
        const levelChanged = level !== groupLevel;
        if (startsAlertGroup || levelChanged) {
          groups.push({ start: groupStart, end: i - 1 });
          groupStart = i;
          groupLevel = level;
        }
        i++;
      }
      groups.push({ start: groupStart, end: i - 1 });
    } else {
      i++;
    }
  }

  for (let g = 0; g < groups.length; g++) {
    let li = groups[g].end + 1;
    let blankCount = 0;
    while (li < lines.length && lines[li].trim() === '') {
      blankCount++;
      li++;
    }
    if (li < lines.length && !/^ {0,3}>/.test(lines[li])) {
      // Preserve explicit authored spacing before non-blockquote content,
      // including zero-blank transitions (`> quote` immediately followed by
      // a paragraph line), so DOCX→MD can reconstruct semantic boundaries.
      blanksByGroup.set(g, blankCount);
    }
  }

  return blanksByGroup;
}
// Compute per-blockquote-group alert marker style from source markdown.
// true means `> [!TYPE] body`, false means marker-only line.
export function computeBlockquoteAlertMarkerInlineByGroup(markdown: string): Map<number, boolean> {
  const inlineByGroup = new Map<number, boolean>();
  const lines = markdown.split('\n');
  const alertMarkerRe = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](.*)$/i;

  let groupIndex = 0;
  let i = 0;
  while (i < lines.length) {
    if (/^ {0,3}>/.test(lines[i])) {
      const runStart = i;
      let groupStart = i;
      let groupLevel = parseBlockquoteLevel(lines[i]);
      i++;
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        const level = parseBlockquoteLevel(lines[i]);
        const startsAlertGroup = alertMarkerRe.test(lines[i]) && i > runStart;
        const levelChanged = level !== groupLevel;
        if (startsAlertGroup || levelChanged) {
          const first = lines[groupStart].match(alertMarkerRe);
          if (first) inlineByGroup.set(groupIndex, first[2].trim().length > 0);
          groupIndex++;
          groupStart = i;
          groupLevel = level;
        }
        i++;
      }
      const first = lines[groupStart].match(alertMarkerRe);
      if (first) inlineByGroup.set(groupIndex, first[2].trim().length > 0);
      groupIndex++;
    } else {
      i++;
    }
  }

  return inlineByGroup;
}

// Assign a sequential blockquoteGroupIndex to each blockquote token so the
// gap map can be correlated during docx→md conversion.  Groups are delimited
// by alertFirst/alertLast boundaries set by annotateBlockquoteBoundaries.
export function annotateBlockquoteGroupIndices(tokens: MdToken[]): void {
  let groupIndex = 0;
  let inGroup = false;
  for (const token of tokens) {
    if (token.type !== 'blockquote') {
      if (inGroup) {
        groupIndex++;
        inGroup = false;
      }
      continue;
    }
    if (!inGroup) {
      inGroup = true;
    }
    token.blockquoteGroupIndex = groupIndex;
    if (token.alertLast) {
      groupIndex++;
      inGroup = false;
    }
  }
}

// Serialize blockquote gap metadata as custom XML properties, following the
// same chunked-JSON pattern used by codeBlockLanguageProps.
export function blockquoteGapProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_GAPS_', JSON.stringify(mapping));
}
export function computeBlockquotePreContentBlankLines(markdown: string): Map<number, number> {
  const blanksByGroup = new Map<number, number>();
  const lines = markdown.split('\n');
  const alertMarkerRe = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

  const groups: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^ {0,3}>/.test(lines[i])) {
      const runStart = i;
      let groupStart = i;
      let groupLevel = parseBlockquoteLevel(lines[i]);
      i++;
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        const level = parseBlockquoteLevel(lines[i]);
        const startsAlertGroup = alertMarkerRe.test(lines[i]) && i > runStart;
        const levelChanged = level !== groupLevel;
        if (startsAlertGroup || levelChanged) {
          groups.push({ start: groupStart, end: i - 1 });
          groupStart = i;
          groupLevel = level;
        }
        i++;
      }
      groups.push({ start: groupStart, end: i - 1 });
    } else {
      i++;
    }
  }

  for (let g = 0; g < groups.length; g++) {
    let li = groups[g].start - 1;
    let blankCount = 0;
    while (li >= 0 && lines[li].trim() === '') {
      blankCount++;
      li--;
    }
    if (li >= 0 && !/^ {0,3}>/.test(lines[li])) {
      blanksByGroup.set(g, blankCount);
    }
  }
  return blanksByGroup;
}
export function blockquoteAlertMarkerStyleProps(inlineByGroup: Map<number, boolean>): CustomPropEntry[] {
  if (inlineByGroup.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, isInline] of inlineByGroup) {
    mapping[String(index)] = isInline ? 1 : 0;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_ALERT_STYLE_', JSON.stringify(mapping));
}
export function blockquotePreContentBlankLineProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_PRE_CONTENT_BLANK_LINES_', JSON.stringify(mapping));
}
export function blockquotePostContentBlankLineProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_POST_CONTENT_BLANK_LINES_', JSON.stringify(mapping));
}

export function imageFormatProps(imageFormats: Map<string, string>): CustomPropEntry[] {
  if (imageFormats.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [rId, syntax] of imageFormats) {
    mapping[rId] = syntax;
  }
  return chunkCustomProps('MANUSCRIPT_IMAGE_FORMATS_', JSON.stringify(mapping));
}

export function tableFormatProps(tableFormats: Map<number, TableFormat>): CustomPropEntry[] {
  if (tableFormats.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [idx, fmt] of tableFormats) {
    mapping[String(idx)] = fmt;
  }
  return chunkCustomProps('MANUSCRIPT_TABLE_FORMATS_', JSON.stringify(mapping));
}

export function tableFontSizeProps(sizes: Map<number, number>): CustomPropEntry[] {
  const mapping: Record<string, string> = {};
  for (const [idx, pt] of sizes) {
    mapping[String(idx)] = String(pt);
  }
  if (Object.keys(mapping).length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_TABLE_FONT_SIZES_', JSON.stringify(mapping));
}

export function tableFontProps(fonts: Map<number, string>): CustomPropEntry[] {
  const mapping: Record<string, string> = {};
  for (const [idx, font] of fonts) {
    mapping[String(idx)] = font;
  }
  if (Object.keys(mapping).length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_TABLE_FONTS_', JSON.stringify(mapping));
}


export function parseMd(markdown: string, warnings?: string[]): MdToken[] {
  const md = createMarkdownIt();
  // Preserve explicit source semantics for blockquotes by disabling markdown-it
  // lazy continuation behavior (where a non-`>` line can be absorbed into a
  // preceding blockquote paragraph). For roundtrip fidelity we treat a missing
  // `>` as a hard blockquote boundary
  const gridProcessed = preprocessGridTables(markdown);
  const deLazified = deLazifyBlockquotes(gridProcessed);
  const wrapped = wrapBareLatexEnvironments(deLazified);
  const processed = preprocessCriticMarkup(wrapped);
  const tokens = md.parse(processed, {});

  const result = convertTokens(tokens, 0, 0, warnings);
  annotateBlockquoteBoundaries(result);

  // Post-process: transfer table-font directives from HTML comment tokens to table tokens
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].type !== 'paragraph' || result[i].runs.length !== 1) continue;
    const run = result[i].runs[0];
    if (run.type !== 'html_comment') continue;
    const text = run.text.trim();
    const fontSizeMatch = text.match(/^<!--\s*table-font-size:\s*(\d+(?:\.\d+)?)\s*-->$/);
    const fontMatch = text.match(/^<!--\s*table-font:\s*(.+?)\s*-->$/);
    if (!fontSizeMatch && !fontMatch) continue;
    // Look for the next table token; only assign if not already set (nearest wins)
    if (i + 1 < result.length && result[i + 1].type === 'table') {
      if (fontSizeMatch && result[i + 1].tableFontSize === undefined) {
        const n = parseFloat(fontSizeMatch[1]);
        if (isFinite(n) && n > 0) result[i + 1].tableFontSize = n;
      }
      const fontVal = fontMatch ? fontMatch[1].trim() : '';
      if (fontVal && result[i + 1].tableFont === undefined) result[i + 1].tableFont = fontVal;
      result.splice(i, 1);
    }
  }

  return result;
}

function deLazifyBlockquotes(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inBlockquoteRun = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}([`~]{3,})/);
    if (fenceMatch) {
      const run = fenceMatch[1];
      const runChar = run[0] as '`' | '~';
      // Invariant: de-lazification must not inject blank lines inside fenced
      // code blocks, or code content roundtrip fidelity is corrupted.
      if (!fenceChar) {
        if (inBlockquoteRun) {
          out.push('');
          inBlockquoteRun = false;
        }
        fenceChar = runChar;
        fenceLen = run.length;
      } else if (runChar === fenceChar && run.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      out.push(line);
      continue;
    }
    if (fenceChar) {
      out.push(line);
      continue;
    }
    const isBlank = line.trim() === '';
    const isBlockquoteLine = /^ {0,3}>/.test(line);

    if (isBlockquoteLine) {
      inBlockquoteRun = true;
      out.push(line);
      continue;
    }

    if (isBlank) {
      inBlockquoteRun = false;
      out.push(line);
      continue;
    }

    if (inBlockquoteRun) {
      // Insert a blank line to end the previous blockquote before this
      // non-blank, non-`>` line.
      out.push('');
      inBlockquoteRun = false;
    }

    out.push(line);
  }

  return out.join('\n');
}


function stripLeadingAlertMarker(runs: MdRun[]): { alertType?: GfmAlertType; runs: MdRun[] } {
  const firstTextIdx = runs.findIndex(run => run.type === 'text' && run.text.length > 0);
  if (firstTextIdx === -1) return { runs };
  const firstText = runs[firstTextIdx];
  const parsed = parseGfmAlertMarker(firstText.text);
  if (!parsed) return { runs };
  const nextRuns = [...runs];
  if (parsed.rest.length > 0) {
    nextRuns[firstTextIdx] = { ...firstText, text: parsed.rest };
  } else {
    nextRuns.splice(firstTextIdx, 1);
  }
  return { alertType: parsed.type, runs: nextRuns };
}

/** Strip leading and trailing softbreak runs from an array. */
function trimSoftbreaks(runs: MdRun[]): MdRun[] {
  let start = 0, end = runs.length;
  while (start < end && runs[start].type === 'softbreak') start++;
  while (end > start && runs[end - 1].type === 'softbreak') end--;
  return start === 0 && end === runs.length ? runs : runs.slice(start, end);
}

function annotateBlockquoteAlert(tokens: MdToken[], level: number): MdToken[] {
  // Pre-pass: split merged paragraphs that contain alert [!TYPE] markers
  // separated by softbreaks (markdown-it merges consecutive > lines without
  // blank lines into one paragraph).
  const expanded: MdToken[] = [];
  for (const token of tokens) {
    if (token.type === 'blockquote' || token.runs.length === 0) {
      expanded.push(token);
      continue;
    }
    const markerIndices: number[] = [];
    for (let r = 0; r < token.runs.length; r++) {
      if (token.runs[r].type === 'text' && parseGfmAlertMarker(token.runs[r].text)) {
        markerIndices.push(r);
      }
    }
    // Skip splitting only when the first text run IS the sole marker
    const firstTextRunIdx = token.runs.findIndex(r => r.type === 'text' && r.text.length > 0);
    if (markerIndices.length === 0 ||
        (markerIndices.length === 1 && markerIndices[0] === firstTextRunIdx)) {
      expanded.push(token);
      continue;
    }
    // Content before the first marker becomes a plain paragraph
    if (markerIndices[0] > 0) {
      const preRuns = trimSoftbreaks(token.runs.slice(0, markerIndices[0]));
      if (preRuns.length > 0) {
        expanded.push({ ...token, runs: preRuns });
      }
    }
    // Each marker starts a new segment
    for (let m = 0; m < markerIndices.length; m++) {
      const start = markerIndices[m];
      const end = m + 1 < markerIndices.length ? markerIndices[m + 1] : token.runs.length;
      const segRuns = trimSoftbreaks(token.runs.slice(start, end));
      if (segRuns.length > 0) {
        expanded.push({ ...token, runs: segRuns });
      }
    }
  }

  // Find all tokens whose runs start with an alert marker
  interface Hit { idx: number; type: GfmAlertType; runs: MdRun[] }
  const hits: Hit[] = [];
  for (let idx = 0; idx < expanded.length; idx++) {
    if (expanded[idx].type === 'blockquote' || expanded[idx].runs.length === 0) continue;
    const parsed = stripLeadingAlertMarker(expanded[idx].runs);
    if (parsed.alertType) {
      hits.push({ idx, type: parsed.alertType, runs: parsed.runs });
    }
  }

  if (hits.length === 0) {
    return expanded.map(t => ({ ...t, type: 'blockquote' as const, level: t.type === 'blockquote' ? t.level : level }));
  }

  // Assign each group of tokens (from one marker to the next) its alert type.
  // Tokens before the first marker become a plain blockquote.
  const result: MdToken[] = [];
  for (let idx = 0; idx < expanded.length; idx++) {
    const t = expanded[idx];
    const hit = hits.find(h => h.idx === idx);
    let currentAlert: GfmAlertType | undefined;
    let isLead = false;
    if (hit) {
      currentAlert = hit.type;
      isLead = true;
    } else {
      for (let h = hits.length - 1; h >= 0; h--) {
        if (hits[h].idx < idx) { currentAlert = hits[h].type; break; }
      }
    }
    result.push({
      ...t,
      type: 'blockquote' as const,
      level: t.type === 'blockquote' ? t.level : level,
      ...(currentAlert && t.type !== 'blockquote' ? { alertType: currentAlert } : {}),
      ...(isLead ? { alertLead: true, runs: hit!.runs } : {}),
    });
  }
  return result;
}

function convertTokens(tokens: any[], listLevel = 0, blockquoteLevel = 0, warnings?: string[]): MdToken[] {
  const result: MdToken[] = [];
  let i = 0;
  
  while (i < tokens.length) {
    const token = tokens[i];
    
    switch (token.type) {
      case 'heading_open':
        const headingClose = findClosingToken(tokens, i, 'heading_close');
        result.push({
          type: 'heading',
          level: parseInt(token.tag.slice(1)),
          runs: convertInlineTokens(tokens.slice(i + 1, headingClose))
        });
        i = headingClose + 1;
        break;
        
      case 'paragraph_open':
        const paragraphClose = findClosingToken(tokens, i, 'paragraph_close');
        result.push({
          type: 'paragraph',
          runs: convertInlineTokens(tokens.slice(i + 1, paragraphClose))
        });
        i = paragraphClose + 1;
        break;
        
      case 'bullet_list_open':
      case 'ordered_list_open':
        const listClose = findClosingToken(tokens, i, token.type.replace('_open', '_close'));
        const currentLevel = listLevel + 1;
        const listItems = extractListItems(tokens.slice(i + 1, listClose), token.type === 'ordered_list_open', currentLevel, warnings);
        result.push(...listItems);
        i = listClose + 1;
        break;

      case 'blockquote_open':
        const blockquoteClose = findClosingToken(tokens, i, 'blockquote_close');
        const bqLevel = blockquoteLevel + 1;
        // Intentionally reset listLevel inside blockquotes.
        // In Markdown, `> - item` starts a new list context within the quote,
        // so numbering/indentation should not inherit from outer lists.
        const blockquoteTokens = convertTokens(tokens.slice(i + 1, blockquoteClose), 0, bqLevel, warnings);
        result.push(...annotateBlockquoteAlert(blockquoteTokens, bqLevel));
        i = blockquoteClose + 1;
        break;
        
      case 'fence': {
        // Detect trailing blank line by checking if the next token starts
        // more than one line after this fence ends.  Both map values must
        // be present; if either is missing we conservatively assume no gap.
        const fenceEnd = token.map?.[1];
        const nextStart = tokens[i + 1]?.map?.[0];
        result.push({
          type: 'code_block',
          language: token.info || undefined,
          trailingBlankLine: fenceEnd != null && nextStart != null && nextStart > fenceEnd,
          runs: [{ type: 'text', text: token.content }]
        });
        i++;
        break;
      }

      case 'code_block': {
        const cbEnd = token.map?.[1];
        const cbNextStart = tokens[i + 1]?.map?.[0];
        result.push({
          type: 'code_block',
          language: undefined,
          trailingBlankLine: cbEnd != null && cbNextStart != null && cbNextStart > cbEnd,
          runs: [{ type: 'text', text: token.content }]
        });
        i++;
        break;
      }

      case 'table_open':
        const tableClose = findClosingToken(tokens, i, 'table_close');
        const tableData = extractTableData(tokens.slice(i + 1, tableClose));
        result.push({
          type: 'table',
          runs: [],
          rows: tableData,
          sourceFormat: 'pipe',
        });
        i = tableClose + 1;
        break;
      
      case 'html_block': {
        const htmlContent = token.content || '';
        if (htmlContent.trim().startsWith(GRID_TABLE_PLACEHOLDER_PREFIX)) {
          const b64 = htmlContent.trim().slice(GRID_TABLE_PLACEHOLDER_PREFIX.length, -4); // strip prefix and ' -->'
          try {
            const jsonStr = Buffer.from(b64, 'base64').toString();
            const gridData: GridTableData = JSON.parse(jsonStr);
            const md = createMarkdownIt();
            const gridRows: MdTableRow[] = gridData.rows.map(row => ({
              cells: row.cells.map(cellText => ({
                runs: cellText ? convertInlineTokens(md.parseInline(cellText, {})) : [],
              })),
              header: row.header,
            }));
            result.push({
              type: 'table',
              runs: [],
              rows: gridRows,
              sourceFormat: 'grid',
            });
          } catch {
            // Invalid JSON — emit as regular HTML comment
            result.push({
              type: 'paragraph',
              runs: [{ type: 'html_comment' as const, text: htmlContent.replace(/\n$/, '') }]
            });
          }
          i++;
          break;
        }
        if (/^<!--[\s\S]*?-->\s*$/.test(htmlContent.trim())) {
          // Compute blank lines before this HTML comment using token.map
          const thisStart = token.map?.[0] ?? 0;
          // Find previous token's end line — scan backwards through markdown-it tokens
          let prevEnd = 0;
          for (let pi = i - 1; pi >= 0; pi--) {
            if (tokens[pi].map) {
              prevEnd = tokens[pi].map[1];
              break;
            }
          }
          const blankLines = Math.max(0, thisStart - prevEnd);
          result.push({
            type: 'paragraph',
            blankLinesBefore: blankLines,
            runs: [{ type: 'html_comment' as const, text: htmlContent.replace(/\n$/, '') }]
          });
        } else if (isGfmDisallowedRawHtml(htmlContent)) {
          result.push({
            type: 'paragraph',
            runs: [{ type: 'text', text: htmlContent.replace(/\n$/, '') }]
          });
        } else if (/^<img\s/i.test(htmlContent.trim())) {
          const srcMatch = htmlContent.match(/src\s*=\s*["']([^"']+)["']/);
          const altMatch = htmlContent.match(/alt\s*=\s*["']([^"']*?)["']/);
          const wMatch = htmlContent.match(/width\s*=\s*["']?(\d+)(?:px)?["']?(?=[\s\/>])/);
          const hMatch = htmlContent.match(/height\s*=\s*["']?(\d+)(?:px)?["']?(?=[\s\/>])/);
          if (srcMatch) {
            result.push({
              type: 'paragraph',
              runs: [{
                type: 'image' as const,
                text: '',
                imageSrc: decodeHtmlEntities(srcMatch[1]),
                imageAlt: altMatch ? decodeHtmlEntities(altMatch[1]) : '',
                imageWidth: wMatch ? parseInt(wMatch[1], 10) : undefined,
                imageHeight: hMatch ? parseInt(hMatch[1], 10) : undefined,
                imageSyntax: 'html' as const,
              }]
            });
          } else {
            // Preserve malformed <img> tags as literal text
            result.push({
              type: 'paragraph',
              runs: [{ type: 'text', text: htmlContent.replace(/\n$/, '') }]
            });
          }
        } else {
          const htmlTables = extractHtmlTables(htmlContent);
          if (htmlTables.length > 0) {
            for (const meta of htmlTables) {
              if (meta.rows.length > 0) {
                // Keep this mapping explicit so HtmlTableRun/MdRun shape changes
                // cannot silently alter assignability behavior.
                const mappedRows = mapHtmlTableRowsToMdTableRows(meta.rows);
                const tableToken: MdToken = {
                  type: 'table',
                  runs: [],
                  rows: mappedRows,
                  sourceFormat: 'html',
                };
                if (meta.fontSize) tableToken.tableFontSize = meta.fontSize;
                if (meta.font) tableToken.tableFont = meta.font;
                result.push(tableToken);
              }
            }
          } else {
            // Preserve non-table raw HTML blocks as literal text so user content
            // like <tag> is not silently dropped during MD→DOCX parsing.
            result.push({
              type: 'paragraph',
              runs: [{ type: 'text', text: htmlContent.replace(/\n$/, '') }]
            });
          }
        }
        i++;
        break;
      }
        
      case 'hr':
        result.push({
          type: 'hr',
          runs: []
        });
        i++;
        break;
        
      default:
        i++;
        break;
    }
  }
  
  return result;
}

function convertInlineTokens(tokens: any[]): MdRun[] {
  const runs: MdRun[] = [];
  
  for (const token of tokens) {
    if (token.type === 'inline' && token.children) {
      // Process the children of inline tokens
      runs.push(...processInlineChildren(token.children));
    } else {
      // Single token processing
      const tokenRuns = processInlineChildren([token]);
      runs.push(...tokenRuns);
    }
  }
  
  return runs;
}

function processInlineChildren(tokens: any[]): MdRun[] {
  const runs: MdRun[] = [];
  const formatStack: any = {};
  let currentHref: string | undefined;
  
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti];
    if (token.type === 'inline' && token.children) {
      // Process the children directly - they should already have custom tokens
      runs.push(...processInlineChildren(token.children));
      continue;
    }
    
    switch (token.type) {
      case 'text':
        if (token.content) {  // Only add non-empty text
          runs.push({
            type: 'text',
            text: token.content,
            ...formatStack,
            href: currentHref
          });
        }
        break;
        
      case 'code_inline':
        runs.push({
          type: 'text',
          text: token.content,
          code: true,
          ...formatStack,
          href: currentHref
        });
        break;
        
      case 'softbreak':
        runs.push({ type: 'softbreak', text: '\n' });
        break;
        
      case 'strong_open':
        formatStack.bold = true;
        break;
      case 'strong_close':
        delete formatStack.bold;
        break;
        
      case 'em_open':
        formatStack.italic = true;
        break;
      case 'em_close':
        delete formatStack.italic;
        break;
        
      case 's_open':
        formatStack.strikethrough = true;
        break;
      case 's_close':
        delete formatStack.strikethrough;
        break;
        
      case 'link_open':
        currentHref = token.attrGet('href');
        break;
      case 'link_close':
        currentHref = undefined;
        break;
        
      case 'html_inline': {
        const html = token.content;
        if (html.startsWith('<!--')) {
          runs.push({ type: 'html_comment', text: html });
        } else if (isGfmDisallowedRawHtml(html)) {
          runs.push({
            type: 'text',
            text: html,
            ...formatStack,
            href: currentHref
          });
        } else if (/^<img\s/i.test(html)) {
          const srcMatch = html.match(/src\s*=\s*["']([^"']+)["']/);
          const altMatch = html.match(/alt\s*=\s*["']([^"']*?)["']/);
          const wMatch = html.match(/width\s*=\s*["']?(\d+)(?:px)?["']?(?=[\s\/>])/);
          const hMatch = html.match(/height\s*=\s*["']?(\d+)(?:px)?["']?(?=[\s\/>])/);
          if (srcMatch) {
            runs.push({
              type: 'image',
              text: '',
              imageSrc: decodeHtmlEntities(srcMatch[1]),
              imageAlt: altMatch ? decodeHtmlEntities(altMatch[1]) : '',
              imageWidth: wMatch ? parseInt(wMatch[1], 10) : undefined,
              imageHeight: hMatch ? parseInt(hMatch[1], 10) : undefined,
              imageSyntax: 'html',
            });
          } else {
            // Preserve malformed <img> tags as literal text
            runs.push({ type: 'text', text: html, ...formatStack });
          }
        } else if (html === '<u>') formatStack.underline = true;
        else if (html === '</u>') delete formatStack.underline;
        else if (html === '<sup>') formatStack.superscript = true;
        else if (html === '</sup>') delete formatStack.superscript;
        else if (html === '<sub>') formatStack.subscript = true;
        else if (html === '</sub>') delete formatStack.subscript;
        else {
          // Preserve unsupported inline HTML-like fragments as literal text
          // instead of dropping them.
          runs.push({
            type: 'text',
            text: html,
            ...formatStack,
            href: currentHref
          });
        }
        break;
      }
        
      case 'critic_markup':
        if (token.criticType === 'critic_sub') {
          const oldText = token.oldText || '';
          const newText = token.newText || '';
          runs.push({
            type: 'critic_sub',
            text: oldText,
            newText,
            oldRuns: parseCriticInnerRuns(oldText),
            newRuns: parseCriticInnerRuns(newText),
            ...formatStack,
            href: currentHref
          });
        } else if (token.criticType === 'critic_comment') {
          const commentAnchorText = '';
          runs.push({
            type: 'critic_comment',
            text: commentAnchorText,
            innerRuns: parseCriticInnerRuns(commentAnchorText),
            author: token.author,
            date: token.date,
            commentText: token.commentText,
            replies: token.replies,
            ...formatStack,
            href: currentHref
          });
        } else {
          let text = token.content;
          let innerHighlight: boolean | undefined;
          let innerColor: string | undefined;

          // Only strip inner ==...== from critic_highlight — not critic_add/critic_del
          // where literal == characters in added/deleted text would be misinterpreted.
          if (token.criticType === 'critic_highlight') {
            const coloredMatch = text.match(/^==([\s\S]*)==\{([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\}$/);
            const plainMatch = !coloredMatch && text.match(/^==([\s\S]*)==$/);

            if (coloredMatch) {
              text = coloredMatch[1];
              innerHighlight = true;
              innerColor = coloredMatch[2];
            } else if (plainMatch) {
              text = plainMatch[1];
              innerHighlight = true;
            }
          }

          runs.push({
            type: token.criticType,
            text,
            innerRuns: parseCriticInnerRuns(text),
            author: token.author,
            date: token.date,
            highlight: innerHighlight,
            highlightColor: innerColor,
            ...formatStack,
            href: currentHref
          });
        }
        break;
        
      case 'colored_highlight': {
        let text = token.content;
        const criticMatch = text.match(/^\{==([\s\S]*)==\}$/);
        if (criticMatch) text = criticMatch[1];
        runs.push({
          type: 'critic_highlight',
          text,
          highlight: true,
          highlightColor: token.color,
          ...formatStack,
          href: currentHref
        });
        break;
      }

      case 'plain_highlight': {
        let text = token.content;
        const criticMatch = text.match(/^\{==([\s\S]*)==\}$/);
        if (criticMatch) text = criticMatch[1];
        runs.push({
          type: 'critic_highlight',
          text,
          highlight: true,
          ...formatStack,
          href: currentHref
        });
        break;
      }
        
      case 'citation':
        runs.push({
          type: 'citation',
          text: token.content,
          keys: token.keys,
          locators: token.locators,
          suppressAuthorKeys: token.suppressAuthorKeys || undefined,
          ...formatStack,
          href: currentHref
        });
        break;
        
      case 'math':
        runs.push({
          type: 'math',
          text: token.content,
          display: token.display,
          ...formatStack,
          href: currentHref
        });
        break;

      case 'comment_range_start':
        runs.push({
          type: 'comment_range_start',
          text: '',
          commentId: token.commentId,
        });
        break;

      case 'comment_range_end':
        runs.push({
          type: 'comment_range_end',
          text: '',
          commentId: token.commentId,
        });
        break;

      case 'comment_body_with_id':
        runs.push({
          type: 'comment_body_with_id',
          text: '',
          commentId: token.commentId,
          author: token.author,
          date: token.date,
          commentText: token.commentText,
          replies: token.replies,
        });
        break;

      case 'footnote_ref':
        runs.push({
          type: 'footnote_ref',
          text: '',
          footnoteLabel: token.footnoteLabel,
          ...formatStack,
        });
        break;

      case 'image': {
        const src = token.attrGet?.('src') || '';
        const alt = token.children?.map((c: any) => c.content || '').join('') || '';
        let width: number | undefined;
        let height: number | undefined;
        // Look ahead for {width=N height=N} attribute syntax
        const nextToken = tokens[ti + 1];
        if (nextToken?.type === 'text' && nextToken.content) {
          const attrMatch = nextToken.content.match(/^\{([^}]+)\}/);
          if (attrMatch) {
            const attrs = attrMatch[1];
            const wm = attrs.match(/width=(\d+)/);
            const hm = attrs.match(/height=(\d+)/);
            if (wm) width = parseInt(wm[1], 10);
            if (hm) height = parseInt(hm[1], 10);
            // Consume the attribute text (or remainder after it)
            const remainder = nextToken.content.slice(attrMatch[0].length);
            if (remainder) {
              nextToken.content = remainder;
            } else {
              ti++; // skip the attribute token entirely
            }
          }
        }
        runs.push({
          type: 'image',
          text: '',
          imageSrc: src,
          imageAlt: alt,
          imageWidth: width,
          imageHeight: height,
          imageSyntax: 'md',
        });
        break;
      }
    }
  }

  return runs;
}

function findClosingToken(tokens: any[], start: number, closeType: string): number {
  let depth = 1;
  for (let i = start + 1; i < tokens.length; i++) {
    if (tokens[i].type === tokens[start].type) depth++;
    else if (tokens[i].type === closeType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length;
}

// Block token types that are silently dropped when they appear inside list
// continuation (e.g. a fenced code block indented under a list item).
// The md-to-docx converter only preserves the first paragraph and nested
// sublists; all other block content is lost.
const DROPPED_LIST_BLOCK_TYPES = new Set([
  'fence', 'code_block', 'html_block', 'blockquote_open', 'table_open',
]);

function extractListItems(tokens: any[], ordered: boolean, level: number, warnings?: string[]): MdToken[] {
  const items: MdToken[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].type === 'list_item_open') {
      const closePos = findClosingToken(tokens, i, 'list_item_close');
      const itemTokens = tokens.slice(i + 1, closePos);
      let runs: MdRun[] = [];
      let foundFirstParagraph = false;
      // Track nested list depth so we only capture the parent item's own
      // paragraph — not paragraphs belonging to child list items.
      let nestedListDepth = 0;
      for (let j = 0; j < itemTokens.length; j++) {
        if (itemTokens[j].type === 'bullet_list_open' || itemTokens[j].type === 'ordered_list_open') {
          nestedListDepth++;
          continue;
        }
        if (itemTokens[j].type === 'bullet_list_close' || itemTokens[j].type === 'ordered_list_close') {
          nestedListDepth--;
          continue;
        }
        if (nestedListDepth > 0) continue;
        if (itemTokens[j].type === 'paragraph_open') {
          const paragraphClose = findClosingToken(itemTokens, j, 'paragraph_close');
          if (!foundFirstParagraph) {
            runs = processInlineChildren(itemTokens.slice(j + 1, paragraphClose));
            foundFirstParagraph = true;
          } else if (warnings) {
            warnings.push('Continuation paragraph inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.');
          }
          j = paragraphClose;
        } else if (itemTokens[j].type === 'inline' && !foundFirstParagraph) {
          runs = processInlineChildren([itemTokens[j]]);
          foundFirstParagraph = true;
        } else if (warnings && DROPPED_LIST_BLOCK_TYPES.has(itemTokens[j].type)) {
          const kind = itemTokens[j].type === 'fence' ? 'Code block'
            : itemTokens[j].type === 'code_block' ? 'Indented code block'
            : itemTokens[j].type === 'html_block' ? 'HTML block'
            : itemTokens[j].type === 'blockquote_open' ? 'Blockquote'
            : itemTokens[j].type === 'table_open' ? 'Table'
            : 'Block element';
          warnings.push(kind + ' inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.');
        }
      }

      const taskInfo = extractTaskListItem(runs);
      items.push({
        type: 'list_item',
        ordered,
        level,
        runs: taskInfo?.runs ?? runs,
        taskChecked: taskInfo?.checked,
      });

      // Extract nested sublists
      for (let j = 0; j < itemTokens.length; j++) {
        if (itemTokens[j].type === 'bullet_list_open' || itemTokens[j].type === 'ordered_list_open') {
          const subClose = findClosingToken(itemTokens, j, itemTokens[j].type.replace('_open', '_close'));
          const subOrdered = itemTokens[j].type === 'ordered_list_open';
          items.push(...extractListItems(itemTokens.slice(j + 1, subClose), subOrdered, level + 1, warnings));
          j = subClose;
        }
      }

      i = closePos + 1;
    } else {
      i++;
    }
  }

  return items;
}

function extractTaskListItem(runs: MdRun[]): { checked: boolean; runs: MdRun[] } | undefined {
  const firstTextIdx = runs.findIndex(run => run.type === 'text' && run.text.length > 0);
  if (firstTextIdx === -1) return undefined;
  const firstTextRun = runs[firstTextIdx];
  const parsed = parseTaskListMarker(firstTextRun.text);
  if (!parsed) return undefined;
  const updatedRuns = [...runs];
  if (parsed.rest.length === 0) {
    updatedRuns.splice(firstTextIdx, 1);
  } else {
    updatedRuns[firstTextIdx] = { ...firstTextRun, text: parsed.rest };
  }
  return { checked: parsed.checked, runs: updatedRuns };
}

function extractTableData(tokens: any[]): MdTableRow[] {
  const rows: MdTableRow[] = [];
  let i = 0;
  let isHeader = true;
  
  while (i < tokens.length) {
    if (tokens[i].type === 'tr_open') {
      const closePos = findClosingToken(tokens, i, 'tr_close');
      const cells = extractTableCells(tokens.slice(i + 1, closePos));
      rows.push({ cells, header: isHeader });
      isHeader = false;
      i = closePos + 1;
    } else {
      i++;
    }
  }
  
  return rows;
}

function extractTableCells(tokens: any[]): MdTableCell[] {
  const cells: MdTableCell[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].type === 'td_open' || tokens[i].type === 'th_open') {
      const closeType = tokens[i].type.replace('_open', '_close');
      const closePos = findClosingToken(tokens, i, closeType);
      cells.push({ runs: convertInlineTokens(tokens.slice(i + 1, closePos)) });
      i = closePos + 1;
    } else {
      i++;
    }
  }

  return cells;
}


function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// OOXML Generation Layer

async function extractTemplateParts(templateDocx: Uint8Array): Promise<Map<string, Uint8Array>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(templateDocx);
  const parts = new Map<string, Uint8Array>();
  
  for (const path of ['word/styles.xml', 'word/theme/theme1.xml', 'word/numbering.xml', 'word/settings.xml']) {
    const file = zip.file(path);
    if (file) {
      parts.set(path, await file.async('uint8array'));
    }
  }
  return parts;
}

export interface MdToDocxOptions {
  bibtex?: string;
  authorName?: string;
  templateDocx?: Uint8Array;
  zoteroBiblData?: ZoteroBiblData;
  /** Directory for caching downloaded CSL styles (e.g. VS Code global storage). */
  cslCacheDir?: string;
  /** Directory of the source markdown file, used to resolve relative CSL paths. */
  sourceDir?: string;
  /** Called when a CSL style is not bundled or found locally.
   *  Return true to attempt downloading from the CSL repository. */
  onStyleNotFound?: (styleName: string) => Promise<boolean>;
  /** Word paragraph style to use for blockquotes. */
  blockquoteStyle?: 'Quote' | 'IntenseQuote' | 'GitHub';
  /** Color scheme for alert callouts. */
  colors?: ColorScheme;
}

export interface MdToDocxResult {
  docx: Uint8Array;
  warnings: string[];
}

export interface FootnoteEntry {
  id: number;
  bodyXml: string;
}

export interface DocxGenState {
  commentId: number;
  comments: CommentEntry[];
  commentIdMap: Map<string, number>; // markdown ID -> OOXML numeric ID
  relationships: Map<string, string>; // URL -> rId
  nextRId: number;
  rIdOffset: number; // reserved rIds for fixed relationships (styles, numbering, comments, theme, settings)
  warnings: string[];
  hasList: boolean;
  hasComments: boolean;
  hasFootnotes: boolean;
  hasEndnotes: boolean;
  footnoteId: number;           // next available note ID (starts at 1)
  footnoteEntries: FootnoteEntry[];
  footnoteLabelToId: Map<string, number>;
  notesMode: 'footnotes' | 'endnotes';
  missingKeys: Set<string>;
  citationIds: Set<string>;
  citationItemIds: Map<string, string | number>;
  timezone?: string; // UTC offset from frontmatter (e.g. "-05:00")
  replyRanges: Array<{replyId: number; parentId: number}>;
  nextParaId: number;
  codeBlockIndex: number;
  codeBlockLanguages: Map<number, string>;
  citedKeys: Set<string>;
  codeFont: string;
  codeShadingMode: boolean;
  blockquoteGaps: Map<number, number>; // gap (blank-line count) after each blockquote group, keyed by group index
  blockquotePreContentBlankLines: Map<number, number>; // blank lines before group when previous non-blank source line is non-blockquote content
  blockquotePostContentBlankLines: Map<number, number>; // blank lines after group when next non-blank line is non-blockquote content
  blockquoteAlertMarkerInlineByGroup: Map<number, boolean>; // alert group index -> inline marker style
  // Image tracking
  imageRelationships: Map<string, { rId: string; mediaPath: string }>; // dedup key (absPath + '\0' + syntax) -> { rId, media path }
  imageMediaPaths: Map<string, string>; // absPath -> mediaPath (for binary dedup across syntaxes)
  imageBinaries: Map<string, Uint8Array>; // media path -> binary data
  imageFormats: Map<string, string>; // rId -> syntax ("md" | "html")
  imageExtensions: Set<string>; // collected extensions for content types
  nextImageDocPrId: number;
  tableIndex: number;
  tableFormats: Map<number, TableFormat>; // table index -> source format
  tableFontSizes: Map<number, number>; // table index -> per-table font size (pt)
  tableFonts: Map<number, string>;     // table index -> per-table font name
  fontOverrides?: FontOverrides;       // document-level font overrides for table default resolution
  listIndent: 'tab' | 'spaces'; // indentation style for nested list items
  consecutiveReplyParaIds: Set<string>; // parent paraIds whose replies were in consecutive format
  htmlCommentGaps: Map<number, number>; // blank-line-before count per HTML comment index (non-default only)
  tableRunRPrExtra: string; // extra rPr elements injected into every run inside a table cell (per-table font/size overrides)
}

interface CommentEntry {
  id: number;
  author: string;
  date: string;
  text: string;
  paraId: string;            // generated 8-hex-char ID
  parentParaId?: string;     // set for replies
}

/**
 * Normalize a date string to UTC ISO format for Word XML.
 * Handles:
 * - ISO with offset: "2024-01-15T10:30-05:00" → "2024-01-15T15:30:00Z"
 * - ISO with Z: "2024-01-15T15:30:00Z" → passed through
 * - Local format without offset: "2024-01-15 10:30" → uses fallbackTz to build UTC
 * - Already UTC ISO: returned as-is
 */
export function normalizeToUtcIso(dateStr: string, fallbackTz?: string): string {
  if (!dateStr) return '';

  // If the string already has a timezone offset (+ or - after time, or trailing Z), parse directly
  const hasOffset = /[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/.test(dateStr);
  if (hasOffset) {
    const dt = new Date(dateStr);
    if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());
  }

  // Local date format like "2024-01-15T10:30" or "2024-01-15 10:30"
  // Append fallback timezone to interpret correctly
  const normalized = dateStr.replace(' ', 'T');
  if (fallbackTz) {
    const dt = new Date(normalized + fallbackTz);
    if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());
  }

  // Last resort: parse as-is (system local time interpretation)
  const dt = new Date(normalized);
  if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());

  // If nothing works, return the original string
  return dateStr;
}

function stripMillis(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

interface ContentTypesOptions {
  hasList: boolean;
  hasComments: boolean;
  hasTheme?: boolean;
  hasCustomProps?: boolean;
  hasFootnotes?: boolean;
  hasEndnotes?: boolean;
  hasCommentsExtended?: boolean;
  hasCommentsIds?: boolean;
  hasCommentsExtensible?: boolean;
  hasPeople?: boolean;
  imageExtensions?: Set<string>;
}

function contentTypesXml(opts: ContentTypesOptions): string {
  const { hasList, hasComments, hasTheme, hasCustomProps, hasFootnotes, hasEndnotes, hasCommentsExtended, hasCommentsIds, hasCommentsExtensible, hasPeople, imageExtensions } = opts;
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n';
  xml += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n';
  xml += '<Default Extension="xml" ContentType="application/xml"/>\n';
  if (imageExtensions) {
    for (const ext of imageExtensions) {
      const ct = getImageContentType(ext);
      if (ct) xml += '<Default Extension="' + ext + '" ContentType="' + ct + '"/>\n';
    }
  }
  xml += '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n';
  xml += '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n';
  xml += '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>\n';
  xml += '<Override PartName="/word/webSettings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"/>\n';
  xml += '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>\n';
  if (hasList) {
    xml += '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>\n';
  }
  if (hasComments) {
    xml += '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>\n';
  }
  if (hasFootnotes) {
    xml += '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>\n';
  }
  if (hasEndnotes) {
    xml += '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>\n';
  }
  if (hasCommentsExtended) {
    xml += '<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>\n';
  }
  if (hasCommentsIds) {
    xml += '<Override PartName="/word/commentsIds.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml"/>\n';
  }
  if (hasCommentsExtensible) {
    xml += '<Override PartName="/word/commentsExtensible.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml"/>\n';
  }
  if (hasPeople) {
    xml += '<Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/>\n';
  }
  if (hasTheme) {
    xml += '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>\n';
  }
  xml += '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\n';
  xml += '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>\n';
  if (hasCustomProps) {
    xml += '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>\n';
  }
  xml += '</Types>';
  return xml;
}

function relsXml(hasCustomProps?: boolean): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\n' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>\n';
  if (hasCustomProps) {
    xml += '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>\n';
  }
  xml += '</Relationships>';
  return xml;
}

// --- Font override resolution ---
// Default sizes in half-points for OOXML styles.
// Implementation note: bodySizeHp default (22hp = 11pt) is the scaling base
// for proportional heading computation.
const DEFAULT_BODY_HP = 22;
const DEFAULT_HEADING_SIZES_HP: Record<string, number> = {
  Heading1: 32,
  Heading2: 26,
  Heading3: 24,
  Heading4: 22,
  Heading5: 20,
  Heading6: 18,
  Title: 56,
  FootnoteText: 20,
  EndnoteText: 20,
};
const DEFAULT_CODE_BLOCK_HP = 20;
// Uniform padding (horizontal indent + vertical spacing) for code blocks, in twips (~8pt / 0.11in)
const CODE_BLOCK_INSET_TWIPS = 160;
const DEFAULT_CODE_BACKGROUND = 'E8E8E8';
const DEFAULT_CODE_COLOR = '2E2E2E';
const DEFAULT_CODE_BORDER_SIZE = 48;
const CODE_BORDER_SPACE = 8;
const GITHUB_BLOCKQUOTE_BORDER_SIZE = 18;
const GITHUB_BLOCKQUOTE_BORDER_SPACE = 8;
const GITHUB_BLOCKQUOTE_BORDER_COLOR = 'D0D7DE';
const GITHUB_BLOCKQUOTE_INDENT = 240;
// Single-line spacing in OOXML (240 twips = 12pt)
const SINGLE_LINE_SPACING = 240;
// Left/right indent for shading-mode code blocks to prevent margin overflow (~0.22in)
export const CODE_BLOCK_MARGIN_INDENT = 317;

export interface FontOverrides {
  bodyFont?: string;
  codeFont?: string;
  bodySizeHp?: number;
  codeSizeHp?: number;
  headingSizesHp?: Map<string, number>;
  headingFonts?: Map<string, string>;
  headingStyles?: Map<string, string>;
  titleFonts?: string[];
  titleSizesHp?: number[];
  titleStyles?: string[];
  tableFont?: string;
  tableSizeHp?: number;
  tableSizeFromDefault?: boolean; // true when tableSizeHp was auto-computed from DEFAULT_BODY_HP
}

/** Resolve value at index with Array_Inheritance: use arr[i] if i < length, else arr[last]. */
export function resolveAtIndex<T>(arr: T[] | undefined, index: number): T | undefined {
  if (!arr || arr.length === 0) return undefined;
  return index < arr.length ? arr[index] : arr[arr.length - 1];
}

export interface CodeBlockConfig {
  background?: string;
  insetMode: boolean;
  codeFontColor?: string;
  codeBlockInset?: number;
}

export function resolveFontOverrides(fm: Frontmatter): FontOverrides {
  const overrides: FontOverrides = {};

  if (fm.font) {
    overrides.bodyFont = fm.font;
  }
  if (fm.codeFont) {
    overrides.codeFont = fm.codeFont;
  }

  if (fm.fontSize !== undefined) {
    const bodySizeHp = Math.round(fm.fontSize * 2);
    overrides.bodySizeHp = bodySizeHp;

    // Proportional heading scaling: preserve ratio relative to default 11pt body
    const headingSizesHp = new Map<string, number>();
    for (const [styleId, defaultHp] of Object.entries(DEFAULT_HEADING_SIZES_HP)) {
      headingSizesHp.set(styleId, Math.round(defaultHp / DEFAULT_BODY_HP * bodySizeHp));
    }
    overrides.headingSizesHp = headingSizesHp;

    // Code-font-size inference: body - 2hp (1pt), clamped to minimum 1hp
    if (fm.codeFontSize === undefined) {
      overrides.codeSizeHp = Math.max(1, bodySizeHp - 2);
    }
  }

  if (fm.codeFontSize !== undefined) {
    overrides.codeSizeHp = Math.round(fm.codeFontSize * 2);
  }

  // Per-heading font overrides
  const HEADING_IDS = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];
  if (fm.headerFont || fm.font) {
    const headingFonts = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const font = resolveAtIndex(fm.headerFont, i) ?? fm.font;
      if (font) headingFonts.set(HEADING_IDS[i], font);
    }
    if (headingFonts.size > 0) overrides.headingFonts = headingFonts;
  }

  // Per-heading style overrides
  if (fm.headerFontStyle) {
    const headingStyles = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const style = resolveAtIndex(fm.headerFontStyle, i);
      if (style) headingStyles.set(HEADING_IDS[i], style);
    }
    if (headingStyles.size > 0) overrides.headingStyles = headingStyles;
  }

  // Per-heading explicit size overrides (take precedence over proportional scaling)
  if (fm.headerFontSize) {
    if (!overrides.headingSizesHp) overrides.headingSizesHp = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const size = resolveAtIndex(fm.headerFontSize, i);
      if (size !== undefined) overrides.headingSizesHp.set(HEADING_IDS[i], Math.round(size * 2));
    }
  }

  // Title font overrides
  if (fm.titleFont || fm.font) {
    const arr = fm.titleFont ?? (fm.font ? [fm.font] : undefined);
    if (arr) overrides.titleFonts = arr;
  }
  if (fm.titleFontSize) {
    overrides.titleSizesHp = fm.titleFontSize.map(s => Math.round(s * 2));
  }
  if (fm.titleFontStyle) {
    overrides.titleStyles = fm.titleFontStyle;
  }

  // Table font overrides
  if (fm.tableFont) {
    overrides.tableFont = fm.tableFont;
  }
  if (fm.tableFontSize !== undefined) {
    overrides.tableSizeHp = Math.round(fm.tableFontSize * 2);
  } else if (fm.fontSize !== undefined) {
    // Auto-shrink: tables use body - 2pt (4hp)
    overrides.tableSizeHp = Math.max(1, Math.round(fm.fontSize * 2) - 4);
  } else {
    // Auto-shrink from default body size; may be recomputed from template Normal
    overrides.tableSizeHp = Math.max(1, DEFAULT_BODY_HP - 4);
    overrides.tableSizeFromDefault = true;
  }

  return overrides;
}

// --- Template font override application ---
// Style IDs that receive body font/size overrides
const BODY_STYLE_IDS = new Set([
  'Normal', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6',
  'Title', 'Quote', 'IntenseQuote', 'GitHub', 'GitHubNote', 'GitHubTip', 'GitHubImportant', 'GitHubWarning', 'GitHubCaution', 'FootnoteText', 'EndnoteText',
]);
// Style IDs that receive code font/size overrides
const CODE_STYLE_IDS = new Set(['CodeChar', 'CodeBlock']);
// Style IDs that receive table font/size overrides
const TABLE_STYLE_IDS = new Set(['TableParagraph']);

/**
 * Apply font overrides to a template's word/styles.xml content.
 * Decodes the raw bytes, finds <w:style> elements by w:styleId,
 * and inserts/replaces w:rFonts and w:sz/w:szCs in each matching
 * style's <w:rPr> section. Styles not present in the template are
 * silently skipped.
 */
export function applyFontOverridesToTemplate(
  stylesXmlBytes: Uint8Array,
  overrides: FontOverrides
): string {
  let xml = new TextDecoder('utf-8').decode(stylesXmlBytes);

  // Recompute auto-shrink from template's Normal style size when no explicit font-size
  if (overrides.tableSizeFromDefault) {
    const normalMatch = /<w:style\b[^>]*\bw:styleId="Normal"[^>]*>[\s\S]*?<\/w:style>/.exec(xml);
    if (normalMatch) {
      const szMatch = /<w:sz\s+w:val="(\d+)"/.exec(normalMatch[0]);
      if (szMatch) {
        const templateBodyHp = parseInt(szMatch[1], 10);
        overrides.tableSizeHp = Math.max(1, templateBodyHp - 4);
      }
    }
  }

  // Inject TableParagraph style if table overrides exist but the template lacks it
  if (overrides.tableSizeHp || overrides.tableFont) {
    if (!xml.includes('w:styleId="TableParagraph"')) {
      // Insert before </w:styles>
      const tableRpr = '<w:rPr>' +
        (overrides.tableFont
          ? '<w:rFonts w:ascii="' + escapeXml(overrides.tableFont) + '" w:hAnsi="' + escapeXml(overrides.tableFont) + '"/>'
          : (overrides.bodyFont
            ? '<w:rFonts w:ascii="' + escapeXml(overrides.bodyFont) + '" w:hAnsi="' + escapeXml(overrides.bodyFont) + '"/>'
            : '')) +
        (overrides.tableSizeHp
          ? '<w:sz w:val="' + overrides.tableSizeHp + '"/><w:szCs w:val="' + overrides.tableSizeHp + '"/>'
          : '') +
        '</w:rPr>';
      const tableStyle = '<w:style w:type="paragraph" w:styleId="TableParagraph">' +
        '<w:name w:val="Table Paragraph"/>' +
        '<w:basedOn w:val="Normal"/>' +
        tableRpr +
        '</w:style>';
      xml = xml.replace('</w:styles>', tableStyle + '</w:styles>');
    }
  }

  // Collect all style IDs we want to modify
  const allTargetIds = new Set([...BODY_STYLE_IDS, ...CODE_STYLE_IDS, ...TABLE_STYLE_IDS]);

  for (const styleId of allTargetIds) {
    // Find the <w:style ...w:styleId="ID"...> ... </w:style> block
    const styleRegex = new RegExp(
      '(<w:style\\b[^>]*\\bw:styleId="' + styleId + '"[^>]*>)([\\s\\S]*?)(</w:style>)'
    );
    const styleMatch = styleRegex.exec(xml);
    if (!styleMatch) continue; // style not in template — skip silently

    const openTag = styleMatch[1];
    let innerContent = styleMatch[2];
    const closeTag = styleMatch[3];

    const isCodeStyle = CODE_STYLE_IDS.has(styleId);
    const isTableStyle = TABLE_STYLE_IDS.has(styleId);
    const isHeading = /^Heading[1-6]$/.test(styleId);
    const isTitle = styleId === 'Title';

    // Determine font: heading-specific > title-specific > table > body/code font
    let font: string | undefined;
    if (isCodeStyle) {
      font = overrides.codeFont;
    } else if (isTableStyle) {
      font = overrides.tableFont ?? overrides.bodyFont;
    } else if (isHeading && overrides.headingFonts?.has(styleId)) {
      font = overrides.headingFonts.get(styleId);
    } else if (isTitle && overrides.titleFonts?.[0]) {
      font = overrides.titleFonts[0];
    } else {
      font = overrides.bodyFont;
    }

    // Determine the size for this style
    let sizeHp: number | undefined;
    if (isCodeStyle) {
      if (styleId === 'CodeBlock') sizeHp = overrides.codeSizeHp;
    } else if (isTableStyle) {
      sizeHp = overrides.tableSizeHp;
    } else if (isTitle && overrides.titleSizesHp?.[0]) {
      sizeHp = overrides.titleSizesHp[0];
    } else if (overrides.headingSizesHp && overrides.headingSizesHp.has(styleId)) {
      sizeHp = overrides.headingSizesHp.get(styleId);
    } else if (styleId === 'Normal') {
      sizeHp = overrides.bodySizeHp;
    }

    // Determine style override for headings and title
    let fontStyleOverride: string | undefined;
    if (isHeading) fontStyleOverride = overrides.headingStyles?.get(styleId);
    else if (isTitle) fontStyleOverride = overrides.titleStyles?.[0];

    // Nothing to do for this style
    if (font === undefined && sizeHp === undefined && fontStyleOverride === undefined) continue;

    // Build the replacement fragments
    const rFontsEl = font !== undefined
      ? '<w:rFonts w:ascii="' + escapeXml(font) + '" w:hAnsi="' + escapeXml(font) + '"/>'
      : undefined;
    const szEl = sizeHp !== undefined
      ? '<w:sz w:val="' + sizeHp + '"/>'
      : undefined;
    const szCsEl = sizeHp !== undefined
      ? '<w:szCs w:val="' + sizeHp + '"/>'
      : undefined;

    // Skip past any <w:pPr>...</w:pPr> block so we match the style-level
    // <w:rPr>, not one nested inside paragraph properties.
    const pPrClose = innerContent.indexOf('</w:pPr>');
    const rPrSearchStart = pPrClose !== -1 ? pPrClose + '</w:pPr>'.length : 0;
    const rPrRegex = /(<w:rPr\b[^>]*>)([\s\S]*?)(<\/w:rPr>)/;
    const rPrMatch = rPrRegex.exec(innerContent.slice(rPrSearchStart));

    if (rPrMatch) {
      // Modify existing <w:rPr> content
      let rPrContent = rPrMatch[2];

      if (rFontsEl !== undefined) {
        // Replace existing w:rFonts or insert at start of rPr content
        if (/<w:rFonts\b[^/]*\/>/.test(rPrContent)) {
          rPrContent = rPrContent.replace(/<w:rFonts\b[^/]*\/>/, () => rFontsEl);
        } else {
          rPrContent = rFontsEl + rPrContent;
        }
      }

      if (szEl !== undefined) {
        // Replace existing w:sz or append
        if (/<w:sz\b[^/]*\/>/.test(rPrContent)) {
          rPrContent = rPrContent.replace(/<w:sz\b[^/]*\/>/, () => szEl);
        } else {
          rPrContent = rPrContent + szEl;
        }
      }

      if (szCsEl !== undefined) {
        // Replace existing w:szCs or append
        if (/<w:szCs\b[^/]*\/>/.test(rPrContent)) {
          rPrContent = rPrContent.replace(/<w:szCs\b[^/]*\/>/, () => szCsEl);
        } else {
          rPrContent = rPrContent + szCsEl;
        }
      }

      // Apply font-style overrides (bold, italic, underline) for headings and title
      if (fontStyleOverride !== undefined) {
        // Remove existing b, i, u elements (all toggle forms: self-closing, with attributes, open+close)
        rPrContent = rPrContent.replace(/<w:b\b[^>]*(?:\/>|><\/w:b>)/g, '');
        rPrContent = rPrContent.replace(/<w:i\b[^>]*(?:\/>|><\/w:i>)/g, '');
        rPrContent = rPrContent.replace(/<w:u\b[^>]*(?:\/>|><\/w:u>)/g, '');
        // Add new style elements at the start
        let styleEls = '';
        if (fontStyleOverride !== 'normal') {
          if (fontStyleOverride.includes('bold')) styleEls += '<w:b/>';
          if (fontStyleOverride.includes('italic')) styleEls += '<w:i/>';
          if (fontStyleOverride.includes('underline')) styleEls += '<w:u w:val="single"/>';
        }
        rPrContent = styleEls + rPrContent;
      }

      const newRPr = rPrMatch[1] + rPrContent + rPrMatch[3];
      const matchStart = rPrSearchStart + rPrMatch.index;
      const matchEnd = matchStart + rPrMatch[0].length;
      innerContent = innerContent.slice(0, matchStart) + newRPr + innerContent.slice(matchEnd);
    } else {
      // No <w:rPr> section — insert one
      let rPrContent = '';
      if (fontStyleOverride !== undefined && fontStyleOverride !== 'normal') {
        if (fontStyleOverride.includes('bold')) rPrContent += '<w:b/>';
        if (fontStyleOverride.includes('italic')) rPrContent += '<w:i/>';
        if (fontStyleOverride.includes('underline')) rPrContent += '<w:u w:val="single"/>';
      }
      if (rFontsEl !== undefined) rPrContent += rFontsEl;
      if (szEl !== undefined) rPrContent += szEl;
      if (szCsEl !== undefined) rPrContent += szCsEl;
      innerContent = innerContent + '<w:rPr>' + rPrContent + '</w:rPr>';
    }

    xml = xml.slice(0, styleMatch.index) + openTag + innerContent + closeTag + xml.slice(styleMatch.index + styleMatch[0].length);
  }

  return xml;
}

/** Map from alert style ID → GfmAlertType for template color patching. */
const ALERT_STYLE_ID_TO_TYPE: Record<string, GfmAlertType> = {
  'GitHubNote': 'note',
  'GitHubTip': 'tip',
  'GitHubImportant': 'important',
  'GitHubWarning': 'warning',
  'GitHubCaution': 'caution',
};

/**
 * Patch alert border colors in a template styles.xml string.
 * Finds each GitHubXxx style and replaces the w:left border color with the
 * color from the given scheme, regardless of what scheme the template was
 * originally generated with.  Returns the (potentially mutated) XML string.
 */
export function applyAlertColorsToTemplate(stylesXml: string, scheme: ColorScheme): string {
  const colors = alertColorsByScheme(scheme);
  let xml = stylesXml;

  for (const [styleId, alertType] of Object.entries(ALERT_STYLE_ID_TO_TYPE)) {
    const styleRegex = new RegExp(
      '(<w:style\\b[^>]*\\bw:styleId="' + styleId + '"[^>]*>)([\\s\\S]*?)(</w:style>)'
    );
    const styleMatch = styleRegex.exec(xml);
    if (!styleMatch) continue;

    const openTag = styleMatch[1];
    let innerContent = styleMatch[2];
    const closeTag = styleMatch[3];

    // Replace w:color on the w:left border element
    innerContent = innerContent.replace(
      /(<w:left\b[^>]*\bw:color=")[0-9A-Fa-f]{6}("[^>]*\/>)/,
      (_match, before, after) => before + colors[alertType] + after
    );

    xml = xml.slice(0, styleMatch.index) + openTag + innerContent + closeTag + xml.slice(styleMatch.index + styleMatch[0].length);
  }

  return xml;
}

export function stylesXml(overrides?: FontOverrides, codeBlockConfig?: CodeBlockConfig, colorScheme?: ColorScheme): string {
  const alertColors = alertColorsByScheme(colorScheme ?? getDefaultColorScheme());
  // Helper: build w:rFonts element for a given font name
  function rFonts(font: string): string {
    return '<w:rFonts w:ascii="' + escapeXml(font) + '" w:hAnsi="' + escapeXml(font) + '"/>';
  }

  // Helper: build w:sz + w:szCs elements for a given half-point size
  function szPair(hp: number): string {
    return '<w:sz w:val="' + hp + '"/><w:szCs w:val="' + hp + '"/>';
  }

  // Resolve body font rFonts string (empty if no override)
  const bodyFontStr = overrides?.bodyFont ? rFonts(overrides.bodyFont) : '';
  const codeFontStr = overrides?.codeFont
    ? rFonts(overrides.codeFont)
    : rFonts('Consolas');

  // Normal style: body font + body size (default 22hp)
  const normalSz = overrides?.bodySizeHp
    ? szPair(overrides.bodySizeHp)
    : szPair(22);
  const normalRpr = '<w:rPr>' + bodyFontStr + normalSz + '</w:rPr>\n';

  // Heading helper: per-heading font/style/size overrides with defaults
  function headingRpr(styleId: string, defaultHp: number): string {
    const font = overrides?.headingFonts?.get(styleId)
      ? rFonts(overrides.headingFonts.get(styleId)!)
      : bodyFontStr;
    const sz = overrides?.headingSizesHp?.has(styleId)
      ? szPair(overrides.headingSizesHp.get(styleId)!)
      : szPair(defaultHp);
    const style = overrides?.headingStyles?.get(styleId);
    let styleStr: string;
    if (style === 'normal') {
      styleStr = '';
    } else if (style) {
      styleStr = '';
      if (style.includes('bold')) styleStr += '<w:b/>';
      if (style.includes('italic')) styleStr += '<w:i/>';
      if (style.includes('underline')) styleStr += '<w:u w:val="single"/>';
    } else {
      styleStr = '<w:b/>';
    }
    return '<w:rPr>' + styleStr + font + sz + '</w:rPr>\n';
  }

  // CodeChar: code font only (no size override for character style)
  const isInsetMode = codeBlockConfig?.insetMode ?? false;
  const codeBg = isInsetMode ? undefined : (codeBlockConfig?.background || DEFAULT_CODE_BACKGROUND);
  const codeFontColor = codeBlockConfig?.codeFontColor || (isInsetMode ? undefined : DEFAULT_CODE_COLOR);
  const codeBorderSize = isInsetMode ? undefined : (codeBlockConfig?.codeBlockInset || DEFAULT_CODE_BORDER_SIZE);
  
  let codeCharRprInner = codeFontStr;
  if (codeBg) {
    codeCharRprInner += '<w:shd w:val="clear" w:color="auto" w:fill="' + codeBg + '"/>';
  }
  if (codeFontColor) {
    codeCharRprInner += '<w:color w:val="' + codeFontColor + '"/>';
  }
  const codeCharRpr = '<w:rPr>' + codeCharRprInner + '</w:rPr>\n';

  // CodeBlock: code font + code size (default 20hp)
  const codeBlockSz = overrides?.codeSizeHp
    ? szPair(overrides.codeSizeHp)
    : szPair(DEFAULT_CODE_BLOCK_HP);
  let codeBlockRprInner = codeFontStr + codeBlockSz;
  if (codeFontColor) {
    codeBlockRprInner += '<w:color w:val="' + codeFontColor + '"/>';
  }
  const codeBlockRpr = '<w:rPr>' + codeBlockRprInner + '</w:rPr>\n';

  // Title: title-specific font/size/style overrides, falling back to body font
  const titleFont = overrides?.titleFonts?.[0]
    ? rFonts(overrides.titleFonts[0])
    : bodyFontStr;
  const titleSz = overrides?.titleSizesHp?.[0]
    ? szPair(overrides.titleSizesHp[0])
    : overrides?.headingSizesHp?.has('Title')
      ? szPair(overrides.headingSizesHp.get('Title')!)
      : szPair(56);
  let titleStyleStr = '';
  const titleStyle0 = overrides?.titleStyles?.[0];
  if (titleStyle0 === 'normal') {
    titleStyleStr = '';
  } else if (titleStyle0) {
    if (titleStyle0.includes('bold')) titleStyleStr += '<w:b/>';
    if (titleStyle0.includes('italic')) titleStyleStr += '<w:i/>';
    if (titleStyle0.includes('underline')) titleStyleStr += '<w:u w:val="single"/>';
  }
  const titleRpr = '<w:rPr>' + titleStyleStr + titleFont + titleSz + '</w:rPr>\n';

  // FootnoteText: body font + size from heading map or default 20hp
  const footnoteSz = overrides?.headingSizesHp?.has('FootnoteText')
    ? szPair(overrides.headingSizesHp.get('FootnoteText')!)
    : szPair(20);
  const footnoteRpr = '<w:rPr>' + bodyFontStr + footnoteSz + '</w:rPr>\n';

  // EndnoteText: body font + size from heading map or default 20hp
  const endnoteSz = overrides?.headingSizesHp?.has('EndnoteText')
    ? szPair(overrides.headingSizesHp.get('EndnoteText')!)
    : szPair(20);
  const endnoteRpr = '<w:rPr>' + bodyFontStr + endnoteSz + '</w:rPr>\n';

  // Quote: body font only (no explicit size — inherits from Normal)
  const quoteRpr = bodyFontStr
    ? '<w:rPr>' + bodyFontStr + '</w:rPr>\n'
    : '';

  // IntenseQuote: body font + existing italic/color
  const intenseQuoteRpr = '<w:rPr><w:i/><w:color w:val="4472C4"/>' + bodyFontStr + '</w:rPr>\n';
  function githubAlertStyle(styleId: string, displayName: string, borderColor: string): string {
    return '<w:style w:type="paragraph" w:styleId="' + styleId + '">\n' +
      '<w:name w:val="' + displayName + '"/>\n' +
      '<w:basedOn w:val="Normal"/>\n' +
      '<w:pPr><w:spacing w:before="0" w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/><w:pBdr><w:left w:val="single" w:sz="' + GITHUB_BLOCKQUOTE_BORDER_SIZE + '" w:space="' + GITHUB_BLOCKQUOTE_BORDER_SPACE + '" w:color="' + borderColor + '"/></w:pBdr><w:ind w:left="' + GITHUB_BLOCKQUOTE_INDENT + '"/></w:pPr>\n' +
      (quoteRpr ? quoteRpr : '') +
      '</w:style>\n';
  }

  // CodeBlock pPr: conditional inset vs shading mode
  let codeBlockPPr: string;
  if (isInsetMode) {
    codeBlockPPr = '<w:pPr><w:spacing w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/><w:ind w:left="' + CODE_BLOCK_INSET_TWIPS + '" w:right="' + CODE_BLOCK_INSET_TWIPS + '"/></w:pPr>\n';
  } else {
    codeBlockPPr = '<w:pPr><w:spacing w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="' + codeBg + '"/>' +
      '<w:pBdr>' +
      '<w:top w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '<w:bottom w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '<w:left w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '<w:right w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '</w:pBdr><w:ind w:left="' + CODE_BLOCK_MARGIN_INDENT + '" w:right="' + CODE_BLOCK_MARGIN_INDENT + '"/></w:pPr>\n';
  }

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">\n' +
    '<w:name w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr>\n' +
    normalRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading1">\n' +
    '<w:name w:val="heading 1"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="240" w:after="0"/></w:pPr>\n' +
    headingRpr('Heading1', 32) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading2">\n' +
    '<w:name w:val="heading 2"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="200" w:after="0"/></w:pPr>\n' +
    headingRpr('Heading2', 26) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading3">\n' +
    '<w:name w:val="heading 3"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="200" w:after="0"/></w:pPr>\n' +
    headingRpr('Heading3', 24) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading4">\n' +
    '<w:name w:val="heading 4"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    headingRpr('Heading4', 22) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading5">\n' +
    '<w:name w:val="heading 5"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    headingRpr('Heading5', 20) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading6">\n' +
    '<w:name w:val="heading 6"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    headingRpr('Heading6', 18) +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="Hyperlink">\n' +
    '<w:name w:val="Hyperlink"/>\n' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Quote">\n' +
    '<w:name w:val="Quote"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:ind w:left="720"/></w:pPr>\n' +
    (quoteRpr ? quoteRpr : '') +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="IntenseQuote">\n' +
    '<w:name w:val="Intense Quote"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="4" w:color="4472C4"/></w:pBdr><w:ind w:left="720"/></w:pPr>\n' +
    intenseQuoteRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="GitHub">\n' +
    '<w:name w:val="GitHub Blockquote"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="0" w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/><w:pBdr><w:left w:val="single" w:sz="' + GITHUB_BLOCKQUOTE_BORDER_SIZE + '" w:space="' + GITHUB_BLOCKQUOTE_BORDER_SPACE + '" w:color="' + GITHUB_BLOCKQUOTE_BORDER_COLOR + '"/></w:pBdr><w:ind w:left="' + GITHUB_BLOCKQUOTE_INDENT + '"/></w:pPr>\n' +
    (quoteRpr ? quoteRpr : '') +
    '</w:style>\n' +
    githubAlertStyle('GitHubNote', 'GitHub Note', alertColors.note) +
    githubAlertStyle('GitHubTip', 'GitHub Tip', alertColors.tip) +
    githubAlertStyle('GitHubImportant', 'GitHub Important', alertColors.important) +
    githubAlertStyle('GitHubWarning', 'GitHub Warning', alertColors.warning) +
    githubAlertStyle('GitHubCaution', 'GitHub Caution', alertColors.caution) +
    '<w:style w:type="character" w:styleId="CodeChar">\n' +
    '<w:name w:val="Code Char"/>\n' +
    codeCharRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock">\n' +
    '<w:name w:val="Code Block"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    codeBlockPPr +
    codeBlockRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Title">\n' +
    '<w:name w:val="Title"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="0" w:after="300"/></w:pPr>\n' +
    titleRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="FootnoteText">\n' +
    '<w:name w:val="footnote text"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    footnoteRpr +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="FootnoteReference">\n' +
    '<w:name w:val="footnote reference"/>\n' +
    '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="EndnoteText">\n' +
    '<w:name w:val="endnote text"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    endnoteRpr +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="EndnoteReference">\n' +
    '<w:name w:val="endnote reference"/>\n' +
    '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>\n' +
    '</w:style>\n' +
    // TableParagraph: table-specific font/size style (only when overrides exist)
    (overrides?.tableSizeHp || overrides?.tableFont
      ? '<w:style w:type="paragraph" w:styleId="TableParagraph">\n' +
        '<w:name w:val="Table Paragraph"/>\n' +
        '<w:basedOn w:val="Normal"/>\n' +
        '<w:rPr>' +
        (overrides.tableFont
          ? '<w:rFonts w:ascii="' + escapeXml(overrides.tableFont) + '" w:hAnsi="' + escapeXml(overrides.tableFont) + '"/>'
          : bodyFontStr) +
        (overrides.tableSizeHp ? szPair(overrides.tableSizeHp) : '') +
        '</w:rPr>\n' +
        '</w:style>\n'
      : '') +
    '<w:style w:type="character" w:styleId="CommentReference">\n' +
    '<w:name w:val="annotation reference"/>\n' +
    '<w:basedOn w:val="DefaultParagraphFont"/>\n' +
    '<w:uiPriority w:val="99"/>\n' +
    '<w:semiHidden/>\n' +
    '<w:unhideWhenUsed/>\n' +
    '<w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="CommentText">\n' +
    '<w:name w:val="annotation text"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:uiPriority w:val="99"/>\n' +
    '<w:semiHidden/>\n' +
    '<w:unhideWhenUsed/>\n' +
    '<w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>\n' +
    '<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>\n' +
    '</w:style>\n' +
    '</w:styles>';
}


function numberingXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
    '<w:abstractNum w:abstractNumId="0">\n' +
    '<w:multiLevelType w:val="hybridMultilevel"/>\n' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2880" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="4"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="3600" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="5"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="4320" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="6"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5040" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="7"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5760" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="8"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="6480" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '</w:abstractNum>\n' +
    '<w:abstractNum w:abstractNumId="1">\n' +
    '<w:multiLevelType w:val="hybridMultilevel"/>\n' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%3."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%4."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2880" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="4"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%5."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="3600" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="5"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%6."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="4320" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="6"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%7."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5040" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="7"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%8."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="5760" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '<w:lvl w:ilvl="8"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%9."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="6480" w:hanging="360"/></w:pPr></w:lvl>\n' +
    '</w:abstractNum>\n' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>\n' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>\n' +
    '</w:numbering>';
}

function settingsXml(hasFootnotes?: boolean, hasEndnotes?: boolean, hasThreadedComments?: boolean): string {
  const ignorable = hasThreadedComments ? 'w14 w15 w16se w16cid w16 w16cex w16sdtdh w16du' : 'w14 w15';
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="' + ignorable + '">\n' +
    '<w:compat>\n' +
    '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>\n' +
    '</w:compat>\n' +
    '<w:defaultTabStop w:val="720"/>\n' +
    '<w:characterSpacingControl w:val="doNotCompress"/>\n';
  if (hasFootnotes) {
    xml += '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>\n';
  }
  if (hasEndnotes) {
    xml += '<w:endnotePr><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>\n';
  }
  // OneDrive co-authoring compatibility: w14:docId (Word 2010 document identifier)
  // and w15:docId (Word 2013 GUID-based document identifier) MUST be present.
  //
  // Without these, OneDrive's server-side processor treats the file as a legacy
  // document and "upgrades" it for co-authoring — which reassigns all w14:paraId
  // values and strips w15:paraIdParent from commentsExtended.xml, destroying
  // comment threading.  webSettings.xml (registered separately) is also required
  // as part of this minimum viable set.
  //
  // Discovery: raw extension output had correct threading, but OneDrive silently
  // rewrote the file before Word could open it.  Quitting OneDrive made the same
  // file open correctly.  Adding docId + webSettings prevents the rewrite.
  const hexId = Math.floor(Math.random() * 0x7FFFFFFF).toString(16).toUpperCase().padStart(8, '0');
  xml += '<w14:docId w14:val="' + hexId + '"/>\n';
  xml += '<w15:docId w15:val="{' + crypto.randomUUID().toUpperCase() + '}"/>\n';
  xml += '</w:settings>';
  return xml;
}

/**
 * Minimal webSettings.xml — part of the OneDrive co-authoring compatibility set.
 * Together with w14:docId and w15:docId in settings.xml, this prevents OneDrive
 * from "upgrading" the file and stripping comment threading metadata.
 * See the extended comment in settingsXml() for the full explanation.
 */
function webSettingsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n' +
    '<w:optimizeForBrowser/>\n' +
    '</w:webSettings>';
}

function fontTableXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n' +
    '<w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>\n' +
    '<w:font w:name="Times New Roman"><w:panose1 w:val="02020603050405020304"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>\n' +
    '<w:font w:name="Consolas"><w:panose1 w:val="02070309020205020404"/><w:charset w:val="00"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>\n' +
    '</w:fonts>';
}

function corePropsXml(author?: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
  if (author && author.trim()) {
    xml += '<dc:creator>' + escapeXml(author) + '</dc:creator>\n';
  }
  xml += '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>\n' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>\n' +
    '</cp:coreProperties>';
  return xml;
}

function appPropsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">\n' +
    '<Application>Manuscript Markup</Application>\n' +
    '</Properties>';
}
interface CustomPropEntry {
  name: string;
  value: string;
}

/** Chunk a string value into numbered custom properties: PREFIX_1, PREFIX_2, … */
function chunkCustomProps(prefix: string, data: string, chunkSize = 240): CustomPropEntry[] {
  const props: CustomPropEntry[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    props.push({
      name: prefix + (props.length + 1),
      value: data.slice(i, i + chunkSize),
    });
  }
  return props;
}

function customPropsXml(properties: CustomPropEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n';
  for (let i = 0; i < properties.length; i++) {
    const pid = i + 2; // fmtid starts at pid=2 per OOXML convention
    xml += '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + pid + '" name="' + escapeXml(properties[i].name) + '">';
    xml += '<vt:lpwstr>' + escapeXml(properties[i].value) + '</vt:lpwstr>';
    xml += '</property>\n';
  }
  xml += '</Properties>';
  return xml;
}

function zoteroCustomProps(fm: Frontmatter): CustomPropEntry[] {
  const styleId = zoteroStyleFullId(fm.csl || '');
  const prefData = JSON.stringify({
    dataVersion: 4,
    zoteroVersion: '6.0',
    style: {
      styleID: styleId,
      locale: fm.locale || 'en-US',
      hasBibliography: true,
      bibliographyStyleHasBeenSet: true,
    },
    prefs: {
      fieldType: 'Field',
      noteType: fm.zoteroNotes ? noteTypeToNumber(fm.zoteroNotes) : 0,
    },
  });

  // Chunk the pref string into ZOTERO_PREF_1, ZOTERO_PREF_2, etc. (max 240 chars each)
  const CHUNK_SIZE = 240;
  const props: CustomPropEntry[] = [];
  for (let i = 0; i < prefData.length; i += CHUNK_SIZE) {
    props.push({
      name: 'ZOTERO_PREF_' + (props.length + 1),
      value: prefData.slice(i, i + CHUNK_SIZE),
    });
  }
  return props;
}

function commentIdMappingProps(commentIdMap: Map<string, number>): CustomPropEntry[] {
  if (commentIdMap.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [mdId, numericId] of commentIdMap) {
    mapping[String(numericId)] = mdId;
  }
  return chunkCustomProps('MANUSCRIPT_COMMENT_IDS_', JSON.stringify(mapping));
}

function footnoteIdMappingProps(footnoteLabelToId: Map<string, number>): CustomPropEntry[] {
  if (footnoteLabelToId.size === 0) return [];
  // Only store mapping if any label is non-numeric (named labels)
  let hasNamedLabel = false;
  for (const label of footnoteLabelToId.keys()) {
    if (!/^\d+$/.test(label)) {
      hasNamedLabel = true;
      break;
    }
  }
  if (!hasNamedLabel) return [];

  const mapping: Record<string, string> = {};
  for (const [label, numericId] of footnoteLabelToId) {
    mapping[String(numericId)] = label;
  }
  return chunkCustomProps('MANUSCRIPT_FOOTNOTE_IDS_', JSON.stringify(mapping));
}

function codeBlockLanguageProps(codeBlockLanguages: Map<number, string>): CustomPropEntry[] {
  if (codeBlockLanguages.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [index, language] of codeBlockLanguages) {
    mapping[String(index)] = language;
  }
  return chunkCustomProps('MANUSCRIPT_CODE_BLOCK_LANGS_', JSON.stringify(mapping));
}

function codeBlockStylingProps(fm: Frontmatter): CustomPropEntry[] {
  const obj: Record<string, string> = {};
  if (fm.codeBackgroundColor) obj.bg = fm.codeBackgroundColor;
  if (fm.codeFontColor) obj.fc = fm.codeFontColor;
  if (fm.codeBlockInset !== undefined) obj.inset = String(fm.codeBlockInset);
  if (Object.keys(obj).length === 0) return [];
  return [{ name: 'MANUSCRIPT_CODE_BLOCK_STYLING', value: JSON.stringify(obj) }];
}

function pipeTableMaxLineWidthProps(fm: Frontmatter): CustomPropEntry[] {
  if (fm.pipeTableMaxLineWidth === undefined) return [];
  return [{ name: 'MANUSCRIPT_PIPE_TABLE_MAX_LINE_WIDTH', value: String(fm.pipeTableMaxLineWidth) }];
}

function listIndentProps(state: DocxGenState): CustomPropEntry[] {
  if (state.listIndent === 'tab') {
    return [{ name: 'MANUSCRIPT_LIST_INDENT', value: 'tab' }];
  }
  return [];
}

function consecutiveReplyProps(state: DocxGenState): CustomPropEntry[] {
  if (state.consecutiveReplyParaIds.size === 0) return [];
  return [{ name: 'MANUSCRIPT_CONSECUTIVE_REPLY_COMMENTS', value: [...state.consecutiveReplyParaIds].join(',') }];
}

function frontmatterBlankLineProps(count: number): CustomPropEntry[] {
  if (count < 0) return []; // no frontmatter
  return [{ name: 'MANUSCRIPT_FRONTMATTER_BLANK_LINES', value: String(count) }];
}

function bibKeyOrderProps(bibEntries: Map<string, BibtexEntry> | undefined): CustomPropEntry[] {
  if (!bibEntries || bibEntries.size === 0) return [];
  return chunkCustomProps('MANUSCRIPT_BIB_KEY_ORDER_', [...bibEntries.keys()].join(','));
}

function bibDataProps(bibtex: string | undefined): CustomPropEntry[] {
  if (!bibtex || bibtex.trim().length === 0) return [];
  // Larger chunk size: .bib data can be 10–50+ KB (vs 240 for small metadata).
  return chunkCustomProps('MANUSCRIPT_BIB_DATA_', bibtex, 4000);
}

/** Assign sequential htmlCommentIndex to each HTML comment token and return
 *  a map from index → blankLinesBefore count (only for non-default values). */
export function annotateHtmlCommentIndices(tokens: MdToken[]): Map<number, number> {
  const gaps = new Map<number, number>();
  let idx = 0;
  for (const token of tokens) {
    const isHtmlComment = token.type === 'paragraph'
      && token.runs.length === 1
      && token.runs[0].type === 'html_comment';
    if (isHtmlComment) {
      token.htmlCommentIndex = idx;
      if (token.blankLinesBefore !== undefined && token.blankLinesBefore !== 1) {
        gaps.set(idx, token.blankLinesBefore);
      }
      idx++;
    }
  }
  return gaps;
}

function htmlCommentGapProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_HTML_COMMENT_GAPS_', JSON.stringify(mapping));
}

interface DocumentRelsOptions {
  relationships: Map<string, string>;
  hasList: boolean;
  hasComments: boolean;
  hasTheme?: boolean;
  hasFootnotes?: boolean;
  hasEndnotes?: boolean;
  hasCommentsExtended?: boolean;
  hasCommentsIds?: boolean;
  hasCommentsExtensible?: boolean;
  hasPeople?: boolean;
  imageRelationships?: Map<string, { rId: string; mediaPath: string }>;
}

function documentRelsXml(opts: DocumentRelsOptions): string {
  const { relationships, hasList, hasComments, hasTheme, hasFootnotes, hasEndnotes, hasCommentsExtended, hasCommentsIds, hasCommentsExtensible, hasPeople, imageRelationships } = opts;
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  xml += '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n';

  if (hasList) {
    xml += '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>\n';
  }

  if (hasComments) {
    xml += '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>\n';
  }

  let nextFixed = 4;
  if (hasFootnotes) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>\n';
    nextFixed++;
  }
  if (hasEndnotes) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>\n';
    nextFixed++;
  }
  if (hasCommentsExtended) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>\n';
    nextFixed++;
  }
  if (hasCommentsIds) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"/>\n';
    nextFixed++;
  }
  if (hasCommentsExtensible) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible" Target="commentsExtensible.xml"/>\n';
    nextFixed++;
  }
  if (hasPeople) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>\n';
    nextFixed++;
  }
  if (hasTheme) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>\n';
    nextFixed++;
  }
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>\n';
  nextFixed++;
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings" Target="webSettings.xml"/>\n';
  nextFixed++;
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>\n';

  for (const [url, relId] of relationships) {
    xml += '<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + escapeXml(url) + '" TargetMode="External"/>\n';
  }

  if (imageRelationships) {
    for (const [, entry] of imageRelationships) {
      xml += '<Relationship Id="' + entry.rId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + entry.mediaPath + '"/>\n';
    }
  }

  xml += '</Relationships>';
  return xml;
}

export function generateRPr(run: MdRun, extraRPr?: string): string {
  const parts: string[] = [];

  if (run.code) parts.push('<w:rStyle w:val="CodeChar"/>');
  if (run.bold) parts.push('<w:b/>');
  if (run.italic) parts.push('<w:i/>');
  if (run.strikethrough) parts.push('<w:strike/>');
  if (run.underline) parts.push('<w:u w:val="single"/>');
  if (run.highlight) {
    const color = COLOR_TO_OOXML[run.highlightColor || 'yellow'] || 'yellow';
    parts.push('<w:highlight w:val="' + color + '"/>');
  }
  if (run.superscript) parts.push('<w:vertAlign w:val="superscript"/>');
  else if (run.subscript) parts.push('<w:vertAlign w:val="subscript"/>');
  if (extraRPr) parts.push(extraRPr);

  return parts.length > 0 ? '<w:rPr>' + parts.join('') + '</w:rPr>' : '';
}

export function generateRun(text: string, rPr: string): string {
  return '<w:r>' + rPr + '<w:t xml:space="preserve">' + escapeXml(text) + '</w:t></w:r>';
}

function generateHiddenHtmlCommentRun(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  let xml = '<w:r><w:rPr><w:vanish/></w:rPr>';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      xml += '<w:br/>';
    }
    const line = lines[i];
    if (i === 0) {
      xml += '<w:t xml:space="preserve">' + '\u200B' + escapeXml(line) + '</w:t>';
    } else if (line.length > 0) {
      xml += '<w:t xml:space="preserve">' + escapeXml(line) + '</w:t>';
    }
  }
  xml += '</w:r>';
  return xml;
}

function mergeRunFormatting(inner: MdRun, outer: MdRun, forced: Partial<MdRun> = {}): MdRun {
  const merged: MdRun = { ...inner, type: 'text', text: inner.text };

  merged.code = inner.code || outer.code || forced.code ? true : undefined;
  merged.bold = inner.bold || outer.bold || forced.bold ? true : undefined;
  merged.italic = inner.italic || outer.italic || forced.italic ? true : undefined;
  merged.underline = inner.underline || outer.underline || forced.underline ? true : undefined;
  merged.strikethrough = inner.strikethrough || outer.strikethrough || forced.strikethrough ? true : undefined;
  merged.superscript = inner.superscript || outer.superscript || forced.superscript ? true : undefined;
  merged.subscript = inner.subscript || outer.subscript || forced.subscript ? true : undefined;

  const hasHighlight = !!inner.highlight || !!outer.highlight || !!forced.highlight;
  merged.highlight = hasHighlight ? true : undefined;
  merged.highlightColor = hasHighlight
    ? (inner.highlightColor || outer.highlightColor || forced.highlightColor)
    : undefined;

  merged.href = inner.href || outer.href || forced.href;
  return merged;
}

function formatCriticInnerRuns(runs: MdRun[] | undefined, outer: MdRun, forced: Partial<MdRun> = {}): MdRun[] | undefined {
  if (!runs || runs.length === 0) return undefined;
  const formatted: MdRun[] = [];
  for (const run of runs) {
    if (run.type === 'softbreak') {
      formatted.push(run);
      continue;
    }
    if (run.type === 'math') {
      formatted.push(run);
      continue;
    }
    if (run.type === 'critic_add' || run.type === 'critic_del' || run.type === 'critic_sub' || run.type === 'critic_comment' || run.type === 'critic_highlight') {
      const updated = { ...run };
      if (updated.innerRuns) updated.innerRuns = formatCriticInnerRuns(updated.innerRuns, outer, forced);
      if (updated.oldRuns) updated.oldRuns = formatCriticInnerRuns(updated.oldRuns, outer, forced);
      if (updated.newRuns) updated.newRuns = formatCriticInnerRuns(updated.newRuns, outer, forced);
      formatted.push(updated);
      continue;
    }
    if (run.type !== 'text') continue;
    formatted.push(mergeRunFormatting(run, outer, forced));
  }
  return formatted;
}

function generateInlineCriticContent(
  runs: MdRun[] | undefined,
  fallbackText: string,
  outer: MdRun,
  state: DocxGenState,
  options?: MdToDocxOptions,
  bibEntries?: Map<string, BibtexEntry>,
  citeprocEngine?: any,
  forced: Partial<MdRun> = {}
): string {
  const formattedRuns = formatCriticInnerRuns(runs, outer, forced);
  if (formattedRuns && formattedRuns.length > 0) {
    return generateRuns(formattedRuns, state, options, bibEntries, citeprocEngine);
  }
  const fallbackRun = mergeRunFormatting({ type: 'text', text: fallbackText }, outer, forced);
  return generateRun(fallbackText, generateRPr(fallbackRun, state.tableRunRPrExtra || undefined));
}

function generateDeletedCriticContent(
  runs: MdRun[] | undefined,
  fallbackText: string,
  outer: MdRun,
  forced: Partial<MdRun> = {},
  extraRPr?: string
): string {
  const formattedRuns = formatCriticInnerRuns(runs, outer, forced);
  if (!formattedRuns || formattedRuns.length === 0) {
    const fallbackRun = mergeRunFormatting({ type: 'text', text: fallbackText }, outer, forced);
    const rPr = generateRPr(fallbackRun, extraRPr);
    return '<w:r>' + (rPr ? rPr : '') + '<w:delText xml:space="preserve">' + escapeXml(fallbackText) + '</w:delText></w:r>';
  }

  let xml = '';
  for (const run of formattedRuns) {
    if (run.type === 'softbreak') {
      xml += '<w:r><w:br/></w:r>';
      continue;
    }
    if (run.type === 'math') {
      xml += generateMathXml(run.text, !!run.display);
      continue;
    }
    if (run.type === 'critic_add' || run.type === 'critic_del') {
      xml += generateDeletedCriticContent(run.innerRuns, run.text, run, {}, extraRPr);
      continue;
    }
    if (run.type === 'critic_sub') {
      xml += generateDeletedCriticContent(run.oldRuns, run.text, run, {}, extraRPr);
      if (run.newText) xml += generateDeletedCriticContent(run.newRuns, run.newText, run, {}, extraRPr);
      continue;
    }
    if (run.type === 'critic_highlight' || run.type === 'critic_comment') {
      if (run.type === 'critic_highlight' && run.text) {
        xml += generateDeletedCriticContent(run.innerRuns, run.text, run, {}, extraRPr);
      }
      continue;
    }
    if (run.type !== 'text' || !run.text) continue;
    const rPr = generateRPr(run, extraRPr);
    xml += '<w:r>' + (rPr ? rPr : '') + '<w:delText xml:space="preserve">' + escapeXml(run.text) + '</w:delText></w:r>';
  }
  return xml;
}

export function generateRuns(inputRuns: MdRun[], state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any): string {
  let xml = '';
  for (let ri = 0; ri < inputRuns.length; ri++) {
    const run = inputRuns[ri];
    const nextRun = inputRuns[ri + 1];
    if (run.type === 'text') {
      const rPr = generateRPr(run, state.tableRunRPrExtra || undefined);
      if (run.href) {
        let rId = state.relationships.get(run.href);
        if (!rId) {
          rId = 'rId' + (state.nextRId + state.rIdOffset);
          state.relationships.set(run.href, rId);
          state.nextRId++;
        }
        xml += '<w:hyperlink r:id="' + rId + '">' + generateRun(run.text, rPr) + '</w:hyperlink>';
      } else {
        xml += generateRun(run.text, rPr);
      }
    } else if (run.type === 'softbreak') {
      xml += '<w:r><w:br/></w:r>';
    } else if (run.type === 'critic_add') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const dateAttr = date ? ' w:date="' + escapeXml(date) + '"' : '';
      const contentXml = generateInlineCriticContent(run.innerRuns, run.text, run, state, options, bibEntries, citeprocEngine);
      xml += '<w:ins w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '"' + dateAttr + '>' + contentXml + '</w:ins>';
    } else if (run.type === 'critic_del') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const dateAttr = date ? ' w:date="' + escapeXml(date) + '"' : '';
      const deletedXml = generateDeletedCriticContent(run.innerRuns, run.text, run, {}, state.tableRunRPrExtra || undefined);
      xml += '<w:del w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '"' + dateAttr + '>' + deletedXml + '</w:del>';
    } else if (run.type === 'critic_sub') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const dateAttr = date ? ' w:date="' + escapeXml(date) + '"' : '';
      const deletedXml = generateDeletedCriticContent(run.oldRuns, run.text, run, {}, state.tableRunRPrExtra || undefined);
      const insertedXml = generateInlineCriticContent(run.newRuns, run.newText || '', run, state, options, bibEntries, citeprocEngine);
      xml += '<w:del w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '"' + dateAttr + '>' + deletedXml + '</w:del>';
      xml += '<w:ins w:id="' + (state.commentId++) + '" w:author="' + escapeXml(author) + '"' + dateAttr + '>' + insertedXml + '</w:ins>';
    } else if (run.type === 'critic_highlight') {
      if (nextRun?.type === 'critic_comment') {
        const commentId = state.commentId++;
        const author = nextRun.author ?? '';
        const date = normalizeToUtcIso(nextRun.date || '', state.timezone);
        const commentBody = nextRun.commentText || '';
        const parentParaId = generateParaId(state);
        state.comments.push({ id: commentId, author, date, text: commentBody, paraId: parentParaId });
        state.hasComments = true;
        // Store allocated reply IDs so anchor generation uses exact IDs
        // (not commentId+1 which could drift if generateInlineCriticContent
        // allocates intervening IDs for track-change revisions).
        const nestedReplyIds: number[] = [];
        if (nextRun.replies && nextRun.replies.length > 0) {
          for (const reply of nextRun.replies) {
            const replyId = state.commentId++;
            nestedReplyIds.push(replyId);
            const replyParaId = generateParaId(state);
            const replyAuthor = reply.author ?? '';
            const replyDate = normalizeToUtcIso(reply.date || '', state.timezone);
            state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: reply.text, paraId: replyParaId, parentParaId });
          }
        }
        // Collect consecutive-reply IDs before emitting XML so all
        // rangeStarts can be grouped together (overlapping the parent range).
        ri++;
        const consecutiveReplyIds: number[] = [];
        let absorbedConsecutiveReply = false;
        while (ri + 1 < inputRuns.length && inputRuns[ri + 1].type === 'critic_comment') {
          const replyRun = inputRuns[ri + 1];
          const replyId = state.commentId++;
          consecutiveReplyIds.push(replyId);
          const replyParaId = generateParaId(state);
          const replyAuthor = replyRun.author ?? '';
          const replyDate = normalizeToUtcIso(replyRun.date || '', state.timezone);
          state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: replyRun.commentText || '', paraId: replyParaId, parentParaId });
          // Preserve reply-on-reply blocks for consecutive replies instead of
          // dropping them; these are emitted as child comments of this reply.
          if (replyRun.replies && replyRun.replies.length > 0) {
            for (const nestedReply of replyRun.replies) {
              const nestedReplyId = state.commentId++;
              consecutiveReplyIds.push(nestedReplyId);
              const nestedReplyParaId = generateParaId(state);
              const nestedReplyAuthor = nestedReply.author ?? '';
              const nestedReplyDate = normalizeToUtcIso(nestedReply.date || '', state.timezone);
              state.comments.push({
                id: nestedReplyId,
                author: nestedReplyAuthor,
                date: nestedReplyDate,
                text: nestedReply.text,
                paraId: nestedReplyParaId,
                parentParaId: replyParaId
              });
            }
          }
          absorbedConsecutiveReply = true;
          ri++;
        }
        if (absorbedConsecutiveReply) {
          state.consecutiveReplyParaIds.add(parentParaId);
        }
        const allReplyIds = [...nestedReplyIds, ...consecutiveReplyIds];
        // Word requires reply ranges to overlap with the parent range for
        // proper threading display — open all ranges together, then close
        // parent first followed by replies (matching real Word output).
        xml += '<w:commentRangeStart w:id=\"' + commentId + '\"/>';
        for (const rid of allReplyIds) {
          xml += '<w:commentRangeStart w:id=\"' + rid + '\"/>';
        }
        xml += generateInlineCriticContent(
          run.innerRuns,
          run.text,
          run,
          state,
          options,
          bibEntries,
          citeprocEngine,
          run.highlight ? { highlight: true, highlightColor: run.highlightColor } : {}
        );
        xml += '<w:commentRangeEnd w:id=\"' + commentId + '\"/>';
        xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + commentId + '\"/></w:r>';
        for (const rid of allReplyIds) {
          xml += '<w:commentRangeEnd w:id=\"' + rid + '\"/>';
          xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + rid + '\"/></w:r>';
        }
      } else {
        xml += generateInlineCriticContent(
          run.innerRuns,
          run.text,
          run,
          state,
          options,
          bibEntries,
          citeprocEngine,
          { highlight: true, highlightColor: run.highlightColor }
        );
      }
    } else if (run.type === 'critic_comment') {
      const commentId = state.commentId++;
      const author = run.author ?? '';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const commentBody = run.commentText || '';
      const parentParaId = generateParaId(state);

      state.comments.push({ id: commentId, author, date, text: commentBody, paraId: parentParaId });
      state.hasComments = true;

      // Generate reply entries — store allocated IDs for anchor generation
      const standaloneReplyIds: number[] = [];
      if (run.replies && run.replies.length > 0) {
        for (const reply of run.replies) {
          const replyId = state.commentId++;
          standaloneReplyIds.push(replyId);
          const replyParaId = generateParaId(state);
          const replyAuthor = reply.author ?? '';
          const replyDate = normalizeToUtcIso(reply.date || '', state.timezone);
          state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: reply.text, paraId: replyParaId, parentParaId });
        }
      }

      // Open all ranges together so replies overlap with the parent range
      xml += '<w:commentRangeStart w:id=\"' + commentId + '\"/>';
      for (const rid of standaloneReplyIds) {
        xml += '<w:commentRangeStart w:id=\"' + rid + '\"/>';
      }
      if (run.text) {
        xml += generateInlineCriticContent(
          run.innerRuns,
          run.text,
          run,
          state,
          options,
          bibEntries,
          citeprocEngine,
          run.highlight ? { highlight: true, highlightColor: run.highlightColor } : {}
        );
      }
      xml += '<w:commentRangeEnd w:id=\"' + commentId + '\"/>';
      xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + commentId + '\"/></w:r>';
      for (const rid of standaloneReplyIds) {
        xml += '<w:commentRangeEnd w:id=\"' + rid + '\"/>';
        xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + rid + '\"/></w:r>';
      }
    } else if (run.type === 'footnote_ref') {
      const label = run.footnoteLabel || '';
      let noteId = state.footnoteLabelToId.get(label);
      if (noteId === undefined) {
        noteId = state.footnoteId++;
        state.footnoteLabelToId.set(label, noteId);
      }
      const noteExtraRPr = state.tableRunRPrExtra || '';
      if (state.notesMode === 'endnotes') {
        xml += '<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/>' + noteExtraRPr + '</w:rPr><w:endnoteReference w:id="' + noteId + '"/></w:r>';
        state.hasEndnotes = true;
      } else {
        xml += '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/>' + noteExtraRPr + '</w:rPr><w:footnoteReference w:id="' + noteId + '"/></w:r>';
        state.hasFootnotes = true;
      }
    } else if (run.type === 'citation') {
      const result = generateCitation(run, bibEntries || new Map(), citeprocEngine, state.citationIds, state.citationItemIds, state.tableRunRPrExtra || undefined);
      xml += result.xml;
      if (result.warning) state.warnings.push(result.warning);
      if (result.missingKeys) {
        for (const k of result.missingKeys) state.missingKeys.add(k);
      }
      if (run.keys && bibEntries) {
        for (const k of run.keys) {
          if (bibEntries.has(k)) state.citedKeys.add(k);
        }
      }
    } else if (run.type === 'math') {
      xml += generateMathXml(run.text, !!run.display);
    } else if (run.type === 'comment_range_start') {
      const mdId = run.commentId || '';
      let numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        numericId = state.commentId++;
        state.commentIdMap.set(mdId, numericId);
      }
      xml += '<w:commentRangeStart w:id="' + numericId + '"/>';
      const replyRanges = state.replyRanges.filter(rr => rr.parentId === numericId);
      for (const reply of replyRanges) {
        xml += '<w:commentRangeStart w:id=\"' + reply.replyId + '\"/>';
      }
      state.hasComments = true;
    } else if (run.type === 'comment_range_end') {
      const mdId = run.commentId || '';
      const numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        state.warnings.push(`Unmatched comment range end marker: {/${mdId}}`);
        continue;
      }
      xml += '<w:commentRangeEnd w:id="' + numericId + '"/>';
      xml += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + numericId + '"/></w:r>';
      const replyRanges = state.replyRanges.filter(rr => rr.parentId === numericId);
      for (const reply of replyRanges) {
        xml += '<w:commentRangeEnd w:id=\"' + reply.replyId + '\"/>';
        xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + reply.replyId + '\"/></w:r>';
      }
    } else if (run.type === 'comment_body_with_id') {
      const mdId = run.commentId || '';
      const numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        state.warnings.push(`Comment body {#${mdId}>>...<<} has no matching range markers {#${mdId}}...{/${mdId}}`);
        continue;
      }
      // Only emit the comment entry once per ID (multi-paragraph comments
      // may produce duplicate body markers in the markdown).
      if (!state.comments.some(c => c.id === numericId)) {
        const author = run.author ?? '';
        const date = normalizeToUtcIso(run.date || '', state.timezone);
        const commentBody = run.commentText || '';
        const parentParaId = generateParaId(state);
        state.comments.push({ id: numericId, author, date, text: commentBody, paraId: parentParaId });

        // Generate reply comment entries (reply IDs may have been
        // pre-allocated by the pre-scan in generateDocumentXml)
        if (run.replies && run.replies.length > 0) {
          const preAllocated = state.replyRanges.filter(rr => rr.parentId === numericId);
          for (let i = 0; i < run.replies.length; i++) {
            const reply = run.replies[i];
            const replyId = i < preAllocated.length ? preAllocated[i].replyId : state.commentId++;
            const replyParaId = generateParaId(state);
            const replyAuthor = reply.author ?? '';
            const replyDate = normalizeToUtcIso(reply.date || '', state.timezone);
            state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: reply.text, paraId: replyParaId, parentParaId });
            if (i >= preAllocated.length) {
              state.replyRanges.push({ replyId, parentId: numericId });
            }
          }
        }
      }
      state.hasComments = true;
    } else if (run.type === 'html_comment') {
      xml += generateHiddenHtmlCommentRun(run.text);
    } else if (run.type === 'image') {
      const src = run.imageSrc || '';
      const alt = run.imageAlt || '';
      const syntax = run.imageSyntax || 'md';
      // Detect unsupported URL/data URI sources
      if (/^(https?:|data:)/i.test(src)) {
        state.warnings.push('Image "' + src.slice(0, 80) + '" is a URL or data URI; only local file paths are supported');
        continue;
      }
      const srcBase = src.split('?')[0].split('#')[0];
      const ext = srcBase.split('.').pop()?.toLowerCase() || '';
      if (!isSupportedImageFormat(ext)) {
        state.warnings.push(IMAGE_WARNINGS.unsupportedFormat(ext, src));
        continue;
      }
      // Resolve file path
      const absPath = options?.sourceDir ? resolve(options.sourceDir, src) : resolve(src);
      // Check deduplication: same file + same syntax reuses the same rId
      const dedupeKey = absPath + '\0' + syntax;
      let imgEntry = state.imageRelationships.get(dedupeKey);
      if (!imgEntry) {
        // Check if media binary already loaded (different syntax, same file)
        let mediaPath = state.imageMediaPaths.get(absPath);
        if (!mediaPath) {
          // Read file
          let fileData: Uint8Array;
          try {
            fileData = new Uint8Array(readFileSync(absPath));
          } catch (err: any) {
            if (err?.code === 'ENOENT') {
              state.warnings.push(IMAGE_WARNINGS.notFound(src));
            } else {
              state.warnings.push(IMAGE_WARNINGS.readError(src, err?.message || String(err)));
            }
            continue;
          }
          const mediaFilename = 'image' + state.imageMediaPaths.size + '.' + ext;
          mediaPath = 'media/' + mediaFilename;
          state.imageMediaPaths.set(absPath, mediaPath);
          state.imageBinaries.set(mediaPath, fileData);
          state.imageExtensions.add(ext);
        }
        const rId = 'rId' + (state.nextRId + state.rIdOffset);
        state.nextRId++;
        imgEntry = { rId, mediaPath };
        state.imageRelationships.set(dedupeKey, imgEntry);
        state.imageFormats.set(rId, syntax);
      }
      // Determine dimensions
      let width = run.imageWidth;
      let height = run.imageHeight;
      if (!width || !height) {
        const data = state.imageBinaries.get(imgEntry.mediaPath);
        if (data) {
          const intrinsic = readImageDimensions(data, ext);
          if (intrinsic) {
            const dims = computeMissingDimension({ width, height }, intrinsic);
            width = dims.width;
            height = dims.height;
          } else {
            if (!width) width = 100;
            if (!height) height = 100;
            state.warnings.push(IMAGE_WARNINGS.defaultDimensions(src));
          }
        } else {
          if (!width) width = 100;
          if (!height) height = 100;
        }
      }
      const cx = pixelsToEmu(width);
      const cy = pixelsToEmu(height);
      const docPrId = state.nextImageDocPrId++;
      const filename = basename(src);
      xml += '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        + '<wp:extent cx="' + cx + '" cy="' + cy + '"/>'
        + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        + '<wp:docPr id="' + docPrId + '" name="' + escapeXml(filename) + '" descr="' + escapeXml(alt) + '"/>'
        + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:nvPicPr><pic:cNvPr id="' + docPrId + '" name="' + escapeXml(filename) + '"/><pic:cNvPicPr/></pic:nvPicPr>'
        + '<pic:blipFill><a:blip r:embed="' + imgEntry.rId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        + '</pic:pic></a:graphicData></a:graphic>'
        + '</wp:inline></w:drawing></w:r>';
    }
  }
  return xml;
}

export function generateParagraph(token: MdToken, state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any): string {
  let pPr = '';
  
  switch (token.type) {
    case 'heading':
      pPr = '<w:pPr><w:pStyle w:val="Heading' + (token.level || 1) + '"/></w:pPr>';
      break;
    case 'list_item':
      if (token.taskChecked !== undefined) {
        const leftIndent = 720 * (token.level || 1);
        pPr = '<w:pPr><w:ind w:left="' + leftIndent + '" w:hanging="360"/></w:pPr>';
      } else {
        const numId = token.ordered ? '2' : '1';
        const ilvl = (token.level || 1) - 1;
        pPr = '<w:pPr><w:numPr><w:ilvl w:val="' + ilvl + '"/><w:numId w:val="' + numId + '"/></w:numPr></w:pPr>';
        state.hasList = true;
      }
      break;
    case 'blockquote': {
      const bqStyle = token.alertType ? ALERT_STYLE_BY_TYPE[token.alertType] : (options?.blockquoteStyle ?? 'GitHub');
      const bqIndentUnit = bqStyle.startsWith('GitHub') ? GITHUB_BLOCKQUOTE_INDENT : 720;
      const bqLeftIndent = bqIndentUnit * (token.level || 1);
      const bqSpacing = '<w:spacing w:before="0" w:after="0"/>';
      pPr = '<w:pPr><w:pStyle w:val="' + bqStyle + '"/>' + bqSpacing + '<w:ind w:left="' + bqLeftIndent + '"/></w:pPr>';
      break;
    }
    case 'code_block':
      pPr = '<w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>';
      if (token.language) {
        state.codeBlockLanguages.set(state.codeBlockIndex, token.language);
      }
      state.codeBlockIndex++;
      break;
    case 'hr':
      pPr = '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr>';
      break;
  }
  
  if (token.type === 'code_block') {
    const lines = (token.runs[0]?.text || '').replace(/\n$/, '').split('\n');
    const rpr = '<w:rPr><w:rFonts w:ascii="' + escapeXml(state.codeFont) + '" w:hAnsi="' + escapeXml(state.codeFont) + '"/></w:rPr>';
    if (state.codeShadingMode) {
      return lines.map((line) => '<w:p>' + pPr + generateRun(line, rpr) + '</w:p>').join('');
    }
    const inset = CODE_BLOCK_INSET_TWIPS;
    return lines.map((line, i) => {
      let linePPr = pPr;
      if (lines.length === 1) {
        linePPr = '<w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="' + inset + '" w:after="' + inset + '" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/></w:pPr>';
      } else if (i === 0) {
        linePPr = '<w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="' + inset + '" w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/></w:pPr>';
      } else if (i === lines.length - 1) {
        linePPr = '<w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="0" w:after="' + inset + '" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/></w:pPr>';
      }
      return '<w:p>' + linePPr + generateRun(line, rpr) + '</w:p>';
    }).join('');
  }
  
  if (token.type === 'hr') {
    return '<w:p>' + pPr + '</w:p>';
  }
  
  const alertColorMap = alertColorsByScheme(options?.colors ?? getDefaultColorScheme());
  const runs = generateRuns(token.runs, state, options, bibEntries, citeprocEngine);
  const taskPrefix = token.type === 'list_item' && token.taskChecked !== undefined
    ? generateRun(token.taskChecked ? '☒ ' : '☐ ', '')
    : '';
  const alertPrefix = token.type === 'blockquote' && token.alertType && token.alertLead
    ? generateRun(ALERT_GLYPH_BY_TYPE[token.alertType] + ' ' + gfmAlertTitle(token.alertType) + ' ', '<w:rPr><w:b/><w:color w:val="' + alertColorMap[token.alertType] + '"/></w:rPr>')
    : '';

  let xml = '<w:p>' + pPr + alertPrefix + taskPrefix + runs + '</w:p>';

  // Encode blockquoteGroupIndex as a hidden (vanish) run so the docx→md
  // converter can reconstruct group boundaries and correlate with the gap map.
  if (token.type === 'blockquote' && token.blockquoteGroupIndex !== undefined) {
    const groupTag = '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">' +
      '\u200B_bqg' + token.blockquoteGroupIndex + '</w:t></w:r>';
    // Insert the hidden run right after pPr inside the <w:p>
    xml = '<w:p>' + pPr + groupTag + alertPrefix + taskPrefix + runs + '</w:p>';
  }

  // Blockquote spacer paragraphs: exact-height empty paragraphs with an
  // inline left border (no pStyle, so the converter ignores them).  The left
  // rule extends symmetrically above/below content regardless of font size.
  if (token.type === 'blockquote' && (token.alertFirst || token.alertLast)) {
    const borderColor = token.alertType ? alertColorMap[token.alertType] : GITHUB_BLOCKQUOTE_BORDER_COLOR;
    const spacerBqStyle = token.alertType ? ALERT_STYLE_BY_TYPE[token.alertType] : (options?.blockquoteStyle ?? 'GitHub');
    const spacerIndentUnit = spacerBqStyle.startsWith('GitHub') ? GITHUB_BLOCKQUOTE_INDENT : 720;
    const spacerLeftIndent = spacerIndentUnit * (token.level || 1);
    const borderPPr = '<w:pBdr><w:left w:val="single" w:sz="' + GITHUB_BLOCKQUOTE_BORDER_SIZE + '" w:space="' + GITHUB_BLOCKQUOTE_BORDER_SPACE + '" w:color="' + borderColor + '"/></w:pBdr>';
    const indPPr = '<w:ind w:left="' + spacerLeftIndent + '"/>';
    if (token.alertFirst) {
      const firstPPr = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/>' + borderPPr + indPPr + '</w:pPr>';
      xml = '<w:p>' + firstPPr + '</w:p>' + xml;
    }
    if (token.alertLast) {
      const lastPPr = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/>' + borderPPr + indPPr + '</w:pPr>';
      xml = xml + '<w:p>' + lastPPr + '</w:p>';
    }
  }

  return xml;
}

export function generateTable(token: MdToken, state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any): string {
  if (!token.rows) return '';

  // Resolve effective table font/size: per-table token > document-level overrides
  const fo = state.fontOverrides;
  const effectiveTableSizeHp = token.tableFontSize !== undefined
    ? Math.round(token.tableFontSize * 2)
    : fo?.tableSizeHp;
  const effectiveTableFont = token.tableFont ?? fo?.tableFont;
  // Build pPr for table cell paragraphs (style ref + inline overrides for per-table diffs)
  let tablePPr = '';
  let tableRunRPr = '';
  if (effectiveTableSizeHp || effectiveTableFont) {
    const hasDocLevelStyle = !!(fo?.tableSizeHp || fo?.tableFont);
    // Per-table overrides that differ from doc-level require inline rPr on both pPr and runs
    const needsInlineFont = effectiveTableFont && effectiveTableFont !== fo?.tableFont;
    const needsInlineSize = effectiveTableSizeHp && effectiveTableSizeHp !== fo?.tableSizeHp;
    let pPrInner = '';
    if (hasDocLevelStyle) pPrInner += '<w:pStyle w:val="TableParagraph"/>';
    let rPrInner = '';
    if (needsInlineFont || (!hasDocLevelStyle && effectiveTableFont)) {
      rPrInner += '<w:rFonts w:ascii="' + escapeXml(effectiveTableFont!) + '" w:hAnsi="' + escapeXml(effectiveTableFont!) + '"/>';
    }
    if (needsInlineSize || (!hasDocLevelStyle && effectiveTableSizeHp)) {
      rPrInner += '<w:sz w:val="' + effectiveTableSizeHp + '"/><w:szCs w:val="' + effectiveTableSizeHp + '"/>';
    }
    tablePPr = '<w:pPr>' + pPrInner + (rPrInner ? '<w:rPr>' + rPrInner + '</w:rPr>' : '') + '</w:pPr>';
    // Run-level rPr: same inline overrides so runs inherit per-table font/size
    // (pPr > rPr only sets the paragraph mark, not run properties)
    tableRunRPr = rPrInner;
  }

  // Compute total grid columns by simulating grid occupancy (accounts for
  // columns implicitly occupied by rowspan cells from previous rows).
  let totalCols = 0;
  {
    const simMerge = new Map<number, { remaining: number; colspan: number }>();
    for (const row of token.rows) {
      let gridCol = 0;
      let ci = 0;
      // Walk the grid for this row, skipping columns occupied by rowspan continuations
      while (ci < row.cells.length) {
        // Skip columns occupied by pending vertical merges
        let pending = simMerge.get(gridCol);
        while (pending && pending.remaining > 0) {
          pending.remaining--;
          if (pending.remaining === 0) simMerge.delete(gridCol);
          gridCol += pending.colspan;
          pending = simMerge.get(gridCol);
        }
        const cell = row.cells[ci++];
        const cs = cell.colspan || 1;
        const rs = cell.rowspan || 1;
        if (rs > 1) {
          simMerge.set(gridCol, { remaining: rs - 1, colspan: cs });
        }
        gridCol += cs;
      }
      // Skip any trailing columns still occupied by merges
      let pending = simMerge.get(gridCol);
      while (pending && pending.remaining > 0) {
        pending.remaining--;
        if (pending.remaining === 0) simMerge.delete(gridCol);
        gridCol += pending.colspan;
        pending = simMerge.get(gridCol);
      }
      if (gridCol > totalCols) totalCols = gridCol;
    }
  }
  if (totalCols === 0) totalCols = 1;

  // Check if any cell uses colspan or rowspan
  const hasSpans = token.rows.some(row =>
    row.cells.some(cell => (cell.colspan && cell.colspan > 1) || (cell.rowspan && cell.rowspan > 1))
  );

  const hasHeaderRow = token.rows.some(row => row.header);

  let xml = '<w:tbl>';
  xml += '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar><w:tblW w:w="0" w:type="auto"/>' + (hasHeaderRow ? '<w:tblLook w:firstRow="1"/>' : '') + '</w:tblPr>';

  // Emit tblGrid if spans are present
  if (hasSpans) {
    xml += '<w:tblGrid>';
    for (let c = 0; c < totalCols; c++) {
      xml += '<w:gridCol/>';
    }
    xml += '</w:tblGrid>';
  }

  // Track pending vertical merges: gridCol -> { remaining: number; colspan: number }
  const mergeMap = new Map<number, { remaining: number; colspan: number }>();

  // Set per-table run rPr so generateRuns injects font/size on each run
  const prevRunRPrExtra = state.tableRunRPrExtra;
  state.tableRunRPrExtra = tableRunRPr;

  for (const row of token.rows) {
    xml += '<w:tr>';
    if (row.header) {
      xml += '<w:trPr><w:tblHeader/></w:trPr>';
    }
    let cellIdx = 0;
    let gridCol = 0;

    while (gridCol < totalCols) {
      // Check for pending vertical merge continuation at this column
      const pending = mergeMap.get(gridCol);
      if (pending && pending.remaining > 0) {
        let tcPr = '<w:tcPr>';
        if (pending.colspan > 1) {
          tcPr += '<w:gridSpan w:val="' + pending.colspan + '"/>';
        }
        tcPr += '<w:vMerge/></w:tcPr>';
        xml += '<w:tc>' + tcPr + '<w:p/></w:tc>';
        pending.remaining--;
        if (pending.remaining === 0) mergeMap.delete(gridCol);
        gridCol += pending.colspan;
        continue;
      }

      // Emit real cell
      if (cellIdx >= row.cells.length) {
        // Pad with empty cells if row is short
        xml += '<w:tc><w:p/></w:tc>';
        gridCol++;
        continue;
      }

      const cell = row.cells[cellIdx++];
      const cs = cell.colspan || 1;
      const rs = cell.rowspan || 1;

      let tcPr = '';
      if (cs > 1 || rs > 1) {
        // ECMA-376 §17.4.66: tcPr children order is gridSpan then vMerge
        const parts: string[] = [];
        if (cs > 1) parts.push('<w:gridSpan w:val="' + cs + '"/>');
        if (rs > 1) parts.push('<w:vMerge w:val="restart"/>');
        tcPr = '<w:tcPr>' + parts.join('') + '</w:tcPr>';
      }

      // Register vertical merge for subsequent rows
      if (rs > 1) {
        mergeMap.set(gridCol, { remaining: rs - 1, colspan: cs });
      }

      xml += '<w:tc>' + tcPr + '<w:p>' + tablePPr;
      // Auto-bold header cells to match Word's default table header styling.
      // Word applies bold to header rows via table styles; we reproduce that here.
      const cellRuns = row.header
        ? cell.runs.map(r => r.type === 'text' && !r.bold ? { ...r, bold: true } : r)
        : cell.runs;
      xml += generateRuns(cellRuns, state, options, bibEntries, citeprocEngine);
      xml += '</w:p></w:tc>';
      gridCol += cs;
    }
    xml += '</w:tr>';
  }

  state.tableRunRPrExtra = prevRunRPrExtra;

  xml += '</w:tbl>';
  return xml;
}

function generateParaId(state: DocxGenState): string {
  return (state.nextParaId++).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Add w14:paraId and w14:textId to every <w:p> element that doesn't already
 * carry a w14:paraId.  Applied as post-processing to document.xml,
 * footnotes.xml, and endnotes.xml before they go into the zip.
 *
 * Why: OneDrive's server-side co-authoring processor expects every paragraph
 * in a modern (compatibilityMode ≥ 15) document to have a unique paraId.
 * When document paragraphs lack them but comments.xml paragraphs have them,
 * OneDrive considers the file structurally inconsistent, reassigns all paraIds,
 * and strips paraIdParent from commentsExtended.xml — destroying comment
 * threading.  This works together with w14:docId, w15:docId, and
 * webSettings.xml (see settingsXml()) to present a complete modern document
 * that OneDrive won't "upgrade".
 *
 * Handles all <w:p> variants: <w:p>, <w:p/>, <w:p attr...>.
 * Skips elements that already have w14:paraId (e.g. comment paragraphs).
 */
function injectParaIds(xml: string, state: DocxGenState): string {
  return xml.replace(/<w:p(\s[^>]*)?(\/?>)/g, (match, attrs, close) => {
    // Already has a paraId (e.g. comment paragraphs) — leave it alone
    if (attrs && attrs.includes('w14:paraId')) return match;
    const pid = generateParaId(state);
    return '<w:p w14:paraId="' + pid + '" w14:textId="77777777"' + (attrs || '') + close;
  });
}


function authorInitials(author: string): string {
  const initials = author
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part[0].toUpperCase())
    .join('')
    .slice(0, 8);
  return initials;
}

/**
 * Comment threading in OOXML requires four coordinated files:
 *
 *   comments.xml        — comment bodies; the LAST <w:p> in each comment carries
 *                         w14:paraId (the identifier commentsExtended links to)
 *   commentsExtended.xml — one <w15:commentEx> per comment with w15:paraId; replies
 *                         include w15:paraIdParent pointing to the parent's paraId
 *   commentsIds.xml     — maps each paraId to a durableId (persistent across edits)
 *   commentsExtensible.xml — maps durableId to dateUtc for each comment
 *
 * For OneDrive compatibility, the document must also include:
 *   - w14:paraId on every <w:p> in document.xml / footnotes / endnotes (injectParaIds)
 *   - w14:docId + w15:docId in settings.xml
 *   - webSettings.xml
 * Without these, OneDrive's co-authoring processor rewrites the file and strips
 * paraIdParent, destroying threading.  See settingsXml() for details.
 */
function commentsXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15 w16cid">';
  for (const c of comments) {
    const dateAttr = c.date ? ' w:date="' + escapeXml(c.date) + '"' : '';
    const initials = authorInitials(c.author);
    const initialsAttr = initials ? ' w:initials="' + escapeXml(initials) + '"' : '';
    xml += '<w:comment w:id="' + c.id + '" w:author="' + escapeXml(c.author) + '"' + initialsAttr + dateAttr + '>';
    // Split on \n\n for paragraph breaks within the comment.
    // Per OOXML spec, commentsExtended.xml links via the paraId of the
    // LAST paragraph in each comment, so place w14:paraId there.
    const paragraphs = c.text.split('\n\n');
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const isLast = pi === paragraphs.length - 1;
      const paraIdAttr = isLast ? ' w14:paraId="' + c.paraId + '" w14:textId="77777777"' : '';
      const annotationRefRun = pi === 0
        ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : '';
      xml += '<w:p' + paraIdAttr + '>' + annotationRefRun + '<w:r><w:t xml:space="preserve">' + escapeXml(paragraphs[pi]) + '</w:t></w:r></w:p>';
    }
    xml += '</w:comment>';
  }
  xml += '</w:comments>';
  return xml;
}

function footnotesXml(entries: FootnoteEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:footnotes xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\">';
  // Separator (id=-1)
  xml += '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>';
  // Continuation separator (id=0)
  xml += '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>';
  for (const entry of entries) {
    xml += '<w:footnote w:id="' + entry.id + '">' + entry.bodyXml + '</w:footnote>';
  }
  xml += '</w:footnotes>';
  return xml;
}

function endnotesXml(entries: FootnoteEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:endnotes xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\">';
  // Separator (id=-1)
  xml += '<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>';
  // Continuation separator (id=0)
  xml += '<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>';
  for (const entry of entries) {
    xml += '<w:endnote w:id="' + entry.id + '">' + entry.bodyXml + '</w:endnote>';
  }
  xml += '</w:endnotes>';
  return xml;
}
function commentsExtendedXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w15">';
  for (const c of comments) {
    if (c.parentParaId) {
      xml += '<w15:commentEx w15:paraId="' + c.paraId + '" w15:paraIdParent="' + c.parentParaId + '" w15:done="0"/>';
    } else {
      xml += '<w15:commentEx w15:paraId="' + c.paraId + '" w15:done="0"/>';
    }
  }
  xml += '</w15:commentsEx>';
  return xml;
}

function durableIdFromParaId(paraId: string): string {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < paraId.length; i++) {
    hash ^= paraId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0');
}

function commentsIdsXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid">';
  for (const c of comments) {
    xml += '<w16cid:commentId w16cid:paraId="' + c.paraId + '" w16cid:durableId="' + durableIdFromParaId(c.paraId) + '"/>';
  }
  xml += '</w16cid:commentsIds>';
  return xml;
}

function commentsExtensibleXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex">';
  for (const c of comments) {
    const dateUtcAttr = c.date ? ' w16cex:dateUtc="' + escapeXml(c.date) + '"' : '';
    xml += '<w16cex:commentExtensible w16cex:durableId="' + durableIdFromParaId(c.paraId) + '"' + dateUtcAttr + '/>';
  }
  xml += '</w16cex:commentsExtensible>';
  return xml;
}

function peopleXml(comments: CommentEntry[]): string {
  const authors = [...new Set(comments.map(c => c.author).filter(a => !!a && a.trim().length > 0))];
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">';
  for (const author of authors) {
    xml += '<w15:person w15:author="' + escapeXml(author) + '"/>';
  }
  xml += '</w15:people>';
  return xml;
}

export function generateDocumentXml(tokens: MdToken[], state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: any, frontmatter?: Frontmatter): string {
  let body = '';
  const separatorParagraph = '<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:p>';

  // Pre-scan: assign comment IDs and discover reply relationships so that
  // replyRanges is populated before range start/end markers are emitted.
  // Without this, replyRanges would be empty when comment_range_start is
  // processed because comment_body_with_id (which populates replyRanges)
  // always appears after the range markers in the token stream.
  const prescanRun = (run: MdRun) => {
    if (run.type === 'comment_range_start') {
      const mdId = run.commentId || '';
      if (!state.commentIdMap.has(mdId)) {
        state.commentIdMap.set(mdId, state.commentId++);
      }
    } else if (run.type === 'comment_body_with_id' && run.replies && run.replies.length > 0) {
      const mdId = run.commentId || '';
      const numericId = state.commentIdMap.get(mdId);
      if (numericId !== undefined && !state.replyRanges.some(rr => rr.parentId === numericId)) {
        for (const _reply of run.replies) {
          const replyId = state.commentId++;
          state.replyRanges.push({ replyId, parentId: numericId });
        }
      }
    }
  };
  for (const token of tokens) {
    for (const run of token.runs) {
      prescanRun(run);
    }
    // Also scan runs inside table cells
    if (token.rows) {
      for (const row of token.rows) {
        for (const cell of row.cells) {
          for (const run of cell.runs) {
            prescanRun(run);
          }
        }
      }
    }
  }

  // Emit title paragraphs from frontmatter before body content
  if (frontmatter?.title) {
    const fo = resolveFontOverrides(frontmatter);
    for (let i = 0; i < frontmatter.title.length; i++) {
      let rPr = '';
      if (fo) {
        let inner = '';
        const style = resolveAtIndex(fo.titleStyles, i);
        if (style) {
          // Explicitly enable or disable each toggle to override inherited Title style
          inner += style.includes('bold') ? '<w:b/>' : '<w:b w:val="0"/>';
          inner += style.includes('italic') ? '<w:i/>' : '<w:i w:val="0"/>';
          inner += style.includes('underline') ? '<w:u w:val="single"/>' : '<w:u w:val="none"/>';
        }
        const font = resolveAtIndex(fo.titleFonts, i);
        if (font) inner += '<w:rFonts w:ascii="' + escapeXml(font) + '" w:hAnsi="' + escapeXml(font) + '"/>';
        const sizeHp = resolveAtIndex(fo.titleSizesHp, i);
        if (sizeHp) inner += '<w:sz w:val="' + sizeHp + '"/><w:szCs w:val="' + sizeHp + '"/>';
        if (inner) rPr = '<w:rPr>' + inner + '</w:rPr>';
      }
      body += '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' + generateRun(frontmatter.title[i], rPr) + '</w:p>';
    }
  }

  let prevToken: MdToken | undefined;
  for (const token of tokens) {
    // Insert an empty paragraph between consecutive code blocks so they
    // don't merge into a single block on DOCX→MD round-trip.
    if (token.type === 'code_block' && prevToken?.type === 'code_block') {
      body += '<w:p/>';
    }
    // Code blocks have w:after="0", so insert a borderless separator when
    // they are followed by non-code content.  Two cases:
    //   (a) Source had a blank line after the fence → always insert separator.
    //   (b) Callout alert immediately follows (no blank line) → still need a
    //       separator so the callout border doesn't sit flush against the code.
    if (prevToken?.type === 'code_block' && token.type !== 'code_block') {
      const needsSep = prevToken.trailingBlankLine || (token.type === 'blockquote' && token.alertFirst);
      if (needsSep) {
        body += separatorParagraph;
      }
    }
    if (token.type === 'table') {
      if (token.sourceFormat) {
        state.tableFormats.set(state.tableIndex, token.sourceFormat);
      }
      if (token.tableFontSize !== undefined) {
        state.tableFontSizes.set(state.tableIndex, token.tableFontSize);
      }
      if (token.tableFont) {
        state.tableFonts.set(state.tableIndex, token.tableFont);
      }
      body += generateTable(token, state, options, bibEntries, citeprocEngine);
      state.tableIndex++;
    } else {
      body += generateParagraph(token, state, options, bibEntries, citeprocEngine);
    }
    if (token.type === 'blockquote' && token.alertLast && token.blockquoteGroupIndex !== undefined) {
      // Inter-blockquote gap: insert separators between consecutive blockquote
      // groups when the source markdown had blank lines between them.
      const interGap = state.blockquoteGaps.get(token.blockquoteGroupIndex) ?? 0;
      if (interGap > 0) {
        for (let bi = 0; bi < interGap; bi++) {
          body += separatorParagraph;
        }
      }
      // Post-blockquote blank lines before non-blockquote content
      const blankCount = state.blockquotePostContentBlankLines.get(token.blockquoteGroupIndex) ?? 0;
      for (let bi = 0; bi < blankCount; bi++) {
        body += separatorParagraph;
      }
    }
    prevToken = token;
  }

  // Register only the actually-cited keys so makeBibliography() outputs
  // only entries that were referenced in the markdown.
  if (citeprocEngine) {
    citeprocEngine.updateItems([...state.citedKeys]);
  }

  // Append bibliography field if we have a citeproc engine
  if (citeprocEngine) {
    body += generateBibliographyXml(citeprocEngine, options?.zoteroBiblData);
  }

  // Append missing-key notes after bibliography
  if (state.missingKeys.size > 0) {
    body += generateMissingKeysXml([...state.missingKeys]);
  }

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14">\n' +
    '<w:body>\n' + body + '\n</w:body>\n' +
    '</w:document>';
}

export async function convertMdToDocx(
  markdown: string,
  options?: MdToDocxOptions
): Promise<MdToDocxResult> {
  // Parse frontmatter for CSL style and other metadata
  const { metadata: frontmatter, body } = parseFrontmatter(markdown);
  // Count blank lines between frontmatter closing --- and body content.
  // parseFrontmatter strips one \n; remaining leading \n's = blank lines.
  const hadFrontmatter = markdown.trimStart().startsWith('---');
  const frontmatterBlankLines = hadFrontmatter
    ? (body.match(/^\n*/) || [''])[0].length
    : -1; // -1 means no frontmatter present
  const fontOverrides = resolveFontOverrides(frontmatter);
  const isInsetMode = frontmatter.codeBackgroundColor === 'none' || frontmatter.codeBackgroundColor === 'transparent';
  const codeBlockConfig: CodeBlockConfig = {
    insetMode: isInsetMode,
    background: !isInsetMode && frontmatter.codeBackgroundColor && /^[0-9A-Fa-f]{6}$/.test(frontmatter.codeBackgroundColor) ? frontmatter.codeBackgroundColor : undefined,
    codeFontColor: frontmatter.codeFontColor,
    codeBlockInset: frontmatter.codeBlockInset,
  };
  // Strip previously-generated "Citation data for @key was not found" paragraphs
  // so they don't accumulate on successive round-trips. The missing-key mechanism
  // regenerates these from the actual unresolved citation keys.
  const MISSING_KEY_LINE = /^Citation data for @\S+ was not found in the bibliography file\.$/;
  const bodyStripped = body.split('\n')
    .filter(line => !MISSING_KEY_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}$/, '\n'); // trim trailing excess blank lines from removed block

  // Extract footnote definitions before markdown parsing
  const { cleaned: bodyWithoutFootnotes, definitions: footnoteDefs } = extractFootnoteDefinitions(bodyStripped);
  const parseWarnings: string[] = [];
  const tokens = parseMd(bodyWithoutFootnotes, parseWarnings);

  // Compute inter-blockquote-group gap metadata from the original markdown
  // source and annotate tokens with sequential group indices.
  const blockquoteGaps = computeBlockquoteGaps(bodyWithoutFootnotes);
  const blockquotePreContentBlankLines = computeBlockquotePreContentBlankLines(bodyWithoutFootnotes);
  const blockquotePostContentBlankLines = computeBlockquotePostContentBlankLines(bodyWithoutFootnotes);
  const blockquoteAlertMarkerInlineByGroup = computeBlockquoteAlertMarkerInlineByGroup(bodyWithoutFootnotes);
  annotateBlockquoteGroupIndices(tokens);
  const htmlCommentGaps = annotateHtmlCommentIndices(tokens);

  // Parse BibTeX if provided
  let bibEntries: Map<string, BibtexEntry> | undefined;
  if (options?.bibtex) {
    bibEntries = parseBibtex(options.bibtex);
  }

  // Create citeproc engine if CSL style specified in frontmatter
  let citeprocEngine: any;
  const earlyWarnings: string[] = [...parseWarnings];
  if (frontmatter.csl && bibEntries) {
    let styleName = frontmatter.csl;

    // 0. Resolve file-like CSL values (relative or absolute paths)
    const isFileLike = styleName.endsWith('.csl') || isAbsolute(styleName);
    if (isFileLike && !isAbsolute(styleName)) {
      if (options?.sourceDir) {
        const resolved = join(options.sourceDir, styleName);
        if (existsSync(resolved)) {
          styleName = resolved;
        } else {
          earlyWarnings.push(`CSL file "${styleName}" not found in source directory (${options.sourceDir}).`);
        }
      } else {
        earlyWarnings.push(`Relative CSL path "${styleName}" cannot be resolved without a source directory.`);
      }
    }

    // 1. Try bundled styles
    let result = createCiteprocEngineLocal(bibEntries, styleName, frontmatter.locale);

    // 2. Try CSL cache directory (e.g. VS Code global storage)
    if (result.styleNotFound && options?.cslCacheDir) {
      const cachedPath = join(options.cslCacheDir, styleName.endsWith('.csl') ? styleName : styleName + '.csl');
      if (existsSync(cachedPath)) {
        result = createCiteprocEngineLocal(bibEntries, cachedPath, frontmatter.locale);
      }
    }

    // 3. Ask user whether to download
    if (result.styleNotFound) {
      let shouldDownload = false;
      if (options?.onStyleNotFound) {
        shouldDownload = await options.onStyleNotFound(styleName);
      }
      if (shouldDownload && options?.cslCacheDir) {
        try {
          await downloadStyle(styleName, options.cslCacheDir);
          const downloadedPath = join(options.cslCacheDir, styleName.endsWith('.csl') ? styleName : styleName + '.csl');
          result = createCiteprocEngineLocal(bibEntries, downloadedPath, frontmatter.locale);
        } catch {
          earlyWarnings.push(`CSL style "${styleName}" could not be downloaded. Export completed without CSL citation formatting.`);
        }
      } else if (shouldDownload) {
        // No cslCacheDir — fall back to async download into bundled dir
        result = await createCiteprocEngineAsync(bibEntries, styleName, frontmatter.locale);
        if (result.styleNotFound) {
          earlyWarnings.push(`CSL style "${styleName}" could not be downloaded. Export completed without CSL citation formatting.`);
        }
      } else {
        earlyWarnings.push(`CSL style "${styleName}" is not bundled. Export completed without CSL citation formatting.`);
      }
    }

    citeprocEngine = result.engine;
  }

  // Extract template parts if provided
  let templateParts: Map<string, Uint8Array> | undefined;
  if (options?.templateDocx) {
    templateParts = await extractTemplateParts(options.templateDocx);
  }

  const hasTheme = !!templateParts?.has('word/theme/theme1.xml');
  const notesMode = frontmatter.notes === 'endnotes' ? 'endnotes' as const : 'footnotes' as const;

  // Reserve rId slots: 1=styles, 2=numbering, 3=comments,
  // 4+=optional notes/comment-thread rels/theme/settings/webSettings/fontTable.
  // Reserve max optional slots to avoid hyperlink rId collisions.
  const rIdOffset = 3 + 6 + (hasTheme ? 1 : 0) + 3; // +6 optional rels (foot/end/commentsExtended/commentsIds/commentsExtensible/people), +3 fixed settings/webSettings/fontTable

  const state: DocxGenState = {
    commentId: 0,
    comments: [],
    commentIdMap: new Map(),
    relationships: new Map(),
    nextRId: 1,
    rIdOffset,
    warnings: [...earlyWarnings],
    hasList: false,
    hasComments: false,
    hasFootnotes: false,
    hasEndnotes: false,
    footnoteId: 1,
    footnoteEntries: [],
    footnoteLabelToId: new Map(),
    notesMode,
    missingKeys: new Set(),
    citationIds: new Set(),
    citationItemIds: new Map(),
    timezone: frontmatter.timezone,
    replyRanges: [],
    // Start document paraIds at a high offset to avoid collisions with template-
    // assigned IDs (which Word typically allocates starting near 0).  Comment paraIds
    // are allocated first during comment generation; document/footnote/endnote paraIds
    // are allocated later by injectParaIds().  All share this single counter so they
    // never collide.  Valid range: 0x00000001–0x7FFFFFFF (Word ignores 0 and ≥ 0x80000000).
    nextParaId: 0x10000000,
    codeBlockIndex: 0,
    codeBlockLanguages: new Map(),
    citedKeys: new Set(),
    codeFont: fontOverrides?.codeFont || 'Consolas',
    codeShadingMode: !isInsetMode,
    blockquoteGaps: blockquoteGaps,
    blockquotePreContentBlankLines,
    blockquotePostContentBlankLines,
    blockquoteAlertMarkerInlineByGroup,
    imageRelationships: new Map(),
    imageMediaPaths: new Map(),
    imageBinaries: new Map(),
    imageFormats: new Map(),
    imageExtensions: new Set(),
    nextImageDocPrId: 1,
    tableIndex: 0,
    tableFormats: new Map(),
    tableFontSizes: new Map(),
    tableFonts: new Map(),
    fontOverrides,
    listIndent: detectListIndent(bodyWithoutFootnotes),
    consecutiveReplyParaIds: new Set(),
    htmlCommentGaps,
    tableRunRPrExtra: '',
  };

  // Pre-scan footnote definitions for citation keys so the bibliography
  // (generated inside generateDocumentXml) includes footnote-only citations.
  if (bibEntries && footnoteDefs.size > 0) {
    for (const [, bodyText] of footnoteDefs) {
      const bodyTokens = parseMd(bodyText);
      for (const token of bodyTokens) {
        for (const run of token.runs) {
          if (run.type === 'citation' && run.keys) {
            for (const k of run.keys) {
              if (bibEntries.has(k)) state.citedKeys.add(k);
            }
          }
        }
        if (token.rows) {
          for (const row of token.rows) {
            for (const cell of row.cells) {
              for (const run of cell.runs) {
                if (run.type === 'citation' && run.keys) {
                  for (const k of run.keys) {
                    if (bibEntries.has(k)) state.citedKeys.add(k);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Resolve effective blockquote style: frontmatter > options > default
  const effectiveBlockquoteStyle = frontmatter.blockquoteStyle ?? options?.blockquoteStyle ?? 'GitHub';
  // Resolve effective color scheme: frontmatter > options > default
  const effectiveColors: ColorScheme = frontmatter.colors ?? options?.colors ?? getDefaultColorScheme();
  const resolvedOptions = options
    ? { ...options, blockquoteStyle: effectiveBlockquoteStyle, colors: effectiveColors }
    : { blockquoteStyle: effectiveBlockquoteStyle, colors: effectiveColors };

  const documentXml = generateDocumentXml(tokens, state, resolvedOptions, bibEntries, citeprocEngine, frontmatter);

  // Build footnote/endnote body OOXML from definitions
  for (const [label, bodyText] of footnoteDefs) {
    const noteId = state.footnoteLabelToId.get(label);
    if (noteId === undefined) {
      state.warnings.push(`Footnote definition [^${label}] has no matching reference in the document.`);
      continue;
    }
    // Parse the definition body into tokens and generate OOXML
    const bodyTokens = parseMd(bodyText, state.warnings);
    // Generate paragraph OOXML for the note body
    const selfRefTag = state.notesMode === 'endnotes' ? 'w:endnoteRef' : 'w:footnoteRef';
    const pStyle = state.notesMode === 'endnotes' ? 'EndnoteText' : 'FootnoteText';
    const refStyle = state.notesMode === 'endnotes' ? 'EndnoteReference' : 'FootnoteReference';
    let bodyXml = '';
    const paragraphPPr = '<w:pPr><w:pStyle w:val="' + pStyle + '"/></w:pPr>';
    const selfRefRun = '<w:r><w:rPr><w:rStyle w:val="' + refStyle + '"/></w:rPr><' + selfRefTag + '/></w:r>';
    for (let ti = 0; ti < bodyTokens.length; ti++) {
      const t = bodyTokens[ti];
      if (ti === 0) {
        if (t.type === 'table') {
          bodyXml += '<w:p>' + paragraphPPr + selfRefRun + '</w:p>';
          bodyXml += generateTable(t, state, options, bibEntries, citeprocEngine);
        } else {
          const runs = generateRuns(t.runs, state, options, bibEntries, citeprocEngine);
          bodyXml += '<w:p>' + paragraphPPr + selfRefRun + runs + '</w:p>';
        }
      } else {
        if (t.type === 'table') {
          bodyXml += generateTable(t, state, options, bibEntries, citeprocEngine);
        } else {
          const runs = generateRuns(t.runs, state, options, bibEntries, citeprocEngine);
          bodyXml += '<w:p>' + paragraphPPr + runs + '</w:p>';
        }
      }
    }
    if (bodyTokens.length === 0) {
      bodyXml = '<w:p>' + paragraphPPr + selfRefRun + '</w:p>';
    }
    state.footnoteEntries.push({ id: noteId, bodyXml });
  }

  // Warn for orphaned references (use footnoteLabelToId, not the pre-body-processing
  // snapshot, so cross-references allocated during footnote body generation are covered)
  for (const [label] of state.footnoteLabelToId) {
    if (!footnoteDefs.has(label)) {
      state.warnings.push(`Footnote reference [^${label}] has no matching definition.`);
    }
  }

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('word/document.xml', injectParaIds(documentXml, state));

  // Use template styles if available, otherwise default; apply font/color overrides when present
  if (templateParts?.has('word/styles.xml') && fontOverrides) {
    let mutated = applyFontOverridesToTemplate(
      templateParts.get('word/styles.xml')!,
      fontOverrides
    );
    mutated = applyAlertColorsToTemplate(mutated, effectiveColors);
    zip.file('word/styles.xml', mutated);
  } else if (templateParts?.has('word/styles.xml')) {
    const decoded = new TextDecoder('utf-8').decode(templateParts.get('word/styles.xml')!);
    zip.file('word/styles.xml', applyAlertColorsToTemplate(decoded, effectiveColors));
  } else {
    zip.file('word/styles.xml', stylesXml(fontOverrides, codeBlockConfig, effectiveColors));
  }

  const hasCommentsExtended = state.hasComments && state.comments.some(c => c.parentParaId);
  const hasThreadedComments = hasCommentsExtended;
  const hasCommentsIds = hasThreadedComments;
  const hasCommentsExtensible = hasThreadedComments;
  const hasPeople = hasThreadedComments;

  // Always use generated settings.xml to guarantee compatibilityMode >= 15
  // (template settings.xml may have compatibilityMode < 15, causing "unreadable content" errors)
  zip.file('word/settings.xml', settingsXml(state.hasFootnotes, state.hasEndnotes, hasThreadedComments));
  zip.file('word/webSettings.xml', webSettingsXml());

  // Always include fontTable.xml
  zip.file('word/fontTable.xml', fontTableXml());

  // Handle numbering - use template as base but ensure bullet/decimal definitions exist
  if (state.hasList) {
    if (templateParts?.has('word/numbering.xml')) {
      zip.file('word/numbering.xml', templateParts.get('word/numbering.xml')!);
    } else {
      zip.file('word/numbering.xml', numberingXml());
    }
  }

  // Include template theme if available
  if (hasTheme) {
    zip.file('word/theme/theme1.xml', templateParts!.get('word/theme/theme1.xml')!);
  }

  if (state.hasComments) {
    zip.file('word/comments.xml', commentsXml(state.comments));
    if (hasCommentsExtended) {
      zip.file('word/commentsExtended.xml', commentsExtendedXml(state.comments));
    }
    if (hasCommentsIds) {
      zip.file('word/commentsIds.xml', commentsIdsXml(state.comments));
    }
    if (hasCommentsExtensible) {
      zip.file('word/commentsExtensible.xml', commentsExtensibleXml(state.comments));
    }
    if (hasPeople) {
      zip.file('word/people.xml', peopleXml(state.comments));
    }
  }

  if (state.hasFootnotes) {
    zip.file('word/footnotes.xml', injectParaIds(footnotesXml(state.footnoteEntries), state));
  }
  if (state.hasEndnotes) {
    zip.file('word/endnotes.xml', injectParaIds(endnotesXml(state.footnoteEntries), state));
  }

  // Document properties
  zip.file('docProps/core.xml', corePropsXml(frontmatter.author));
  zip.file('docProps/app.xml', appPropsXml());

  const customProps: CustomPropEntry[] = [];
  if (frontmatter.csl) {
    customProps.push(...zoteroCustomProps(frontmatter));
  }
  customProps.push(...commentIdMappingProps(state.commentIdMap));
  customProps.push(...footnoteIdMappingProps(state.footnoteLabelToId));
  customProps.push(...codeBlockLanguageProps(state.codeBlockLanguages));
  customProps.push(...codeBlockStylingProps(frontmatter));
  customProps.push(...pipeTableMaxLineWidthProps(frontmatter));
  customProps.push(...blockquoteGapProps(state.blockquoteGaps));
  customProps.push(...blockquotePreContentBlankLineProps(state.blockquotePreContentBlankLines));
  customProps.push(...blockquotePostContentBlankLineProps(state.blockquotePostContentBlankLines));
  customProps.push(...blockquoteAlertMarkerStyleProps(state.blockquoteAlertMarkerInlineByGroup));
  customProps.push(...imageFormatProps(state.imageFormats));
  customProps.push(...tableFormatProps(state.tableFormats));
  customProps.push(...tableFontSizeProps(state.tableFontSizes));
  customProps.push(...tableFontProps(state.tableFonts));
  customProps.push(...listIndentProps(state));
  customProps.push(...consecutiveReplyProps(state));
  customProps.push(...htmlCommentGapProps(state.htmlCommentGaps));
  customProps.push(...frontmatterBlankLineProps(frontmatterBlankLines));
  customProps.push(...bibKeyOrderProps(bibEntries));
  customProps.push(...bibDataProps(options?.bibtex));
  const hasCustomProps = customProps.length > 0;
  if (hasCustomProps) {
    zip.file('docProps/custom.xml', customPropsXml(customProps));
  }

  // Store image binaries in word/media/
  for (const [mediaPath, data] of state.imageBinaries) {
    zip.file('word/' + mediaPath, data);
  }

  zip.file('[Content_Types].xml', contentTypesXml({
    hasList: state.hasList,
    hasComments: state.hasComments,
    hasTheme,
    hasCustomProps,
    hasFootnotes: state.hasFootnotes,
    hasEndnotes: state.hasEndnotes,
    hasCommentsExtended,
    hasCommentsIds,
    hasCommentsExtensible,
    hasPeople,
    imageExtensions: state.imageExtensions.size > 0 ? state.imageExtensions : undefined,
  }));
  zip.file('_rels/.rels', relsXml(hasCustomProps));
  zip.file('word/_rels/document.xml.rels', documentRelsXml({
    relationships: state.relationships,
    hasList: state.hasList,
    hasComments: state.hasComments,
    hasTheme,
    hasFootnotes: state.hasFootnotes,
    hasEndnotes: state.hasEndnotes,
    hasCommentsExtended,
    hasCommentsIds,
    hasCommentsExtensible,
    hasPeople,
    imageRelationships: state.imageRelationships.size > 0 ? state.imageRelationships : undefined,
  }));

  // Check for comment range markers without corresponding bodies
  for (const [mdId, numericId] of state.commentIdMap) {
    if (!state.comments.some(c => c.id === numericId)) {
      state.warnings.push(`Comment range markers {#${mdId}}...{/${mdId}} exist without corresponding body {#${mdId}>>...<<}`);
    }
  }

  const docx = await zip.generateAsync({ type: 'uint8array' });
  return { docx, warnings: state.warnings };
}
