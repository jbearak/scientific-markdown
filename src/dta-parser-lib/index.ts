// -----------------------------------------------------------
// DtaFile — public API for reading .dta files
//
// Combines header parsing, data reading, strL resolution,
// and value label parsing into a single high-level class.
//
// Usage:
//   const file = await DtaFile.open('auto.dta');
//   console.log(file.nobs, file.nvar);
//   const rows = await file.read_rows(0, 100);
//   file.close();
// -----------------------------------------------------------

import * as fs from 'fs';
import { parse_metadata } from './header';
import {
    parse_legacy_metadata,
    legacy_metadata_buffer_size,
} from './legacy-header';
import { read_rows_from_data_buffer } from './data-reader';
import {
    build_gso_index,
    decode_gso_entry,
    read_strl_pointer,
    type GsoEntry,
} from './strl-reader';
import { parse_value_labels } from './value-labels';
import type {
    DtaMetadata,
    LegacyFormatVersion,
    VariableInfo,
    Row,
} from './types';
import { is_legacy_format } from './types';

// -----------------------------------------------------------
// Constants
// -----------------------------------------------------------
const INITIAL_METADATA_READ_SIZE = 64 * 1024;
const MAX_READ_RETRIES = 2;
const DATA_TAG_LENGTH = '<data>'.length;

// -----------------------------------------------------------
// DtaFile class
// -----------------------------------------------------------

export class DtaFile {
    private _fd: number | null;
    private readonly _metadata: DtaMetadata;
    private _gso_index: Map<string, GsoEntry>;
    private _value_label_tables: Map<
        string,
        Map<number, string>
    >;
    private _closed: boolean;

    // Precomputed: column indices of strL variables
    private readonly _strl_col_indices: number[];

    private constructor(
        fd: number,
        metadata: DtaMetadata,
        gso_index: Map<string, GsoEntry>,
        value_label_tables: Map<
            string,
            Map<number, string>
        >
    ) {
        this._fd = fd;
        this._metadata = metadata;
        this._gso_index = gso_index;
        this._value_label_tables = value_label_tables;
        this._closed = false;

        // Pre-scan for strL column indices
        const the_indices: number[] = [];
        for (
            let i = 0;
            i < metadata.variables.length;
            i++
        ) {
            if (metadata.variables[i].type === 'strL') {
                the_indices.push(i);
            }
        }
        this._strl_col_indices = the_indices;
    }

    /**
     * Open a .dta file and parse all metadata.
     *
     * Keeps the file descriptor open for fd-backed random
     * access. Only metadata and sidecar sections are loaded
     * into memory; observation rows are read on demand.
     */
    static async open(file_path: string): Promise<DtaFile> {
        const my_fd = fs.openSync(file_path, 'r');

        try {
            const my_file_size =
                fs.fstatSync(my_fd).size;
            const my_metadata = detect_and_parse_metadata(
                my_fd, my_file_size
            );

            const my_gso_index = read_gso_index(
                my_fd, my_metadata
            );
            const my_labels = read_value_labels(
                my_fd, my_metadata
            );

            return new DtaFile(
                my_fd,
                my_metadata,
                my_gso_index,
                my_labels
            );
        } catch (my_err) {
            fs.closeSync(my_fd);
            throw my_err;
        }
    }

    // -------------------------------------------------------
    // Public accessors
    // -------------------------------------------------------

    /** Number of observations (rows). */
    get nobs(): number {
        return this._metadata.nobs;
    }

    /** Number of variables (columns). */
    get nvar(): number {
        return this._metadata.nvar;
    }

    /** Variable metadata array. */
    get variables(): VariableInfo[] {
        return this._metadata.variables;
    }

    /** Dataset label string. */
    get dataset_label(): string {
        return this._metadata.dataset_label;
    }

    /** Value label tables (table_name -> value -> label). */
    get value_label_tables(): Map<
        string,
        Map<number, string>
    > {
        return this._value_label_tables;
    }

    // -------------------------------------------------------
    // Data reading
    // -------------------------------------------------------

