# Embedded Tables Documentation Design

## Goal

Add user-facing documentation for the embedded tables feature. Target audience is both existing users learning the new syntax and new users discovering the extension.

## Approach

A standalone reference page plus meaningful integration into existing pages — enough inline content at each integration point to be useful without clicking through, with links to the standalone page for full details.

## Standalone Page: `docs/embedded-tables.md`

### Structure

1. **Intro** — Frame embeds as an alternative to inline tables: tables can be written directly in your document as pipe tables, grid tables, or HTML tables; when your data lives in an external file (spreadsheet, CSV export, shared markdown file), you can embed it instead using a single directive. The embedded table behaves identically to an inline table for formatting, preview, and Word export.

2. **Syntax** — The directive format:

   ```
   <!-- embed: <path> [sheet=<name>] [range=<ref>] [headers=<n>] -->
   ```

   Parameter table:

   | Param | Applies to | Default | Description |
   |-------|-----------|---------|-------------|
   | `sheet` | .xlsx | First sheet | Sheet name or 1-based index |
   | `range` | .xlsx | Auto-detect bounding rectangle | Cell range (e.g. `A1:F20`) or named range |
   | `headers` | .csv, .tsv, .xlsx | `1` | Number of header rows |

   Notes: file paths resolve relative to the markdown file; values support optional single/double quotes for paths with spaces.

3. **File types** — A subsection per type:

   - **.csv / .tsv** — Delimiter-based parsing; supports quoted fields with embedded newlines; `headers` param controls header row count.
   - **.xlsx** — Sheet selection by name or index; cell range or named range; auto-detects bounding rectangle when range omitted; merged cells preserved as colspan/rowspan.
   - **.md** — Embeds table(s) from another markdown file; only table content and table directives are included; non-table content is silently ignored.

   Each subsection includes a syntax example.

4. **Worked example** — Scenario: a CSV file `data/survey-results.csv` with survey data (4-5 rows). Shows:
   - The CSV file contents
   - The markdown with formatting directives (`table-font-size`, `table-orientation`) followed by the embed directive
   - A note that this renders as a normal table in preview and Word output, and updating the CSV automatically updates the table on next preview/export

5. **Table directives** — How existing per-table directives (`table-font-size`, `table-font`, `table-orientation`, `table-col-widths`) work with embeds: place them before the embed comment, same as with inline tables.

6. **Round-trip** — Conceptual explanation: embed directives are expanded into full tables on Word export. The original directive is preserved internally so that re-importing the DOCX recovers the embed reference rather than inlining the table. If the external file changes between export and re-import, the next export picks up the updated data.

7. **Error messages** — What users see when:
   - File not found
   - File can't be parsed (malformed CSV, corrupt XLSX)
   - Sheet or named range not found (XLSX)
   - Invalid parameter syntax
   - File exists but produces no table rows (warning)
   - Embedded .md contains non-table content (info diagnostic)

   Note that errors appear both in the preview (as visible error text) and as LSP diagnostics in the editor.

8. **Frontmatter defaults** — Document-level table settings from frontmatter (`table-font`, `table-font-size`, `table-col-widths`, `table-borders`) apply to embedded tables the same as inline tables. Per-table directives override frontmatter defaults.

## Integration Points

### README.md

Add a bullet under "Formatting & Authoring":

> - **Embedded Tables**: Embed tables from external .csv, .tsv, .xlsx, and .md files with a single directive

### `docs/specification.md`

Add an "Embedded Tables" section (after the "Page Orientation Sections" subsection, which is the last table-related section in the frontmatter area) with:
- The directive syntax
- The parameter table (path, sheet, range, headers)
- A note that file paths resolve relative to the markdown file
- Link to standalone page for full details

### `docs/guides/documentation.md`

Expand the existing "Tables" subsection (section 5, currently 4 lines) with:
- A short CSV embed example with a formatting directive
- One sentence explaining what it does
- Link to standalone page

### `docs/converter.md`

Add a brief note that embed directives are expanded during md-to-docx conversion and preserved as custom properties for round-trip. Link to standalone page.
