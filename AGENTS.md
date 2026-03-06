# AGENTS.md - LLM Guidance for Manuscript Markdown

Treat this as a living document. When you fix a subtle bug, add a comment in the relevant source file and update pointers/invariants here.

## What to read

User-facing: `README.md`, `docs/`
Extension: `src/extension.ts` (entry point), `src/changes.ts` (navigation), `src/formatting.ts` (text transformations), `src/preview/manuscript-markdown-plugin.ts` (preview), `syntaxes/manuscript-markdown.json` (syntax highlighting)
Conversion: `src/converter.ts` (docx → md), `src/md-to-docx.ts` (md → docx)
LSP: `src/lsp/server.ts` (language server — diagnostics, completions)

## Cross-cutting learnings

- Template literal corruption: never use `$$` in code touched by tool text-replacement operations — `$` is special in replacement strings and `$$` gets corrupted. Use string concatenation instead.
- Word-save blockquotes: Word may rewrite `GitHub` style paragraphs to `GitHubBlockquote` and split hidden `\u200B_bqgN` metadata across multiple hidden runs. Keep blockquote style detection and hidden-run parsing robust to that rewrite.
- Comment attribution encoding: uses `@Author (Date) | text` syntax — the `@` prefix and `|` separator eliminate the old `:` ambiguity. No heuristic (`isLikelyCommentAuthorLabel`) is needed; if content starts with `@` and contains `|`, it's attributed, otherwise it's plain text.
- Hidden HTML comments: Word may split one hidden HTML comment run into many vanish runs; docx→md must concatenate contiguous hidden fragments (including `w:br`) until the full `<!-- ... -->` payload is reconstructed.
- Expand/Compact table safety: only convert selections that are exactly one HTML table block; mixed text+table selections must pass through unchanged to prevent content loss.
- Inline code in HTML-table cells: choose a backtick fence longer than the longest backtick run in cell text (and add fence padding only when content starts/ends with backticks) to preserve literal backticks.
- Pipe-table escaping invariant: when emitting HTML-table cell text to pipe tables, ensure each literal `|` has an odd number of preceding backslashes so parser splitting does not create extra columns.
- Table fallback cascade invariant: `renderTableOrFallback` in `converter.ts` uses a four-case cascade based on `storedFormat`: `'html'` → HTML directly; `'grid'` → grid (no width limit) → HTML (skip pipe); `'pipe'` → pipe (no width limit) → HTML (skip grid); `undefined` (plain DOCX) → pipe (with `pipeTableMaxLineWidth`) → grid (with `gridTableMaxLineWidth`) → HTML. Stored formats bypass their width limits to preserve round-trip fidelity. `gridTableMaxLineWidth` follows the same plumbing pattern as `pipeTableMaxLineWidth`: frontmatter field `grid-table-max-line-width`, custom property `MANUSCRIPT_GRID_TABLE_MAX_LINE_WIDTH`, resolution chain explicit > stored > caller default > 120.
- Regex parity invariant: keep navigation (`src/changes.ts`) plain-highlight lookaround logic in lockstep with `syntaxes/manuscript-markdown.json` and mirrored regex test copies.
- data-font attribute parsing: the regex uses separate double-quoted and single-quoted branches (not a shared `[^"']` class) so that apostrophes in double-quoted values like `"O'Brien Sans"` are preserved. The extracted value is HTML-entity-decoded and whitespace-normalized before use.
- Comment paraId invariant: md→docx writes comment `w14:paraId` on the last `<w:p>` in each comment; docx→md must read the last available paraId (with first-paragraph fallback for third-party files) so threading round-trips.
- Consecutive reply invariant: when consuming consecutive `critic_comment` runs, preserve any nested reply blocks (`replyRun.replies`) as child comments instead of dropping them.
- Notes namespace invariant: any XML part that may receive injected `w14:paraId` attributes (document/footnotes/endnotes) must declare `xmlns:w14`.
- Landscape section invariant: `<!-- landscape -->` / `<!-- /landscape -->` fences produce OOXML section breaks (empty `<w:p>` with `<w:sectPr>` in `<w:pPr>`). The `computeSegmentEnd` function in `converter.ts` must stop on `landscape_open`/`landscape_close` ContentItems to prevent `renderInlineRange` from consuming them. Template page dimensions are extracted from the template's body-level `<w:sectPr>` and swapped for landscape.
- Portrait section invariant: `<!-- portrait -->` / `<!-- /portrait -->` fences produce portrait-orientation section breaks (same page dimensions, no `w:orient`). Since portrait section breaks are indistinguishable from regular Word section breaks in OOXML, md→docx stores closing-break ordinals in `MANUSCRIPT_PORTRAIT_BREAKS_` custom property; docx→md uses these ordinals in `extractDocumentContent` to identify portrait fences.
- Consecutive section block invariant: when any close sentinel (`landscape_close` or `portrait_close`) is immediately followed by any open sentinel (`landscape_open` or `portrait_open`), the open's section break is skipped to avoid an empty intermediate page. This applies to all combinations: landscape→landscape, portrait→portrait, landscape→portrait, portrait→landscape.
- Template sectPr extraction invariant: md→docx template reuse must extract only the trailing body-level `<w:sectPr>` (the final `<w:sectPr>` before `</w:body>`). Paragraph-level section-break paragraphs also contain `<w:sectPr>` inside `<w:pPr>`; matching from those nodes leaks body content and corrupts output XML.
- Bibliography marker invariant: `<!-- references -->` / `<!-- bibliography -->` (case-insensitive) in `parseMd()` post-processing converts to a `bibliographyMarker` sentinel token. `generateDocumentXml()` emits a NUL-byte placeholder at that position, then replaces it after generating bibliography XML using `split(...).join(...)` (never `replace()`) to avoid `$`-corruption. On docx→md, a `bibliography_marker` ContentItem is pushed at ZOTERO_BIBL field-end; `buildMarkdown()` re-emits `<!-- references -->`. Trailing markers (bibliography at document end) are stripped in `convertDocx()`. No custom property is needed because ZOTERO_BIBL field position is directly observable in OOXML.
Per-module learnings live as comments in the corresponding source files.

## Quick commands

- `bun install` — install dependencies
- `bun run compile` — build the extension
- `bun test` — run all tests
- `bun run watch` — watch mode
- `bun run package` — package the extension
