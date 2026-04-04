import { parseCsv, csvToHtmlTableMeta } from './csv-parser';
import { parseXlsx } from './xlsx-parser';
import type { HtmlTableMeta, HtmlTableRun } from './html-table-parser';
import { LineMap, type LineMapSegment } from './preview/line-map';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbedDirective {
  path: string;
  sheet?: string;
  range?: string;
  headers?: number;
}

export interface EmbedResolver {
  readFile(absolutePath: string): Uint8Array | null;
  resolveRelative(basePath: string, relativePath: string): string;
}

// ---------------------------------------------------------------------------
// Directive parsing
// ---------------------------------------------------------------------------

const EMBED_RE = /^<!--\s*embed:\s*([\s\S]+?)\s*-->$/;

/**
 * Parse an embed directive from an HTML comment string.
 * Returns null if the string is not an embed directive.
 */
export function parseEmbedDirective(comment: string): EmbedDirective | null {
  const m = comment.trim().match(EMBED_RE);
  if (!m) return null;

  const body = m[1].trim();
  if (!body) return null;

  const tokens = tokenize(body);
  if (tokens.length === 0) return null;

  const path = tokens[0];
  if (!path) return null;

  const result: EmbedDirective = { path };

  for (let i = 1; i < tokens.length; i++) {
    const kv = tokens[i];
    const eqIdx = kv.indexOf('=');
    if (eqIdx === -1) continue;
    const key = kv.slice(0, eqIdx).toLowerCase();
    const val = unquote(kv.slice(eqIdx + 1));

    switch (key) {
      case 'sheet':
        result.sheet = val;
        break;
      case 'range':
        result.range = val;
        break;
      case 'headers':
        result.headers = parseInt(val, 10);
        break;
    }
  }

  return result;
}

/**
 * Tokenize a directive body, respecting quoted values.
 * "my file.csv" sheet="Sheet One" → ["my file.csv", "sheet=Sheet One"]
 */
function tokenize(body: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < body.length) {
    // Skip whitespace
    while (i < body.length && body[i] === ' ') i++;
    if (i >= body.length) break;

    let token = '';

    // Check for key=value where value might be quoted
    // Or a standalone quoted or unquoted value
    while (i < body.length && body[i] !== ' ') {
      if (body[i] === '"' || body[i] === "'") {
        const quote = body[i];
        i++; // skip opening quote
        while (i < body.length && body[i] !== quote) {
          token += body[i];
          i++;
        }
        if (i < body.length) i++; // skip closing quote
      } else {
        token += body[i];
        i++;
      }
    }

    if (token) tokens.push(token);
  }

  return tokens;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// HTML table rendering
// ---------------------------------------------------------------------------

/**
 * Render HtmlTableMeta as an HTML <table> string.
 */
