# Embedded Tables

Tables can be written directly in your document as pipe tables, grid tables, or HTML tables. When your data lives in an external file — a spreadsheet, a CSV export, or a shared markdown file — you can embed it instead using a single directive. The embedded table behaves identically to an inline table for formatting, preview, and Word export.

## Syntax

```markdown
<!-- embed: <path> [sheet=<name>] [range=<ref>] [headers=<n>] -->
```

File paths are resolved relative to the markdown file containing the directive. All values (including the file path) support optional single or double quotes to allow spaces:

```markdown
<!-- embed: "my data/results.xlsx" sheet='Sheet One' range=A1:F20 headers=2 -->
```

### Parameters

| Param | Applies to | Default | Description |
|-------|-----------|---------|-------------|
| `sheet` | .xlsx | First sheet | Sheet name or 1-based index |
| `range` | .xlsx | Auto-detect bounding rectangle | Cell range (e.g. `A1:F20`) or named range |
| `headers` | .csv, .tsv, .xlsx | `1` | Number of header rows |

## File Types

### CSV and TSV

Embed a comma-separated or tab-separated file:

```markdown
<!-- embed: data/results.csv -->
<!-- embed: data/results.tsv headers=2 -->
```

CSV/TSV parsing follows RFC 4180: quoted fields may contain embedded newlines and the delimiter character, and `""` within a quoted field produces a literal `"`. The `headers` parameter controls how many rows are treated as header rows (default: 1).

### XLSX

Embed a sheet (or part of a sheet) from an Excel workbook:

```markdown
<!-- embed: data/budget.xlsx -->
<!-- embed: data/budget.xlsx sheet=Summary range=A1:D10 -->
<!-- embed: data/budget.xlsx sheet=2 range=Q1Results -->
```

- **Sheet selection**: by name or 1-based index. If omitted, uses the first sheet.
- **Range**: a cell reference like `A1:D10`, or a named range defined in the workbook. If omitted, the bounding rectangle of all non-empty cells is used.
- **Merged cells**: preserved as `colspan`/`rowspan` in the output.

### Markdown

Embed tables from another markdown file:

```markdown
<!-- embed: shared/standard-table.md -->
```

Only table content (pipe tables, grid tables, HTML tables) and table directives (`table-font-size`, `table-font`, `table-orientation`, `table-col-widths`) are included from the embedded file. Non-table content is silently ignored, with an informational diagnostic in the editor.

## Example

Suppose you have a CSV file `data/survey-results.csv`:

```csv
Question,Agree,Neutral,Disagree
The interface is intuitive,72%,18%,10%
Documentation is sufficient,65%,20%,15%
Response time is acceptable,80%,12%,8%
I would recommend the product,74%,16%,10%
```

To embed it in your document as a landscape table with a smaller font:

```markdown
<!-- table-font-size: 9 -->
<!-- table-orientation: landscape -->
<!-- embed: data/survey-results.csv -->
```

This renders as a normal table in both the preview and Word output. If you update the CSV file, the table updates automatically the next time you preview or export.

## Using Table Directives with Embeds

Existing per-table directives work with embedded tables. Place them before the embed comment, the same way you would before an inline table:

```markdown
<!-- table-font-size: 9 -->
<!-- table-font: Arial -->
<!-- table-col-widths: 2 1 1 1 -->
<!-- embed: data/results.csv -->
```

Available directives: `table-font-size`, `table-font`, `table-orientation`, `table-col-widths`. See [Specification](specification.md) for details on each directive.

## Round-Trip Behavior

When you export to Word, embed directives are expanded into full tables — the resulting DOCX contains the actual table data, not a reference to an external file. The original directive is preserved internally so that re-importing the DOCX recovers the embed reference rather than inlining the table as Markdown.

If the external file changes between export and re-import, the next export picks up the updated data. The embedded file is always the source of truth.

## Errors and Diagnostics

If something goes wrong with an embed, you'll see feedback in two places: an error message rendered in the preview (in place of the table) and a diagnostic in the editor's Problems panel.

| Condition | Severity | Message |
|-----------|----------|---------|
| File not found | Error | `could not embed <path> — file not found` |
| Malformed CSV or corrupt XLSX | Error | `could not embed <path> — parse error` |
| Sheet not found (XLSX) | Error | `sheet '<name>' not found in <path>` |
| Named range not found (XLSX) | Error | `range '<name>' not found in <path>` |
| Invalid parameter syntax | Error | `invalid embed parameter: <detail>` |
| File produces no table rows | Warning | `<path> produced an empty table` |
| Embedded .md has non-table content | Info | `non-table content in <path> was ignored` |

## Frontmatter Defaults

Document-level table settings from YAML frontmatter — `table-font`, `table-font-size`, `table-col-widths`, `table-borders` — apply to embedded tables the same way they apply to inline tables. Per-table directives placed before the embed comment override frontmatter defaults.
