// -----------------------------------------------------------
// .dta format types, constants, and helper functions
// -----------------------------------------------------------

// Format version detection strings (first bytes of a .dta file)
export const FORMAT_SIGNATURES = {
    117: '<stata_dta><header><release>117</release>',
    118: '<stata_dta><header><release>118</release>',
    119: '<stata_dta><header><release>119</release>',
} as const;

export type FormatVersion =
    | 113 | 114 | 115
    | 117 | 118 | 119;

export type LegacyFormatVersion = 113 | 114 | 115;

const LEGACY_FORMAT_SET = new Set<number>([113, 114, 115]);

export function is_legacy_format(
    version: FormatVersion
): version is LegacyFormatVersion {
    return LEGACY_FORMAT_SET.has(version);
}

// Type codes vary by format version. v117 uses one set of
// numeric codes; v118/v119 share another.

const V117_TYPE_CODES: Record<number, { type: string; width: number }> = {
    251: { type: 'byte',   width: 1 },
    252: { type: 'int',    width: 2 },
    253: { type: 'long',   width: 4 },
    254: { type: 'float',  width: 4 },
    255: { type: 'double', width: 8 },
    32768: { type: 'strL', width: 8 },
};

const V118_TYPE_CODES: Record<number, { type: string; width: number }> = {
    65530: { type: 'byte',   width: 1 },
    65529: { type: 'int',    width: 2 },
    65528: { type: 'long',   width: 4 },
    65527: { type: 'float',  width: 4 },
    65526: { type: 'double', width: 8 },
    32768: { type: 'strL',   width: 8 },
};

// Maximum fixed-string width per format version
const MAX_STR_WIDTH_V117 = 244;
const MAX_STR_WIDTH_V118 = 2045;

// DtaType — the logical Stata storage type
export type DtaType =
    | 'byte'
    | 'int'
    | 'long'
    | 'float'
    | 'double'
    | 'strL'
    | `str${number}`;

/**
 * Return the byte width for a numeric type code in the
 * given format version. Fixed-string codes (1..244 for
 * v117, 1..2045 for v118/v119) equal their own width.
 *
 * Note: Modern Stata (16+) writes v118 type codes even
 * in saveold v117 files, so v117 accepts both code sets.
 */
export function byte_width_for_type_code(
    code: number,
    format_version: FormatVersion
): number {
    if (format_version === 117) {
        const my_entry = V117_TYPE_CODES[code]
            ?? V118_TYPE_CODES[code];
        if (my_entry) return my_entry.width;

        if (code >= 1 && code <= MAX_STR_WIDTH_V117) {
            return code;
        }
    } else {
        const my_entry = V118_TYPE_CODES[code];
        if (my_entry) return my_entry.width;

        if (code >= 1 && code <= MAX_STR_WIDTH_V118) {
            return code;
        }
    }

    throw new Error(
        `Unknown type code ${code} for format v${format_version}`
    );
}

/**
 * Convert a numeric type code to its DtaType label.
 *
 * Note: Modern Stata (16+) writes v118 type codes even
 * in saveold v117 files, so v117 accepts both code sets.
 */
export function type_code_to_dta_type(
    code: number,
    format_version: FormatVersion
): DtaType {
    if (format_version === 117) {
        const my_entry = V117_TYPE_CODES[code]
            ?? V118_TYPE_CODES[code];
        if (my_entry) return my_entry.type as DtaType;

        if (code >= 1 && code <= MAX_STR_WIDTH_V117) {
            return `str${code}` as DtaType;
        }
    } else {
        const my_entry = V118_TYPE_CODES[code];
        if (my_entry) return my_entry.type as DtaType;

        if (code >= 1 && code <= MAX_STR_WIDTH_V118) {
            return `str${code}` as DtaType;
        }
    }

    throw new Error(
        `Unknown type code ${code} for format v${format_version}`
    );
}

// -----------------------------------------------------------
// Legacy format type codes (113/114/115)
//
// Legacy formats use 1-byte type codes. Numeric codes match
// the v117 set. Fixed strings are 1-244. No strL type.
// -----------------------------------------------------------

const LEGACY_TYPE_CODES: Record<
    number,
    { type: string; width: number }
> = {
    251: { type: 'byte',   width: 1 },
    252: { type: 'int',    width: 2 },
    253: { type: 'long',   width: 4 },
    254: { type: 'float',  width: 4 },
    255: { type: 'double', width: 8 },
};

const MAX_STR_WIDTH_LEGACY = 244;

export function byte_width_for_legacy_type_code(
    code: number
): number {
    const my_entry = LEGACY_TYPE_CODES[code];
    if (my_entry) return my_entry.width;
    if (code >= 1 && code <= MAX_STR_WIDTH_LEGACY) {
        return code;
    }
    throw new Error(
        `Unknown legacy type code ${code}`
    );
}

export function legacy_type_code_to_dta_type(
    code: number
): DtaType {
    const my_entry = LEGACY_TYPE_CODES[code];
    if (my_entry) return my_entry.type as DtaType;
    if (code >= 1 && code <= MAX_STR_WIDTH_LEGACY) {
        return `str${code}` as DtaType;
    }
    throw new Error(
        `Unknown legacy type code ${code}`
    );
}

// -----------------------------------------------------------
// Public interfaces
// -----------------------------------------------------------

export interface VariableInfo {
    name: string;
    type: DtaType;
    type_code: number;
    format: string;           // e.g., "%9.0g", "%20s", "%td"
    label: string;            // variable label
    value_label_name: string; // associated value label table
    byte_width: number;       // width in bytes in data section
    byte_offset: number;      // offset within an observation row
}

export type MissingType =
    | '.'
    | '.a' | '.b' | '.c' | '.d' | '.e' | '.f' | '.g'
    | '.h' | '.i' | '.j' | '.k' | '.l' | '.m' | '.n'
    | '.o' | '.p' | '.q' | '.r' | '.s' | '.t' | '.u'
    | '.v' | '.w' | '.x' | '.y' | '.z';

export interface MissingValue {
    kind: 'missing';
    missing_type: MissingType;
}

export type RowCell = number | string | MissingValue;
export type Row = RowCell[];

export interface SectionOffsets {
    stata_data: number;
    map: number;
    variable_types: number;
    varnames: number;
    sortlist: number;
    formats: number;
    value_label_names: number;
    variable_labels: number;
    characteristics: number;
    data: number;
    strls: number;
    value_labels: number;
    stata_data_close: number;
    end_of_file: number;
}

export interface DtaMetadata {
    format_version: FormatVersion;
    byte_order: 'MSF' | 'LSF';
    nvar: number;
    nobs: number;
    dataset_label: string;
    variables: VariableInfo[];
    section_offsets: SectionOffsets;
    obs_length: number;
}
