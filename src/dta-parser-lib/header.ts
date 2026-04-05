// -----------------------------------------------------------
// .dta header and metadata parsing
//
// Parses the .dta binary file header, section map, variable
// types, names, formats, labels, and value label names.
// This is the metadata-only read path -- it reads everything
// except observation data, strL/GSO, and value-label tables.
//
// Supports format versions 117 (Stata 13), 118 (Stata 14),
// and 119 (Stata 15+).
// -----------------------------------------------------------

import type {
    FormatVersion,
    DtaMetadata,
    VariableInfo,
    SectionOffsets,
} from './types';
import {
    FORMAT_SIGNATURES,
    byte_width_for_type_code,
    type_code_to_dta_type,
} from './types';

// -----------------------------------------------------------
// Constants
// -----------------------------------------------------------

// Field widths that differ by format version
const FIELD_WIDTHS = {
    117: {
        varname: 33,
        format: 49,
        value_label_name: 33,
        variable_label: 81,
    },
    118: {
        varname: 129,
        format: 57,
        value_label_name: 129,
        variable_label: 321,
    },
    119: {
        varname: 129,
        format: 57,
        value_label_name: 129,
        variable_label: 321,
    },
} as const;

const SECTION_MAP_ENTRIES = 14;

const TEXT_DECODER = new TextDecoder('utf-8');

// Tag byte sequences (pre-encoded for scanning)
const TAG_BYTEORDER_OPEN = encode_tag('<byteorder>');
const TAG_BYTEORDER_CLOSE = encode_tag('</byteorder>');
const TAG_K_OPEN = encode_tag('<K>');
const TAG_K_CLOSE = encode_tag('</K>');
const TAG_N_OPEN = encode_tag('<N>');
const TAG_N_CLOSE = encode_tag('</N>');
const TAG_LABEL_OPEN = encode_tag('<label>');
const TAG_LABEL_CLOSE = encode_tag('</label>');
const TAG_TIMESTAMP_CLOSE = encode_tag('</timestamp>');
const TAG_MAP_OPEN = encode_tag('<map>');
const TAG_MAP_CLOSE = encode_tag('</map>');
const TAG_VARIABLE_TYPES_OPEN = encode_tag(
    '<variable_types>'
);
const TAG_VARNAMES_OPEN = encode_tag('<varnames>');
const TAG_FORMATS_OPEN = encode_tag('<formats>');
const TAG_VALUE_LABEL_NAMES_OPEN = encode_tag(
    '<value_label_names>'
);
const TAG_VARIABLE_LABELS_OPEN = encode_tag(
    '<variable_labels>'
);

// -----------------------------------------------------------
// Helpers
// -----------------------------------------------------------

function encode_tag(tag: string): Uint8Array {
    const my_buf = new Uint8Array(tag.length);
    for (let i = 0; i < tag.length; i++) {
        my_buf[i] = tag.charCodeAt(i);
    }
    return my_buf;
}

/**
 * Find the byte offset where `needle` starts in `haystack`,
 * searching forward from `start`. Returns -1 if not found.
 */
function find_bytes(
    haystack: Uint8Array,
    needle: Uint8Array,
    start: number
): number {
    const my_limit = haystack.length - needle.length;
    outer:
    for (let i = start; i <= my_limit; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                continue outer;
            }
        }
        return i;
    }
    return -1;
}

/**
 * Read a null-terminated ASCII string from a fixed-width
 * field. Returns the string up to the first zero byte (or
 * the full field if no zero is found).
 */
function read_fixed_string(
    bytes: Uint8Array,
    offset: number,
    field_width: number
): string {
    let my_end = offset;
    const my_limit = offset + field_width;
    while (my_end < my_limit && bytes[my_end] !== 0) {
        my_end++;
    }
    return TEXT_DECODER.decode(
        bytes.subarray(offset, my_end)
    );
}

// -----------------------------------------------------------
// Format version detection
// -----------------------------------------------------------

function detect_format_version(
    bytes: Uint8Array
): FormatVersion {
    for (const [my_ver_str, my_sig] of Object.entries(
        FORMAT_SIGNATURES
    )) {
        if (bytes.length < my_sig.length) continue;
        let my_match = true;
        for (let i = 0; i < my_sig.length; i++) {
            if (bytes[i] !== my_sig.charCodeAt(i)) {
                my_match = false;
                break;
            }
        }
        if (my_match) {
            return Number(my_ver_str) as FormatVersion;
        }
    }
    throw new Error(
        'Not a valid .dta file: unrecognized format signature'
    );
}

// -----------------------------------------------------------
// Header parsing
// -----------------------------------------------------------

