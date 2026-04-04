# Embedded Stata Dataset (.dta) Support

## Summary

Extend Manuscript Markdown's embedded tables to support Stata `.dta` files. The Sight submodule's dta-parser internals provide all the binary parsing needed. A new synchronous facade reads the full file from a `Uint8Array` (already supplied by the embed pipeline) and calls Sight's lower-level parsers directly, bypassing the async `DtaFile` class.

Design decisions for simplicity:
- Always apply value labels (no toggle).
- Always apply display formatting (no toggle).
- Missing values are colorized in the VS Code preview (red via `--vscode-editorError-foreground`); no color change in Word export.
- A .dta-specific file size limit prevents accidentally embedding huge datasets.

## New module: `src/dta-parser.ts`

Exports a synchronous function:

```typescript
function parseDta(data: Uint8Array, directive: EmbedDirective): string
```

### Buffer-based facade

Replaces `DtaFile`'s fd-based `read_range(fd, offset, length)` with `buffer.slice(offset, offset + length)` on the in-memory `Uint8Array`. Calls Sight's internal parsers:

- `parse_metadata` / `parse_legacy_metadata` (from `sight/src/dta-parser/header.ts` and `legacy-header.ts`) — metadata and section offsets
- `read_rows_from_data_buffer` (from `sight/src/dta-parser/data-reader.ts`) — observation data
- `build_gso_index` + strL pointer resolution (from `sight/src/dta-parser/strl-reader.ts`) — long string variables
- `parse_value_labels` (from `sight/src/dta-parser/value-labels.ts`) — categorical value mappings
- `apply_display_format` (from `sight/src/dta-parser/display-format.ts`) — numeric/date formatting
- `classify_missing_value`, `is_missing_value_object`, `missing_type_to_label_key` (from `sight/src/dta-parser/missing-values.ts`) — missing value detection

### File size limit

Before parsing, checks the byte length against the `manuscriptMarkdown.embedDtaMaxFileSize` setting (default 10,485,760 bytes = 10 MB). If exceeded, returns an error HTML paragraph instead of a table.

### Header rows

- **Default** (no `headers` parameter): variable names become the single header row.
- **`headers=N`**: the first N data rows become header rows. Variable names are **not** shown.

### Value labels

Always applied. For each cell:
1. If the variable has an associated value label table and the cell's value has an entry, display the label.
2. Otherwise, display the formatted value (via `apply_display_format`).

### Missing values

For cells classified as missing (`.`, `.a`–`.z`):
1. Look up the value label table — if a label exists for the missing code (using `missing_type_to_label_key`), display the label.
2. Otherwise, display the raw missing code (`.`, `.a`, etc.).
3. Wrap the displayed text in `<span class="mm-missing-value">`.

### Output

Returns an HTML `<table>` string, same format as the other embed resolvers (csv, xlsx, md).

## Embed pipeline: `src/embed-preprocess.ts`

Add `case '.dta'` to the `resolveEmbed()` switch statement (around line 306), calling the new `parseDta()` function. Same pattern as `.csv`, `.tsv`, `.xlsx`, `.md`.

## Preview: `src/preview/manuscript-markdown-plugin.ts`

Inject a CSS rule into the preview's `<style>` block:

```css
.mm-missing-value {
  color: var(--vscode-editorError-foreground);
}
```

This uses the same theme variable that Sight's data browser uses for missing values, so the color adapts to the user's VS Code theme.

## Word export: `src/md-to-docx.ts`

No special handling for `.mm-missing-value` spans. The HTML table parser will ignore the class — missing values render as plain unstyled text in Word output.

## VS Code setting

In `package.json` contributes.configuration:

```json
"manuscriptMarkdown.embedDtaMaxFileSize": {
  "type": "number",
  "default": 10485760,
  "description": "Maximum .dta file size in bytes for embed directives. Files larger than this are rejected with an error. Default: 10 MB."
}
```

## Test fixture

Create `test/fixtures/tables/embed.dta` using Stata on this machine. The dataset should be a small fruits table matching the existing fixture style:

| Fruit      | Season | Color  |
|------------|--------|--------|
| Apple      | Autumn | Red    |
| Mango      | Summer | Orange |
| .          |        |        |

Requirements:
- At least one missing value to exercise missing value rendering.
- At least one value-labeled variable to exercise value label lookup.
- Small enough to be a reasonable test fixture.

Add to `test/fixtures/tables.md`:

```markdown
### Stata dataset

<!-- embed: tables/embed.dta -->
```

## Documentation

### `README.md`

Line 65 — add `.dta` to the list:

> Embed tables from external .csv, .tsv, .xlsx, .dta, and .md files with a single directive

### `docs/embedded-tables.md`

Add a new section after "Markdown" (after line 60):

**Stata dataset (.dta)**

Document:
- Default behavior: variable names become the header row, value labels and display formats are always applied.
- `headers=N`: first N data rows replace variable names as header rows.
- Missing values (`.`, `.a`–`.z`) are colorized in the VS Code preview; displayed as the value label if one exists, otherwise the raw missing code.
- File size limit setting: `manuscriptMarkdown.embedDtaMaxFileSize` (default 10 MB).
- Supported formats: Stata 8+ (formats 113–115 and 117–119).

Add to the Parameters table:

| Param | Applies to | Default | Description |
|-------|-----------|---------|-------------|
| `headers` | .dta | Variable names | Number of data rows to use as headers (replaces variable names) |

Add to the Errors and Diagnostics table:

| Condition | Severity | Message |
|-----------|----------|---------|
| .dta file exceeds size limit | Error | `.dta file exceeds maximum size (<limit>)` |
| Unsupported .dta format version | Error | `unsupported .dta format` |
