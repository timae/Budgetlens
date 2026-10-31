// Amount parsing for Swiss/European/English number formats.
// 'dot'   : 1'234.50  1,234.50  1 234.50  1234.5
// 'comma' : 1.234,50  1 234,50  1234,5
export const DECIMALS = ['dot', 'comma'];

const CURRENCY = /\b(CHF|EUR|USD|GBP|SFR|FR|SFR\.|FR\.|Fr\.|sFr)\b\.?|[\u20AC$\u00A3\u00A5]|\bFr\b\.?/gi;
const NUMERIC_SHAPE = /^[+\-\u2212]?\(?[+\-\u2212]?[\d'\u2019\u02BC.,\s]+\)?[+\-\u2212]?$/;

/** Does this look like an amount at all (after removing currency markers)? */
export function looksNumeric(raw) {
  if (raw == null) return false;
  const s = String(raw).replace(CURRENCY, '').replace(/\s+/g, ' ').trim();
  return s !== '' && /\d/.test(s) && NUMERIC_SHAPE.test(s);
}

/** Guess whether a column of amounts uses dot or comma as the decimal separator. */
export function detectDecimal(values) {
  let dot = 0, comma = 0;
  for (const raw of values) {
    if (!looksNumeric(raw)) continue;
    const s = String(raw).replace(CURRENCY, '').replace(/[\s'\u2019\u02BC()+\-\u2212]/g, '');
    if (/,\d{1,2}$/.test(s) || /\.\d{3},/.test(s)) comma++;
    else if (/\.\d{1,2}$/.test(s) || /,\d{3}\./.test(s)) dot++;
    else if (/\.\d{3}$/.test(s) && /^\d{1,3}(\.\d{3})+$/.test(s)) comma += 0.25; // 1.234 \u2192 likely thousands
    else if (/,\d{3}$/.test(s) && /^\d{1,3}(,\d{3})+$/.test(s)) dot += 0.25;
  }
  return comma > dot ? 'comma' : 'dot';
}

/** Parse one amount. Returns a finite number or null. */
export function parseAmount(raw, decimal = 'dot') {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).replace(CURRENCY, '').trim();
  if (!s || !/\d/.test(s)) return null;
  let negative = false;
  s = s.replace(/\u2212/g, '-').replace(/[.,][\u2013\u2014-]{1,2}$/, ''); // Swiss "12.\u2013" = 12.00
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/-$/.test(s)) { negative = !negative; s = s.slice(0, -1).trim(); }
  else if (/\+$/.test(s)) s = s.slice(0, -1).trim();
  if (/^-/.test(s)) { negative = !negative; s = s.slice(1).trim(); }
  else if (/^\+/.test(s)) s = s.slice(1).trim();
  s = s.replace(/[\s'\u2019\u02BC]/g, '');
  if (decimal === 'comma') {
    // Thousands dots must form groups of three (rejects dates such as 01.10.2026).
    if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d*)?$/.test(s)) return null;
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (!s.includes('.') && /^\d+,\d{1,2}$/.test(s)) {
    // A lone comma followed by 1-2 digits in a "dot" column is still a decimal comma (e.g. 12,5).
    s = s.replace(',', '.');
  } else {
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d*)?$/.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) return null;
  return negative ? -n : n;
}