    /**
     * Read observation rows, resolving strL pointers.
     *
     * @param start - First row index (0-based)
     * @param count - Number of rows to read
     * @param col_start - First column (inclusive, optional)
     * @param col_end - Last column (exclusive, optional)
     */
    async read_rows(
        start: number,
        count: number,
        col_start?: number,
        col_end?: number
    ): Promise<Row[]> {
        if (this._closed || this._fd === null) return [];

        const my_actual_count = Math.min(
            count,
            this._metadata.nobs - start
        );
        if (
            this._metadata.nobs === 0
            || start >= this._metadata.nobs
            || my_actual_count <= 0
        ) {
            return [];
        }

        const my_data_buffer = read_data_rows(
            this._fd,
            this._metadata,
            start,
            my_actual_count
        );
        const the_rows = read_rows_from_data_buffer(
            my_data_buffer,
            this._metadata,
            start,
            my_actual_count,
            col_start,
            col_end
        );

        // Resolve strL placeholders if any strL columns
        // fall within the requested column range
        if (this._strl_col_indices.length > 0) {
            this._resolve_strls(
                the_rows,
                my_data_buffer,
                col_start ?? 0,
                col_end ?? this._metadata.nvar
            );
        }

        return the_rows;
    }

    // -------------------------------------------------------
    // Resource management
    // -------------------------------------------------------

    /**
     * Release the open file handle and internal caches.
     * After close, read_rows returns empty arrays.
     */
    close(): void {
        if (this._fd !== null) {
            fs.closeSync(this._fd);
            this._fd = null;
        }
        this._closed = true;
        this._gso_index = new Map();
        this._value_label_tables = new Map();
    }

    // -------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------

    /**
     * Post-process rows to resolve strL placeholders.
     *
     * For each strL column in the requested range, decode
     * the pointer from the row buffer and fetch the GSO
     * payload through the open file descriptor.
     */
    private _resolve_strls(
        the_rows: Row[],
        data_buffer: ArrayBuffer,
        col_start: number,
        col_end: number
    ): void {
        if (this._fd === null) return;

        const my_view = new DataView(data_buffer);

        for (const my_abs_col of this._strl_col_indices) {
            // Skip columns outside the requested range
            if (
                my_abs_col < col_start
                || my_abs_col >= col_end
            ) {
                continue;
            }

            // Column index within the row array
            const my_row_col = my_abs_col - col_start;
            const my_var = this._metadata
                .variables[my_abs_col];

            for (let i = 0; i < the_rows.length; i++) {
                const my_pointer_offset =
                    i * this._metadata.obs_length
                    + my_var.byte_offset;
                const my_pointer = read_strl_pointer(
                    my_view,
                    this._metadata,
                    my_pointer_offset
                );
                if (!my_pointer) {
                    the_rows[i][my_row_col] = '';
                    continue;
                }

                const my_key =
                    my_pointer.v + ':' + my_pointer.o;
                const my_entry = this._gso_index.get(
                    my_key
                );
                if (!my_entry) {
                    the_rows[i][my_row_col] = '';
                    continue;
                }

                const my_resolved = read_gso_content(
                    this._fd,
                    my_entry
                );

                the_rows[i][my_row_col] =
                    my_resolved ?? '';
            }
        }
    }
}

// -----------------------------------------------------------
// Format detection and metadata dispatch
// -----------------------------------------------------------

// Legacy format version bytes
const LEGACY_VERSION_BYTES = new Set([113, 114, 115]);

// Minimum .dta file must have at least the version byte
const MIN_LEGACY_HEADER = 109;

function detect_and_parse_metadata(
    fd: number,
    file_size: number
): DtaMetadata {
    // Peek at the first byte to determine format family
    if (file_size < 1) {
        throw new Error(
            'Not a valid .dta file: file is empty'
        );
    }
    const my_probe = read_range(fd, 0, 1);
    const my_first_byte = new Uint8Array(my_probe)[0];

    if (LEGACY_VERSION_BYTES.has(my_first_byte)) {
        return read_legacy_metadata(fd, file_size);
    }

    return read_modern_metadata(fd, file_size);
}

function read_legacy_metadata(
    fd: number,
    file_size: number
): DtaMetadata {
    if (file_size < MIN_LEGACY_HEADER) {
        throw new Error(
            'Not a valid .dta file: too small for ' +
            'legacy header'
        );
    }

    // Read the fixed header to get nvar and format version
    const my_header = read_range(
        fd, 0, Math.min(file_size, MIN_LEGACY_HEADER)
    );
    const my_header_bytes = new Uint8Array(my_header);
    const my_version =
        my_header_bytes[0] as LegacyFormatVersion;
    const my_byte_order_code = my_header_bytes[1];
    const my_little_endian = my_byte_order_code === 2;
    const my_header_view = new DataView(my_header);
    const my_nvar = my_header_view.getUint16(
        4, my_little_endian
    );

    // Compute exact buffer size needed for all metadata
    const my_needed = legacy_metadata_buffer_size(
        my_nvar, my_version
    );
    const my_read_size = Math.min(file_size, my_needed);
    const my_buffer = read_range(fd, 0, my_read_size);

    return parse_legacy_metadata(my_buffer, file_size);
}

