# Embedded Tables Design Spec

## Problem

Users need to embed tables from external files (.md, .csv, .tsv, .xlsx) into Manuscript Markdown documents. The current workaround — an R script replacing content between sentinels — works but uses non-standard syntax that is a barrier for some users.

## Syntax

A single HTML comment directive:

```
<!-- embed: <path> [sheet=<name>] [range=<ref>] [headers=<n>] -->
```

All values, including the file path, support optional single or double quotes to allow spaces:

```
<!-- embed: "my data/results.xlsx" sheet='Sheet One' range=A1:F20 headers=2 -->
```

### Parameters

| Param | Applies to | Default | Description |
|-------|-----------|---------|-------------|
| `sheet` | .xlsx | First sheet | Sheet name or 1-based index |
| `range` | .xlsx | Auto-detect bounding rectangle | Cell range (`A1:F20`) or named range |
| `headers` | .csv, .tsv, .xlsx | `1` | Number of header rows |

- **File paths** are resolved relative to the markdown file containing the directive.
- **Auto-detect bounding rectangle** (XLSX default): finds the leftmost, rightmost, topmost, and bottommost non-empty cell and uses that as the range.
- **Named ranges** (XLSX): if `range=` matches a defined name in the workbook, it resolves to the corresponding cell reference.

### .md embeds

Only the path parameter is accepted. The embedded file is expected to contain table(s) and optional table directives (`table-font-size`, `table-font`, `table-orientation`, `table-col-widths`). Non-table content is silently ignored (with an info-level LSP diagnostic).

### Interaction with table directives

Existing table directives work with embeds, placed before the embed comment:

```
<!-- table-font-size: 9 -->
<!-- table-orientation: landscape -->
<!-- embed: data/results.csv headers=1 -->
```

These apply to the resulting table, same as if it were an inline table.

## Architecture: Preprocessing Expansion

Embed resolution follows the established grid table pattern: a preprocessor runs early in the pipeline, replacing the embed comment with HTML table markup before markdown-it tokenization. All downstream code (directive post-processing, OOXML generation, preview rendering, scroll sync) sees a normal HTML table.

### New files

| File | Purpose |
|------|---------|
| `src/embed-preprocess.ts` | Directive parsing, file resolution, embed expansion |
| `src/csv-parser.ts` | RFC 4180-compliant CSV/TSV parser |
| `src/xlsx-parser.ts` | XLSX parsing via SheetJS |

### New dependency

- `xlsx` (SheetJS) — for XLSX parsing, merged cell detection, and named range resolution.

## Preprocessing & File Resolution

### `src/embed-preprocess.ts`

**Core function:** `preprocessEmbeds(markdown: string, resolver: EmbedResolver, documentPath: string): string`

- Scans for `<!-- embed: ... -->` comments, skipping fenced code blocks
- Calls the resolver to read and parse the external file
- Replaces the embed comment with the resulting HTML `<table>` markup
- Ensures blank lines around the replacement for markdown-it block parsing

**Directive parser:** `parseEmbedDirective(comment: string): EmbedDirective | null`

- Extracts path and key-value parameters
- Unquotes values wrapped in matching single or double quotes

**EmbedResolver interface:**

```typescript
interface EmbedResolver {
  readFile(absolutePath: string): Uint8Array | null;
  resolveRelative(basePath: string, relativePath: string): string;
}
```

Injected by callers: VS Code extension provides one backed by `workspace.fs`; md-to-docx provides one backed by Node `fs`. This keeps the preprocessor testable with in-memory fakes.

### File type handling

- **.md** — Read the file, extract only table blocks and preceding table directives, splice them in. Non-table content is dropped.
- **.csv / .tsv** — Parse into a 2D array, convert to HTML `<table>` string.
- **.xlsx** — Parse with SheetJS, resolve sheet/range/named-range parameters, detect merged cells, convert to HTML `<table>` string with `colspan`/`rowspan` attributes.

### Error handling

If a file can't be read or parsed, the preprocessor replaces the embed comment with an error placeholder paragraph (visible in both preview and Word output):

> Error: could not embed data/missing.csv — file not found

## CSV/TSV Parsing

### `src/csv-parser.ts`

**No external dependency.** A small RFC 4180-compliant parser.

**`parseCsv(content: string, delimiter: string): string[][]`**
- Returns a 2D array of cell values
- Handles quoted fields with embedded newlines, escaped quotes (`""`), and fields containing the delimiter
- Delimiter is `','` for .csv, `'\t'` for .tsv

**`csvToHtmlTableMeta(rows: string[][], headerCount: number): HtmlTableMeta`**
- Converts the 2D array into `HtmlTableMeta` (the existing type from `html-table-parser.ts`)
- First `headerCount` rows are marked as header rows
- Newlines within cells become `<br>` tags
- Cell content is HTML-escaped (`&`, `<`, `>`)
- The shared `renderHtmlTable(meta: HtmlTableMeta): string` function (in `embed-preprocess.ts`) then converts to an HTML `<table>` string — used by both CSV and XLSX paths

## XLSX Parsing

### `src/xlsx-parser.ts`

**Uses SheetJS (`xlsx` npm package).**

