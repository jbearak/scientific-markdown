# Writing Technical Documentation

Manuscript Markdown also works well for technical documentation and general prose.

## Why use Manuscript Markdown for Docs?

- **Roundtrip to Word**: Easily collaborate with stakeholders who require Word documents.
- **Review Workflow**: Use CriticMarkup annotations in Markdown, or Word's Track Changes — the two are interchangeable.
- **Rich Formatting**: Full support for tables, code blocks, GitHub-style callouts (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`), and complex formatting.
- **Image Support**: Images are extracted from DOCX on import and embedded on export, with dimension and alt text preservation.

## Workflow

### 1. Drafting

Write in standard Markdown. Use the **Preview** (`Cmd+K V` / `Ctrl+K V`) to see your document rendered in real-time.

### 2. Code Blocks

Use fenced code blocks for syntax highlighting:

```python
def hello():
    print("Hello, world!")
```

### 3. Review and Feedback

When collaborating with others:

- **Peers using VS Code**: Can use the annotation toolbar to add `{++suggestions++}` and `{>>comments<<}`.
- **Stakeholders using Word**: Export to Word, let them use Track Changes and comments, then import back to Markdown. The converter preserves their change tracking.

### 4. Callouts and Notes

Use blockquotes for simple callouts:

```markdown
> This is a note or aside.
```

For GitHub-style typed callouts:

```markdown
> [!NOTE]
> Highlights information readers should be aware of.

> [!TIP]
> Optional advice to help readers succeed.

> [!WARNING]
> Critical information about risks or unexpected behavior.
```

Confluence-style panels are also supported — useful when pasting content from a Confluence page:

```markdown
~~~panel type=info
Highlight information in a coloured panel.
~~~

~~~panel type=success
Add tips or confirmations.
~~~

~~~panel type=error
Call out errors.
~~~
```

Both syntaxes accept any of these type names: `note`, `tip`, `important`, `warning`, `caution`, `info`, `error`, `success`. The word `note` means something different in each vocabulary (blue in GitHub, purple in Confluence). To pick which interpretation applies, set the `callout-style` frontmatter field:

```yaml
---
callout-style: confluence    # optional; defaults to "github"
---
```

Under `callout-style: confluence`, `note` renders as the purple Confluence panel. Under the default `callout-style: github`, `note` renders as the blue GitHub alert.

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

## Tips

- **Word Count**: Keep an eye on the status bar for document length.
- **Split View**: Open two different sections of the same document side by side, or view a reference file alongside your draft.
