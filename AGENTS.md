# AGENTS.md - LLM Guidance for Manuscript Markdown

Treat this as a living document. Per-module invariants belong as comments in the relevant source file. Only truly cross-cutting items (spanning multiple files or general principles) belong here.

## What to read

User-facing: `README.md`, `docs/`
Extension: `src/extension.ts` (entry point), `src/changes.ts` (navigation), `src/formatting.ts` (text transformations), `src/preview/manuscript-markdown-plugin.ts` (preview), `syntaxes/manuscript-markdown.json` (syntax highlighting)
Conversion: `src/converter.ts` (docx → md), `src/md-to-docx.ts` (md → docx)
LSP: `src/lsp/server.ts` (language server — diagnostics, completions)

## Cross-cutting learnings

- Template literal corruption: never use `$$` in code touched by tool text-replacement operations — `$` is special in replacement strings and `$$` gets corrupted. Use string concatenation instead.
- Regex parity invariant: keep navigation (`src/changes.ts`) plain-highlight lookaround logic in lockstep with `syntaxes/manuscript-markdown.json` and mirrored regex test copies.
- Word dirty-flag invariants: see the 11 numbered invariants in the `md-to-docx.ts` file header. The `wt()` helper enforces invariant #1 (`xml:space="preserve"` only when needed).

Per-module invariants live as comments in the corresponding source files.

## Quick commands

- `bun install` — install dependencies
- `bun run compile` — build the extension
- `bun test` — run all tests
- `bun run watch` — watch mode
- `bun run package` — package the extension