**`parseXlsx(data: Uint8Array, options?: { sheet?: string, range?: string, headers?: number }): HtmlTableMeta`**

**Sheet resolution:**
1. If `sheet` is a number, use as 1-based index
2. If `sheet` is a string, match by name
3. If omitted, use the first sheet

**Range resolution:**
1. If `range` is a cell reference (e.g. `A1:F20`), use directly
2. If `range` matches a defined name in the workbook, resolve it to a cell reference
3. If omitted, auto-detect: find the bounding rectangle of all non-empty cells

**Merged cell handling:**
- SheetJS exposes merge ranges via `sheet['!merges']`
- Each merge becomes `colspan` and/or `rowspan` on the top-left cell
- Cells covered by a merge are omitted from output

**Output:** Returns `HtmlTableMeta` (the existing type from `html-table-parser.ts`), feeding directly into the existing HTML table rendering pipeline.

Both CSV and XLSX paths produce `HtmlTableMeta`, which is then rendered to an HTML `<table>` string by the shared `renderHtmlTable()` function in `embed-preprocess.ts`.

## Round-Trip Preservation

When md-to-docx resolves an embed directive, the resulting Word table is indistinguishable from an inline table. To recover the directive on docx-to-md round-trip, the original directive text is stored as a custom property.

### Custom property: `MANUSCRIPT_EMBED_DIRECTIVES_`

- Keyed by table ordinal (0-based), same pattern as `MANUSCRIPT_TABLE_FORMATS_`
- Value: JSON mapping `{ [tableOrdinal]: directiveText }` where `directiveText` is the full original comment (e.g. `<!-- embed: data/results.csv headers=2 -->`)
- Stored via `chunkCustomProps('MANUSCRIPT_EMBED_DIRECTIVES_', JSON.stringify(mapping))`

### During docx-to-md (`converter.ts`):

- Extract the mapping via `extractIdMappingFromCustomXml(data, 'MANUSCRIPT_EMBED_DIRECTIVES')`
- When rendering a table whose ordinal has an embed directive entry, emit the directive text instead of rendering the table as markdown
- Table directives (font-size, orientation, etc.) are still stored in their own custom properties and emitted as preceding comments, same as today

### Edge case

If the embedded file has changed since the docx was generated, the round-tripped directive still references it correctly. The next md-to-docx conversion picks up the current file contents.

## Preview & Scroll Sync

### Preview resolution

The embed preprocessor runs first in the preprocessing chain. For the preview, the `EmbedResolver` is backed by VS Code's filesystem. The plugin entry point (`manuscriptMarkdownPlugin`) receives the resolver via a setter or markdown-it options.

**Preprocessing chain:**

```
preprocessEmbedsWithMap(src, resolver)
  → preprocessGridTablesWithMap
  → wrapBareLatexEnvironmentsWithMap
  → preprocessCriticMarkupWithMap
```

The `LineMap` is chained across all four steps.

### Scroll sync

An embed comment is one line in the source. The preprocessor replaces it with a multi-line HTML table. The existing `buildMapFromLines` function in `preprocess-with-map.ts` handles this automatically — it detects the divergent region and maps expanded lines back to the original source line. No changes needed to the LineMap machinery.

### Caching (preview only)

- `EmbedCache` stores `{ content: string, mtime: number }` keyed by absolute file path
- On each preview render, the preprocessor checks mtime before using cached content
- A `FileSystemWatcher` on `**/*.{csv,tsv,xlsx,md}` within the workspace invalidates cache entries on change/delete
- The watcher is registered in `extension.ts` activate and disposed on deactivate
- The md-to-docx path does not cache (runs once)

### Error handling in preview

If a file can't be read or parsed, the preprocessor replaces the embed comment with a styled HTML block showing the error, visible in the preview.

## LSP Diagnostics

### In `src/lsp/server.ts`:

Scan for embed directives during document validation and produce diagnostics:

| Severity | Condition |
|----------|-----------|
| Error | File not found at resolved path |
| Error | Unparseable file (malformed CSV, corrupt XLSX) |
| Error | Sheet not found (XLSX with explicit `sheet=` that doesn't exist) |
| Error | Named range not found (XLSX with explicit `range=` name that doesn't exist) |
| Error | Invalid parameter syntax (unrecognized param name, malformed value) |
| Warning | Empty result (file exists but produces no table rows) |
| Info | Embedded .md file contains non-table content (will be ignored) |

Each diagnostic is positioned on the embed comment's line, with the range spanning the relevant portion (e.g. the file path for "not found", the `sheet=` value for "sheet not found").

## Supported file types summary

| Format | Parser | Multiline cells | Merged cells | Header rows param |
|--------|--------|----------------|-------------|-------------------|
| .md | Built-in (extract tables) | Via source format | Via source format | N/A |
| .csv | Built-in RFC 4180 | Yes (quoted fields → `<br>`) | No | Yes |
| .tsv | Built-in RFC 4180 | Yes (quoted fields → `<br>`) | No | Yes |
| .xlsx | SheetJS | Yes | Yes (colspan/rowspan) | Yes |

All non-.md formats produce HTML `<table>` output.
