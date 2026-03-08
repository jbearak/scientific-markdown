# Requirements Document

## Introduction

Add per-heading-level font configuration to the YAML frontmatter of Manuscript Markdown documents. Three new fields (`header-font`, `header-font-size`, `header-font-style`) allow authors to control heading typography independently of body text. Each field accepts a single value (applied uniformly to all heading levels) or an Inline_Array of up to six values using `[val1, val2, ...]` syntax or bare comma-separated values without brackets (one per heading level 1–6). Three analogous fields (`title-font`, `title-font-size`, `title-font-style`) provide per-element font control over the title array, where each array element maps to a successive title paragraph. The `title` field additionally gains Inline_Array support alongside its existing repeated-key format. When the array has fewer elements than the number of heading levels or title paragraphs, later entries inherit the last specified value. These fields, together with the existing `font`, `code-font`, `font-size`, and `code-font-size` fields, round-trip through the md→docx→md conversion pipeline and override any formatting supplied by a Word template file.

## Glossary

- **Frontmatter**: The YAML metadata block delimited by `---` at the top of a Manuscript Markdown file, parsed by `parseFrontmatter()` and serialized by `serializeFrontmatter()` in `src/frontmatter.ts`.
- **Converter**: The bidirectional conversion pipeline: `convertDocx()` (docx→md) in `src/converter.ts` and `convertMdToDocx()` (md→docx) in `src/md-to-docx.ts`.
- **FontOverrides**: The internal interface in `src/md-to-docx.ts` that carries resolved font configuration from Frontmatter to the docx generation functions (`stylesXml()` and `applyFontOverridesToTemplate()`).
- **Heading_Level**: An integer 1–6 corresponding to Markdown heading depths `#` through `######` and Word style IDs `Heading1` through `Heading6`.
- **Inline_Array**: A multi-value syntax for header font fields in Frontmatter. The canonical form uses YAML inline array brackets: `[val1, val2, ...]`. Brackets are optional: bare comma-separated values (e.g., `header-font: Georgia, Palatino, Helvetica`) are also accepted and treated identically to the bracketed form. The Frontmatter_Parser detects either format — a value starting with `[` and ending with `]`, or a value containing commas without brackets — splits on commas, and trims whitespace from each element.
- **Array_Inheritance**: The rule that when a font field array has fewer than six elements, heading levels beyond the array length inherit the value of the last element.
- **Font_Style**: A typographic style value: one of `bold`, `italic`, `underline`, `normal`, or any hyphenated combination of `bold`, `italic`, and `underline` in any order (e.g., `bold-italic`, `italic-bold`, `underline-bold-italic`). Hyphenated combinations are order-independent: the Parser normalizes them to a canonical form so that `italic-bold` and `bold-italic` are equivalent.
- **Title_Element**: A positional entry in the `title` array. Element 0 corresponds to the first title paragraph, element 1 to the second, and so on. Title font field arrays map to Title_Elements by index.
- **Template_File**: An optional `.docx` file whose `word/styles.xml` provides base formatting; frontmatter values override the template's heading styles.

## Requirements

### Requirement 1: Parse header-font from Frontmatter

**User Story:** As an author, I want to specify a `header-font` field in YAML frontmatter, so that I can control which typeface is used for headings independently of body text.

#### Acceptance Criteria

1. WHEN the Frontmatter contains a `header-font` field with a single value (no brackets, no commas), THE Frontmatter_Parser SHALL store the value as a one-element array in `headerFont`.
2. WHEN the Frontmatter contains a `header-font` field with Inline_Array syntax (e.g., `header-font: [Georgia, Palatino, Helvetica]`), THE Frontmatter_Parser SHALL parse the bracketed value, split on commas, trim whitespace from each element, and store the results as the `headerFont` array in order.
3. WHEN the Frontmatter contains a `header-font` field with bare comma-separated values (no brackets, e.g., `header-font: Georgia, Palatino, Helvetica`), THE Frontmatter_Parser SHALL split on commas, trim whitespace from each element, and store the results as the `headerFont` array in order, identically to the bracketed Inline_Array form.
4. IF the Frontmatter contains a `header-font` field using repeated YAML keys (multiple `header-font:` lines), THEN THE Frontmatter_Parser SHALL use only the last occurrence and ignore earlier lines.
5. WHEN the Frontmatter does not contain a `header-font` field, THE Frontmatter_Parser SHALL leave `headerFont` undefined.
6. WHEN `headerFont` is undefined and `font` is defined, THE Font_Resolver SHALL use the `font` value as the effective header font for all six heading levels.
7. WHEN `headerFont` is undefined and `font` is also undefined, THE Font_Resolver SHALL apply no header font override (template or default styling applies).

