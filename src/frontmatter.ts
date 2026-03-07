export type NoteType = 'in-text' | 'footnotes' | 'endnotes';

const NOTE_TYPE_NAMES: Record<string, NoteType> = {
  'in-text': 'in-text',
  'footnotes': 'footnotes',
  'endnotes': 'endnotes',
  '0': 'in-text',
  '1': 'footnotes',
  '2': 'endnotes',
};

const NOTE_TYPE_TO_NUMBER: Record<NoteType, number> = {
  'in-text': 0,
  'footnotes': 1,
  'endnotes': 2,
};

export function noteTypeFromNumber(n: number): NoteType {
  if (n === 1) return 'footnotes';
  if (n === 2) return 'endnotes';
  return 'in-text';
}

export function noteTypeToNumber(nt: NoteType): number {
  return NOTE_TYPE_TO_NUMBER[nt];
}

export type NotesMode = 'footnotes' | 'endnotes';

/** Parse a value that may be a YAML inline array `[v1, v2, ...]` or bare comma-separated values. */
export function parseInlineArray(value: string): string[] {
  let inner = value;
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1);
  if (!inner.includes(',')) return [inner.trim()].filter(s => s.length > 0);
  return inner.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// Design rationale: A single combined header-font-style field was chosen over
// separate CSS-style fields (font-style, font-weight, font-decoration) because:
// 1. One field is simpler for authors than three separate fields.
// 2. Manuscript authors are not web developers — CSS distinctions between
//    font-style, font-weight, and text-decoration are unfamiliar.
// 3. Word only supports bold on/off (no numeric weights 100–900), so a
//    separate font-weight field accepting numbers would be misleading.
const VALID_STYLE_PARTS = new Set(['bold', 'italic', 'underline']);
const CANONICAL_ORDER = ['bold', 'italic', 'underline'];

/** Validate and normalize a Font_Style value to canonical order (bold-italic-underline). */
export function normalizeFontStyle(raw: string): string | undefined {
  const lower = raw.toLowerCase().trim();
  if (!lower) return undefined;
  if (lower === 'normal') return 'normal';
  const parts = lower.split('-');
  const unique = [...new Set(parts)];
  if (unique.length !== parts.length) return undefined;
  if (!unique.every(p => VALID_STYLE_PARTS.has(p))) return undefined;
  return unique.sort((a, b) => CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b)).join('-');
}

export type BlockquoteStyle = 'Quote' | 'IntenseQuote' | 'GitHub';

const BLOCKQUOTE_STYLE_NAMES: Record<string, BlockquoteStyle> = {
  'quote': 'Quote',
  'intensequote': 'IntenseQuote',
  'github': 'GitHub',
};

/** Normalize a raw blockquote-style value (case-insensitive). */
export function normalizeBlockquoteStyle(raw: string): BlockquoteStyle | undefined {
  return BLOCKQUOTE_STYLE_NAMES[raw.toLowerCase().trim()];
}

export type ColorScheme = 'github' | 'guttmacher';

const COLOR_SCHEME_NAMES: Record<string, ColorScheme> = {
  'github': 'github',
  'guttmacher': 'guttmacher',
};

/** Normalize a raw colors value (case-insensitive). */
export function normalizeColorScheme(raw: string): ColorScheme | undefined {
  return COLOR_SCHEME_NAMES[raw.toLowerCase().trim()];
}

export interface Frontmatter {
  title?: string[];
  author?: string;
  csl?: string;
  locale?: string;
  zoteroNotes?: NoteType;
  notes?: NotesMode;
  timezone?: string;
  bibliography?: string;
  font?: string;
  codeFont?: string;
  fontSize?: number;
  codeFontSize?: number;
  headerFont?: string[];
  headerFontSize?: number[];
  headerFontStyle?: string[];
  titleFont?: string[];
  titleFontSize?: number[];
  titleFontStyle?: string[];
  codeBackgroundColor?: string;
  codeFontColor?: string;
  codeBlockInset?: number;
  pipeTableMaxLineWidth?: number;
  gridTableMaxLineWidth?: number;
  tableFont?: string;
  tableFontSize?: number;
  blockquoteStyle?: BlockquoteStyle;
  colors?: ColorScheme;
}

