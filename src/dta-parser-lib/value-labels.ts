// -----------------------------------------------------------
// Value label table parsing
//
// The <value_labels> section contains zero or more label
// tables, each wrapped in <lbl>...</lbl> tags. Each table
// maps integer values to string labels.
//
// Supports format versions 113-115 (legacy) and 117-119.
// -----------------------------------------------------------

import type { DtaMetadata } from './types';
import { is_legacy_format } from './types';

// -----------------------------------------------------------
// Constants
// -----------------------------------------------------------

const VALUE_LABELS_TAG = '<value_labels>';
const VALUE_LABELS_TAG_LENGTH = VALUE_LABELS_TAG.length;
const LBL_OPEN_TAG = '<lbl>';
const LBL_OPEN_TAG_LENGTH = LBL_OPEN_TAG.length; // 5
const LBL_CLOSE_TAG_LENGTH = 6; // "</lbl>"

// Label name field widths by format version
const LABEL_NAME_WIDTH: Record<number, number> = {
    113: 33,
    114: 33,
    115: 33,
    117: 33,
    118: 129,
    119: 129,
};

const PADDING_BYTES = 3;

const UTF8_DECODER = new TextDecoder('utf-8');

// -----------------------------------------------------------
// Shared label entry parser
// -----------------------------------------------------------

/**
 * Parse a single value label entry starting at `pos`.
 * The binary payload (n, txt_len, offsets[], values[],
 * text[]) is identical across all format versions.
 *
 * Returns the parsed label map and the position after
 * the entry.
 */
function parse_label_entry_payload(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    pos: number,
    entry_end: number
): { label_map: Map<number, string>; next_pos: number } {
    // n (int32): number of entries
    if (pos + 8 > entry_end) {
        throw new Error(
            'Corrupt value label table: truncated header'
        );
    }
    const my_n = view.getInt32(pos, little_endian);
    pos += 4;

    // txt_len (int32): total bytes in the text block
    const my_txt_len = view.getInt32(pos, little_endian);
    pos += 4;

    if (my_n < 0 || my_txt_len < 0) {
        throw new Error(
            'Corrupt value label table: negative count '
            + `or text length (n=${my_n}, `
            + `txt_len=${my_txt_len})`
        );
    }

    if (pos + my_n * 8 + my_txt_len > entry_end) {
        throw new Error(
            'Corrupt value label table: payload exceeds '
            + 'entry bounds'
        );
    }

    // offsets[n]: byte offsets into text block
    const the_offsets: number[] = [];
    for (let i = 0; i < my_n; i++) {
        the_offsets.push(
            view.getInt32(pos, little_endian)
        );
        pos += 4;
    }

    // values[n]: integer values
    const the_values: number[] = [];
    for (let i = 0; i < my_n; i++) {
        the_values.push(
            view.getInt32(pos, little_endian)
        );
        pos += 4;
    }

    // text block: packed null-terminated strings
    const my_text_start = pos;
    const my_label_map = new Map<number, string>();

    for (let i = 0; i < my_n; i++) {
        if (the_offsets[i] < 0
            || the_offsets[i] >= my_txt_len) {
            continue;
        }
        const my_str_start =
            my_text_start + the_offsets[i];
        let my_str_end = my_str_start;
        const my_str_limit =
            my_text_start + my_txt_len;

        while (
            my_str_end < my_str_limit
            && bytes[my_str_end] !== 0
        ) {
            my_str_end++;
        }

        const my_label = UTF8_DECODER.decode(
            bytes.subarray(my_str_start, my_str_end)
        );
        my_label_map.set(the_values[i], my_label);
    }

    return {
        label_map: my_label_map,
        next_pos: my_text_start + my_txt_len,
    };
}

/**
 * Read a null-terminated string from a fixed-width field.
 */