### Requirement 2: Parse header-font-size from Frontmatter

**User Story:** As an author, I want to specify a `header-font-size` field in YAML frontmatter, so that I can control heading sizes independently of body font size.

#### Acceptance Criteria

1. WHEN the Frontmatter contains a `header-font-size` field with a single positive finite number (no brackets, no commas), THE Frontmatter_Parser SHALL store the value as a one-element numeric array in `headerFontSize`.
2. WHEN the Frontmatter contains a `header-font-size` field with Inline_Array syntax (e.g., `header-font-size: [24, 20, 16]`), THE Frontmatter_Parser SHALL parse the bracketed value, split on commas, trim whitespace, parse each element as a number, and store valid positive finite numbers as the `headerFontSize` array in order.
3. WHEN the Frontmatter contains a `header-font-size` field with bare comma-separated values (no brackets, e.g., `header-font-size: 24, 20, 16`), THE Frontmatter_Parser SHALL split on commas, trim whitespace, parse each element as a number, and store valid positive finite numbers as the `headerFontSize` array in order, identically to the bracketed Inline_Array form.
4. IF the Frontmatter contains a `header-font-size` field using repeated YAML keys (multiple `header-font-size:` lines), THEN THE Frontmatter_Parser SHALL use only the last occurrence and ignore earlier lines.
5. IF a `header-font-size` value (whether single or an element within an Inline_Array or bare comma-separated list) is not a positive finite number, THEN THE Frontmatter_Parser SHALL ignore that value.
6. WHEN `headerFontSize` is undefined, THE Font_Resolver SHALL not apply any explicit heading size override from this field (existing proportional scaling from `font-size` or template defaults apply).

### Requirement 3: Parse header-font-style from Frontmatter

**User Story:** As an author, I want to specify a `header-font-style` field in YAML frontmatter, so that I can control whether headings are bold, italic, underlined, any combination thereof, or normal.

#### Acceptance Criteria

1. WHEN the Frontmatter contains a `header-font-style` field with a single valid Font_Style value (no brackets, no commas), THE Frontmatter_Parser SHALL store the normalized value as a one-element array in `headerFontStyle`.
2. WHEN the Frontmatter contains a `header-font-style` field with Inline_Array syntax (e.g., `header-font-style: [bold, italic, normal]`), THE Frontmatter_Parser SHALL parse the bracketed value, split on commas, trim whitespace, normalize each valid Font_Style element, and store the results as the `headerFontStyle` array in order.
3. WHEN the Frontmatter contains a `header-font-style` field with bare comma-separated values (no brackets, e.g., `header-font-style: bold, italic, normal`), THE Frontmatter_Parser SHALL split on commas, trim whitespace, normalize each valid Font_Style element, and store the results as the `headerFontStyle` array in order, identically to the bracketed Inline_Array form.
4. IF the Frontmatter contains a `header-font-style` field using repeated YAML keys (multiple `header-font-style:` lines), THEN THE Frontmatter_Parser SHALL use only the last occurrence and ignore earlier lines.
5. THE Frontmatter_Parser SHALL accept the following as valid Font_Style values: `bold`, `italic`, `underline`, `smallcaps`, `allcaps`, `center`, `normal`, and any hyphenated combination of those parts in any order (e.g., `bold-italic`, `italic-bold`, `bold-smallcaps`, `bold-center`), subject to the constraint that `smallcaps` and `allcaps` are mutually exclusive.
6. WHEN a Font_Style value is a hyphenated combination, THE Frontmatter_Parser SHALL normalize the value by sorting the component parts into a canonical order (`bold-italic-underline-smallcaps-allcaps-center`) so that order-independent equivalence holds (e.g., `italic-bold` normalizes to `bold-italic`, `center-bold` normalizes to `bold-center`).
7. IF a `header-font-style` value (whether single or an element within an Inline_Array or bare comma-separated list) contains duplicate parts, unrecognized parts, both `smallcaps` and `allcaps`, or is not a valid Font_Style value, THEN THE Frontmatter_Parser SHALL ignore that value.
8. WHEN `headerFontStyle` is undefined, THE Font_Resolver SHALL apply the default heading style (bold, matching current behavior).

