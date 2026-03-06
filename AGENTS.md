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
- Regex parity invariant: keep navigation (`src/changes.ts`) plain-highlight lookaround logic in lockstep with `syntaxes/manuscript-markdown.json` and mirrored regex test copies.
- data-font attribute parsing: the regex uses separate double-quoted and single-quoted branches (not a shared `[^"']` class) so that apostrophes in double-quoted values like `"O'Brien Sans"` are preserved. The extracted value is HTML-entity-decoded and whitespace-normalized before use.
- Comment paraId invariant: md→docx writes comment `w14:paraId` on the last `<w:p>` in each comment; docx→md must read the last available paraId (with first-paragraph fallback for third-party files) so threading round-trips.
- Consecutive reply invariant: when consuming consecutive `critic_comment` runs, preserve any nested reply blocks (`replyRun.replies`) as child comments instead of dropping them.
- Notes namespace invariant: any XML part that may receive injected `w14:paraId` attributes (document/footnotes/endnotes) must declare `xmlns:w14`.
Per-module learnings live as comments in the corresponding source files.

## Quick commands

- `bun install` — install dependencies
- `bun run compile` — build the extension
- `bun test` — run all tests
- `bun run watch` — watch mode
- `bun run package` — package the extension
