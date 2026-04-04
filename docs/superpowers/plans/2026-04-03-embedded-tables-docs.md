# Embedded Tables Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-facing documentation for the embedded tables feature — a standalone reference page plus integration into README, specification, documentation guide, and converter docs.

**Architecture:** Documentation-only changes across 5 files: one new page (`docs/embedded-tables.md`) and edits to 4 existing pages. Each task produces one complete file change and a commit.

**Tech Stack:** Markdown

---

### Task 1: Create standalone page `docs/embedded-tables.md`

**Files:**
- Create: `docs/embedded-tables.md`

- [ ] **Step 1: Write the standalone page**

Create `docs/embedded-tables.md` with this content:

```markdown
# Embedded Tables

Tables can be written directly in your document as pipe tables, grid tables, or HTML tables. When your data lives in an external file — a spreadsheet, a CSV export, or a shared markdown file — you can embed it instead using a single directive. The embedded table behaves identically to an inline table for formatting, preview, and Word export.

## Syntax

```
<!-- embed: <path> [sheet=<name>] [range=<ref>] [headers=<n>] -->
```

File paths are resolved relative to the markdown file containing the directive. All values (including the file path) support optional single or double quotes to allow spaces:

```
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

```
<!-- embed: data/results.csv -->
<!-- embed: data/results.tsv headers=2 -->
```

CSV/TSV parsing follows RFC 4180: quoted fields may contain embedded newlines and the delimiter character, and `""` within a quoted field produces a literal `"`. The `headers` parameter controls how many rows are treated as header rows (default: 1).

### XLSX

Embed a sheet (or part of a sheet) from an Excel workbook:

```
<!-- embed: data/budget.xlsx -->
<!-- embed: data/budget.xlsx sheet=Summary range=A1:D10 -->
<!-- embed: data/budget.xlsx sheet=2 range=Q1Results -->
```

- **Sheet selection**: by name or 1-based index. If omitted, uses the first sheet.
- **Range**: a cell reference like `A1:D10`, or a named range defined in the workbook. If omitted, the bounding rectangle of all non-empty cells is used.
- **Merged cells**: preserved as `colspan`/`rowspan` in the output.

### Markdown

Embed tables from another markdown file:

```
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

When you export to Word, embed directives are expanded into full tables — the resulting DOCX contains the actual table data, not a reference to an external file. The original directive is preserved internally so that re-importing the DOCX recovers the embed reference rather than inlining the table as markdown.

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
```

- [ ] **Step 2: Verify the file reads correctly**

Run: `head -5 docs/embedded-tables.md`
Expected: The title and intro paragraph appear.

- [ ] **Step 3: Commit**

```bash
git add docs/embedded-tables.md
git commit -m "docs: add embedded tables reference page"
```

---

### Task 2: Add README feature bullet

**Files:**
- Modify: `README.md:63-64` (the "Formatting & Authoring" section)

- [ ] **Step 1: Add the embedded tables bullet**

In `README.md`, after the existing bullets under "Formatting & Authoring":

```markdown
- **Rich Text Support**: Markdown formatting toolbar for bold, italic, lists, headings, code, links, and tables
- **Preview**: Real-time syntax highlighting and Markdown preview rendering
```

Add:

```markdown
- **Embedded Tables**: Embed tables from external .csv, .tsv, .xlsx, and .md files with a [single directive](docs/embedded-tables.md)
```

- [ ] **Step 2: Add link to Documentation section**

In `README.md`, in the "Documentation" list (around line 77-91), add a link to the new page. Insert after the "DOCX Converter" entry:

```markdown
- [Embedded Tables](docs/embedded-tables.md)
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add embedded tables to README feature list and doc links"
```

---

### Task 3: Add Embedded Tables section to `docs/specification.md`

**Files:**
- Modify: `docs/specification.md:266` (insert after the "Page Orientation Sections" subsection ends at line 265, before "Code Block Styling Example" at line 267)

- [ ] **Step 1: Add the Embedded Tables section**

Insert the following between the end of the "Page Orientation Sections" subsection (line 265) and the "Code Block Styling Example" heading (line 267):

```markdown
### Embedded Tables

Embed tables from external files using an HTML comment directive:

```
<!-- embed: <path> [sheet=<name>] [range=<ref>] [headers=<n>] -->
```

File paths are resolved relative to the markdown file. Values support optional single or double quotes for paths with spaces.

| Param | Applies to | Default | Description |
|-------|-----------|---------|-------------|
| `sheet` | .xlsx | First sheet | Sheet name or 1-based index |
| `range` | .xlsx | Auto-detect bounding rectangle | Cell range (e.g. `A1:F20`) or named range |
| `headers` | .csv, .tsv, .xlsx | `1` | Number of header rows |

Supported file types: `.csv`, `.tsv`, `.xlsx`, and `.md` (tables only). Table directives (`table-font-size`, `table-font`, `table-orientation`, `table-col-widths`) placed before the embed comment apply to the resulting table, same as with inline tables.

See [Embedded Tables](embedded-tables.md) for file-type details, a worked example, error diagnostics, and round-trip behavior.
```

- [ ] **Step 2: Commit**

```bash
git add docs/specification.md
git commit -m "docs: add embedded tables syntax to specification"
```

---

### Task 4: Expand Tables section in `docs/guides/documentation.md`

**Files:**
- Modify: `docs/guides/documentation.md:55-65` (the "Tables" subsection, section 5)

- [ ] **Step 1: Expand the Tables section**

The current section 5 content:

```markdown
### 5. Tables

Create tables using standard Markdown syntax. For complex tables (merged cells), you can use HTML tables, which are fully supported and preserved during conversion.

```markdown
| Feature | Support |
|---------|---------|
| Tables  | Yes     |
| Code    | Yes     |
```
```

Replace it with:

```markdown
### 5. Tables

Create tables using standard Markdown syntax. For complex tables (merged cells), you can use HTML tables, which are fully supported and preserved during conversion.

```markdown
| Feature | Support |
|---------|---------|
| Tables  | Yes     |
| Code    | Yes     |
```

When your data lives in an external file, embed it instead of copying it into your document:

```markdown
<!-- table-font-size: 9 -->
<!-- embed: data/metrics.csv -->
```

This embeds the CSV as a table, with all the same formatting and export support as an inline table. Supported formats: `.csv`, `.tsv`, `.xlsx`, and `.md`. See [Embedded Tables](../embedded-tables.md) for the full syntax reference.
```

- [ ] **Step 2: Commit**

```bash
git add docs/guides/documentation.md
git commit -m "docs: add embedded tables example to documentation guide"
```

---

### Task 5: Add embed note to `docs/converter.md`

**Files:**
- Modify: `docs/converter.md:23-24` (the Tables bullet in the Round-Trip Features list)

- [ ] **Step 1: Add embed round-trip note**

The current Tables bullet in the Round-Trip Features list (line 24) ends with:

```
Markdown→DOCX export accepts pipe tables, grid tables, and HTML tables (with `colspan` and `rowspan` support)
```

Append to that same bullet:

```
. Embed directives (`<!-- embed: path -->`) are expanded into full tables on export; the original directive is stored in DOCX custom properties under the `MANUSCRIPT_EMBED_DIRECTIVES_` prefix so that re-importing the DOCX recovers the embed reference. See [Embedded Tables](embedded-tables.md)
```

- [ ] **Step 2: Commit**

```bash
git add docs/converter.md
git commit -m "docs: add embed directive round-trip note to converter docs"
```