### Requirement 4: Array Inheritance for heading levels

**User Story:** As an author, I want to specify fewer than six values for a header font field and have deeper headings inherit from the last specified value, so that I can configure headings concisely.

#### Acceptance Criteria

1. WHEN a header font field array contains fewer than six elements, THE Font_Resolver SHALL use the last element of the array as the effective value for all Heading_Levels beyond the array length.
2. WHEN a header font field array contains exactly six elements, THE Font_Resolver SHALL use element at index N−1 for Heading_Level N (1-indexed).
3. WHEN a header font field array contains more than six elements, THE Font_Resolver SHALL use only the first six elements and ignore the rest.
4. THE Font_Resolver SHALL apply Array_Inheritance identically to `header-font`, `header-font-size`, `header-font-style`, `title-font`, `title-font-size`, and `title-font-style` fields.

### Requirement 5: Serialize header font fields to Frontmatter

**User Story:** As an author, I want header font fields to be written back to YAML frontmatter when converting from docx, so that my heading configuration is preserved.

#### Acceptance Criteria

1. WHEN `headerFont` contains exactly one value, THE Frontmatter_Serializer SHALL emit a single `header-font:` line with the plain value (no brackets).
2. WHEN `headerFont` contains two or more values, THE Frontmatter_Serializer SHALL emit a single `header-font:` line using Inline_Array syntax (e.g., `header-font: [Georgia, Palatino, Helvetica]`).
3. WHEN `headerFontSize` contains exactly one value, THE Frontmatter_Serializer SHALL emit a single `header-font-size:` line with the plain value (no brackets).
4. WHEN `headerFontSize` contains two or more values, THE Frontmatter_Serializer SHALL emit a single `header-font-size:` line using Inline_Array syntax (e.g., `header-font-size: [24, 20, 16]`).
5. WHEN `headerFontStyle` contains exactly one value, THE Frontmatter_Serializer SHALL emit a single `header-font-style:` line with the plain value (no brackets).
6. WHEN `headerFontStyle` contains two or more values, THE Frontmatter_Serializer SHALL emit a single `header-font-style:` line using Inline_Array syntax (e.g., `header-font-style: [bold, italic, normal]`).
7. WHEN a header font field is undefined or an empty array, THE Frontmatter_Serializer SHALL omit the corresponding YAML key entirely.
8. WHEN `title` contains one or more values, THE Frontmatter_Serializer SHALL emit one `title:` line per array element in order (repeated-key format), preserving backward compatibility.
9. WHEN `titleFont` contains exactly one value, THE Frontmatter_Serializer SHALL emit a single `title-font:` line with the plain value (no brackets).
10. WHEN `titleFont` contains two or more values, THE Frontmatter_Serializer SHALL emit a single `title-font:` line using Inline_Array syntax (e.g., `title-font: [Georgia, Palatino]`).
11. WHEN `titleFontSize` contains exactly one value, THE Frontmatter_Serializer SHALL emit a single `title-font-size:` line with the plain value (no brackets).
12. WHEN `titleFontSize` contains two or more values, THE Frontmatter_Serializer SHALL emit a single `title-font-size:` line using Inline_Array syntax (e.g., `title-font-size: [24, 18]`).
13. WHEN `titleFontStyle` contains exactly one value, THE Frontmatter_Serializer SHALL emit a single `title-font-style:` line with the plain value (no brackets).
14. WHEN `titleFontStyle` contains two or more values, THE Frontmatter_Serializer SHALL emit a single `title-font-style:` line using Inline_Array syntax (e.g., `title-font-style: [bold, italic]`).
15. WHEN a title font field is undefined or an empty array, THE Frontmatter_Serializer SHALL omit the corresponding YAML key entirely.