function read_label_name(
    bytes: Uint8Array,
    pos: number,
    name_width: number
): string {
    let my_end = pos;
    const my_limit = pos + name_width;
    while (my_end < my_limit && bytes[my_end] !== 0) {
        my_end++;
    }
    return UTF8_DECODER.decode(
        bytes.subarray(pos, my_end)
    );
}

// -----------------------------------------------------------
// Modern format (117-119): XML-wrapped entries
// -----------------------------------------------------------

function parse_modern_entries(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    name_width: number,
    start_pos: number,
    section_end: number
): Map<string, Map<number, string>> {
    const my_result = new Map<string, Map<number, string>>();
    let pos = start_pos;

    while (pos + LBL_OPEN_TAG_LENGTH <= section_end) {
        // Check for <lbl> opening tag
        if (
            bytes[pos] !== 0x3C     // '<'
            || bytes[pos + 1] !== 0x6C  // 'l'
            || bytes[pos + 2] !== 0x62  // 'b'
            || bytes[pos + 3] !== 0x6C  // 'l'
            || bytes[pos + 4] !== 0x3E  // '>'
        ) {
            break;
        }
        pos += LBL_OPEN_TAG_LENGTH;

        // table_length (int32)
        pos += 4;

        // label_name
        const my_label_name = read_label_name(
            bytes, pos, name_width
        );
        pos += name_width;

        // 3 bytes padding
        pos += PADDING_BYTES;

        // Parse the entry payload
        const { label_map, next_pos } =
            parse_label_entry_payload(
                bytes, view, little_endian, pos,
                section_end
            );
        my_result.set(my_label_name, label_map);

        // Skip past text block + </lbl>
        pos = next_pos + LBL_CLOSE_TAG_LENGTH;
    }

    return my_result;
}

// -----------------------------------------------------------
// Legacy format (113-115): no XML wrapper
// -----------------------------------------------------------

function parse_legacy_entries(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    name_width: number,
    start_pos: number,
    section_end: number
): Map<string, Map<number, string>> {
    const my_result = new Map<string, Map<number, string>>();
    let pos = start_pos;

    while (pos + 4 <= section_end) {
        // table_length (int32)
        const my_table_len = view.getInt32(
            pos, little_endian
        );
        if (my_table_len <= 0) break;
        pos += 4;

        // label_name
        const my_label_name = read_label_name(
            bytes, pos, name_width
        );
        pos += name_width;

        // 3 bytes padding
        pos += PADDING_BYTES;

        // Parse the entry payload (identical layout)
        const { label_map, next_pos } =
            parse_label_entry_payload(
                bytes, view, little_endian, pos,
                section_end
            );
        my_result.set(my_label_name, label_map);
        pos = next_pos;
    }

    return my_result;
}

// -----------------------------------------------------------
// Public API
// -----------------------------------------------------------

/**
 * Parse all value label tables from the value_labels
 * section of a .dta file.
 *
 * Returns a Map of table_name to a Map of integer_value
 * to label_string.
 */
export function parse_value_labels(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    base_offset: number = 0
): Map<string, Map<number, string>> {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const little_endian = metadata.byte_order === 'LSF';

    const my_name_width =
        LABEL_NAME_WIDTH[metadata.format_version];

    const my_legacy = is_legacy_format(
        metadata.format_version
    );

    // Start position: skip XML tag for modern formats
    const my_tag_skip = my_legacy
        ? 0
        : VALUE_LABELS_TAG_LENGTH;
    const my_start_pos =
        metadata.section_offsets.value_labels
        - base_offset
        + my_tag_skip;

    // Section end sentinel
    const my_section_end =
        metadata.section_offsets.stata_data_close
        - base_offset;

    if (my_legacy) {
        return parse_legacy_entries(
            bytes, view, little_endian,
            my_name_width, my_start_pos, my_section_end
        );
    }

    return parse_modern_entries(
        bytes, view, little_endian,
        my_name_width, my_start_pos, my_section_end
    );
}
