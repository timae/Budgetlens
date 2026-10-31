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
const monthIndex = (ym) => +ym.slice(0, 4) * 12 + +ym.slice(5, 7) - 1;
const r2 = (n) => Math.round(n * 100) / 100;

/** Nearest supported cadence (in months) for a typical gap. */
function cadenceOf(gap) {
  let best = 1;
  for (const c of CADENCES.keys()) if (Math.abs(c - gap) < Math.abs(best - gap)) best = c;
  return best;
}

/**
 * Find recurring payments. Returns items sorted by monthly cost:
 * { key, payee, category, currency, every, amount, monthly, count, first, last, next, day, confidence: 'high'|'medium', score, varies }
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
    const byMonth = new Map();
    for (const t of list) {
      if (!byMonth.has(t.month)) byMonth.set(t.month, []);
      byMonth.get(t.month).push(t);
    }
    const months = [...byMonth.keys()].sort();
    if (months.length < 2) continue;
    // Frequent shopping (several payments most months) is not a fixed cost.
    if (median([...byMonth.values()].map((v) => v.length)) > 1.5) continue;
    // The main payment of each month: the largest one.
    const main = months.map((m) => byMonth.get(m).reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a)));
    const amounts = main.map((t) => -t.amount);
    const amount = median(amounts);
    if (amount <= 0) continue;
    const spread = median(amounts.map((a) => Math.abs(a - amount))) / amount; // robust relative deviation
    const gaps = months.slice(1).map((m, i) => monthIndex(m) - monthIndex(months[i]));
    const every = cadenceOf(median(gaps));
    const regular = gaps.filter((g) => Math.abs(g - every) <= (every === 1 ? 0 : 1)).length / gaps.length;
    const days = main.map((t) => +t.date.slice(8, 10));
    const dayMed = median(days);
    const daySpread = median(days.map((d) => Math.abs(d - dayMed)));
    const category = mostCommon(list.map((t) => t.category));

    // Two months: only consecutive months (monthly) or a year apart, and only as a suggestion.
    if (months.length < 3 && !((every === 12 || gaps[0] === 1) && spread <= 0.1)) continue;
    const hint = FIXED_HINT.has(normalizeKey(category));
    const steadyAmount = spread <= 0.03 || (hint && spread <= 0.15);
    const steadyDay = daySpread <= (hint ? 4 : 2);
    let confidence = null;
    if (regular >= 0.75 && steadyAmount && (steadyDay || (hint && spread <= 0.005)) && months.length >= 3) confidence = 'high';
    else if (regular >= 0.5 && (steadyAmount || (spread <= 0.1 && steadyDay))) confidence = 'medium';
    const score = Math.round(((regular >= 0.75 ? 0.4 : 0.2) + (steadyAmount ? 0.3 : 0.1) + (steadyDay ? 0.2 : 0) + (months.length >= 4 ? 0.1 : 0)) * 100) / 100;
    if (!confidence) continue;
    const last = main[main.length - 1].date;
    out.push({
      key, payee: list[0].payee, category, currency: list[0].currency, every,
      amount: r2(amount), monthly: r2(amount / every), count: list.length,
      first: main[0].date, last, next: `${addMonths(last.slice(0, 7), every)}-${String(Math.min(28, Math.round(dayMed))).padStart(2, '0')}`,
      day: Math.round(dayMed), confidence, score, varies: spread > 0.02,
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