### Requirement 6: Round-trip all font fields through md→docx→md

**User Story:** As an author, I want all font frontmatter fields to survive a round-trip conversion (md→docx→md), so that I do not lose my font configuration.

#### Acceptance Criteria

1. FOR ALL valid Frontmatter objects containing any combination of `font`, `code-font`, `font-size`, `code-font-size`, `header-font`, `header-font-size`, `header-font-style`, `title-font`, `title-font-size`, and `title-font-style`, parsing then serializing then parsing SHALL produce an equivalent Frontmatter object (parse–serialize–parse round-trip property).
2. FOR ALL valid Frontmatter objects containing header font fields or title font fields, converting to docx with `convertMdToDocx()` and back with `convertDocx()` SHALL produce a Frontmatter object with equivalent header font and title font field values (full pipeline round-trip property).

### Requirement 7: Apply header font overrides in md→docx (no template)

**User Story:** As an author, I want my header font settings to be reflected in the generated Word document when no template is used, so that the docx output matches my configuration.

#### Acceptance Criteria

1. WHEN `header-font` values are resolved for a Heading_Level, THE Docx_Generator SHALL set the `w:rFonts` element in the corresponding Word heading style to the resolved font name.
2. WHEN `header-font-size` values are resolved for a Heading_Level, THE Docx_Generator SHALL set the `w:sz` and `w:szCs` elements in the corresponding Word heading style to the resolved size in half-points (value × 2).
3. WHEN the normalized `header-font-style` for a Heading_Level includes `bold`, THE Docx_Generator SHALL include `<w:b/>` in the heading style run properties.
4. WHEN the normalized `header-font-style` for a Heading_Level does not include `bold`, THE Docx_Generator SHALL exclude `<w:b/>` from the heading style run properties.
5. WHEN the normalized `header-font-style` for a Heading_Level includes `italic`, THE Docx_Generator SHALL include `<w:i/>` in the heading style run properties.
6. WHEN the normalized `header-font-style` for a Heading_Level does not include `italic`, THE Docx_Generator SHALL exclude `<w:i/>` from the heading style run properties.
7. WHEN the normalized `header-font-style` for a Heading_Level includes `underline`, THE Docx_Generator SHALL include `<w:u w:val="single"/>` in the heading style run properties.
8. WHEN the normalized `header-font-style` for a Heading_Level does not include `underline`, THE Docx_Generator SHALL exclude `<w:u/>` from the heading style run properties.
9. WHEN `header-font-style` resolves to `normal` for a Heading_Level, THE Docx_Generator SHALL exclude `<w:b/>`, `<w:i/>`, and `<w:u/>` from the heading style run properties.
10. WHEN `header-font-size` is specified for a Heading_Level, THE Docx_Generator SHALL use the explicit size and not apply proportional scaling from `font-size` for that level.
11. WHEN `title-font` values are resolved for a Title_Element, THE Docx_Generator SHALL set the `w:rFonts` element in the run properties of the corresponding title paragraph to the resolved font name.
12. WHEN `title-font-size` values are resolved for a Title_Element, THE Docx_Generator SHALL set the `w:sz` and `w:szCs` elements in the run properties of the corresponding title paragraph to the resolved size in half-points (value × 2).
13. WHEN `title-font-style` values are resolved for a Title_Element, THE Docx_Generator SHALL apply the same `<w:b/>`, `<w:i/>`, `<w:u/>` logic as heading styles to the run properties of the corresponding title paragraph.
14. WHEN `title-font-style` resolves to `normal` for a Title_Element, THE Docx_Generator SHALL exclude `<w:b/>`, `<w:i/>`, and `<w:u/>` from the title paragraph run properties.

