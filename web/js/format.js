// Swiss number formatting (apostrophe thousands separator) and labels.
const nf2 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const pf = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthShort = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const money = (n) => nf2.format(n);
export const money0 = (n) => nf0.format(Math.round(n));
export const signed0 = (n) => (n > 0 ? '+' : n < 0 ? '\u2212' : '\u00B1') + nf0.format(Math.abs(Math.round(n)));
export const signed2 = (n) => (n > 0 ? '+' : n < 0 ? '\u2212' : '') + nf2.format(Math.abs(n));
export const pct = (x) => (x == null || !Number.isFinite(x) ? '\u2013' : pf.format(x));
export const signedPct = (x) => (x == null || !Number.isFinite(x) ? '\u2013' : (x > 0 ? '+' : x < 0 ? '\u2212' : '\u00B1') + pf.format(Math.abs(x)));

const utc = (ym, d = 1) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, d));
export const monthLabel = (ym) => (!ym ? '\u2013' : ym.length === 4 ? ym : monthFmt.format(utc(ym)));
export const monthTick = (ym) => monthShort.format(utc(ym));
export const dayLabel = (iso) => dayFmt.format(utc(iso.slice(0, 7), +iso.slice(8, 10)));
