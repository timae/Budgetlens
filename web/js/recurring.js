// Recurring fixed costs: detect payments that come back at a steady rhythm with a steady amount,
// merge them with what the user declared, and mark the matching transactions.
import { normalizeKey } from './sanitize.js';
import { INCOME, TRANSFERS } from './categorize.js';
import { addMonths } from './dates.js';

export const CADENCES = new Map([[1, 'Monthly'], [2, 'Every 2 months'], [3, 'Quarterly'], [6, 'Half-yearly'], [12, 'Yearly']]);
// Categories where a steady payment is very likely a fixed cost.
const FIXED_HINT = new Set(['housing', 'insurance', 'utilities telecom', 'childcare kids', 'subscriptions media', 'health', 'taxes fees']);

export const fixedKey = (currency, payee) => `${currency}|${normalizeKey(payee)}`;

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (n) => Math.round(n * 100) / 100;

const DAY = 86400000;
const dayNo = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;
// Typical length in days of each rhythm and the tolerance for one gap.
const CADENCE_DAYS = new Map([[1, [30.4, 6]], [2, [60.9, 9]], [3, [91.3, 12]], [6, [182.6, 20]], [12, [365.2, 25]]]);
// Bank wording for standing orders and direct debits: a strong sign of a fixed cost.
const ORDER_WORDS = /(dauerauftrag|standing order|ordre permanent|ordine permanente|ebill|e-bill|lsv|direct debit|lastschrift|recouvrement direct|addebito diretto|bank_auto_order|scheduled payment)/i;

function cadenceFromDays(gapDays) {
  let best = 1, err = Infinity;
  for (const [c, [d]] of CADENCE_DAYS) {
    const e = Math.abs(gapDays - d) / d;
    if (e < err) { err = e; best = c; }
  }
  return best;
}

function addMonthsDay(iso, n, day) {
  const ym = addMonths(iso.slice(0, 7), n);
  const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
  return `${ym}-${String(Math.min(dim, day)).padStart(2, '0')}`;
}

/**
 * Find recurring payments. Rhythm is measured in days between payments (so a standing order that
 * moves between the 1st and the 31st is still monthly), amount by the median and a robust spread.
 * Returns items sorted by monthly cost:
 * { key, payee, category, currency, account, every, amount, monthly, count, first, last, next, day,
 *   confidence: 'high'|'medium', reasons: string[], varies }
 */