/**
 * Split YAML frontmatter (delimited by `---`) from the markdown body.
 * Returns the parsed metadata and the remaining body text.
 */
export function parseFrontmatter(markdown: string): { metadata: Frontmatter; body: string; fieldOrder: string[] } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { metadata: {}, body: markdown, fieldOrder: [] };
  }

  const endMatch = trimmed.substring(3).match(/\n---(?:\r?\n|$)/);
  if (!endMatch) {
    return { metadata: {}, body: markdown, fieldOrder: [] };
  }
  const endIdx = endMatch.index! + 3;

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).replace(/^\r?\n/, '');

  const metadata: Frontmatter = {};
  const fieldOrder: string[] = [];
  const seenFields = new Set<string>();
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!seenFields.has(key)) {
      seenFields.add(key);
      fieldOrder.push(key);
    }
    switch (key) {
      case 'title':
        if (!metadata.title) metadata.title = [];
        metadata.title.push(value);
        break;
      case 'author':
        if (value) metadata.author = value;
        break;
      case 'csl':
        metadata.csl = value;
        break;
      case 'locale':
        metadata.locale = value;
        break;
      case 'zotero-notes':
      case 'note-type': {
        const nt = NOTE_TYPE_NAMES[value];
        if (nt) metadata.zoteroNotes = nt;
        break;
      }
      case 'notes': {
        if (value === 'footnotes' || value === 'endnotes') {
          metadata.notes = value;
        }
        break;
      }
      case 'timezone':
        if (value && /^[+-]\d{2}:\d{2}$/.test(value)) metadata.timezone = value;
        break;
      // Implementation note: accepts bibliography / bib / bibtex (first match wins).
      // Normalize with normalizeBibPath(); resolution order: relative to .md dir →
      // workspace root → fallback {basename}.bib. CLI --bib takes precedence.
      case 'bibliography':
      case 'bib':
      case 'bibtex':
        if (value && !metadata.bibliography) metadata.bibliography = value;
        break;
      case 'font':
        if (value) metadata.font = value;
        break;
      case 'code-font':
        if (value) metadata.codeFont = value;
        break;
      case 'font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.fontSize = n;
        break;
      }
      case 'code-font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.codeFontSize = n;
        break;
      }
      case 'header-font':
        if (value) metadata.headerFont = parseInlineArray(value);
        break;
      case 'header-font-size': {
        const arr = parseInlineArray(value).map(s => parseFloat(s)).filter(n => isFinite(n) && n > 0);
        if (arr.length > 0) metadata.headerFontSize = arr;
        break;
      }
      case 'header-font-style': {
        const arr = parseInlineArray(value).map(s => normalizeFontStyle(s)).filter((s): s is string => s !== undefined);
        if (arr.length > 0) metadata.headerFontStyle = arr;
        break;
      }
      case 'title-font':
        if (value) metadata.titleFont = parseInlineArray(value);
        break;
      case 'title-font-size': {
        const arr = parseInlineArray(value).map(s => parseFloat(s)).filter(n => isFinite(n) && n > 0);
        if (arr.length > 0) metadata.titleFontSize = arr;
        break;
      }
      case 'title-font-style': {
        const arr = parseInlineArray(value).map(s => normalizeFontStyle(s)).filter((s): s is string => s !== undefined);
        if (arr.length > 0) metadata.titleFontStyle = arr;
        break;
      }
      case 'code-background-color':
      case 'code-background': {
        if (/^[0-9A-Fa-f]{6}$/.test(value) || value === 'none' || value === 'transparent') {
          metadata.codeBackgroundColor = value;
        }
        break;
      }
      case 'code-font-color':
      case 'code-color': {
        if (/^[0-9A-Fa-f]{6}$/.test(value)) {
          metadata.codeFontColor = value;
        }
        break;
      }
      case 'code-block-inset': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n > 0 && value.trim() === String(n)) {
          metadata.codeBlockInset = n;
        }
        break;
      }
      case 'table-font':
        if (value) metadata.tableFont = value;
        break;
      case 'table-font-size': {
        const n = parseFloat(value);
        if (isFinite(n) && n > 0) metadata.tableFontSize = n;
        break;
      }
      // 0 = disable pipe tables (always HTML); positive = max line width
      case 'pipe-table-max-line-width': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0 && value.trim() === String(n)) {
          metadata.pipeTableMaxLineWidth = n;
        }
        break;
      }
      case 'grid-table-max-line-width': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0 && value.trim() === String(n)) {
          metadata.gridTableMaxLineWidth = n;
        }
        break;
      }
      case 'blockquote-style': {
        const style = normalizeBlockquoteStyle(value);
        if (style) metadata.blockquoteStyle = style;
        break;
      }
      case 'colors': {
        const scheme = normalizeColorScheme(value);
        if (scheme) metadata.colors = scheme;
        break;
      }
    }
  }

  // Title inline array: if exactly one title entry looks like [v1, v2, ...], expand it
  if (metadata.title && metadata.title.length === 1) {
    const t = metadata.title[0];
    if (t.startsWith('[') && t.endsWith(']')) {
      metadata.title = parseInlineArray(t);
    }
  }

  return { metadata, body, fieldOrder };
}

