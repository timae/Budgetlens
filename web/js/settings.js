// Save and load the user's setup (budgets, people, accounts, fixed costs, rules) as a JSON file.
// Nothing is stored in the browser; this file is the only way settings survive a reload.
// Loading treats the file as untrusted: strict shape checks, limits, cleaned strings, Maps only.
import { LIMITS } from './limits.js';
import { cleanLabel, normalizeKey } from './sanitize.js';
import { CADENCES } from './recurring.js';

export const SETTINGS_VERSION = 1;
export const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_ITEMS = 2000;

const str = (v, max = 60) => (typeof v === 'string' ? cleanLabel(v).slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9 ? Math.round(v * 100) / 100 : null);
const cur = (v) => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** state-like object -> JSON text */
export function saveSettings(s) {
  const data = {
    app: 'budget-lens',
    version: SETTINGS_VERSION,
    budgets: [...s.budgetEdits.values()].map((b) => ({ currency: b.currency, category: b.category, monthly: b.amount })),
    cards: [...s.cardOwners].map(([card, owner]) => ({ card, owner })),
    accounts: [...s.accounts].map(([, a]) => ({ name: a.name, kind: a.kind, owner: a.owner })),
    files: s.fileAccounts.map(([file, account]) => ({ file, account })),
    fixed: {
      overrides: [...s.fixedOverrides].map(([key, o]) => ({ key, ...o })),
      declared: [...s.fixedManual.values()].map((m) => ({ key: m.key, payee: m.payee, category: m.category, currency: m.currency, amount: m.amount, every: m.every })),
    },
    excluded: [...s.excluded],
    rules: s.ruleEntries.map(([category, keywords]) => ({ category, keywords })),
    useFileCategories: !!s.useFileCategories,
  };
  return JSON.stringify(data, null, 2);
}

/** JSON text -> validated settings with Maps. Throws a user-facing Error when the file is not a settings file. */
export function loadSettings(text) {
  if (typeof text !== 'string' || text.length > MAX_SETTINGS_BYTES) throw new Error('The settings file is too large.');
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('This is not a valid Budget Lens settings file.'); }
  if (!isObj(d) || d.app !== 'budget-lens' || d.version !== SETTINGS_VERSION) throw new Error('This is not a Budget Lens settings file.');

  const budgetEdits = new Map();
  for (const b of arr(d.budgets)) {
    if (!isObj(b)) continue;
    const c = cur(b.currency), category = str(b.category, LIMITS.maxCategoryLength), amount = num(b.monthly);
    if (c && category && amount != null) budgetEdits.set(`${c}|${normalizeKey(category)}`, { category, amount, currency: c });
  }
  const cardOwners = new Map();
  for (const x of arr(d.cards)) {
    if (isObj(x) && typeof x.card === 'string' && /^\d{4}$/.test(x.card) && str(x.owner, 40)) cardOwners.set(x.card, str(x.owner, 40));
  }
  const accounts = new Map();
  for (const a of arr(d.accounts)) {
    const name = isObj(a) ? str(a.name, 40) : '';
    if (!name) continue;
    accounts.set(normalizeKey(name), { name, kind: a.kind === 'individual' ? 'individual' : 'shared', owner: str(a.owner, 40) });
  }
  const fileAccounts = new Map();
  for (const f of arr(d.files)) {
    if (isObj(f) && str(f.file, 120) && str(f.account, 40)) fileAccounts.set(normalizeKey(str(f.file, 120)), str(f.account, 40));
  }
  const fixedOverrides = new Map();
  const fixedManual = new Map();
  const fx = isObj(d.fixed) ? d.fixed : {};
  const keyOk = (k) => typeof k === 'string' && /^[A-Z]{3}\|[a-z0-9 ]{1,120}$/.test(k);
  for (const o of arr(fx.overrides)) {
    if (!isObj(o) || !keyOk(o.key)) continue;
    const v = {};
    if (typeof o.active === 'boolean') v.active = o.active;
    if (o.amount === null) v.amount = null;
    else if (num(o.amount) != null) v.amount = num(o.amount);
    if (CADENCES.has(o.every)) v.every = o.every;
    fixedOverrides.set(o.key, v);
  }
  for (const m of arr(fx.declared)) {
    if (!isObj(m) || !keyOk(m.key) || !cur(m.currency)) continue;
    fixedManual.set(m.key, {
      key: m.key, payee: str(m.payee, 60) || m.key.slice(4), category: str(m.category, LIMITS.maxCategoryLength) || 'Other',
      currency: m.currency, amount: m.amount === null ? null : num(m.amount), every: CADENCES.has(m.every) ? m.every : 1,
    });
  }
  const excluded = new Set(arr(d.excluded).map((x) => str(x, LIMITS.maxCategoryLength)).filter(Boolean));
  const rules = arr(d.rules).slice(0, LIMITS.maxRules)
    .filter((r) => isObj(r) && str(r.category, LIMITS.maxCategoryLength))
    .map((r) => [str(r.category, LIMITS.maxCategoryLength), typeof r.keywords === 'string' ? r.keywords.slice(0, 8000) : '']);
  return {
    budgetEdits, cardOwners, accounts, fileAccounts, fixedOverrides, fixedManual, excluded,
    rules: rules.length ? rules : null,
    useFileCategories: typeof d.useFileCategories === 'boolean' ? d.useFileCategories : true,
  };
}
