// Expenses that are not in any loaded file (paid from another account, in cash, by employer
// deduction ...): gym, public transport, taxes. The user enters them; they are added as
// transactions so they count in categories, totals, budgets, people and the forecast.
import { addMonths } from './dates.js';

export const OUTSIDE = 'Not in files';
export const MANUAL_RHYTHMS = new Map([[1, 'Monthly'], [2, 'Every 2 months'], [3, 'Quarterly'], [6, 'Half-yearly'], [12, 'Yearly'], [0, 'Once']]);

const r2 = (n) => Math.round(n * 100) / 100;
const active = (item, m) => m >= item.start && (!item.end || m <= item.end);

/**
 * Transactions for the analysis. Recurring costs appear as their monthly share in every
 * month (a yearly tax of 6000 is 500 a month), so averages and budgets are not distorted
 * by when the bill happens to fall. One-off costs appear in their month.
 * months: the months the analysis covers.
 */
export function manualTransactions(items, months) {
  const out = [];
  for (const it of items) {
    if (!(it.amount > 0) || !it.start) continue;
    for (const m of months) {
      if (!active(it, m)) continue;
      if (it.every === 0 && m !== it.start) continue;
      const amount = it.every === 0 ? it.amount : it.amount / it.every;
      out.push({
        date: `${m}-01`, month: m, desc: it.every > 1 ? `${it.name} (${MANUAL_RHYTHMS.get(it.every).toLowerCase()} ${r2(it.amount)}, monthly share)` : it.name,
        payee: it.name, rawCategory: it.category, category: it.category, amount: -r2(amount), currency: it.currency,
        synthetic: true, manual: true, fixed: it.every !== 0, account: OUTSIDE, person: it.person || 'Shared', card: '', file: -1,
      });
    }
  }
  return out;
}

/** When a manual cost is actually due in [start, end]: for the forecast (cash flow). */
export function manualDue(item, start, end) {
  const out = [];
  if (!(item.amount > 0) || !item.start) return out;
  if (item.every === 0) return item.start >= start && item.start <= end ? [{ month: item.start, amount: item.amount }] : [];
  for (let m = item.start, i = 0; m <= end && i < 1200; m = addMonths(m, item.every), i++) {
    if (m >= start && active(item, m)) out.push({ month: m, amount: item.amount });
  }
  return out;
}

/** Monthly equivalent of a manual cost (0 for one-offs). */
export const manualMonthly = (item) => (item.every ? r2(item.amount / item.every) : 0);