export function detectRecurring(txs) {
  const groups = new Map();
  for (const t of txs) {
    if (t.amount >= 0 || t.synthetic || t.category === INCOME || t.category === TRANSFERS) continue;
    const key = fixedKey(t.currency, t.payee);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    // Reference amount: median of the largest payment per month, so a premium plus small
    // excess bills (same payee) still finds the premium.
    const byMonth = new Map();
    for (const t of list) byMonth.set(t.month, Math.max(byMonth.get(t.month) || 0, -t.amount));
    const ref = median([...byMonth.values()]);
    if (ref <= 0) continue;
    const main = list.filter((t) => Math.abs(-t.amount - ref) <= Math.max(2, ref * 0.35));
    if (main.length < 2) continue;
    const gaps = main.slice(1).map((t, i) => dayNo(t.date) - dayNo(main[i].date));
    const gapMed = median(gaps);
    if (gapMed < 20) continue; // several payments a month: shopping, not a fixed cost
    const every = cadenceFromDays(gapMed);
    const [len, baseTol] = CADENCE_DAYS.get(every);
    // eBills and direct debits are paid when the bill is due or approved: allow more drift.
    const orderedEarly = main.filter((t) => ORDER_WORDS.test(t.desc || '')).length >= Math.ceil(main.length / 2);
    const tol = baseTol + (orderedEarly ? 6 : 0);
    const regular = gaps.filter((g) => Math.abs(g - len) <= tol).length / gaps.length;
    const amounts = main.map((t) => -t.amount);
    const amount = median(amounts);
    const spread = median(amounts.map((a) => Math.abs(a - amount))) / amount;
    const timing = median(gaps.map((g) => Math.abs(g - len)));
    const category = mostCommon(main.map((t) => t.category));
    const hint = FIXED_HINT.has(normalizeKey(category));
    const ordered = main.filter((t) => ORDER_WORDS.test(t.desc || '')).length >= Math.ceil(main.length / 2);
    const cycles = main.length;
    const steadyAmount = spread <= 0.03 || ((hint || ordered) && spread <= 0.15);
    const steadyTiming = timing <= (hint || ordered ? 5 : 3);

    if (cycles < 3 && !(ordered || every === 12 || (hint && spread <= 0.03))) continue;
    if (regular < 0.5 || spread > 0.35) continue;
    let confidence = null;
    if (cycles >= 3 && regular >= 0.75 && steadyAmount && (steadyTiming || ordered)) confidence = 'high';
    else if (steadyAmount || (spread <= 0.1 && steadyTiming)) confidence = 'medium';
    if (!confidence) continue;

    const reasons = [`${CADENCES.get(every).toLowerCase()} rhythm (${gaps.filter((g) => Math.abs(g - len) <= tol).length} of ${gaps.length} gaps)`];
    reasons.push(spread <= 0.005 ? 'same amount every time' : spread <= 0.03 ? 'almost the same amount' : `amount varies about ${Math.round(spread * 100)}%`);
    if (ordered) reasons.push('standing order or eBill');
    if (cycles < 3) reasons.push(`only seen ${cycles} times so far`);
    const last = main[main.length - 1];
    const day = Math.round(median(main.map((t) => +t.date.slice(8, 10))));
    out.push({
      key, payee: list[0].payee, category, currency: list[0].currency, account: last.account ?? '', every,
      amount: r2(amount), monthly: r2(amount / every), count: cycles, first: main[0].date, last: last.date,
      next: addMonthsDay(last.date, every, +last.date.slice(8, 10) >= 28 ? day : +last.date.slice(8, 10)),
      day, confidence, reasons, varies: spread > 0.02,
    });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}

function mostCommon(xs) {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Merge detection with the user's choices.
 * overrides: Map(key -> { active?: boolean, amount?: number|null, every?: number })
 * manual:    Map(key -> { key, payee, category, currency, amount|null, every })
 * High-confidence detections are active by default; medium ones are suggestions.
 */
export function fixedCosts(detected, overrides, manual) {
  const items = new Map();
  for (const d of detected) items.set(d.key, { ...d, source: 'auto', active: d.confidence === 'high' });
  for (const [key, m] of manual) {
    const base = items.get(key) || { count: 0, first: '', last: '', next: '', day: 0, confidence: null, score: 0, varies: false };
    items.set(key, { ...base, ...m, key, source: 'declared', active: true });
  }
  for (const [key, o] of overrides) {
    const it = items.get(key);
    if (!it) continue;
    if (typeof o.active === 'boolean') it.active = o.active;
    if (o.amount === null || (typeof o.amount === 'number' && o.amount >= 0)) it.amount = o.amount;
    if (CADENCES.has(o.every)) it.every = o.every;
    if (it.source === 'auto' && (o.active === true || o.amount !== undefined || o.every !== undefined)) it.source = 'adjusted';
  }
  for (const it of items.values()) it.monthly = it.amount == null ? null : r2(it.amount / it.every);
  return [...items.values()].sort((a, b) => (b.active - a.active) || (b.monthly ?? 0) - (a.monthly ?? 0));
}

/** Does a transaction belong to an active fixed cost? Amount must be within 15% (or CHF 5) unless "any amount". */
export function matchesFixed(t, item) {
  if (!item || !item.active || t.amount >= 0 || t.currency !== item.currency) return false;
  if (item.amount == null) return true;
  const a = -t.amount;
  return Math.abs(a - item.amount) <= Math.max(5, item.amount * 0.15);
}

/** Flag fixed transactions. */
export function markFixed(txs, items) {
  const active = new Map(items.filter((i) => i.active).map((i) => [i.key, i]));
  return txs.map((t) => {
    const it = active.get(fixedKey(t.currency, t.payee));
    return matchesFixed(t, it) ? { ...t, fixed: true } : t.fixed ? { ...t, fixed: false } : t;
  });
}

/** Status of an active fixed cost relative to the latest date in the data. */
export function fixedStatus(item, latestDate) {
  if (!item.last) return 'declared';
  if (item.next && latestDate) {
    const due = new Date(`${item.next}T00:00:00Z`).getTime();
    const now = new Date(`${latestDate}T00:00:00Z`).getTime();
    if (now - due > 10 * 86400000) return 'missing';
  }
  return 'ok';
}
