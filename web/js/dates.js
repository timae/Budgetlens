// Date parsing. All dates are returned as ISO strings 'YYYY-MM-DD' (no time zones involved).
export const DATE_FORMATS = ['DMY', 'MDY', 'YMD', 'serial', 'text'];

const MONTHS = new Map();
[
  ['jan', 1], ['januar', 1], ['january', 1], ['janvier', 1], ['janv', 1], ['gennaio', 1], ['gen', 1], ['jaenner', 1], ['janner', 1],
  ['feb', 2], ['februar', 2], ['february', 2], ['fevrier', 2], ['fevr', 2], ['fev', 2], ['febbraio', 2],
  ['mar', 3], ['marz', 3], ['maerz', 3], ['march', 3], ['mars', 3], ['marzo', 3], ['mrz', 3],
  ['apr', 4], ['april', 4], ['avril', 4], ['avr', 4], ['aprile', 4],
  ['may', 5], ['mai', 5], ['maggio', 5], ['mag', 5],
  ['jun', 6], ['juni', 6], ['june', 6], ['juin', 6], ['giugno', 6], ['giu', 6],
  ['jul', 7], ['juli', 7], ['july', 7], ['juillet', 7], ['juil', 7], ['luglio', 7], ['lug', 7],
  ['aug', 8], ['august', 8], ['aout', 8], ['agosto', 8], ['ago', 8],
  ['sep', 9], ['sept', 9], ['september', 9], ['septembre', 9], ['settembre', 9], ['set', 9],
  ['oct', 10], ['okt', 10], ['oktober', 10], ['october', 10], ['octobre', 10], ['ottobre', 10], ['ott', 10],
  ['nov', 11], ['november', 11], ['novembre', 11],
  ['dec', 12], ['dez', 12], ['dezember', 12], ['december', 12], ['decembre', 12], ['dicembre', 12], ['dic', 12],
].forEach(([k, v]) => MONTHS.set(k, v));

const strip = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
export const monthFromName = (word) => MONTHS.get(strip(word).replace(/[^a-z]/g, '')) || 0;

const pad = (n) => String(n).padStart(2, '0');
function iso(y, m, d) {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function excelSerialToISO(n) {
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const NUMERIC = /^(\d{1,4})[./\-\s](\d{1,2})[./\-\s](\d{1,4})\.?(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp][Mm])?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Parse a date string with a given format. */
export function parseDate(raw, format = 'DMY') {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (format === 'serial') {
    if (!/^\d{4,6}(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return n >= 20000 && n <= 80000 ? excelSerialToISO(n) : null;
  }
  const m = NUMERIC.exec(s);
  if (m) {
    const a = +m[1], b = +m[2], c = +m[3];
    if (m[1].length === 4) return iso(a, b, c); // YYYY-MM-DD always unambiguous
    if (format === 'YMD') return null;
    if (m[3].length !== 4 && m[3].length !== 2) return null;
    return format === 'MDY' ? iso(c, a, b) : iso(c, b, a);
  }
  // Textual months: "01 Oct 2026", "1. Oktober 2026", "Oct 1, 2026", "2026-Oct-01"
  const words = strip(s).replace(/[,.]/g, ' ').split(/[\s\-/]+/).filter(Boolean);
  if (words.length >= 3) {
    let y = 0, mo = 0, d = 0;
    for (const w of words.slice(0, 4)) {
      if (/^\d{4}$/.test(w)) y = +w;
      else if (/^\d{1,2}$/.test(w) && !d) d = +w;
      else if (/^[a-z]+$/.test(w) && !mo) mo = monthFromName(w);
      else if (/^\d{1,2}:\d{2}/.test(w)) break;
    }
    if (y && mo && d) return iso(y, mo, d);
  }
  return null;
}

/** Detect the most plausible date format for a column of sample values. */
export function detectDateFormat(values, allowSerial = true) {
  const sample = values.filter((v) => v != null && String(v).trim() !== '').slice(0, 300);
  if (!sample.length) return { format: 'DMY', ratio: 0 };
  let dmyOnly = 0, mdyOnly = 0;
  for (const v of sample) {
    const m = NUMERIC.exec(String(v).trim());
    if (m && m[1].length !== 4) {
      if (+m[1] > 12 && +m[2] <= 12) dmyOnly++;
      if (+m[2] > 12 && +m[1] <= 12) mdyOnly++;
    }
  }
  const candidates = mdyOnly > dmyOnly ? ['MDY', 'DMY'] : ['DMY', 'MDY'];
  if (allowSerial) candidates.push('serial');
  let best = { format: candidates[0], ratio: 0 };
  for (const f of candidates) {
    const ok = sample.filter((v) => parseDate(v, f)).length / sample.length;
    if (ok > best.ratio + 1e-9) best = { format: f, ratio: ok };
  }
  return best;
}

/** Parse a month label: '2026-10', '10.2026', '10/26', 'Oct 2026', 'Oktober', 'Okt. 26'. Returns 'YYYY-MM' or null. */
export function parseMonth(raw, fallbackYear) {
  if (raw == null) return null;
  const s = strip(String(raw)).trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad(+m[2])}`;
  m = /^(\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) {
    let y = +m[2];
    if (y < 100) y += 2000;
    return `${y}-${pad(+m[1])}`;
  }
  const words = s.replace(/[,.'\u2019]/g, ' ').split(/[\s\-/_]+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 2) {
    let mo = 0, y = 0;
    for (const w of words) {
      if (/^[a-z]+$/.test(w)) mo = mo || monthFromName(w);
      else if (/^\d{4}$/.test(w)) y = +w;
      else if (/^\d{2}$/.test(w)) y = 2000 + +w;
      else return null;
    }
    if (mo && (y || fallbackYear)) return `${y || fallbackYear}-${pad(mo)}`;
  }
  return null;
}

export const monthOf = (isoDate) => isoDate.slice(0, 7);

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

/** Inclusive list of months between two 'YYYY-MM' strings (capped at 600). */
export function monthRange(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let m = from; m <= to && out.length < 600; m = addMonths(m, 1)) out.push(m);
  return out;
}