function parse_byte_order(
    bytes: Uint8Array,
    start: number
): { byte_order: 'MSF' | 'LSF'; end: number } {
    const my_open = find_bytes(
        bytes, TAG_BYTEORDER_OPEN, start
    );
    if (my_open === -1) {
        throw new Error('Missing <byteorder> tag');
    }
    const my_data_start = my_open + TAG_BYTEORDER_OPEN.length;
    const my_close = find_bytes(
        bytes, TAG_BYTEORDER_CLOSE, my_data_start
    );
    if (my_close === -1) {
        throw new Error('Missing </byteorder> tag');
    }
    const my_str = TEXT_DECODER.decode(
        bytes.subarray(my_data_start, my_close)
    );
    if (my_str !== 'MSF' && my_str !== 'LSF') {
        throw new Error(
            `Invalid byte order: "${my_str}"`
        );
    }
    return {
        byte_order: my_str,
        end: my_close + TAG_BYTEORDER_CLOSE.length,
    };
}

function parse_nvar(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    format_version: FormatVersion,
    start: number
): { nvar: number; end: number } {
    const my_open = find_bytes(
        bytes, TAG_K_OPEN, start
    );
    if (my_open === -1) {
        throw new Error('Missing <K> tag');
    }
    const my_data_start = my_open + TAG_K_OPEN.length;

    let my_nvar: number;
    let my_data_end: number;
    if (format_version === 119) {
        // v119: uint32
        my_nvar = view.getUint32(
            my_data_start, little_endian
        );
        my_data_end = my_data_start + 4;
    } else {
        // v117, v118: uint16
        my_nvar = view.getUint16(
            my_data_start, little_endian
        );
        my_data_end = my_data_start + 2;
    }

    return { nvar: my_nvar, end: my_data_end };
}

function parse_nobs(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    format_version: FormatVersion,
    start: number
): { nobs: number; end: number } {
    const my_open = find_bytes(
        bytes, TAG_N_OPEN, start
    );
    if (my_open === -1) {
        throw new Error('Missing <N> tag');
    }
    const my_data_start = my_open + TAG_N_OPEN.length;

    let my_nobs: number;
    let my_data_end: number;
    if (format_version === 117 || format_version === 118) {
        // v117, v118: uint32
        my_nobs = view.getUint32(
            my_data_start, little_endian
        );
        my_data_end = my_data_start + 4;
    } else {
        // v119: uint64
        const my_big_nobs = view.getBigUint64(
            my_data_start, little_endian
        );
        if (my_big_nobs > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(
                'Dataset too large: observation count '
                + 'exceeds JavaScript safe integer limit'
            );
        }
        my_nobs = Number(my_big_nobs);
        my_data_end = my_data_start + 8;
    }

    return { nobs: my_nobs, end: my_data_end };
}

function parse_dataset_label(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    format_version: FormatVersion,
    start: number
): { dataset_label: string; end: number } {
    const my_open = find_bytes(
        bytes, TAG_LABEL_OPEN, start
    );
    if (my_open === -1) {
        throw new Error('Missing <label> tag');
    }
    const my_data_start = my_open + TAG_LABEL_OPEN.length;

    // Length prefix: uint8 for v117, uint16 for v118/v119
    let my_str_len: number;
    let my_str_start: number;
    if (format_version === 117) {
        my_str_len = view.getUint8(my_data_start);
        my_str_start = my_data_start + 1;
    } else {
        my_str_len = view.getUint16(
            my_data_start, little_endian
        );
        my_str_start = my_data_start + 2;
    }

    const my_label = TEXT_DECODER.decode(
        bytes.subarray(my_str_start, my_str_start + my_str_len)
    );

    // Skip past </label>
    const my_close = find_bytes(
        bytes, TAG_LABEL_CLOSE, my_str_start + my_str_len
    );
    if (my_close === -1) {
        throw new Error('Missing </label> tag');
    }

    return {
        dataset_label: my_label,
        end: my_close + TAG_LABEL_CLOSE.length,
    };
}

// -----------------------------------------------------------
// Section map parsing
// -----------------------------------------------------------

const SECTION_OFFSET_KEYS: (keyof SectionOffsets)[] = [
    'stata_data',
    'map',
    'variable_types',
    'varnames',
    'sortlist',
    'formats',
    'value_label_names',
    'variable_labels',
    'characteristics',
    'data',
    'strls',
    'value_labels',
    'stata_data_close',
    'end_of_file',
];

function parse_section_map(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    start: number
): SectionOffsets {
    const my_open = find_bytes(
        bytes, TAG_MAP_OPEN, start
    );
    if (my_open === -1) {
        throw new Error('Missing <map> tag');
    }
    const my_data_start = my_open + TAG_MAP_OPEN.length;

    const my_offsets = {} as SectionOffsets;
    for (let i = 0; i < SECTION_MAP_ENTRIES; i++) {
        const my_val = Number(view.getBigUint64(
            my_data_start + i * 8, little_endian
        ));
        my_offsets[SECTION_OFFSET_KEYS[i]] = my_val;
    }

    return my_offsets;
}

// -----------------------------------------------------------
// Variable metadata sections
// -----------------------------------------------------------

