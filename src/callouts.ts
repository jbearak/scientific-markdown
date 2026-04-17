import { GFM_ALERT_TYPES, parseGfmAlertMarker, gfmAlertTitle, toGfmAlertMarker, type GfmAlertType } from './gfm';
import type { CalloutStyle } from './frontmatter';

export { GFM_ALERT_TYPES, parseGfmAlertMarker, gfmAlertTitle, toGfmAlertMarker };
export type { GfmAlertType };

/** Types unique to the Confluence panel vocabulary. */
export const CONFLUENCE_ONLY_TYPES = ['info', 'error', 'success'] as const;
export type ConfluenceOnlyType = typeof CONFLUENCE_ONLY_TYPES[number];

/** Superset union: every type name recognized in either `> [!X]` or `~~~panel type=X` syntax. */
export const ALL_CALLOUT_TYPES = [...GFM_ALERT_TYPES, ...CONFLUENCE_ONLY_TYPES] as const;
export type CalloutType = typeof ALL_CALLOUT_TYPES[number];

const ALL_CALLOUT_TYPE_SET = new Set<string>(ALL_CALLOUT_TYPES);

/** Parse a raw type-name string from either syntax. Case-insensitive. */
export function parseCalloutTypeName(raw: string, _style: CalloutStyle = 'github'): CalloutType | undefined {
  const lower = raw.toLowerCase().trim();
  return ALL_CALLOUT_TYPE_SET.has(lower) ? (lower as CalloutType) : undefined;
}

/** Parse a callout marker `[!TYPE] rest`. Accepts all 8 type names (not just the 5 GitHub ones).
 *  Returns undefined if the text doesn't start with a recognized marker. */
export function parseCalloutMarker(text: string): { type: CalloutType; rest: string } | undefined {
  const match = text.match(/^\[!([A-Za-z]+)\](?:[ \t]+|$)/);
  if (!match) return undefined;
  const type = match[1].toLowerCase();
  if (!ALL_CALLOUT_TYPE_SET.has(type)) return undefined;
  return { type: type as CalloutType, rest: text.slice(match[0].length) };
}

/** Emit `[!TYPE]` (uppercase) for a given callout type. */
export function toCalloutMarker(type: CalloutType): string {
  return '[!' + type.toUpperCase() + ']';
}

/** Is this a GitHub alert type (one of the original 5)? */
export function isGfmAlertType(type: CalloutType): type is GfmAlertType {
  return (GFM_ALERT_TYPES as readonly string[]).includes(type);
}

/** Human-readable title (capitalize first letter). */
export function calloutTitle(type: CalloutType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

const OCTICON_COMMON = 'class="octicon markdown-alert-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"';

const GFM_OCTICON_BY_TYPE: Record<GfmAlertType, string> = {
  note:      '<svg ' + OCTICON_COMMON + '><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
  tip:       '<svg ' + OCTICON_COMMON + '><path d="M8 1.5a4.5 4.5 0 0 0-2.106 8.478.75.75 0 0 1 .356.643v.629h3.5v-.63a.75.75 0 0 1 .356-.642A4.5 4.5 0 0 0 8 1.5ZM2 6a6 6 0 1 1 11.693 1.897 6.5 6.5 0 0 1-2.044 2.213c-.015.01-.024.024-.024.04v.85A1.5 1.5 0 0 1 10.125 12h-4.25a1.5 1.5 0 0 1-1.5-1.5v-.85c0-.015-.009-.03-.024-.04A6.501 6.501 0 0 1 2 6Zm3.75 7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Z"/></svg>',
  important: '<svg ' + OCTICON_COMMON + '><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  warning:   '<svg ' + OCTICON_COMMON + '><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  caution:   '<svg ' + OCTICON_COMMON + '><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
};

const CONFLUENCE_OCTICON_BY_TYPE: Record<ConfluenceOnlyType, string> = {
  // info: circled info — same visual family as note but distinct
  info:    '<svg ' + OCTICON_COMMON + '><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM9 11a1 1 0 1 1-2 0V7.75a1 1 0 1 1 2 0V11ZM8 4.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z"/></svg>',
  // error: circled X
  error:   '<svg ' + OCTICON_COMMON + '><path d="M2.344 2.343h-.001a8 8 0 0 1 11.314 11.314A8.002 8.002 0 0 1 .234 10.089a8 8 0 0 1 2.11-7.746Zm1.06 10.253a6.5 6.5 0 1 0 9.108-9.275 6.5 6.5 0 0 0-9.108 9.275ZM6.03 4.97 8 6.94l1.97-1.97a.749.749 0 1 1 1.06 1.06L9.06 8l1.97 1.97a.749.749 0 1 1-1.06 1.06L8 9.06l-1.97 1.97a.749.749 0 1 1-1.06-1.06L6.94 8 4.97 6.03a.749.749 0 1 1 1.06-1.06Z"/></svg>',
  // success: check circle
  success: '<svg ' + OCTICON_COMMON + '><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"/></svg>',
};

/** Octicon SVG string for the preview title row. */
export function calloutOcticonSvg(type: CalloutType): string {
  if (isGfmAlertType(type)) return GFM_OCTICON_BY_TYPE[type];
  return CONFLUENCE_OCTICON_BY_TYPE[type];
}

/** Word paragraph style name for a given type + callout-style.
 *  Ambiguity resolution: `note` → `GitHubNote` under github, `PanelNote` (purple) under confluence.
 *  Confluence-only types (info/error/success) always use the `Panel*` style.
 *  Other GFM types (tip/important/caution/warning) always use the `GitHub*` style. */
export function alertStyleForType(type: CalloutType, style: CalloutStyle): string {
  switch (type) {
    case 'note':      return style === 'confluence' ? 'PanelNote' : 'GitHubNote';
    case 'tip':       return 'GitHubTip';
    case 'important': return 'GitHubImportant';
    case 'warning':   return 'GitHubWarning';
    case 'caution':   return 'GitHubCaution';
    case 'info':      return 'PanelInfo';
    case 'error':     return 'PanelError';
    case 'success':   return 'PanelSuccess';
    default: {
      const _exhaustive: never = type;
      return 'GitHubNote';
    }
  }
}

/** Unicode glyph used in the Word title-run prefix. */
export function alertGlyphForType(type: CalloutType, style: CalloutStyle): string {
  switch (type) {
    case 'note':      return style === 'confluence' ? '🗒' : '※';
    case 'tip':       return '◈';
    case 'important': return '‼';
    case 'warning':   return '▲';
    case 'caution':   return '⛒';
    case 'info':      return 'ℹ';
    case 'error':     return '✖';
    case 'success':   return '✔';
    default: {
      const _exhaustive: never = type;
      return '';
    }
  }
}
