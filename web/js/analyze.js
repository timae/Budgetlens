// Aggregation. Pure functions over normalised records; all user-derived keys live in Maps.
import { normalizeKey } from './sanitize.js';
import { monthRange, addMonths } from './dates.js';
import { INCOME } from './categorize.js';

const r2 = (n) => Math.round(n * 100) / 100;

/** Months that have data, sorted. */
export function dataMonths(txs, budgets = []) {
  const set = new Set();
  for (const t of txs) set.add(t.month);
  for (const b of budgets) if (b.month) set.add(b.month);
  return [...set].sort();
}

export function currencies(txs, budgets = []) {
  const counts = new Map();
  for (const t of txs) counts.set(t.currency, (counts.get(t.currency) || 0) + 1);
  for (const b of budgets) if (!counts.has(b.currency)) counts.set(b.currency, 0);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/** Resolve a period preset against the data (presets are relative to the latest month with data). */
export function presetRange(preset, months) {
  if (!months.length) return { from: null, to: null };
  const last = months[months.length - 1];
  const first = months[0];
  const year = last.slice(0, 4);
  switch (preset) {
    case 'last-month': return { from: last, to: last };
    case 'last-3': return { from: maxM(first, addMonths(last, -2)), to: last };
    case 'last-6': return { from: maxM(first, addMonths(last, -5)), to: last };
    case 'last-12': return { from: maxM(first, addMonths(last, -11)), to: last };
    case 'this-year': return { from: maxM(first, `${year}-01`), to: last };
    case 'last-year': {
      const y = String(+year - 1);
      return { from: `${y}-01`, to: `${y}-12` };
    }
    default: return { from: first, to: last };
  }
}
const maxM = (a, b) => (a > b ? a : b);

/** Canonical display names: budget and transaction categories match case/accent-insensitively. */
function nameIndex(txs, budgets) {
  const names = new Map();
  for (const t of txs) {
    const k = normalizeKey(t.category);
    if (!names.has(k)) names.set(k, t.category);
  }
  for (const b of budgets) {
    const k = normalizeKey(b.category);
    if (!names.has(k)) names.set(k, b.category);
  }
  return (name) => names.get(normalizeKey(name)) || name;
}

/**
 * Analyse transactions and budgets for a period and currency.
 * opts: { from, to, currency, excluded: Set<string>, focus: string|null }
 */
export function analyze(allTxs, allBudgets, opts) {
  const { currency, excluded = new Set(), focus = null } = opts;
  const txsC = allTxs.filter((t) => t.currency === currency);
  const budC = allBudgets.filter((b) => b.currency === currency);
  const months = dataMonths(txsC, budC);
  const from = opts.from || months[0];
  const to = opts.to || months[months.length - 1];
  const range = from && to ? monthRange(from, to) : [];
  const inRange = (m) => m >= from && m <= to;
  const canon = nameIndex(txsC, budC);
  const txs = txsC.filter((t) => inRange(t.month)).map((t) => ({ ...t, category: canon(t.category) }));
  const isSpending = (cat) => cat !== INCOME && !excluded.has(cat);

  // Months with data inside the range define the averaging base.
  const activeMonths = range.filter((m) => txs.some((t) => t.month === m));
  const monthsCount = Math.max(1, activeMonths.length || range.length);

  // Category totals.
  const cats = new Map();
  const cat = (name) => {
    if (!cats.has(name)) cats.set(name, { name, spent: 0, count: 0, budget: 0, income: 0, fixed: 0 });
    return cats.get(name);
  };
  let income = 0;
  for (const t of txs) {
    const c = cat(t.category);
    c.count++;
    if (t.category === INCOME) { c.income += t.amount; income += t.amount; }
    else {
      c.spent -= t.amount;
      if (t.fixed) c.fixed -= t.amount;
    }
  }
  // Budgets: undated entries recur each month of the range; dated entries count in their month.
  const budgetByMonth = new Map(range.map((m) => [m, new Map()]));
  for (const b of budC) {
    const name = canon(b.category);
    if (b.month) {
      if (!inRange(b.month)) continue;
      cat(name).budget += b.amount;
      const mm = budgetByMonth.get(b.month);
      if (mm) mm.set(name, (mm.get(name) || 0) + b.amount);
    } else {
      cat(name).budget += b.amount * monthsCount;
      for (const m of activeMonths.length ? activeMonths : range) {
        const mm = budgetByMonth.get(m);
        mm.set(name, (mm.get(name) || 0) + b.amount);
      }
    }
  }

  const categories = [...cats.values()]
    .filter((c) => c.name !== INCOME)
    .map((c) => {
      const spent = r2(c.spent), budget = r2(c.budget);
      const diff = r2(budget - spent);
      const pct = budget ? (spent - budget) / budget : null;
      const status = !budget ? 'none' : spent > budget * 1.005 ? 'over' : spent >= budget * 0.9 ? 'near' : 'under';
      return { name: c.name, spent, budget, diff, pct, status, count: c.count, fixed: r2(c.fixed), included: isSpending(c.name) };
    })
    .sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
  const included = categories.filter((c) => c.included);
  const spent = r2(included.reduce((s, c) => s + Math.max(0, c.spent), 0));
  for (const c of categories) c.share = c.included && spent > 0 ? Math.max(0, c.spent) / spent : 0;
  const budgeted = included.filter((c) => c.budget > 0);
  const budgetTotal = r2(budgeted.reduce((s, c) => s + c.budget, 0));
  const spentBudgeted = r2(budgeted.reduce((s, c) => s + c.spent, 0));

  // Monthly series.
  const monthly = range.map((m) => {
    const byCat = new Map();
    let total = 0;
    for (const t of txs) {
      if (t.month !== m || !isSpending(t.category)) continue;
      byCat.set(t.category, (byCat.get(t.category) || 0) - t.amount);
      total -= t.amount;
    }
    let budget = 0;
    for (const [name, v] of budgetByMonth.get(m) || []) if (isSpending(name)) budget += v;
    return { month: m, byCat, total: r2(total), budget: r2(budget) };
  });

  // Month over month: last two months with data.
  const withData = monthly.filter((m) => activeMonths.includes(m.month));
  const last = withData[withData.length - 1], prev = withData[withData.length - 2];
  const mom = last && prev ? { lastMonth: last.month, prevMonth: prev.month, last: last.total, prev: prev.total, change: r2(last.total - prev.total), pct: prev.total ? (last.total - prev.total) / Math.abs(prev.total) : null } : null;

  // Payees (spending only, respecting the focus category).
  const payeeMap = new Map();
  for (const t of txs) {
    if (t.amount >= 0 || !isSpending(t.category) || (focus && t.category !== focus)) continue;
    const key = t.payee;
    if (!payeeMap.has(key)) payeeMap.set(key, { name: key, spent: 0, count: 0, cats: new Map() });
    const p = payeeMap.get(key);
    p.spent -= t.amount;
    p.count++;
    p.cats.set(t.category, (p.cats.get(t.category) || 0) + 1);
  }
  const payees = [...payeeMap.values()]
    .map((p) => ({ name: p.name, spent: r2(p.spent), count: p.count, category: [...p.cats.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.spent - a.spent);

  return {
    currency, from, to, range, activeMonths, monthsCount,
    totals: {
      spent, income: r2(income), avgMonthly: r2(spent / monthsCount),
      fixed: r2(included.reduce((s, c) => s + c.fixed, 0)),
      budget: budgetTotal, spentBudgeted, variance: r2(budgetTotal - spentBudgeted),
      variancePct: budgetTotal ? (spentBudgeted - budgetTotal) / budgetTotal : null,
      unbudgeted: r2(spent - spentBudgeted), mom,
    },
    categories, monthly, payees,
    transactions: focus ? txs.filter((t) => t.category === focus) : txs,
  };
}

/** Spending per category for two periods ('YYYY-MM' or 'YYYY'). */
export function comparePeriods(allTxs, currency, a, b, excluded = new Set()) {
  const match = (p, m) => (p.length === 4 ? m.startsWith(p) : m === p);
  const rows = new Map();
  for (const t of allTxs) {
    if (t.currency !== currency || t.category === INCOME || excluded.has(t.category)) continue;
    const inA = match(a, t.month), inB = match(b, t.month);
    if (!inA && !inB) continue;
    if (!rows.has(t.category)) rows.set(t.category, { name: t.category, a: 0, b: 0 });
    const r = rows.get(t.category);
    if (inA) r.a -= t.amount;
    if (inB) r.b -= t.amount;
  }
  const out = [...rows.values()].map((r) => ({ name: r.name, a: r2(r.a), b: r2(r.b), diff: r2(r.b - r.a), pct: r.a ? (r.b - r.a) / Math.abs(r.a) : null }));
  out.sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b));
  const ta = r2(out.reduce((s, r) => s + r.a, 0)), tb = r2(out.reduce((s, r) => s + r.b, 0));
  return { rows: out, total: { a: ta, b: tb, diff: r2(tb - ta), pct: ta ? (tb - ta) / Math.abs(ta) : null } };
}

/** Percentage change from a to b, symmetric percentage difference, and ratio. */
export function percentDiff(a, b) {
  const ok = Number.isFinite(a) && Number.isFinite(b);
  if (!ok) return null;
  return {
    change: a !== 0 ? (b - a) / Math.abs(a) : null,
    difference: a + b !== 0 ? Math.abs(a - b) / (Math.abs(a + b) / 2) : null,
    ratio: a !== 0 ? b / a : null,
    absolute: r2(b - a),
  };
}

/** Squarified treemap layout. items: [{value}], returns [{item, x, y, w, h}] in a w\u00D7h box. */
export function treemap(items, width, height) {
  const data = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = data.reduce((s, d) => s + d.value, 0);
  const out = [];
  if (!total || width <= 0 || height <= 0) return out;
  const scale = (width * height) / total;
  let rect = { x: 0, y: 0, w: width, h: height };
  let row = [];
  const worst = (r, side) => {
    const s = r.reduce((a, d) => a + d.value * scale, 0);
    let max = 0, min = Infinity;
    for (const d of r) { const v = d.value * scale; max = Math.max(max, v); min = Math.min(min, v); }
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const layoutRow = (r) => {
    const s = r.reduce((a, d) => a + d.value * scale, 0);
    const horizontal = rect.w >= rect.h;
    const side = horizontal ? rect.h : rect.w;
    const thick = s / side;
    let off = 0;
    for (const d of r) {
      const len = (d.value * scale) / thick;
      out.push(horizontal ? { item: d, x: rect.x, y: rect.y + off, w: thick, h: len } : { item: d, x: rect.x + off, y: rect.y, w: len, h: thick });
      off += len;
    }
    rect = horizontal ? { x: rect.x + thick, y: rect.y, w: rect.w - thick, h: rect.h } : { x: rect.x, y: rect.y + thick, w: rect.w, h: rect.h - thick };
  };
  for (const d of data) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, d], side) <= worst(row, side)) row.push(d);
    else { layoutRow(row); row = [d]; }
  }
  if (row.length) layoutRow(row);
  return out;
}