### Requirement 8: Apply header font overrides to Word template

**User Story:** As an author, I want my header font settings to override the heading styles in a Word template file, so that frontmatter takes precedence over template formatting.

#### Acceptance Criteria

1. WHEN a Template_File is provided and header font overrides are resolved, THE Template_Applicator SHALL replace the `w:rFonts`, `w:sz`, `w:szCs`, `w:b`, `w:i`, and `w:u` elements in each heading style of the template's `word/styles.xml` with the resolved values.
2. WHEN a Template_File is provided and a specific Heading_Level has no header font override, THE Template_Applicator SHALL preserve the template's existing formatting for that heading style.
3. WHEN a Template_File is provided and title font overrides are resolved, THE Template_Applicator SHALL replace the `w:rFonts`, `w:sz`, `w:szCs`, `w:b`, `w:i`, and `w:u` elements in the Title style of the template's `word/styles.xml` with the resolved values for the first Title_Element (since Word has a single Title style).
4. WHEN a Template_File is provided and no title font overrides are resolved, THE Template_Applicator SHALL preserve the template's existing formatting for the Title style.

### Requirement 9: Existing font field behavior preserved

**User Story:** As an author, I want the existing `font`, `code-font`, `font-size`, and `code-font-size` fields to continue working as before, so that adding header font fields does not break my existing documents.

#### Acceptance Criteria

1. THE Frontmatter_Parser SHALL continue to parse `font`, `code-font`, `font-size`, and `code-font-size` with identical behavior to the current implementation.
2. WHEN `font-size` is set and `header-font-size` is not set, THE Font_Resolver SHALL continue to apply proportional heading scaling from `font-size` (preserving the ratio relative to the default 11pt body size).
3. WHEN both `font-size` and `header-font-size` are set for a given Heading_Level, THE Font_Resolver SHALL use the `header-font-size` value and ignore the proportionally scaled value from `font-size` for that level.

### Requirement 10: Parse title field with repeated-key and Inline_Array support

**User Story:** As an author, I want to specify multiple title paragraphs using repeated `title:` keys (the primary and recommended format), with Inline_Array syntax available as a secondary alternative, so that multi-line titles are easy to write while maintaining backward compatibility.

#### Acceptance Criteria

1. WHEN the Frontmatter contains one or more `title:` lines with plain values (repeated-key format), THE Frontmatter_Parser SHALL store each value as successive elements of the `title` array in document order (preserving existing behavior). This is the primary format for specifying multiple title paragraphs.
2. WHEN the Frontmatter contains a single `title:` line with Inline_Array syntax (e.g., `title: [Line one, Line two]`), THE Frontmatter_Parser SHALL parse the bracketed value, split on commas, trim whitespace from each element, and store the results as the `title` array in order. This is a secondary alternative to repeated keys.
3. WHEN the Frontmatter contains both repeated-key `title:` lines and an Inline_Array `title:` line, THE Frontmatter_Parser SHALL use only the repeated-key values and ignore the Inline_Array line.
4. WHEN the Frontmatter contains a single `title:` line with a plain value (no brackets), THE Frontmatter_Parser SHALL store the value as a one-element array in `title` (preserving existing behavior).

### Requirement 11: Document design rationale for combined header-font-style field

**User Story:** As a future maintainer or contributor, I want the rationale for choosing a single combined `header-font-style` field over separate CSS-style fields (`font-style`, `font-weight`, `font-decoration`) to be documented in the spec and in the source code, so that the design decision is preserved and understood.

#### Acceptance Criteria

