import type { GfmAlertType } from './gfm';
import type { CalloutType } from './callouts';
import type { ColorScheme } from './frontmatter';

/** Confluence-only border colors — fixed regardless of the GFM color scheme. */
export const CONFLUENCE_INFO_COLOR = '0C66E4';
export const CONFLUENCE_ERROR_COLOR = 'C9372C';
export const CONFLUENCE_SUCCESS_COLOR = '22A06B';
/** Confluence purple "note" panel color (used when callout-style: confluence) */
export const CONFLUENCE_NOTE_COLOR = '6E5DC6';

/** GitHub default alert border colors (6-digit hex, no #) */
export const GITHUB_ALERT_COLORS: Record<GfmAlertType, string> = {
  note:      '1F6FEB',
  tip:       '238636',
  important: '8957E5',
  warning:   '9A6700',
  caution:   'CF222E',
};

/** Guttmacher brand alert border colors (6-digit hex, no #) */
export const GUTTMACHER_ALERT_COLORS: Record<GfmAlertType, string> = {
  note:      '0F6779',
  tip:       '5C9E38',
  important: '9F3D61',
  warning:   'B39215',
  caution:   'D55A1F',
};

const COLOR_SCHEMES: Record<ColorScheme, Record<GfmAlertType, string>> = {
  github: GITHUB_ALERT_COLORS,
  guttmacher: GUTTMACHER_ALERT_COLORS,
};

/** Return the alert color map for a given color scheme.
 *  Returns a CalloutType-keyed record so downstream code can look up any type;
 *  Confluence-only types (info/error/success) always use the fixed Confluence palette
 *  regardless of scheme. */
export function alertColorsByScheme(scheme: ColorScheme): Record<CalloutType, string> {
  const gfm = COLOR_SCHEMES[scheme] ?? COLOR_SCHEMES[_defaultColorScheme];
  return {
    ...gfm,
    info: CONFLUENCE_INFO_COLOR,
    error: CONFLUENCE_ERROR_COLOR,
    success: CONFLUENCE_SUCCESS_COLOR,
  };
}

/** Module-level default color scheme, updated from VS Code settings */
let _defaultColorScheme: ColorScheme = 'guttmacher';

export function setDefaultColorScheme(scheme: ColorScheme): void {
  _defaultColorScheme = (scheme === 'github' || scheme === 'guttmacher') ? scheme : 'guttmacher';
}

export function getDefaultColorScheme(): ColorScheme {
  return _defaultColorScheme;
}
