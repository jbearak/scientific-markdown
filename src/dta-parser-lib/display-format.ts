// -----------------------------------------------------------
// Stata display format application
//
// Applies Stata display format strings to raw numeric values.
// Used by the data browser grid to format cell values.
//
// Format syntax: %[+-0][width].[decimals][type][c]
//   type: f (fixed), g (general), e (scientific)
//   c suffix: comma thousand separators
//   %td, %tc, %tw, %tm, %tq, %ty: date/time formats
//   %ws: string format
// -----------------------------------------------------------

const STATA_EPOCH_YEAR = 1960;
const STATA_EPOCH_MONTH = 0; // January (0-indexed for Date)
const STATA_EPOCH_DAY = 1;

const MONTH_ABBREVS = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// Regex to parse the core numeric format after stripping
// the leading % and optional modifiers (-, +, 0).
// Captures: width, decimals, type letter, optional c suffix.
const NUMERIC_FORMAT_RE =
    /^(\d+)\.(\d+)(f|g|e)(c?)$/;

/**
 * Apply a Stata display format string to a raw value.
 *
 * - null values return null.
 * - String values pass through unchanged.
 * - Unknown or unparseable formats fall back to String(value).
 */
export function apply_display_format(
    value: number | string | null,
    format: string
): string | null {
    if (value === null) return null;
    if (typeof value === 'string') return value;

    // Strip the leading %
    const my_trimmed = format.replace(/^%-?[+0]?/, '')
        .replace(/^%/, '');

    if (my_trimmed.length === 0) return String(value);

    // String format: ends with 's'
    if (my_trimmed.endsWith('s')) return String(value);

    // Date/time formats
    if (my_trimmed.startsWith('t')) {
        return format_date_time(value, my_trimmed);
    }

    // Numeric formats: f, g, e (with optional c suffix)
    const my_match = NUMERIC_FORMAT_RE.exec(my_trimmed);
    if (!my_match) return String(value);

    const my_decimals = parseInt(my_match[2], 10);
    const my_type = my_match[3];
    const my_use_commas = my_match[4] === 'c';

    switch (my_type) {
        case 'f':
            return format_fixed(
                value, my_decimals, my_use_commas
            );
        case 'g':
            return format_general(
                value, my_use_commas
            );
        case 'e':
            return format_scientific(value, my_decimals);
        default:
            return String(value);
    }
}

// -----------------------------------------------------------
// Numeric formatters
// -----------------------------------------------------------

function format_fixed(
    value: number,
    decimals: number,
    use_commas: boolean
): string {
    const my_str = value.toFixed(decimals);
    if (!use_commas) return my_str;
    return add_thousand_separators(my_str);
}

function format_general(
    value: number,
    use_commas: boolean
): string {
    // General format: use minimal representation.
    // String() gives us the compact form JavaScript uses,
    // which matches Stata's %g behavior for typical values.
    const my_str = String(value);
    if (!use_commas) return my_str;
    return add_thousand_separators(my_str);
}

function format_scientific(
    value: number,
    decimals: number
): string {
    const my_raw = value.toExponential(decimals);
    // JavaScript uses e+1, e-3 etc. Stata uses e+01, e-03.
    // Normalize exponent to always have two digits.
    return my_raw.replace(
        /e([+-])(\d)$/,
        'e$1' + '0$2'
    );
}

// -----------------------------------------------------------
// Thousand separators
// -----------------------------------------------------------

function add_thousand_separators(str: string): string {
    const my_dot_index = str.indexOf('.');
    const my_int_part = my_dot_index >= 0
        ? str.substring(0, my_dot_index)
        : str;
    const my_dec_part = my_dot_index >= 0
        ? str.substring(my_dot_index)
        : '';

    // Handle negative sign
    const my_is_negative = my_int_part.startsWith('-');
    const my_digits = my_is_negative
        ? my_int_part.substring(1)
        : my_int_part;

    // Insert commas from right to left
    const the_parts: string[] = [];
    const my_len = my_digits.length;
    for (let i = my_len - 1; i >= 0; i--) {
        const my_pos_from_right = my_len - 1 - i;
        if (
            my_pos_from_right > 0
            && my_pos_from_right % 3 === 0
        ) {
            the_parts.push(',');
        }
        the_parts.push(my_digits[i]);
    }
    the_parts.reverse();

    const my_prefix = my_is_negative ? '-' : '';
    return my_prefix + the_parts.join('') + my_dec_part;
}