1. THE Spec_Documentation SHALL include a design rationale section (in requirements.md or design.md) explaining why a single `header-font-style` field was chosen over separate `font-style`, `font-weight`, and `font-decoration` fields.
2. THE Source_Code SHALL include comments near the font-style parsing and handling code in the TypeScript source explaining the design rationale for the combined field.
3. THE Design_Rationale SHALL document that a single combined field reduces complexity: one field is simpler for authors to manage than three separate fields.
4. THE Design_Rationale SHALL document that many manuscript authors are not web developers and would not be familiar with the CSS distinction between `font-style`, `font-weight`, and `text-decoration`, making separate CSS-style fields inaccessible to the target audience.
5. THE Design_Rationale SHALL document that Word does not support CSS-level font-weight customization (e.g., numeric weights 100–900); Word only provides bold on/off, so a separate `font-weight` field accepting numeric values would be misleading and create a false expectation of granularity.

### Requirement 12: Document multi-value syntax options for header font fields

**User Story:** As an author, I want the user-facing documentation (`specification.md`) to clearly describe both ways to specify multiple values for header font fields, so that I can choose the syntax that feels most natural.

#### Acceptance Criteria

1. THE Spec_Documentation SHALL include a section in `specification.md` that documents two equivalent syntaxes for specifying multiple values in `header-font`, `header-font-size`, `header-font-style`, `title-font`, `title-font-size`, and `title-font-style` fields.
2. THE Spec_Documentation SHALL present the bare comma-separated format (e.g., `header-font: Georgia, Palatino, Helvetica`) as the simpler, more casual option for authors who prefer minimal syntax.
3. THE Spec_Documentation SHALL present the YAML inline array format with brackets (e.g., `header-font: [Georgia, Palatino, Helvetica]`) as the more formal option for authors who prefer explicit YAML syntax.
4. THE Spec_Documentation SHALL state that both syntaxes are equivalent and produce identical results.
5. THE Spec_Documentation SHALL include at least one concrete example of each syntax for a header font field.
6. THE Spec_Documentation SHALL document the title font fields (`title-font`, `title-font-size`, `title-font-style`) alongside the header font fields, explaining that array elements map to title paragraphs by position.


### Requirement 13: Parse title-font from Frontmatter

**User Story:** As an author, I want to specify a `title-font` field in YAML frontmatter, so that I can control which typeface is used for each title paragraph independently of body text and heading fonts.

#### Acceptance Criteria

1. WHEN the Frontmatter contains a `title-font` field with a single value (no brackets, no commas), THE Frontmatter_Parser SHALL store the value as a one-element array in `titleFont`.
2. WHEN the Frontmatter contains a `title-font` field with Inline_Array syntax (e.g., `title-font: [Georgia, Palatino]`), THE Frontmatter_Parser SHALL parse the bracketed value, split on commas, trim whitespace from each element, and store the results as the `titleFont` array in order.
3. WHEN the Frontmatter contains a `title-font` field with bare comma-separated values (no brackets, e.g., `title-font: Georgia, Palatino`), THE Frontmatter_Parser SHALL split on commas, trim whitespace from each element, and store the results as the `titleFont` array in order, identically to the bracketed Inline_Array form.
4. IF the Frontmatter contains a `title-font` field using repeated YAML keys (multiple `title-font:` lines), THEN THE Frontmatter_Parser SHALL use only the last occurrence and ignore earlier lines.
5. WHEN the Frontmatter does not contain a `title-font` field, THE Frontmatter_Parser SHALL leave `titleFont` undefined.
6. WHEN `titleFont` is undefined and `font` is defined, THE Font_Resolver SHALL use the `font` value as the effective title font for all Title_Elements.
7. WHEN `titleFont` is undefined and `font` is also undefined, THE Font_Resolver SHALL apply no title font override (template or default styling applies).
8. WHEN the `titleFont` array has fewer elements than the number of Title_Elements, THE Font_Resolver SHALL use the last element of the `titleFont` array as the effective value for all Title_Elements beyond the array length (Array_Inheritance).

### Requirement 14: Parse title-font-size from Frontmatter

**User Story:** As an author, I want to specify a `title-font-size` field in YAML frontmatter, so that I can control the font size of each title paragraph independently.

#### Acceptance Criteria