/**
 * Serialize a Frontmatter object to a YAML frontmatter string.
 * Returns empty string if metadata has no fields.
 */
export function serializeFrontmatter(metadata: Frontmatter, fieldOrder?: string[]): string {
  const lines: string[] = [];
  const emitArr = (key: string, arr: (string | number)[] | undefined) => {
    if (!arr || arr.length === 0) return;
    if (arr.length === 1) lines.push(key + ': ' + arr[0]);
    else lines.push(key + ': [' + arr.join(', ') + ']');
  };

  // Map from YAML key name to emission function
  const emitters: Record<string, () => void> = {
    'title': () => { if (metadata.title && metadata.title.length > 0) { for (const t of metadata.title) lines.push(`title: ${t}`); } },
    'author': () => { if (metadata.author) lines.push(`author: ${metadata.author}`); },
    'csl': () => { if (metadata.csl) lines.push(`csl: ${metadata.csl}`); },
    'locale': () => { if (metadata.locale) lines.push(`locale: ${metadata.locale}`); },
    'zotero-notes': () => { if (metadata.zoteroNotes) lines.push(`zotero-notes: ${metadata.zoteroNotes}`); },
    'note-type': () => emitters['zotero-notes'](),
    'notes': () => { if (metadata.notes) lines.push(`notes: ${metadata.notes}`); },
    'timezone': () => { if (metadata.timezone) lines.push(`timezone: ${metadata.timezone}`); },
    'bibliography': () => { if (metadata.bibliography) lines.push(`bibliography: ${metadata.bibliography}`); },
    'bib': () => emitters['bibliography'](),
    'bibtex': () => emitters['bibliography'](),
    'font': () => { if (metadata.font) lines.push('font: ' + metadata.font); },
    'code-font': () => { if (metadata.codeFont) lines.push('code-font: ' + metadata.codeFont); },
    'font-size': () => { if (metadata.fontSize !== undefined) lines.push('font-size: ' + metadata.fontSize); },
    'code-font-size': () => { if (metadata.codeFontSize !== undefined) lines.push('code-font-size: ' + metadata.codeFontSize); },
    'header-font': () => emitArr('header-font', metadata.headerFont),
    'header-font-size': () => emitArr('header-font-size', metadata.headerFontSize),
    'header-font-style': () => emitArr('header-font-style', metadata.headerFontStyle),
    'title-font': () => emitArr('title-font', metadata.titleFont),
    'title-font-size': () => emitArr('title-font-size', metadata.titleFontSize),
    'title-font-style': () => emitArr('title-font-style', metadata.titleFontStyle),
    'table-font': () => { if (metadata.tableFont) lines.push('table-font: ' + metadata.tableFont); },
    'table-font-size': () => { if (metadata.tableFontSize !== undefined) lines.push('table-font-size: ' + metadata.tableFontSize); },
    'code-background-color': () => { if (metadata.codeBackgroundColor) lines.push('code-background-color: ' + metadata.codeBackgroundColor); },
    'code-background': () => emitters['code-background-color'](),
    'code-font-color': () => { if (metadata.codeFontColor) lines.push('code-font-color: ' + metadata.codeFontColor); },
    'code-color': () => emitters['code-font-color'](),
    'code-block-inset': () => { if (metadata.codeBlockInset !== undefined) lines.push('code-block-inset: ' + metadata.codeBlockInset); },
    'pipe-table-max-line-width': () => { if (metadata.pipeTableMaxLineWidth !== undefined) lines.push('pipe-table-max-line-width: ' + metadata.pipeTableMaxLineWidth); },
    'grid-table-max-line-width': () => { if (metadata.gridTableMaxLineWidth !== undefined) lines.push('grid-table-max-line-width: ' + metadata.gridTableMaxLineWidth); },
    'blockquote-style': () => { if (metadata.blockquoteStyle) lines.push('blockquote-style: ' + metadata.blockquoteStyle); },
    'colors': () => { if (metadata.colors) lines.push('colors: ' + metadata.colors); },
  };

  // Default emission order (backward compatible)
  const defaultOrder = [
    'title', 'author', 'csl', 'locale', 'zotero-notes', 'notes', 'timezone',
    'bibliography', 'font', 'code-font', 'font-size', 'code-font-size',
    'header-font', 'header-font-size', 'header-font-style',
    'title-font', 'title-font-size', 'title-font-style',
    'table-font', 'table-font-size',
    'code-background-color', 'code-font-color', 'code-block-inset',
    'pipe-table-max-line-width', 'grid-table-max-line-width',
    'blockquote-style', 'colors',
  ];

  const aliasToCanonical: Record<string, string> = {
    'note-type': 'zotero-notes',
    'bib': 'bibliography',
    'bibtex': 'bibliography',
    'code-background': 'code-background-color',
    'code-color': 'code-font-color',
  };

  const canonicalToAliases: Record<string, string[]> = {};
  for (const [alias, canonical] of Object.entries(aliasToCanonical)) {
    if (!canonicalToAliases[canonical]) canonicalToAliases[canonical] = [];
    canonicalToAliases[canonical].push(alias);
  }

  const order = fieldOrder && fieldOrder.length > 0 ? fieldOrder : defaultOrder;
  const emitted = new Set<string>();

  for (const key of order) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    const canonical = aliasToCanonical[key];
    if (canonical) {
      emitted.add(canonical);
      const siblingAliases = canonicalToAliases[canonical];
      if (siblingAliases) for (const a of siblingAliases) emitted.add(a);
    }
    const aliases = canonicalToAliases[key];
    if (aliases) for (const a of aliases) emitted.add(a);
    const emitter = emitters[key];
    if (emitter) emitter();
  }

  // Emit any remaining fields not in the provided order
  for (const key of defaultOrder) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    const emitter = emitters[key];
    if (emitter) emitter();
  }

  if (lines.length === 0) return '';
  return '---\n' + lines.join('\n') + '\n---\n';
}

/** Check whether markdown body contains Pandoc-style citations ([@...]) */
export function hasCitations(markdown: string): boolean {
  return /\[@[^\]]+\]/.test(markdown);
}

/** Ensure a bibliography path ends with .bib */
export function normalizeBibPath(p: string): string {
  if (!p) return p;
  return p.endsWith('.bib') ? p : p + '.bib';
}
