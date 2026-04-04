// -----------------------------------------------------------
// Synchronous .dta parser facade
//
// Reads a .dta Uint8Array and returns an HTML <table> string.
// Calls Sight's internal parser modules directly, bypassing
// the async DtaFile class, because the embed pipeline is
// synchronous.
// -----------------------------------------------------------

import { parse_metadata } from '../sight/src/dta-parser/header';
import { parse_legacy_metadata } from '../sight/src/dta-parser/legacy-header';
import { read_rows_from_buffer } from '../sight/src/dta-parser/data-reader';
import { build_gso_index, resolve_strl } from '../sight/src/dta-parser/strl-reader';
import { parse_value_labels } from '../sight/src/dta-parser/value-labels';
import { apply_display_format } from '../sight/src/dta-parser/display-format';
import {
  is_missing_value_object,
  missing_type_to_label_key,
} from '../sight/src/dta-parser/missing-values';
import { is_legacy_format } from '../sight/src/dta-parser/types';
import type {
  DtaMetadata,
  VariableInfo,
  RowCell,
} from '../sight/src/dta-parser/types';
import type { EmbedDirective } from './embed-preprocess';

const DEFAULT_MAX_DTA_FILE_SIZE = 10_485_760; // 10 MB

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse a .dta file from a Uint8Array and return an HTML
 * <table> string.
 *
 * @param data - The full .dta file contents
 * @param directive - Embed directive (path and optional
 *   headers param)
 * @param maxFileSize - Maximum allowed file size in bytes
 *   (default 10 MB)
 */
export function parseDta(
  data: Uint8Array,
  directive: EmbedDirective,
  maxFileSize: number = DEFAULT_MAX_DTA_FILE_SIZE
): string {
  if (data.byteLength > maxFileSize) {
    const my_limit_mb = (maxFileSize / 1_048_576).toFixed(1);
    return '<p><strong>Error: .dta file exceeds maximum'
      + ' size (' + my_limit_mb + ' MB)</strong></p>';
  }

  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;

  // --- Parse metadata ---
  const my_first_byte = data[0];
  const my_is_legacy =
    my_first_byte === 113
    || my_first_byte === 114
    || my_first_byte === 115;

  let metadata: DtaMetadata;
  if (my_is_legacy) {
    metadata = parse_legacy_metadata(
      buffer, data.byteLength
    );
  } else {
    metadata = parse_metadata(buffer);
  }

  // --- Read all observation rows ---
  const the_rows = read_rows_from_buffer(
    buffer, metadata, 0, metadata.nobs
  );

  // --- Resolve strL variables ---
  const my_has_strl = metadata.variables.some(
    v => v.type === 'strL'
  );
  if (my_has_strl) {
    const my_gso_index = build_gso_index(buffer, metadata);
    const my_data_tag_len =
      is_legacy_format(metadata.format_version) ? 0 : 6;

    for (let r = 0; r < the_rows.length; r++) {
      for (let c = 0; c < metadata.nvar; c++) {
        const my_variable = metadata.variables[c];
        if (my_variable.type !== 'strL') continue;

        const my_pointer_offset =
          metadata.section_offsets.data
          + my_data_tag_len
          + r * metadata.obs_length
          + my_variable.byte_offset;

        const my_resolved = resolve_strl(
          buffer, metadata, my_gso_index,
          my_pointer_offset
        );
        if (my_resolved !== null) {
          the_rows[r][c] = my_resolved;
        }
      }
    }
  }

  // --- Parse value label tables ---
  const my_value_label_tables = parse_value_labels(
    buffer, metadata
  );

  // --- Determine header and body rows ---
  const the_variables = metadata.variables;
  const my_header_count = directive.headers;

  let the_header_rows: string[][];
  let my_body_start_idx: number;

  if (
    my_header_count !== undefined
    && my_header_count > 0
  ) {
    // Use first N data rows as headers
    the_header_rows = [];
    const my_limit = Math.min(
      my_header_count, the_rows.length
    );
    for (let r = 0; r < my_limit; r++) {
      the_header_rows.push(
        the_rows[r].map((my_cell, c) =>
          formatCell(
            my_cell,
            the_variables[c],
            my_value_label_tables
          )
        )
      );
    }
    my_body_start_idx = my_header_count;
  } else {
    // Default: variable names as header
    the_header_rows = [
      the_variables.map(v => escapeHtml(v.name))
    ];
    my_body_start_idx = 0;
  }

  // Build body rows
  const the_body_rows: string[][] = [];
  for (let r = my_body_start_idx; r < the_rows.length; r++) {
    the_body_rows.push(
      the_rows[r].map((my_cell, c) =>
        formatCell(
          my_cell,
          the_variables[c],
          my_value_label_tables
        )
      )
    );
  }

  // --- Render HTML table ---
  const the_parts: string[] = [];
  the_parts.push('<table>');

  if (the_header_rows.length > 0) {
    the_parts.push('<thead>');
    for (const my_row of the_header_rows) {
      the_parts.push('<tr>');
      for (const my_cell of my_row) {
        the_parts.push('<th>' + my_cell + '</th>');
      }
      the_parts.push('</tr>');
    }
    the_parts.push('</thead>');
  }

  if (the_body_rows.length > 0) {
    the_parts.push('<tbody>');
    for (const my_row of the_body_rows) {
      the_parts.push('<tr>');
      for (const my_cell of my_row) {
        the_parts.push('<td>' + my_cell + '</td>');
      }
      the_parts.push('</tr>');
    }
    the_parts.push('</tbody>');
  }

  the_parts.push('</table>');
  return the_parts.join('');
}

function formatCell(
  cell: RowCell,
  variable: VariableInfo,
  value_label_tables: Map<string, Map<number, string>>
): string {
  const my_label_table = variable.value_label_name
    ? value_label_tables.get(variable.value_label_name)
    : undefined;

  // Missing values
  if (is_missing_value_object(cell)) {
    let my_display: string;
    if (my_label_table) {
      const my_label_key = missing_type_to_label_key(
        cell.missing_type
      );
      const my_label = my_label_table.get(my_label_key);
      my_display = my_label ?? cell.missing_type;
    } else {
      my_display = cell.missing_type;
    }
    return '<span class="mm-missing-value">'
      + escapeHtml(my_display) + '</span>';
  }

  // Value label lookup (numeric values only)
  if (typeof cell === 'number' && my_label_table) {
    const my_label = my_label_table.get(cell);
    if (my_label !== undefined) {
      return escapeHtml(my_label);
    }
  }

  // Display format
  if (typeof cell === 'number') {
    const my_formatted = apply_display_format(
      cell, variable.format
    );
    return escapeHtml(my_formatted ?? String(cell));
  }

  // String values
  return escapeHtml(String(cell));
}