function read_modern_metadata(
    fd: number,
    file_size: number
): DtaMetadata {
    let my_read_size = Math.min(
        file_size,
        INITIAL_METADATA_READ_SIZE
    );
    let my_last_error: unknown = null;

    while (my_read_size <= file_size) {
        const my_buffer = read_range(
            fd,
            0,
            my_read_size
        );

        try {
            return parse_metadata(my_buffer);
        } catch (my_err) {
            my_last_error = my_err;
            if (
                my_err instanceof Error
                && my_err.message.includes(
                    'unrecognized format signature'
                )
            ) {
                throw new Error(
                    'Unsupported .dta format: only ' +
                    'Stata 8+ files (formats 113-115 ' +
                    'and 117-119) are supported'
                );
            }
            if (my_read_size === file_size) {
                break;
            }
            my_read_size = Math.min(
                file_size,
                my_read_size * 2
            );
        }
    }

    throw my_last_error;
}

function read_gso_index(
    fd: number,
    metadata: DtaMetadata
): Map<string, GsoEntry> {
    const my_has_strl = metadata.variables.some(
        my_var => my_var.type === 'strL'
    );
    if (!my_has_strl) {
        return new Map();
    }

    const my_section_start =
        metadata.section_offsets.strls;
    const my_section_length =
        metadata.section_offsets.value_labels
        - metadata.section_offsets.strls;
    if (my_section_length <= 0) {
        return new Map();
    }

    const my_buffer = read_range(
        fd,
        my_section_start,
        my_section_length
    );
    return build_gso_index(
        my_buffer,
        metadata,
        my_section_start
    );
}

function read_value_labels(
    fd: number,
    metadata: DtaMetadata
): Map<string, Map<number, string>> {
    const my_section_start =
        metadata.section_offsets.value_labels;
    const my_section_length =
        metadata.section_offsets.end_of_file
        - metadata.section_offsets.value_labels;
    if (my_section_length <= 0) {
        return new Map();
    }

    const my_buffer = read_range(
        fd,
        my_section_start,
        my_section_length
    );
    return parse_value_labels(
        my_buffer,
        metadata,
        my_section_start
    );
}

function read_data_rows(
    fd: number,
    metadata: DtaMetadata,
    start: number,
    count: number
): ArrayBuffer {
    const my_tag_length = is_legacy_format(
        metadata.format_version
    ) ? 0 : DATA_TAG_LENGTH;
    const my_offset =
        metadata.section_offsets.data
        + my_tag_length
        + start * metadata.obs_length;
    const my_length = count * metadata.obs_length;

    return read_range(fd, my_offset, my_length);
}

function read_gso_content(
    fd: number,
    entry: GsoEntry
): string {
    const my_buffer = read_range(
        fd,
        entry.content_offset,
        entry.content_length
    );
    return decode_gso_entry(
        new Uint8Array(my_buffer),
        {
            ...entry,
            content_offset: 0,
        }
    );
}

function read_range(
    fd: number,
    offset: number,
    length: number
): ArrayBuffer {
    const my_buffer = Buffer.allocUnsafe(length);
    let my_total_read = 0;
    let my_attempts = 0;

    while (my_total_read < length) {
        const my_bytes_read = fs.readSync(
            fd,
            my_buffer,
            my_total_read,
            length - my_total_read,
            offset + my_total_read
        );

        if (my_bytes_read === 0) {
            my_attempts++;
            if (my_attempts > MAX_READ_RETRIES) {
                throw new Error(
                    `Unexpected EOF while reading ${length} bytes ` +
                    `at offset ${offset}`
                );
            }
            continue;
        }

        my_total_read += my_bytes_read;
    }

    return my_buffer.buffer.slice(
        my_buffer.byteOffset,
        my_buffer.byteOffset + my_total_read
    ) as ArrayBuffer;
}

// -----------------------------------------------------------
// Barrel exports
// -----------------------------------------------------------

export type {
    VariableInfo,
    Row,
    RowCell,
    MissingType,
    MissingValue,
    DtaMetadata,
    DtaType,
    FormatVersion,
    LegacyFormatVersion,
    SectionOffsets,
} from './types';
export { is_legacy_format } from './types';
export { apply_display_format } from './display-format';
export {
    classify_missing_value,
    classify_raw_float_missing,
    classify_raw_double_missing_at,
    is_missing_value,
    is_missing_value_object,
    make_missing_value,
    missing_type_to_label_key,
    STATA_MISSING_B,
} from './missing-values';
