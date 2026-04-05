// -----------------------------------------------------------
// .dta data section row reader
//
// Reads decoded observation data from the .dta data section
// using random-access seeks. Decodes raw bytes into
// JavaScript values based on each variable's storage type.
//
// Supports format versions 117, 118, and 119.
// -----------------------------------------------------------

import {
    classify_raw_double_missing_at,
    classify_raw_float_missing,
    classify_missing_value,
    make_missing_value,
} from './missing-values';
import type {
    DtaMetadata,
    MissingValue,
    Row,
    RowCell,
} from './types';
import { is_legacy_format } from './types';

// The <data> tag that precedes observation bytes
const DATA_TAG = '<data>';
const DATA_TAG_LENGTH = DATA_TAG.length; // 6 bytes

const UTF8_DECODER = new TextDecoder('utf-8');

/**
 * Read a fixed-width string field, stopping at the first
 * null byte. Returns the decoded UTF-8 string.
 */
function read_fixed_string(
    bytes: Uint8Array,
    offset: number,
    width: number
): string {
    let my_end = offset;
    const my_limit = offset + width;
    while (my_end < my_limit && bytes[my_end] !== 0) {
        my_end++;
    }
    return UTF8_DECODER.decode(
        bytes.subarray(offset, my_end)
    );
}

/**
 * Read a single cell value from the data section.
 *
 * Returns the decoded value: number, string, or null
 * (for missing values).
 */
function read_cell(
    view: DataView,
    bytes: Uint8Array,
    offset: number,
    type: string,
    width: number,
    little_endian: boolean
): RowCell {
    switch (type) {
        case 'byte': {
            const my_val = view.getInt8(offset);
            const my_missing_type = classify_missing_value(
                my_val,
                'byte'
            );
            if (my_missing_type) {
                return make_missing_value(my_missing_type);
            }
            return my_val;
        }
        case 'int': {
            const my_val = view.getInt16(
                offset, little_endian
            );
            const my_missing_type = classify_missing_value(
                my_val,
                'int'
            );
            if (my_missing_type) {
                return make_missing_value(my_missing_type);
            }
            return my_val;
        }
        case 'long': {
            const my_val = view.getInt32(
                offset, little_endian
            );
            const my_missing_type = classify_missing_value(
                my_val,
                'long'
            );
            if (my_missing_type) {
                return make_missing_value(my_missing_type);
            }
            return my_val;
        }
        case 'float': {
            const my_raw = view.getUint32(
                offset, little_endian
            );
            const my_missing_type =
                classify_raw_float_missing(my_raw);
            if (my_missing_type) {
                return make_missing_value(my_missing_type);
            }
            return view.getFloat32(
                offset, little_endian
            );
        }
        case 'double': {
            const my_missing_type =
                classify_raw_double_missing_at(
                view, offset, little_endian
            );
            if (my_missing_type) {
                return make_missing_value(my_missing_type);
            }
            return view.getFloat64(
                offset, little_endian
            );
        }
        case 'strL': {
            // strL pointers are 8-byte references into
            // the GSO block. Return placeholder for now.
            return '__strl__';
        }
        default: {
            // Fixed-length string: str1 through str2045
            return read_fixed_string(
                bytes, offset, width
            );
        }
    }
}

function read_rows_from_view(
    view: DataView,
    bytes: Uint8Array,
    metadata: DtaMetadata,
    row_base_offset: number,
    start: number,
    count: number,
    col_start?: number,
    col_end?: number
): Row[] {
    // Handle empty dataset or out-of-range start
    if (
        metadata.nobs === 0
        || start < 0
        || count <= 0
        || start >= metadata.nobs
    ) {
        return [];
    }

    // Clamp count so we don't read past the end
    const my_actual_count = Math.min(
        count, metadata.nobs - start
    );
    if (my_actual_count <= 0) return [];

    // Resolve and clamp column range
    const my_col_start = Math.max(0, col_start ?? 0);
    const my_col_end = Math.min(
        metadata.nvar, col_end ?? metadata.nvar
    );
    if (my_col_start >= my_col_end) {
        return [];
    }
    const little_endian = metadata.byte_order === 'LSF';
    const the_rows: Row[] = [];

    for (let i = 0; i < my_actual_count; i++) {
        const my_row_offset =
            row_base_offset + i * metadata.obs_length;
        const my_row: Row = [];

        for (
            let j = my_col_start;
            j < my_col_end;
            j++
        ) {
            const my_var = metadata.variables[j];
            const my_cell_offset =
                my_row_offset + my_var.byte_offset;

            my_row.push(
                read_cell(
                    view,
                    bytes,
                    my_cell_offset,
                    my_var.type,
                    my_var.byte_width,
                    little_endian
                )
            );
        }

        the_rows.push(my_row);
    }

    return the_rows;
}

/**
 * Read observation rows from a .dta buffer.
 *
 * @param buffer - The full .dta file as an ArrayBuffer
 * @param metadata - Parsed metadata from parse_metadata()
 * @param start - First row index (0-based)
 * @param count - Number of rows to read
 * @param col_start - First column index (inclusive, optional)
 * @param col_end - Last column index (exclusive, optional)
 * @returns Array of rows, each row an array of cell values
 */
export function read_rows_from_buffer(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    start: number,
    count: number,
    col_start?: number,
    col_end?: number
): Row[] {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Legacy formats (113–115) report section_offsets.data at the
    // first observation byte; modern formats include a <data> tag.
    const my_tag_length = is_legacy_format(
        metadata.format_version
    ) ? 0 : DATA_TAG_LENGTH;
    const my_data_start =
        metadata.section_offsets.data + my_tag_length;

    return read_rows_from_view(
        view,
        bytes,
        metadata,
        my_data_start + start * metadata.obs_length,
        start,
        count,
        col_start,
        col_end
    );
}

/**
 * Read observation rows from a buffer that contains only
 * contiguous observation bytes, starting at `start`.
 */
export function read_rows_from_data_buffer(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    start: number,
    count: number,
    col_start?: number,
    col_end?: number
): Row[] {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    return read_rows_from_view(
        view,
        bytes,
        metadata,
        0,
        start,
        count,
        col_start,
        col_end
    );
}
