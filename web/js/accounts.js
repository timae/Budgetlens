// Accounts: recognise which files belong to the same bank account, remove transactions that
// appear in several exports of the same account, and find money moved between own accounts.
import { normalizeKey, cleanLabel } from './sanitize.js';
import { TRANSFERS, INCOME, OTHER } from './categorize.js';

/** A transaction's identity inside one account. */
export const txKey = (t) => `${t.date}|${Math.round(t.amount * 100)}|${normalizeKey(t.desc).slice(0, 80)}`;

/**
 * Fingerprint of a bank-export file: IBAN when the file has one, the column layout,
 * the bank (from the layout), the cards seen and the transaction keys (to spot overlap).
 */
export function fingerprint(result, txs) {
  const h = result.hint || {};
  return {
    iban: h.iban || '',
    layout: h.layout || '',
    bank: h.bank || '',
    cards: new Set(txs.map((t) => t.card).filter(Boolean)),
    keys: new Set(txs.map(txKey)),
  };
}

const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

/**
 * Group files into accounts. fps[i] is a fingerprint or null (budget sheets are not accounts).
 * Files are the same account when their IBANs match, or (without conflicting IBANs) when they share
 * the column layout and either a card or at least three identical transactions.
 * choices: Map(fileIndex -> 'own' | fileIndex) lets the user split a file off or join it to another.
 */
export function clusterAccounts(fps, choices = new Map()) {
  const parent = fps.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const a = fps[i], b = fps[j];
      if (!a || !b || choices.get(i) === 'own' || choices.get(j) === 'own' || choices.has(i) || choices.has(j)) continue;
      if (a.iban && b.iban) { if (a.iban === b.iban) union(i, j); continue; }
      if (a.layout !== b.layout) continue;
      if (overlap(a.cards, b.cards) > 0 || overlap(a.keys, b.keys) >= 3) union(i, j);
    }
  }
  for (const [i, target] of choices) if (typeof target === 'number' && fps[i] && fps[target]) union(i, target);
  const clusters = new Map();
  const of = fps.map((fp, i) => {
    if (!fp) return null;
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, { id: `a${root}`, files: [], iban: '', layout: fp.layout, bank: fp.bank, cards: new Set() });
    const c = clusters.get(root);
    c.files.push(i);
    c.iban = c.iban || fp.iban;
    c.bank = c.bank || fp.bank;
    for (const x of fp.cards) c.cards.add(x);
    return c.id;
  });
  return { clusters: [...clusters.values()], of };
}

/** A readable default name: bank plus IBAN tail or cards. */
export function defaultAccountName(c, fileName = '') {
  const cards = [...c.cards].sort();
  const what = c.iban ? `\u2026${c.iban.slice(-4)}` : cards.length ? `card${cards.length > 1 ? 's' : ''} ${cards.slice(0, 3).join(', ')}` : '';
  const name = [c.bank || '', what].filter(Boolean).join(' ');
  return cleanLabel(name || String(fileName).replace(/\.(csv|tsv|txt)$/i, '').replace(/[_-]+/g, ' ')).slice(0, 40) || 'Account';
}

/** Saved account settings that belong to a cluster: same IBAN, or same layout and a shared card. */
export function matchSaved(c, saved) {
  return saved.findIndex((s) => (c.iban && s.iban ? s.iban === c.iban : s.layout === c.layout && s.cards.some((x) => c.cards.has(x))))
    ;
}

/**
 * Drop transactions that several exports of the same account contain. Within one file identical
 * rows are kept (two coffees of 3.40 on one day); across files each key is kept as often as the
 * file with the most copies has it. Returns { txs, removed: Map(fileIndex -> count) }.
 */
export function dedupe(txs, accountOfFile) {
  const counts = new Map(); // account|key -> Map(file -> n)
  for (const t of txs) {
    const k = `${accountOfFile(t.file)}|${txKey(t)}`;
    if (!counts.has(k)) counts.set(k, new Map());
    const m = counts.get(k);
    m.set(t.file, (m.get(t.file) || 0) + 1);
  }
  const used = new Map();
  const removed = new Map();
  const out = [];
  for (const t of txs) {
    if (t.synthetic) { out.push(t); continue; }
    const k = `${accountOfFile(t.file)}|${txKey(t)}`;
    const allowed = Math.max(...counts.get(k).values());
    const n = used.get(k) || 0;
    if (n < allowed) { out.push(t); used.set(k, n + 1); }
    else removed.set(t.file, (removed.get(t.file) || 0) + 1);
  }
  return { txs: out, removed };
}

/**
 * Money moved between own accounts is a transfer, not income or spending:
 *  - a payment out of one account and a payment of the same amount into another within 4 days,
 *  - a payment whose text names one of the household's people (e.g. "Credit originator: Tim Muster").
 * ownNames: words (3+ letters) that identify the household's own transfers.
 */
export function markOwnTransfers(txs, ownNames = []) {
  const names = [...new Set(ownNames.map((n) => normalizeKey(n)).flatMap((n) => n.split(' ')).filter((w) => w.length >= 3))];
  const isTransfer = new Set();
  const outs = txs.map((t, i) => [t, i]).filter(([t]) => t.amount < 0 && !t.synthetic);
  const ins = txs.map((t, i) => [t, i]).filter(([t]) => t.amount > 0 && !t.synthetic);
  const byAmount = new Map();
  for (const [t, i] of ins) {
    const k = `${t.currency}|${Math.round(t.amount * 100)}`;
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push([t, i]);
  }
  const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  for (const [o, oi] of outs) {
    const cands = byAmount.get(`${o.currency}|${Math.round(-o.amount * 100)}`) || [];
    const hit = cands.find(([t, i]) => !isTransfer.has(i) && t.account !== o.account && Math.abs(day(t.date) - day(o.date)) <= 4);
    if (hit) { isTransfer.add(oi); isTransfer.add(hit[1]); }
  }
  if (names.length) {
    txs.forEach((t, i) => {
      if (t.synthetic || ![INCOME, OTHER, TRANSFERS].includes(t.category)) return;
      const hay = ` ${normalizeKey(t.desc)} `;
      if (names.some((n) => hay.includes(` ${n} `))) isTransfer.add(i);
    });
  }
  return txs.map((t, i) => (isTransfer.has(i) && t.category !== TRANSFERS ? { ...t, category: TRANSFERS, ownTransfer: true } : t));
}