function parse_variable_types(
    bytes: Uint8Array,
    view: DataView,
    little_endian: boolean,
    offsets: SectionOffsets,
    nvar: number
): number[] {
    // Find start of data after the opening tag
    const my_tag_pos = find_bytes(
        bytes, TAG_VARIABLE_TYPES_OPEN, offsets.variable_types
    );
    if (my_tag_pos === -1) {
        throw new Error('Missing <variable_types> tag');
    }
    const my_data_start =
        my_tag_pos + TAG_VARIABLE_TYPES_OPEN.length;

    const my_required_bytes = nvar * 2;
    if (my_data_start + my_required_bytes > bytes.length) {
        throw new Error(
            'Corrupt .dta file: variable_types section '
            + 'truncated'
        );
    }

    const the_type_codes: number[] = [];
    for (let i = 0; i < nvar; i++) {
        the_type_codes.push(
            view.getUint16(
                my_data_start + i * 2, little_endian
            )
        );
    }
    return the_type_codes;
}

function parse_fixed_string_section(
    bytes: Uint8Array,
    tag: Uint8Array,
    search_start: number,
    nvar: number,
    field_width: number
): string[] {
    const my_tag_pos = find_bytes(
        bytes, tag, search_start
    );
    if (my_tag_pos === -1) {
        throw new Error(
            `Missing section tag at offset ${search_start}`
        );
    }
    const my_data_start = my_tag_pos + tag.length;

    const my_required_bytes = nvar * field_width;
    if (my_data_start + my_required_bytes > bytes.length) {
        throw new Error(
            'Corrupt .dta file: section truncated'
        );
    }

    const the_strings: string[] = [];
    for (let i = 0; i < nvar; i++) {
        the_strings.push(
            read_fixed_string(
                bytes,
                my_data_start + i * field_width,
                field_width
            )
        );
    }
    return the_strings;
}

// -----------------------------------------------------------
// Public API
// -----------------------------------------------------------

export function parse_metadata(
    buffer: ArrayBuffer
): DtaMetadata {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // 1. Detect format version from the file signature
    //    (always 117, 118, or 119 — legacy is handled
    //    by legacy-header.ts)
    const format_version = detect_format_version(bytes);
    const my_widths = FIELD_WIDTHS[
        format_version as 117 | 118 | 119
    ];

    // 2. Parse byte order
    const { byte_order, end: my_after_byteorder } =
        parse_byte_order(bytes, 0);
    const little_endian = byte_order === 'LSF';

    // 3. Parse K (number of variables)
    const { nvar, end: my_after_k } = parse_nvar(
        bytes, view, little_endian,
        format_version, my_after_byteorder
    );

    // 4. Parse N (number of observations)
    const { nobs, end: my_after_n } = parse_nobs(
        bytes, view, little_endian,
        format_version, my_after_k
    );

    // 5. Parse dataset label
    const { dataset_label, end: my_after_label } =
        parse_dataset_label(
            bytes, view, little_endian,
            format_version, my_after_n
        );

    // 6. Skip timestamp — find </timestamp> to locate
    //    the end of the header
    const my_ts_close = find_bytes(
        bytes, TAG_TIMESTAMP_CLOSE, my_after_label
    );
    if (my_ts_close === -1) {
        throw new Error('Missing </timestamp> tag');
    }

    // 7. Parse section map (14 x uint64 offsets)
    const section_offsets = parse_section_map(
        bytes, view, little_endian, my_ts_close
    );

    // 8. Parse variable type codes
    const the_type_codes = parse_variable_types(
        bytes, view, little_endian, section_offsets, nvar
    );

    // 9. Parse variable names
    const the_varnames = parse_fixed_string_section(
        bytes, TAG_VARNAMES_OPEN,
        section_offsets.varnames,
        nvar, my_widths.varname
    );

    // 10. Parse display formats
    const the_formats = parse_fixed_string_section(
        bytes, TAG_FORMATS_OPEN,
        section_offsets.formats,
        nvar, my_widths.format
    );

    // 11. Parse value label names
    const the_value_label_names =
        parse_fixed_string_section(
            bytes, TAG_VALUE_LABEL_NAMES_OPEN,
            section_offsets.value_label_names,
            nvar, my_widths.value_label_name
        );

    // 12. Parse variable labels
    const the_variable_labels =
        parse_fixed_string_section(
            bytes, TAG_VARIABLE_LABELS_OPEN,
            section_offsets.variable_labels,
            nvar, my_widths.variable_label
        );

    // 13. Build VariableInfo array with byte widths and
    //     cumulative offsets
    let my_running_offset = 0;
    const the_variables: VariableInfo[] = [];
    for (let i = 0; i < nvar; i++) {
        const my_code = the_type_codes[i];
        const my_width = byte_width_for_type_code(
            my_code, format_version
        );
        the_variables.push({
            name: the_varnames[i],
            type: type_code_to_dta_type(
                my_code, format_version
            ),
            type_code: my_code,
            format: the_formats[i],
            label: the_variable_labels[i],
            value_label_name: the_value_label_names[i],
            byte_width: my_width,
            byte_offset: my_running_offset,
        });
        my_running_offset += my_width;
    }

    return {
        format_version,
        byte_order,
        nvar,
        nobs,
        dataset_label,
        variables: the_variables,
        section_offsets,
        obs_length: my_running_offset,
    };
}