export function renderHtmlTable(meta: HtmlTableMeta): string {
  const headerRows = meta.rows.filter(r => r.header);
  const bodyRows = meta.rows.filter(r => !r.header);

  let html = '<table>';

  if (headerRows.length > 0) {
    html += '<thead>';
    for (const row of headerRows) {
      html += '<tr>';
      for (const cell of row.cells) {
        const attrs = cellAttrs(cell);
        html += '<th' + attrs + '>' + renderRuns(cell.runs) + '</th>';
      }
      html += '</tr>';
    }
    html += '</thead>';
  }

  if (bodyRows.length > 0) {
    html += '<tbody>';
    for (const row of bodyRows) {
      html += '<tr>';
      for (const cell of row.cells) {
        const attrs = cellAttrs(cell);
        html += '<td' + attrs + '>' + renderRuns(cell.runs) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody>';
  }

  html += '</table>';
  return html;
}

function cellAttrs(cell: { colspan?: number; rowspan?: number }): string {
  let attrs = '';
  if (cell.colspan && cell.colspan > 1) attrs += ' colspan="' + cell.colspan + '"';
  if (cell.rowspan && cell.rowspan > 1) attrs += ' rowspan="' + cell.rowspan + '"';
  return attrs;
}

function renderRuns(runs: HtmlTableRun[]): string {
  let html = '';
  for (const run of runs) {
    if (run.type === 'hardbreak' || run.type === 'softbreak') {
      html += '<br>';
    } else {
      html += run.text;
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// Embed preprocessing
// ---------------------------------------------------------------------------

const TABLE_DIRECTIVE_RE = /^<!--\s*table-(font-size|font|orientation|col-widths):\s*.+?\s*-->$/;

/**
 * Preprocess embed directives in markdown source.
 * Replaces `<!-- embed: ... -->` with expanded HTML table markup.
 * Skips directives inside fenced code blocks.
 */
/**
 * Result of embed preprocessing, including the list of embed directives
 * found and their original comment text (in document order).
 */
export interface PreprocessEmbedsResult {
  output: string;
  /** Original directive text for each embed, in order of appearance. */
  embedDirectives: string[];
}

export function preprocessEmbeds(markdown: string, resolver: EmbedResolver, documentPath: string): string {
  return preprocessEmbedsTracked(markdown, resolver, documentPath).output;
}

/**
 * Preprocess embeds and track which directives were expanded.
 * Each expanded table gets a `data-embed-idx` attribute for round-trip tracking.
 */
export function preprocessEmbedsTracked(markdown: string, resolver: EmbedResolver, documentPath: string): PreprocessEmbedsResult {
  const lines = markdown.split('\n');
  const result: string[] = [];
  const embedDirectives: string[] = [];
  let i = 0;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  let embedIdx = 0;

  while (i < lines.length) {
    // Track fenced code blocks
    const fenceMatch = lines[i].match(/^ {0,3}([`~]{3,})/);
    if (fenceMatch) {
      const run = fenceMatch[1];
      const runChar = run[0] as '`' | '~';
      if (!fenceChar) {
        fenceChar = runChar;
        fenceLen = run.length;
      } else if (runChar === fenceChar && run.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      result.push(lines[i]);
      i++;
      continue;
    }
    if (fenceChar) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Check for embed directive
    const trimmed = lines[i].trim();
    const directive = parseEmbedDirective(trimmed);
    if (directive) {
      embedDirectives.push(trimmed);
      let expanded = resolveEmbed(directive, resolver, documentPath);

      // Tag the expanded table with data-embed-idx for round-trip tracking
      expanded = expanded.replace(/^<table/, '<table data-embed-idx="' + embedIdx + '"');
      embedIdx++;

      // Ensure blank line before
      if (result.length > 0 && result[result.length - 1].trim() !== '') {
        result.push('');
      }

      // Add expanded content
      const expandedLines = expanded.split('\n');
      for (const line of expandedLines) {
        result.push(line);
      }

      // Ensure blank line after
      if (i + 1 < lines.length && lines[i + 1]?.trim() !== '') {
        result.push('');
      }

      i++;
      continue;
    }

    result.push(lines[i]);
    i++;
  }

  return { output: result.join('\n'), embedDirectives };
}

function resolveEmbed(directive: EmbedDirective, resolver: EmbedResolver, documentPath: string): string {
  const absolutePath = resolver.resolveRelative(documentPath, directive.path);
  const data = resolver.readFile(absolutePath);

  if (!data) {
    return '<p><strong>Error: could not embed ' + directive.path + ' \u2014 file not found</strong></p>';
  }

  const ext = directive.path.toLowerCase().replace(/^.*\./, '.');

  try {
    switch (ext) {
      case '.csv':
        return resolveDelimited(data, ',', directive);
      case '.tsv':
        return resolveDelimited(data, '\t', directive);
      case '.xlsx':
        return resolveXlsx(data, directive);
      case '.md':
        return resolveMd(data);
      default:
        return '<p><strong>Error: unsupported embed format: ' + ext + '</strong></p>';
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return '<p><strong>Error: could not embed ' + directive.path + ' \u2014 ' + msg + '</strong></p>';
  }
}

function resolveDelimited(data: Uint8Array, delimiter: string, directive: EmbedDirective): string {
  const content = new TextDecoder().decode(data);
  const rows = parseCsv(content, delimiter);
  if (rows.length === 0) {
    return '<p><strong>Error: could not embed ' + directive.path + ' \u2014 file is empty</strong></p>';
  }
  const headerCount = directive.headers ?? 1;
  const meta = csvToHtmlTableMeta(rows, headerCount);
  return renderHtmlTable(meta);
}

function resolveXlsx(data: Uint8Array, directive: EmbedDirective): string {
  const meta = parseXlsx(data, {
    sheet: directive.sheet,
    range: directive.range,
    headers: directive.headers,
  });
  return renderHtmlTable(meta);
}

function resolveMd(data: Uint8Array): string {
  const content = new TextDecoder().decode(data);
  const lines = content.split('\n');
  const extracted: string[] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Blank lines are neutral — keep them in extracted if we're accumulating
    // directives or tables, don't trigger directive cleanup
    if (trimmed === '') {
      extracted.push(lines[i]);
      continue;
    }

    // Table directives preceding a table
    if (TABLE_DIRECTIVE_RE.test(trimmed)) {
      // Look ahead for a table — collect directive and keep going
      extracted.push(lines[i]);
      continue;
    }

    // HTML table block
    if (trimmed.startsWith('<table') || trimmed === '<table>') {
      inTable = true;
      extracted.push(lines[i]);
      if (trimmed.includes('</table>')) {
        inTable = false;
      }
      continue;
    }
    if (inTable) {
      extracted.push(lines[i]);
      if (trimmed.includes('</table>')) {
        inTable = false;
      }
      continue;
    }

    // Pipe table: line starting with |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      extracted.push(lines[i]);
      continue;
    }

    // Grid table separator
    if (/^\+[-=]+(\+[-=]+)*\+$/.test(trimmed)) {
      extracted.push(lines[i]);
      continue;
    }

    // If we were collecting directives but hit non-table content, drop the directives
    // by removing trailing directive lines from extracted
    while (extracted.length > 0 && TABLE_DIRECTIVE_RE.test(extracted[extracted.length - 1].trim())) {
      extracted.pop();
    }
  }

  return extracted.join('\n');
}

// ---------------------------------------------------------------------------
// WithMap variant for preview scroll sync
// ---------------------------------------------------------------------------

/**
 * Preprocess embeds and return a LineMap tracking the line expansion.
 * Uses the same buildMapFromLines approach as other preprocessors.
 */
export function preprocessEmbedsWithMap(
  src: string,
  resolver: EmbedResolver,
  documentPath: string,
): { output: string; map: LineMap } {
  const output = preprocessEmbeds(src, resolver, documentPath);
  if (output === src) return { output, map: LineMap.identity() };

  const origLines = src.split('\n');
  const outLines = output.split('\n');
  return { output, map: buildMapFromLines(origLines, outLines) };
}

/**
 * Build a LineMap by comparing original and output line arrays.
 * Mirrors the implementation in preprocess-with-map.ts.
 */
function buildMapFromLines(origLines: string[], outLines: string[]): LineMap {
  if (origLines.length === outLines.length) {
    let allMatch = true;
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== outLines[i]) { allMatch = false; break; }
    }
    if (allMatch) return LineMap.identity();
  }

  const segments: LineMapSegment[] = [];
  let oi = 0;
  let pi = 0;

  while (oi < origLines.length && pi < outLines.length) {
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

    let foundAnchor = false;
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

    if (!foundAnchor) break;
  }

  if (segments.length === 0) return LineMap.identity();
  return LineMap.fromSegments(segments);
}
