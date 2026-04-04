// -----------------------------------------------------------
// Legacy .dta header and metadata parsing (formats 113-115)
//
// Parses the fixed-offset binary header used by Stata 8-12.
// Produces the same DtaMetadata shape as the modern parser,
// with section offsets computed from nvar rather than read
// from a section map.
//
// Layout (all offsets are byte positions):
//   0:       format version (uint8: 113/114/115)
//   1:       byte order (uint8: 0x01=MSF, 0x02=LSF)
//   2:       filetype (always 0x01)
//   3:       unused
//   4-5:     nvar (int16)
//   6-9:     nobs (int32)
//   10-90:   dataset label (81 bytes, null-terminated)
//   91-108:  timestamp (18 bytes, null-terminated)
//   109+:    sequential variable metadata sections
// -----------------------------------------------------------

import type {
    DtaMetadata,
    LegacyFormatVersion,
    VariableInfo,
    SectionOffsets,
} from './types';
import {
    byte_width_for_legacy_type_code,
    legacy_type_code_to_dta_type,
} from './types';

// -----------------------------------------------------------
// Constants
// -----------------------------------------------------------

const HEADER_FIXED_SIZE = 109;

// Field widths shared by all legacy formats
const VARNAME_WIDTH = 33;
const VALUE_LABEL_NAME_WIDTH = 33;
const VARIABLE_LABEL_WIDTH = 81;
const SORTLIST_ENTRY_WIDTH = 2;

// Display format width differs for format 113
const FORMAT_WIDTH_113 = 12;
const FORMAT_WIDTH_114_115 = 49;

const TEXT_DECODER = new TextDecoder('ascii');

// -----------------------------------------------------------
// Helpers
// -----------------------------------------------------------

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

/**
 * Compute the minimum buffer size needed to read all
 * metadata sections for a legacy .dta file, given nvar.
 * This is everything up to and including the expansion
 * fields terminator (we add a generous allowance for
 * expansion fields since they're typically tiny).
 */
export function legacy_metadata_buffer_size(
    nvar: number,
    format_version: LegacyFormatVersion
): number {
    const my_fmt_width = format_version === 113
        ? FORMAT_WIDTH_113
        : FORMAT_WIDTH_114_115;

    const my_sections_size =
        nvar * 1                          // variable_types
        + nvar * VARNAME_WIDTH            // varnames
        + (nvar + 1) * SORTLIST_ENTRY_WIDTH // sortlist
        + nvar * my_fmt_width             // formats
        + nvar * VALUE_LABEL_NAME_WIDTH   // value_label_names
        + nvar * VARIABLE_LABEL_WIDTH;    // variable_labels

    // Add a generous allowance for expansion fields
    // (typically just the 5-byte terminator)
    return HEADER_FIXED_SIZE + my_sections_size + 65536;
}

// -----------------------------------------------------------
// Expansion field scanning
// -----------------------------------------------------------

/**
 * Scan past the expansion fields section and return the
 * byte offset immediately after it (= start of data).
 *
 * Expansion fields are a sequence of entries:
 *   uint8  data_type
 *   int32  len
 *   byte[len] content
 *
 * The section terminates when data_type=0 and len=0.
 */
function scan_expansion_fields(
    view: DataView,
    little_endian: boolean,
    start: number,
    buffer_length: number
): number {
    let pos = start;

    while (pos + 5 <= buffer_length) {
        const my_data_type = view.getUint8(pos);
        const my_len = view.getInt32(pos + 1, little_endian);

        pos += 5;

        if (my_data_type === 0 && my_len === 0) {
            return pos;
        }

        pos += my_len;
    }

    // If we run out of buffer, return current position
    // (the caller will detect EOF issues downstream)
    return pos;
}

// -----------------------------------------------------------
// Public API
// -----------------------------------------------------------

/**
 * Parse legacy .dta metadata from a buffer containing at
 * least the header and all variable metadata sections.
 *
 * The buffer does NOT need to contain the entire file —
 * it only needs to extend past the expansion fields.
 *
 * @param buffer - Buffer starting at byte 0 of the file
 * @param file_size - Total file size (for end_of_file)
 */
