import { LIMITS } from './limits.js';

// C0/C1 controls, DEL, zero-width characters, bidi embeddings/overrides/isolates,
// soft hyphen, word joiner, BOM, interlinear annotations and tag characters.
const STRIP =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]/g;
// Whitespace variants (tab, newlines, NBSP, thin/narrow spaces, ideographic space).
const SPACES = /[\t\n\r\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/** Clean one untrusted cell: strip invisible/control/bidi characters, normalise spaces, cap length. */
export function cleanText(value, maxLength = LIMITS.maxCellLength) {
  if (value == null) return '';
  let s = String(value);
  if (s.length > maxLength * 4) s = s.slice(0, maxLength * 4);
  s = s.replace(SPACES, ' ').replace(STRIP, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > maxLength) s = s.slice(0, maxLength).trimEnd() + '\u2026';
  return s;
}

/** Lowercase, strip accents and punctuation: used for header and keyword matching. */
export function normalizeKey(value) {
  return cleanText(value, 200)
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/\u00DF/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A safe, bounded category/rule label. */
export function cleanLabel(value) {
  return cleanText(value, LIMITS.maxCategoryLength);
}

// Characters that make spreadsheet apps evaluate a cell as a formula (incl. full-width forms).
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20|%]/;

/** Escape one value for CSV export, neutralising formula injection in text cells. */
export function csvCell(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';
  let s = cleanText(value, 4000);
  if (FORMULA_START.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function toCSV(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
