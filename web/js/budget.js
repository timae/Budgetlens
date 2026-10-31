// Budgets edited in the app. They are monthly amounts per category and currency
// and replace any budget a file provides for that category.
import { normalizeKey, toCSV } from './sanitize.js';

export const MAX_BUDGET = 1e9;
export const budgetKey = (currency, category) => `${currency}|${normalizeKey(category)}`;

/** File budgets with edited categories replaced by the edited monthly amounts. */
export function applyBudgetEdits(fileBudgets, edits) {
  const out = fileBudgets.filter((b) => !edits.has(budgetKey(b.currency, b.category)));
  for (const e of edits.values()) if (e.amount > 0) out.push({ category: e.category, month: null, amount: e.amount, currency: e.currency });
  return out;
}

/** Parse a budget input: '' clears, otherwise a non-negative number (Swiss separators allowed). */
export function parseBudgetInput(raw) {
  const s = String(raw ?? '').trim().replace(/['\u2019\s]/g, '');
  if (s === '') return null;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET) return NaN;
  return Math.round(n * 100) / 100;
}

/** Suggested monthly budget: average monthly spending, rounded up to the next 10. */
export const suggestMonthly = (spent, months) => (spent > 0 ? Math.ceil(spent / Math.max(1, months) / 10) * 10 : 0);

/** A budget file that Budget Lens (and spreadsheets) can read back: Category, Monthly budget. */
export function budgetCSV(rows) {
  return toCSV([['Category', 'Monthly budget'], ...rows.filter((r) => r.amount > 0).map((r) => [r.category, r.amount])]);
}