// -----------------------------------------------------------
// Date/time formatters
// -----------------------------------------------------------

function format_date_time(
    value: number,
    format_code: string
): string {
    switch (format_code) {
        case 'td':
            return format_td(value);
        case 'tc':
            return format_tc(value);
        case 'tw':
            return format_tw(value);
        case 'tm':
            return format_tm(value);
        case 'tq':
            return format_tq(value);
        case 'ty':
            return String(value);
        default:
            return String(value);
    }
}

/**
 * %td -- days since 01jan1960 -> "DDmonYYYY"
 */
function format_td(days_since_epoch: number): string {
    const my_date = new Date(Date.UTC(
        STATA_EPOCH_YEAR,
        STATA_EPOCH_MONTH,
        STATA_EPOCH_DAY + days_since_epoch
    ));
    const my_day = String(my_date.getUTCDate())
        .padStart(2, '0');
    const my_month = MONTH_ABBREVS[my_date.getUTCMonth()];
    const my_year = my_date.getUTCFullYear();
    return `${my_day}${my_month}${my_year}`;
}

/**
 * %tc -- milliseconds since 01jan1960 00:00:00
 *     -> "DDmonYYYY HH:MM:SS"
 */
function format_tc(ms_since_epoch: number): string {
    const my_total_days = Math.floor(
        ms_since_epoch / MS_PER_DAY
    );
    const my_remainder_ms = ms_since_epoch
        - my_total_days * MS_PER_DAY;

    const my_date_str = format_td(my_total_days);

    const my_hours = Math.floor(
        my_remainder_ms / MS_PER_HOUR
    );
    const my_minutes = Math.floor(
        (my_remainder_ms % MS_PER_HOUR) / MS_PER_MINUTE
    );
    const my_seconds = Math.floor(
        (my_remainder_ms % MS_PER_MINUTE) / MS_PER_SECOND
    );

    const my_hh = String(my_hours).padStart(2, '0');
    const my_mm = String(my_minutes).padStart(2, '0');
    const my_ss = String(my_seconds).padStart(2, '0');

    return `${my_date_str} ${my_hh}:${my_mm}:${my_ss}`;
}

/**
 * %tw -- weeks since 1960w1 -> "YYYYwW"
 */
function format_tw(weeks_since_epoch: number): string {
    const my_year = STATA_EPOCH_YEAR
        + Math.floor(weeks_since_epoch / 52);
    let my_week = (weeks_since_epoch % 52) + 1;
    if (my_week <= 0) my_week += 52;
    return `${my_year}w${my_week}`;
}

/**
 * %tm -- months since 1960m1 -> "YYYYmM"
 */
function format_tm(months_since_epoch: number): string {
    // Use floor division so negatives work correctly.
    // months_since_epoch = 0 -> 1960m1
    // months_since_epoch = -1 -> 1959m12
    const my_year = STATA_EPOCH_YEAR
        + Math.floor(months_since_epoch / 12);
    let my_month = (months_since_epoch % 12) + 1;
    // JavaScript % can return negative for negative
    // operands: fix that.
    if (my_month <= 0) my_month += 12;
    return `${my_year}m${my_month}`;
}

/**
 * %tq -- quarters since 1960q1 -> "YYYYqQ"
 */
function format_tq(quarters_since_epoch: number): string {
    const my_year = STATA_EPOCH_YEAR
        + Math.floor(quarters_since_epoch / 4);
    let my_quarter = (quarters_since_epoch % 4) + 1;
    if (my_quarter <= 0) my_quarter += 4;
    return `${my_year}q${my_quarter}`;
}