1. WHEN the Frontmatter contains a `title-font-size` field with a single positive finite number (no brackets, no commas), THE Frontmatter_Parser SHALL store the value as a one-element numeric array in `titleFontSize`.
2. WHEN the Frontmatter contains a `title-font-size` field with Inline_Array syntax (e.g., `title-font-size: [24, 18]`), THE Frontmatter_Parser SHALL parse the bracketed value, split on commas, trim whitespace, parse each element as a number, and store valid positive finite numbers as the `titleFontSize` array in order.
3. WHEN the Frontmatter contains a `title-font-size` field with bare comma-separated values (no brackets, e.g., `title-font-size: 24, 18`), THE Frontmatter_Parser SHALL split on commas, trim whitespace, parse each element as a number, and store valid positive finite numbers as the `titleFontSize` array in order, identically to the bracketed Inline_Array form.
4. IF the Frontmatter contains a `title-font-size` field using repeated YAML keys (multiple `title-font-size:` lines), THEN THE Frontmatter_Parser SHALL use only the last occurrence and ignore earlier lines.
5. IF a `title-font-size` value (whether single or an element within an Inline_Array or bare comma-separated list) is not a positive finite number, THEN THE Frontmatter_Parser SHALL ignore that value.
6. WHEN `titleFontSize` is undefined, THE Font_Resolver SHALL not apply any explicit title size override from this field (template or default styling applies).
7. WHEN the `titleFontSize` array has fewer elements than the number of Title_Elements, THE Font_Resolver SHALL use the last element of the `titleFontSize` array as the effective value for all Title_Elements beyond the array length (Array_Inheritance).

### Requirement 15: Parse title-font-style from Frontmatter

**User Story:** As an author, I want to specify a `title-font-style` field in YAML frontmatter, so that I can control whether each title paragraph is bold, italic, underlined, any combination thereof, or normal.

#### Acceptance Criteria

1. WHEN the Frontmatter contains a `title-font-style` field with a single valid Font_Style value (no brackets, no commas), THE Frontmatter_Parser SHALL store the normalized value as a one-element array in `titleFontStyle`.
2. WHEN the Frontmatter contains a `title-font-style` field with Inline_Array syntax (e.g., `title-font-style: [bold, italic]`), THE Frontmatter_Parser SHALL parse the bracketed value, split on commas, trim whitespace, normalize each valid Font_Style element, and store the results as the `titleFontStyle` array in order.
3. WHEN the Frontmatter contains a `title-font-style` field with bare comma-separated values (no brackets, e.g., `title-font-style: bold, italic`), THE Frontmatter_Parser SHALL split on commas, trim whitespace, normalize each valid Font_Style element, and store the results as the `titleFontStyle` array in order, identically to the bracketed Inline_Array form.
4. IF the Frontmatter contains a `title-font-style` field using repeated YAML keys (multiple `title-font-style:` lines), THEN THE Frontmatter_Parser SHALL use only the last occurrence and ignore earlier lines.
5. THE Frontmatter_Parser SHALL accept the same Font_Style values for `title-font-style` as for `header-font-style`: `bold`, `italic`, `underline`, `normal`, and any hyphenated combination of `bold`, `italic`, and `underline` in any order.
6. WHEN a Font_Style value is a hyphenated combination, THE Frontmatter_Parser SHALL normalize the value using the same canonical ordering as `header-font-style` (`bold-italic-underline`).
7. IF a `title-font-style` value (whether single or an element within an Inline_Array or bare comma-separated list) contains duplicate parts, unrecognized parts, or is not a valid Font_Style value, THEN THE Frontmatter_Parser SHALL ignore that value.
8. WHEN `titleFontStyle` is undefined, THE Font_Resolver SHALL apply no explicit title font style override (template or default styling applies).
9. WHEN the `titleFontStyle` array has fewer elements than the number of Title_Elements, THE Font_Resolver SHALL use the last element of the `titleFontStyle` array as the effective value for all Title_Elements beyond the array length (Array_Inheritance).