export function parse_legacy_metadata(
    buffer: ArrayBuffer,
    file_size: number
): DtaMetadata {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // 1. Format version
    const my_version_byte = bytes[0];
    if (
        my_version_byte !== 113
        && my_version_byte !== 114
        && my_version_byte !== 115
    ) {
        throw new Error(
            `Not a legacy .dta file: ` +
            `version byte ${my_version_byte}`
        );
    }
    const format_version =
        my_version_byte as LegacyFormatVersion;

    // 2. Byte order
    const my_byte_order_code = bytes[1];
    if (my_byte_order_code !== 1 && my_byte_order_code !== 2) {
        throw new Error(
            `Invalid byte order code: ${my_byte_order_code}`
        );
    }
    const byte_order: 'MSF' | 'LSF' =
        my_byte_order_code === 1 ? 'MSF' : 'LSF';
    const little_endian = byte_order === 'LSF';

    // 3. nvar (uint16 at bytes 4-5)
    const nvar = view.getUint16(4, little_endian);

    // 4. nobs (int32 at bytes 6-9)
    const nobs = view.getInt32(6, little_endian);
    if (nobs < 0) {
        throw new Error(
            `Invalid observation count: ${nobs}`
        );
    }

    // 5. Dataset label (81 bytes at 10-90)
    const dataset_label = read_fixed_string(bytes, 10, 81);

    // 6. Skip timestamp (18 bytes at 91-108)

    // 7. Compute section offsets from nvar
    const my_fmt_width = format_version === 113
        ? FORMAT_WIDTH_113
        : FORMAT_WIDTH_114_115;

    let pos = HEADER_FIXED_SIZE;

    // -- variable types: nvar × 1 byte --
    const my_variable_types_offset = pos;
    const the_type_codes: number[] = [];
    for (let i = 0; i < nvar; i++) {
        the_type_codes.push(bytes[pos + i]);
    }
    pos += nvar;

    // -- varnames: nvar × 33 bytes --
    const my_varnames_offset = pos;
    const the_varnames: string[] = [];
    for (let i = 0; i < nvar; i++) {
        the_varnames.push(
            read_fixed_string(
                bytes,
                pos + i * VARNAME_WIDTH,
                VARNAME_WIDTH
            )
        );
    }
    pos += nvar * VARNAME_WIDTH;

    // -- sortlist: (nvar+1) × 2 bytes --
    const my_sortlist_offset = pos;
    pos += (nvar + 1) * SORTLIST_ENTRY_WIDTH;

    // -- formats: nvar × fmt_width bytes --
    const my_formats_offset = pos;
    const the_formats: string[] = [];
    for (let i = 0; i < nvar; i++) {
        the_formats.push(
            read_fixed_string(
                bytes,
                pos + i * my_fmt_width,
                my_fmt_width
            )
        );
    }
    pos += nvar * my_fmt_width;

    // -- value_label_names: nvar × 33 bytes --
    const my_value_label_names_offset = pos;
    const the_value_label_names: string[] = [];
    for (let i = 0; i < nvar; i++) {
        the_value_label_names.push(
            read_fixed_string(
                bytes,
                pos + i * VALUE_LABEL_NAME_WIDTH,
                VALUE_LABEL_NAME_WIDTH
            )
        );
    }
    pos += nvar * VALUE_LABEL_NAME_WIDTH;

    // -- variable_labels: nvar × 81 bytes --
    const my_variable_labels_offset = pos;
    const the_variable_labels: string[] = [];
    for (let i = 0; i < nvar; i++) {
        the_variable_labels.push(
            read_fixed_string(
                bytes,
                pos + i * VARIABLE_LABEL_WIDTH,
                VARIABLE_LABEL_WIDTH
            )
        );
    }
    pos += nvar * VARIABLE_LABEL_WIDTH;

    // -- expansion fields --
    const my_expansion_offset = pos;
    const my_data_offset = scan_expansion_fields(
        view, little_endian, pos, buffer.byteLength
    );

    // 8. Build VariableInfo with byte widths and offsets
    let my_running_offset = 0;
    const the_variables: VariableInfo[] = [];
    for (let i = 0; i < nvar; i++) {
        const my_code = the_type_codes[i];
        const my_width =
            byte_width_for_legacy_type_code(my_code);
        the_variables.push({
            name: the_varnames[i],
            type: legacy_type_code_to_dta_type(my_code),
            type_code: my_code,
            format: the_formats[i],
            label: the_variable_labels[i],
            value_label_name: the_value_label_names[i],
            byte_width: my_width,
            byte_offset: my_running_offset,
        });
        my_running_offset += my_width;
    }
    const obs_length = my_running_offset;

    // 9. Compute value labels offset (BigInt to avoid
    //    overflow for large legacy files)
    const my_value_labels_offset = Number(
        BigInt(my_data_offset)
        + BigInt(nobs) * BigInt(obs_length)
    );

    // 10. Synthesize SectionOffsets
    const section_offsets: SectionOffsets = {
        stata_data: 0,
        map: 0,
        variable_types: my_variable_types_offset,
        varnames: my_varnames_offset,
        sortlist: my_sortlist_offset,
        formats: my_formats_offset,
        value_label_names: my_value_label_names_offset,
        variable_labels: my_variable_labels_offset,
        characteristics: my_expansion_offset,
        data: my_data_offset,
        strls: my_value_labels_offset,
        value_labels: my_value_labels_offset,
        stata_data_close: file_size,
        end_of_file: file_size,
    };

    return {
        format_version,
        byte_order,
        nvar,
        nobs,
        dataset_label,
        variables: the_variables,
        section_offsets,
        obs_length,
    };
}
