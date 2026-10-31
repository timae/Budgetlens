// Forecast and savings goals: project an account month by month and work out how much has to be
// paid in to cover fixed costs, regular spending and savings goals without falling below a minimum.
import { addMonths, monthRange } from './dates.js';

const r2 = (n) => Math.round(n * 100) / 100;
const monthsBetween = (from, to) => (to < from ? 0 : monthRange(from, to).length);

/** Months a fixed cost is due inside [start, end]: from its next due date, every `every` months. */
export function fixedSchedule(item, start, end) {
  const out = [];
  if (!item || !item.every) return out;
  let m = item.next ? item.next.slice(0, 7) : start;
  // A due date in the past (overdue or missed) is expected in the first forecast month.
  if (m < start) m = start;
  for (let i = 0; m <= end && i < 600; i++, m = addMonths(m, item.every)) out.push(m);
  return out;
}

/** Monthly amount to set aside for a goal so it is reached by its target month. */
export function goalMonthly(goal, start) {
  const left = Math.max(0, (goal.amount || 0) - (goal.saved || 0));
  if (!left) return { monthly: 0, months: 0, left: 0, done: true };
  const months = Math.max(1, monthsBetween(start, goal.by && goal.by >= start ? goal.by : start));
  return { monthly: r2(left / months), months, left: r2(left), done: false };
}

/**
 * Build the forecast.
 * input: {
 *   start: 'YYYY-MM' first forecast month, months: horizon,
 *   balance: opening balance, buffer: minimum balance to keep,
 *   contributions: [{ name, monthly }] money paid in by people,
 *   otherIncome: monthly income other than contributions,
 *   variable: monthly spending that is not a fixed cost,
 *   fixed: [{ payee, amount, every, next }] (amount per due date),
 *   goals: [{ name, amount, saved, by }],
 * }
 */
export function buildForecast(input) {
  const { start, months, balance = 0, buffer = 0, contributions = [], otherIncome = 0, variable = 0, fixed = [], goals = [] } = input;
  const end = addMonths(start, Math.max(1, months) - 1);
  const range = monthRange(start, end);
  const contrib = contributions.reduce((s, c) => s + (Number(c.monthly) || 0), 0);

  const fixedBy = new Map(range.map((m) => [m, []]));
  for (const f of fixed) {
    if (f.amount == null || !(f.amount > 0)) continue;
    for (const m of fixedSchedule(f, start, end)) fixedBy.get(m).push({ payee: f.payee, amount: f.amount });
  }
  const goalPlans = goals.map((g) => ({ ...g, ...goalMonthly(g, start) }));

  let bal = balance;
  let cumBase = 0; // running total of everything except the contributions
  let required = 0; // smallest constant monthly contribution that keeps the balance >= buffer
  const rows = range.map((m, i) => {
    const fx = fixedBy.get(m).reduce((s, x) => s + x.amount, 0);
    const toGoals = goalPlans.reduce((s, g) => s + (!g.done && m <= addMonths(start, g.months - 1) ? g.monthly : 0), 0);
    const base = otherIncome - fx - variable - toGoals;
    cumBase += base;
    required = Math.max(required, (buffer - balance - cumBase) / (i + 1));
    const opening = bal;
    bal = bal + contrib + base;
    return { month: m, opening: r2(opening), moneyIn: r2(contrib + otherIncome), fixed: r2(fx), fixedItems: fixedBy.get(m), variable: r2(variable), goals: r2(toGoals), closing: r2(bal), belowBuffer: bal < buffer };
  });

  const n = rows.length;
  const avgOut = rows.reduce((s, r) => s + r.fixed + r.variable + r.goals, 0) / n;
  const average = Math.max(0, avgOut - otherIncome); // what has to come in per month on average
  return {
    start, end, rows, goals: goalPlans,
    contributions: r2(contrib),
    required: r2(Math.max(0, required)),
    average: r2(average),
    fixedMonthly: r2(rows.reduce((s, r) => s + r.fixed, 0) / n),
    goalsMonthly: r2(rows.reduce((s, r) => s + r.goals, 0) / n),
    lowest: rows.reduce((lo, r) => (r.closing < lo.closing ? r : lo), rows[0]),
    shortfallMonths: rows.filter((r) => r.belowBuffer).map((r) => r.month),
  };
}

export const SPLIT_MODES = new Map([
  ['current', 'Like today'],
  ['equal', 'Equal shares'],
  ['income', 'By net income'],
  ['custom', 'Own percentages'],
]);

/**
 * Split a monthly amount between people. Modes:
 *  current - in proportion to what each pays in today (equal when nobody pays in yet)
 *  equal   - the same for everyone
 *  income  - in proportion to the net incomes entered (weights)
 *  custom  - in proportion to the percentages entered (weights)
 * weights: Map(name -> number). Rounded to whole francs; the last person absorbs rounding.
 */
export function splitContribution(total, contributions, { mode = 'current', weights = new Map() } = {}) {
  const people = contributions.filter((c) => c.name);
  if (!people.length) return [];
  const raw = people.map((c) => {
    if (mode === 'equal') return 1;
    if (mode === 'income' || mode === 'custom') return Math.max(0, Number(weights.get(c.name)) || 0);
    return Math.max(0, Number(c.monthly) || 0);
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  let left = Math.round(total);
  return people.map((c, i) => {
    const share = sum > 0 ? raw[i] / sum : 1 / people.length;
    const amount = i === people.length - 1 ? left : Math.round(total * share);
    left -= amount;
    return { name: c.name, share, amount, current: Number(c.monthly) || 0, change: amount - (Number(c.monthly) || 0) };
  });
}

/**
 * Starting values for the plan from what happened in complete months:
 * spending that is not a fixed cost, income, and money paid in by each person
 * (transfers between own accounts, attributed by the names that identify them).
 * txs: transactions of the planned account(s) in one currency. fullMonths: complete months.
 */
export function planBaseline(txs, fullMonths, { ownNames = [], excluded = new Set(), income = 'Income', transfers = 'Transfers & savings' } = {}) {
  const months = new Set(fullMonths);
  const n = Math.max(1, months.size);
  let variable = 0, otherIncome = 0;
  const people = new Map();
  const names = ownNames.map((x) => x.trim()).filter((x) => x.length >= 2);
  const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
  for (const t of txs) {
    if (!months.has(t.month) || t.synthetic) continue;
    if (t.category === income) { if (t.amount > 0) otherIncome += t.amount; continue; }
    if (t.category === transfers) {
      if (t.amount <= 0) continue;
      const hay = ` ${norm(t.desc).replace(/[^a-z0-9]+/g, ' ')} `;
      const who = names.find((nm) => hay.includes(` ${norm(nm).replace(/[^a-z0-9]+/g, ' ').trim()} `)) || 'Other transfers in';
      people.set(who, (people.get(who) || 0) + t.amount);
      continue;
    }
    if (excluded.has(t.category) || t.fixed) continue;
    variable -= t.amount;
  }
  return {
    months: months.size,
    variable: r2(Math.max(0, variable / n)),
    otherIncome: r2(otherIncome / n),
    contributions: [...people].map(([name, sum]) => ({ name, monthly: Math.round(sum / n) })).sort((a, b) => b.monthly - a.monthly),
  };
}
