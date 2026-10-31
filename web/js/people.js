// Cards and people: find the card behind each transaction and attribute spending to a person.
import { cleanLabel } from './sanitize.js';
import { INCOME } from './categorize.js';

export const UNASSIGNED = 'Unassigned';

// "xxxx 1234", "XXXX1234", "**** 1234", "*1234" (Revolut top-ups), "Karte Nr. 1234", "card no. 1234"
const MASKED = /(?:x{2,}|\*+)\s?(\d{4})\b/i;
const NAMED = /\b(?:karte|card|carte|carta|kartennummer)\s*(?:nr\.?|no\.?|n\u00B0|number)?\s*:?\s*(\d{4})\b/i;

/** Last four digits of the card in a bank description, or ''. */
export function cardOf(desc) {
  const s = String(desc || '');
  const m = MASKED.exec(s) || NAMED.exec(s);
  return m ? m[1] : '';
}

export const SHARED = 'Shared';
export const ACCOUNT_KINDS = new Map([['shared', 'Shared account'], ['individual', 'Individual account']]);

/**
 * Attribute every transaction to an account and a person.
 * Individual account: everything belongs to its owner.
 * Shared account: card payments belong to the card's owner, everything else is "Shared".
 * accountOfFile(fileIndex) -> { name, kind: 'shared' | 'individual', owner }
 */
export function assignPeople(txs, { cardOwners, accountOfFile }) {
  return txs.map((t) => {
    const acct = accountOfFile(t.file) || { name: '', kind: 'shared', owner: '' };
    const person = acct.kind === 'individual'
      ? acct.owner || UNASSIGNED
      : (t.card && cardOwners.get(t.card)) || SHARED;
    return { ...t, account: acct.name, person };
  });
}

/** Money in and out per account (excluded categories left out of spending). */
export function accountSummary(txs, excluded = new Set()) {
  const accts = new Map();
  for (const t of txs) {
    if (!accts.has(t.account)) accts.set(t.account, { name: t.account, spent: 0, moneyIn: 0, count: 0 });
    const a = accts.get(t.account);
    a.count++;
    if (t.amount > 0) a.moneyIn += t.amount;
    if (t.category !== INCOME && !excluded.has(t.category)) a.spent -= t.amount;
  }
  return [...accts.values()].map((a) => ({ ...a, spent: Math.round(a.spent * 100) / 100, moneyIn: Math.round(a.moneyIn * 100) / 100 }));
}

/** Cards seen in the data with count, spending and the files they appear in. */
export function cardSummary(txs) {
  const cards = new Map();
  for (const t of txs) {
    if (!t.card) continue;
    if (!cards.has(t.card)) cards.set(t.card, { card: t.card, count: 0, spent: new Map(), files: new Set() });
    const c = cards.get(t.card);
    c.count++;
    c.files.add(t.file);
    if (t.amount < 0) c.spent.set(t.currency, (c.spent.get(t.currency) || 0) - t.amount);
  }
  return [...cards.values()].sort((a, b) => b.count - a.count || a.card.localeCompare(b.card));
}

/** Spending per person (excluded categories and income left out). */
export function personSummary(txs, excluded = new Set()) {
  const people = new Map();
  let total = 0;
  for (const t of txs) {
    if (t.category === INCOME || excluded.has(t.category)) continue;
    if (!people.has(t.person)) people.set(t.person, { name: t.person, spent: 0, count: 0, cats: new Map() });
    const p = people.get(t.person);
    p.spent -= t.amount;
    p.count++;
    p.cats.set(t.category, (p.cats.get(t.category) || 0) - t.amount);
    total -= t.amount;
  }
  return [...people.values()]
    .map((p) => ({
      name: p.name,
      spent: Math.round(p.spent * 100) / 100,
      count: p.count,
      share: total > 0 ? Math.max(0, p.spent) / total : 0,
      top: [...p.cats.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, spent]) => ({ name, spent: Math.round(spent * 100) / 100 })),
    }))
    .sort((a, b) => rank(a.name) - rank(b.name) || b.spent - a.spent);
}

const rank = (n) => (n === UNASSIGNED ? 2 : n === SHARED ? 1 : 0);

/** A safe person name from user input ('' means not assigned). */
export const cleanPerson = (v) => cleanLabel(v).slice(0, 40);
