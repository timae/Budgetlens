// Budget Lens UI. All state lives in memory for the lifetime of the tab.
import { LIMITS } from './limits.js';
import { ENCODINGS } from './csv.js';
import { KINDS, ROLES, ROLE_LABELS } from './detect.js';
import { processFile, prepareTransactions, collectBudgets } from './pipeline.js';
import { DEFAULT_RULES, TRANSFERS, INCOME, buildRules, ruleText } from './categorize.js';
import { analyze, comparePeriods, currencies, dataMonths, percentDiff, presetRange } from './analyze.js';
import { normalizeKey, toCSV, cleanText } from './sanitize.js';
import { h, $, setChildren, option } from './dom.js';
import { drawMonthly, drawTreemap } from './charts.js';
import { money, money0, signed0, signed2, pct, signedPct, monthLabel, dayLabel } from './format.js';
import { ACCOUNT_KINDS, SHARED, UNASSIGNED, accountSummary, assignPeople, cardSummary, cleanPerson, personSummary } from './people.js';
import { applyBudgetEdits, budgetCSV, budgetKey, parseBudgetInput, suggestMonthly } from './budget.js';

const state = {
  files: [], // {id, name, bytes, overrides, result, error, open}
  seq: 0,
  ruleEntries: DEFAULT_RULES.map(([c, t]) => [c, t]),
  rules: buildRules(DEFAULT_RULES),
  useFileCategories: true,
  txs: [],
  fileBudgets: [],
  budgets: [],
  okFiles: [],
  // People and accounts: account settings keyed by normalised account name, card owners by last 4 digits.
  accounts: new Map(),
  cardOwners: new Map(),
  person: '',
  account: '',
  // Monthly budgets edited in the app, keyed by currency|category.
  budgetEdits: new Map(),
  currency: null,
  preset: 'all',
  from: null,
  to: null,
  excluded: new Set([TRANSFERS]),
  focus: null,
  colors: new Map(),
  cmpA: null,
  cmpB: null,
  txSearch: '',
  txKind: 'all',
  txSort: { key: 'date', dir: 'desc' },
  txLimit: 200,
  last: null,
};

const DELIMS = new Map([[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']]);
const DATE_LABELS = new Map([['DMY', 'Day first (31.12.2026)'], ['MDY', 'Month first (12/31/2026)'], ['YMD', 'ISO (2026-12-31)'], ['serial', 'Excel serial number']]);
const DEC_LABELS = new Map([['dot', "1'234.50 (dot decimal)"], ['comma', '1.234,50 (comma decimal)']]);

// ---------- status ----------
function setStatus(msg, error = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', error);
}

// ---------- files ----------
async function addFiles(list) {
  const files = [...list];
  if (!files.length) return;
  const room = LIMITS.maxFiles - state.files.length;
  if (room <= 0) return setStatus(`You can load up to ${LIMITS.maxFiles} files. Remove one first.`, true);
  const skipped = [];
  for (const f of files.slice(0, room)) {
    if (f.size > LIMITS.maxFileBytes) { skipped.push(`${cleanText(f.name, 60)} (over 15 MB)`); continue; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      state.files.push({ id: ++state.seq, name: f.name, bytes, overrides: {}, open: false, account: defaultAccountName(f.name) });
    } catch {
      skipped.push(cleanText(f.name, 60));
    }
  }
  if (files.length > room) skipped.push(`${files.length - room} more (file limit reached)`);
  reprocess();
  const ok = state.files.filter((f) => f.result).length;
  setStatus(skipped.length ? `Skipped: ${skipped.join(', ')}.` : `${ok} file${ok === 1 ? '' : 's'} analysed in this browser.`, skipped.length > 0);
}

function runFile(f, defaultMonth) {
  try {
    f.result = processFile(f.name, f.bytes, f.overrides, { defaultMonth });
    f.error = null;
  } catch (e) {
    f.result = null;
    f.error = e instanceof Error ? e.message : 'Could not read this file.';
  }
}

function reprocess() {
  for (const f of state.files) runFile(f);
  // Undated budget/actual sheets default to the latest month found in transaction files.
  const latest = state.files.flatMap((f) => (f.result ? f.result.records.transactions.filter((t) => !t.synthetic).map((t) => t.month) : [])).sort().pop();
  if (latest) for (const f of state.files) if (f.result && f.result.settings.kind !== 'transactions' && !f.overrides.month) runFile(f, latest);
  recompute();
}

const defaultAccountName = (name) => cleanPerson(String(name).replace(/\.(csv|tsv|txt)$/i, '').replace(/[_-]+/g, ' ')) || 'Account';

function accountFor(f) {
  const name = f.account || defaultAccountName(f.name);
  const a = state.accounts.get(normalizeKey(name));
  return { name, kind: a?.kind || 'shared', owner: a?.owner || '' };
}

function recompute() {
  state.okFiles = state.files.filter((f) => f.result);
  const ok = state.okFiles.map((f) => f.result);
  const txs = prepareTransactions(ok, state.rules, { useFileCategories: state.useFileCategories });
  state.txs = assignPeople(txs, { cardOwners: state.cardOwners, accountOfFile: (i) => accountFor(state.okFiles[i]) });
  state.fileBudgets = collectBudgets(ok);
  state.budgets = applyBudgetEdits(state.fileBudgets, state.budgetEdits);
  if (state.person && !state.txs.some((t) => t.person === state.person)) state.person = '';
  if (state.account && !state.txs.some((t) => t.account === state.account)) state.account = '';
  const cur = currencies(state.txs, state.budgets);
  if (!cur.includes(state.currency)) state.currency = cur[0] || 'CHF';
  assignColors();
  applyPreset(false);
  renderAll();
}

/** Stable category colours: rank by spending across all data in the currency. */
function assignColors() {
  const tot = new Map();
  for (const t of state.txs) {
    if (t.currency !== state.currency || t.category === INCOME) continue;
    tot.set(t.category, (tot.get(t.category) || 0) - t.amount);
  }
  for (const b of state.budgets) if (!tot.has(b.category)) tot.set(b.category, 0);
  const ranked = [...tot.entries()].filter(([n]) => !state.excluded.has(n)).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  state.colors = new Map();
  ranked.forEach((n, i) => state.colors.set(normalizeKey(n), i < 12 ? `c${i}` : 'cx'));
}
const colorOf = (name) => state.colors.get(normalizeKey(name)) || 'cx';

function months() {
  return dataMonths(state.txs.filter((t) => t.currency === state.currency), state.budgets.filter((b) => b.currency === state.currency && b.month));
}

function applyPreset(fromUser) {
  const ms = months();
  if (state.preset !== 'custom' || !state.from || !ms.length) {
    const r = presetRange(state.preset === 'custom' ? 'all' : state.preset, ms);
    state.from = r.from;
    state.to = r.to;
  }
  if (state.from && state.to && state.from > state.to) [state.from, state.to] = [state.to, state.from];
  if (fromUser) state.txLimit = 200;
}

// ---------- rendering ----------
function renderAll() {
  const has = state.files.length > 0;
  $('#files-section').hidden = !has;
  $('#intake').classList.toggle('compact', has);
  $('#clear-btn').disabled = !has;
  renderFiles();
  const hasData = state.txs.length > 0 || state.budgets.length > 0;
  $('#dashboard').hidden = !hasData;
  if (hasData) renderDashboard();
}

/** Transactions after the account and person filters. */
function viewTxs() {
  return state.txs.filter((t) => (!state.account || t.account === state.account) && (!state.person || t.person === state.person));
}

function renderDashboard() {
  const a = analyze(viewTxs(), state.budgets, { from: state.from, to: state.to, currency: state.currency, excluded: state.excluded, focus: state.focus });
  state.last = a;
  renderToolbar();
  renderHero(a);
  renderWhere(a);
  renderPeople();
  renderBudget(a);
  renderMonthly(a);
  renderCompare();
  renderCalc();
  renderPayees(a);
  renderTx();
  if (!$('#rules').childElementCount) renderRules();
}

function renderToolbar() {
  const ms = months();
  $('#preset').value = state.preset;
  setChildren($('#from'), ms.map((m) => option(m, monthLabel(m), m === state.from)));
  setChildren($('#to'), ms.map((m) => option(m, monthLabel(m), m === state.to)));
  const cur = currencies(state.txs, state.budgets);
  setChildren($('#currency'), cur.map((c) => option(c, c, c === state.currency)));
  const accts = [...new Set(state.txs.map((t) => t.account))].sort();
  setChildren($('#account'), option('', 'All accounts', !state.account), accts.map((n) => option(n, n, n === state.account)));
  const generic = (n) => n === SHARED || n === UNASSIGNED;
  const people = [...new Set(state.txs.map((t) => t.person))].sort((x, y) => generic(x) - generic(y) || x.localeCompare(y));
  setChildren($('#person'), option('', 'Everyone', !state.person), people.map((n) => option(n, n, n === state.person)));
}

function figure(label, value, sub, cls) {
  return h('div', { class: 'figure' },
    h('span', { class: 'label', text: label }),
    h('span', { class: ['value', cls] }, value),
    h('span', { class: 'sub' }, sub));
}
const curSpan = (c) => h('span', { class: 'cur', text: c });

function renderHero(a) {
  const c = a.currency, t = a.totals;
  const period = !a.from ? 'No dated rows' : a.from === a.to ? monthLabel(a.from) : `${monthLabel(a.from)} \u2013 ${monthLabel(a.to)}`;
  const items = [
    figure('Total spent', [curSpan(c), money0(t.spent)], `${period}${t.income ? ` \u00B7 income ${money0(t.income)}` : ''}`),
    figure('Monthly average', [curSpan(c), money0(t.avgMonthly)], `over ${a.monthsCount} month${a.monthsCount === 1 ? '' : 's'} with data`),
  ];
  if (t.budget > 0) {
    const over = t.variance < 0;
    items.push(figure('Budget variance', [curSpan(c), money0(Math.abs(t.variance))],
      `${signedPct(t.variancePct)} \u00B7 ${over ? 'over' : 'under'} a budget of ${money0(t.budget)}${t.unbudgeted > 0.5 ? ` \u00B7 ${money0(t.unbudgeted)} not budgeted` : ''}`, over ? 'bad' : 'good'));
  } else {
    items.push(figure('Budget variance', '\u2013', 'No budget for this period and currency'));
  }
  const mom = t.mom;
  if (mom && mom.pct != null) {
    items.push(figure('Month over month', signedPct(mom.pct), `${monthLabel(mom.lastMonth)}: ${money0(mom.last)} vs ${money0(mom.prev)} in ${monthLabel(mom.prevMonth)}`, mom.change > 0 ? 'bad' : 'good'));
  } else {
    items.push(figure('Month over month', '\u2013', 'Needs two months with data'));
  }
  setChildren($('#hero'), items);
}

function setFocus(name) {
  state.focus = name;
  state.txLimit = 200;
  renderDashboard();
  const target = name ? $('#crumbs button') : $('#treemap .tile');
  if (target) target.focus();
}

function renderWhere(a) {
  const c = a.currency;
  const crumbs = $('#crumbs');
  if (state.focus) {
    const cat = a.categories.find((x) => x.name === state.focus);
    setChildren(crumbs,
      h('button', { type: 'button', class: 'btn small', text: '\u2190 All categories', on: { click: () => setFocus(null) } }),
      h('span', { class: 'cat-cell' }, h('span', { class: ['swatch', colorOf(state.focus)] }), h('strong', { text: state.focus })),
      cat ? h('span', { class: 'muted', text: `${c} ${money0(cat.spent)} \u00B7 ${pct(cat.share)} \u00B7 payees below` }) : null);
  } else {
    setChildren(crumbs, h('span', { class: 'muted', text: `All categories \u00B7 ${a.categories.filter((x) => x.included && x.spent > 0).length} with spending` }));
  }

  const map = $('#treemap');
  let items;
  if (state.focus) {
    const cls = colorOf(state.focus);
    const top = a.payees.slice(0, 40);
    const rest = a.payees.slice(40).reduce((s, p) => s + p.spent, 0);
    items = top.map((p) => ({ name: p.name, value: p.spent, cls, hint: 'Press to show its transactions.', onClick: () => showPayee(p.name) }));
    if (rest > 0) items.push({ name: `${a.payees.length - 40} more payees`, value: rest, cls: 'cx', onClick: () => {} });
  } else {
    items = a.categories.filter((x) => x.included && x.spent > 0).map((x) => ({ name: x.name, value: x.spent, cls: colorOf(x.name), hint: 'Press to focus.', onClick: () => setFocus(x.name) }));
  }
  drawTreemap(map, items, { currency: c, emptyText: 'No spending in this period.' });

  const rows = a.categories.filter((x) => x.spent !== 0 || x.budget > 0);
  setChildren($('#catlist'), rows.map((x) => {
    const id = `inc-${normalizeKey(x.name).replace(/ /g, '-') || 'x'}-${rows.indexOf(x)}`;
    return h('li', { class: x.included ? '' : 'off' },
      h('input', {
        type: 'checkbox', id, checked: x.included,
        attrs: { 'aria-label': `Include ${x.name} in totals` },
        on: { change: (e) => { e.target.checked ? state.excluded.delete(x.name) : state.excluded.add(x.name); if (!e.target.checked && state.focus === x.name) state.focus = null; renderDashboard(); $(`#${CSS.escape(id)}`)?.focus(); } },
      }),
      h('span', { class: ['swatch', x.included ? colorOf(x.name) : 'cx'] }),
      h('span', { class: 'cat-name' }, x.included && x.spent > 0
        ? h('button', { type: 'button', text: x.name, attrs: { 'aria-label': `Focus on ${x.name}` }, on: { click: () => setFocus(x.name) } })
        : x.name),
      h('span', { class: 'cat-amt' }, money0(x.spent), x.included ? h('span', { class: 'cat-share', text: pct(x.share) }) : h('span', { class: 'cat-share', text: 'excluded' })),
      h('span', { class: 'cat-bar', attrs: { 'aria-hidden': 'true' } }, h('span', { class: ['bar-fill', colorOf(x.name)], css: { width: `${Math.max(0, x.share * 100)}%` } })));
  }));
}

function showPayee(name) {
  state.txSearch = name;
  $('#tx-search').value = name;
  state.txLimit = 200;
  renderTx();
  $('#tx-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('#tx-search').focus();
}

const STATUS = new Map([['over', 'Over'], ['near', 'Near limit'], ['under', 'Under'], ['none', 'No budget']]);

// ---------- budgets edited in the app ----------
function setBudgetEdit(category, raw, inputId) {
  const v = parseBudgetInput(raw);
  if (Number.isNaN(v)) { setStatus(`"${cleanText(raw, 20)}" is not a valid amount for ${category}.`, true); return; }
  const key = budgetKey(state.currency, category);
  if (v == null) state.budgetEdits.delete(key);
  else state.budgetEdits.set(key, { category, amount: v, currency: state.currency });
  refreshBudgets();
  if (inputId) document.getElementById(inputId)?.focus();
}

function refreshBudgets() {
  state.budgets = applyBudgetEdits(state.fileBudgets, state.budgetEdits);
  renderAll();
}

function renderBudget(a) {
  const el = $('#bva');
  const c = a.currency;
  const t = a.totals;
  const rows = a.categories.filter((x) => x.included && (x.budget > 0 || x.spent > 0));
  const edited = [...state.budgetEdits.values()].filter((e) => e.currency === c).length;
  $('#budget-reset').disabled = edited === 0;
  $('#budget-note').textContent = state.person || state.account
    ? `Showing ${[state.account, state.person].filter(Boolean).join(' \u00B7 ')} against the full budget. Monthly budgets are multiplied by the months in the period.`
    : 'Set a monthly budget per category, or load a budget file. Monthly budgets are multiplied by the months in the period.';
  if (!rows.length) { setChildren(el, h('p', { class: 'empty', text: 'No spending in this period.' })); return; }
  const table = h('table', { class: 'data' },
    h('caption', { class: 'sr-only', text: `Budget versus actual spending per category, ${c}. The monthly budget column is editable.` }),
    h('thead', {}, h('tr', {},
      h('th', { attrs: { scope: 'col' }, text: 'Category' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: 'Monthly budget' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: 'Budget (period)' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: 'Actual' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: 'Difference' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: '% vs budget' }),
      h('th', { attrs: { scope: 'col' }, text: 'Status' }),
      h('th', { class: 'hide-sm', attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Bar' })))),
    h('tbody', {}, rows.map((x, i) => {
      const scale = Math.max(x.budget, x.spent, 1);
      const edit = state.budgetEdits.get(budgetKey(c, x.name));
      const monthly = x.budget ? Math.round((x.budget / a.monthsCount) * 100) / 100 : 0;
      const id = `bud-${i}`;
      const input = h('input', {
        type: 'text', id, value: edit ? String(edit.amount) : monthly ? String(monthly) : '',
        class: edit ? 'edited' : '',
        attrs: { inputmode: 'decimal', autocomplete: 'off', placeholder: 'none', maxlength: 14, 'aria-label': `Monthly budget for ${x.name} in ${c}${edit ? ' (changed here)' : ''}` },
        on: {
          change: (e) => setBudgetEdit(x.name, e.target.value, id),
          keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); document.getElementById(`bud-${i + 1}`)?.focus(); } },
        },
      });
      return h('tr', {},
        h('th', { attrs: { scope: 'row' } }, h('span', { class: 'cat-cell' }, h('span', { class: ['swatch', colorOf(x.name)] }), x.name)),
        h('td', { class: 'num' }, h('span', { class: 'budget-input' }, input)),
        h('td', { class: 'num', text: x.budget ? money(x.budget) : '\u2013' }),
        h('td', { class: 'num', text: money(x.spent) }),
        h('td', { class: ['num', x.budget ? (x.diff < 0 ? 'bad' : 'good') : ''], text: x.budget ? signed2(x.diff) : '\u2013' }),
        h('td', { class: 'num', text: signedPct(x.pct) }),
        h('td', {}, h('span', { class: ['pill', x.status], text: STATUS.get(x.status) })),
        h('td', { class: 'hide-sm' }, h('div', { class: ['bva-bar', colorOf(x.name)], attrs: { 'aria-hidden': 'true' } },
          h('span', { class: ['fill', x.status === 'over' ? 'over' : ''], css: { width: `${(Math.max(0, x.spent) / scale) * 100}%` } }),
          x.budget ? h('span', { class: 'mark', css: { left: `calc(${(x.budget / scale) * 100}% - 1px)` } }) : null)));
    })),
    h('tfoot', {}, h('tr', {},
      h('td', { text: 'Budgeted categories' }),
      h('td', { class: 'num', text: t.budget ? money(t.budget / a.monthsCount) : '\u2013' }),
      h('td', { class: 'num', text: money(t.budget) }),
      h('td', { class: 'num', text: money(t.spentBudgeted) }),
      h('td', { class: ['num', t.variance < 0 ? 'bad' : 'good'], text: t.budget ? signed2(t.variance) : '\u2013' }),
      h('td', { class: 'num', text: signedPct(t.variancePct) }),
      h('td', { attrs: { colspan: 2 }, class: 'muted', text: t.unbudgeted > 0.5 ? `${money(t.unbudgeted)} spent without a budget` : '' }))));
  setChildren(el, table);
}

function suggestBudgets() {
  const a = state.last;
  if (!a) return;
  let n = 0;
  for (const x of a.categories) {
    if (!x.included || x.spent <= 0) continue;
    const key = budgetKey(a.currency, x.name);
    if (x.budget > 0 && !state.budgetEdits.has(key)) continue; // keep budgets that came from files
    state.budgetEdits.set(key, { category: x.name, amount: suggestMonthly(x.spent, a.monthsCount), currency: a.currency });
    n++;
  }
  refreshBudgets();
  setStatus(n ? `Suggested monthly budgets for ${n} categories from average spending. Edit any amount in the table.` : 'Every category already has a budget.');
}

function exportBudget() {
  const a = state.last;
  if (!a) return;
  const rows = a.categories.filter((x) => x.included && x.budget > 0).map((x) => {
    const edit = state.budgetEdits.get(budgetKey(a.currency, x.name));
    return { category: x.name, amount: edit ? edit.amount : Math.round((x.budget / a.monthsCount) * 100) / 100 };
  });
  if (!rows.length) { setStatus('There are no budgets to download yet.', true); return; }
  download(`budget-lens-budget_${a.currency}.csv`, budgetCSV(rows));
  setStatus(`Budget for ${rows.length} categories downloaded. Drop it in next time to start with these budgets.`);
}

// ---------- people and accounts ----------
function renderPeople() {
  const c = state.currency;
  const inRange = state.txs.filter((t) => t.currency === c && (!state.from || (t.month >= state.from && t.month <= state.to)));
  const people = personSummary(inRange, state.excluded);
  const named = [...new Set([...state.cardOwners.values(), ...[...state.accounts.values()].map((x) => x.owner)].filter(Boolean))].sort();
  setChildren($('#people-list'), named.map((n) => option(n, n)));
  setChildren($('#account-list'), [...new Set(state.files.map((f) => f.account))].map((n) => option(n, n)));

  setChildren($('#people-summary'), people.length ? h('table', { class: 'data' },
    h('caption', { class: 'sr-only', text: `Spending per person in ${c} for the selected period` }),
    h('thead', {}, h('tr', {},
      h('th', { attrs: { scope: 'col' }, text: 'Person' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: `Spent (${c})` }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: 'Share' }),
      h('th', { class: 'num hide-sm', attrs: { scope: 'col' }, text: 'Transactions' }),
      h('th', { class: 'hide-sm', attrs: { scope: 'col' }, text: 'Top categories' }),
      h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Filter' })))),
    h('tbody', {}, people.map((p) => {
      const on = state.person === p.name;
      return h('tr', {},
        h('th', { attrs: { scope: 'row' }, text: p.name }),
        h('td', { class: 'num', text: money0(p.spent) }),
        h('td', { class: 'num', text: pct(p.share) }),
        h('td', { class: 'num hide-sm', text: String(p.count) }),
        h('td', { class: ['top-cats', 'hide-sm'], text: p.top.map((x) => `${x.name} ${money0(x.spent)}`).join(' \u00B7 ') }),
        h('td', {}, h('button', {
          type: 'button', class: 'btn small', text: on ? 'Show everyone' : 'Show only',
          attrs: { 'aria-label': on ? 'Show everyone' : `Show only ${p.name}` },
          on: { click: () => { state.person = on ? '' : p.name; state.focus = null; renderDashboard(); } },
        })));
    }))) : h('p', { class: 'empty', text: 'No spending in this period.' }));

  // Accounts: one row per file; several files with the same account name form one account.
  const firstOf = new Map();
  for (const f of state.okFiles) {
    if (f.result.settings.kind !== 'transactions') continue;
    const k = normalizeKey(accountFor(f).name);
    if (!firstOf.has(k)) firstOf.set(k, f);
  }
  const sums = new Map(accountSummary(inRange, state.excluded).map((x) => [normalizeKey(x.name), x]));
  setChildren($('#accounts'), h('table', { class: 'data' },
    h('caption', { class: 'sr-only', text: 'Accounts: name the account behind each file, mark it shared or individual and set the owner' }),
    h('thead', {}, h('tr', {},
      h('th', { attrs: { scope: 'col' }, text: 'File' }),
      h('th', { attrs: { scope: 'col' }, text: 'Account' }),
      h('th', { attrs: { scope: 'col' }, text: 'Type' }),
      h('th', { attrs: { scope: 'col' }, text: 'Owner' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: `Spent (${c})` }))),
    h('tbody', {}, state.okFiles.map((f, i) => {
      if (f.result.settings.kind !== 'transactions') return null; // budget sheets are not accounts
      const acct = accountFor(f);
      const key = normalizeKey(acct.name);
      const first = firstOf.get(key) === f;
      const set = (patch, focusId) => {
        const cur = state.accounts.get(key) || { kind: 'shared', owner: '' };
        state.accounts.set(key, { ...cur, ...patch });
        recompute();
        if (focusId) document.getElementById(focusId)?.focus();
      };
      return h('tr', {},
        h('td', { class: 'desc', text: f.result.name }),
        h('td', {}, h('input', {
          type: 'text', id: `acct-name-${i}`, value: acct.name,
          attrs: { list: 'account-list', maxlength: 40, autocomplete: 'off', spellcheck: 'false', 'aria-label': `Account name for ${f.result.name}` },
          on: { change: (e) => { f.account = cleanPerson(e.target.value) || defaultAccountName(f.name); recompute(); document.getElementById(`acct-name-${i}`)?.focus(); } },
        })),
        h('td', {}, first
          ? h('select', { id: `acct-kind-${i}`, attrs: { 'aria-label': `Type of account ${acct.name}` }, on: { change: (e) => set({ kind: e.target.value }, `acct-kind-${i}`) } },
            [...ACCOUNT_KINDS].map(([v, l]) => option(v, l, v === acct.kind)))
          : h('span', { class: 'muted', text: 'Same account as above' })),
        h('td', {}, first
          ? h('input', {
            type: 'text', id: `acct-owner-${i}`, value: acct.owner,
            attrs: { list: 'people-list', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: acct.kind === 'individual' ? 'e.g. Tim' : 'Not needed', 'aria-label': `Owner of account ${acct.name}` },
            on: { change: (e) => set({ owner: cleanPerson(e.target.value) }, `acct-owner-${i}`) },
          })
          : null),
        h('td', { class: 'num', text: first ? money0(sums.get(key)?.spent || 0) : '' }));
    }))));

  const cards = cardSummary(state.txs);
  setChildren($('#cards'), cards.length ? h('table', { class: 'data' },
    h('caption', { class: 'sr-only', text: 'Cards found in the transactions; assign each to a person' }),
    h('thead', {}, h('tr', {},
      h('th', { attrs: { scope: 'col' }, text: 'Card' }),
      h('th', { attrs: { scope: 'col' }, text: 'Belongs to' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: 'Payments' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: `Spent (${c})` }))),
    h('tbody', {}, cards.map((cd, i) => h('tr', {},
      h('th', { attrs: { scope: 'row' }, text: `\u2022\u2022\u2022\u2022 ${cd.card}` }),
      h('td', {}, h('input', {
        type: 'text', id: `card-${i}`, value: state.cardOwners.get(cd.card) || '',
        attrs: { list: 'people-list', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. Tim', 'aria-label': `Owner of card ending ${cd.card}` },
        on: { change: (e) => { const v = cleanPerson(e.target.value); if (v) state.cardOwners.set(cd.card, v); else state.cardOwners.delete(cd.card); recompute(); document.getElementById(`card-${i}`)?.focus(); } },
      })),
      h('td', { class: 'num', text: String(cd.count) }),
      h('td', { class: 'num', text: money0(cd.spent.get(c) || 0) }))))) : h('p', { class: 'empty', text: 'No card numbers found in the descriptions.' }));
}

function renderMonthly(a) {
  const totals = new Map();
  for (const m of a.monthly) for (const [n, v] of m.byCat) totals.set(n, (totals.get(n) || 0) + v);
  const top = [...totals.entries()].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 7).map(([n]) => ({ name: n, cls: colorOf(n) }));
  const series = state.focus ? top.filter((x) => x.name === state.focus) : top;
  const monthsData = state.focus
    ? a.monthly.map((m) => ({ ...m, byCat: new Map([[state.focus, m.byCat.get(state.focus) || 0]]), total: m.byCat.get(state.focus) || 0, budget: 0 }))
    : a.monthly;
  drawMonthly($('#monthly'), monthsData, series, { currency: a.currency });
  const legend = series.map((x) => h('span', {}, h('span', { class: ['swatch', x.cls] }), x.name));
  if (!state.focus && totals.size > top.length) legend.push(h('span', {}, h('span', { class: ['swatch', 'cx'] }), 'Other categories'));
  if (monthsData.some((m) => m.budget > 0)) legend.push(h('span', {}, h('span', { class: 'budget-key' }), 'Budget'));
  setChildren($('#monthly-legend'), legend);
  // Tables ignore width/overflow, so the visually hidden wrapper is a div.
  setChildren($('#monthly-table'), h('div', { class: 'sr-only' }, h('table', {},
    h('caption', { text: `Spending per month in ${a.currency}` }),
    h('thead', {}, h('tr', {}, h('th', { attrs: { scope: 'col' }, text: 'Month' }), h('th', { attrs: { scope: 'col' }, text: 'Spent' }), h('th', { attrs: { scope: 'col' }, text: 'Budget' }))),
    h('tbody', {}, monthsData.map((m) => h('tr', {}, h('th', { attrs: { scope: 'row' }, text: monthLabel(m.month) }), h('td', { text: money0(m.total) }), h('td', { text: m.budget ? money0(m.budget) : '\u2013' })))))));
}

function periodOptions() {
  const ms = dataMonths(state.txs.filter((t) => t.currency === state.currency));
  const years = [...new Set(ms.map((m) => m.slice(0, 4)))];
  return { ms, years };
}

function renderCompare() {
  const { ms, years } = periodOptions();
  const all = [...[...ms].reverse(), ...[...years].reverse()];
  if (!all.includes(state.cmpB)) state.cmpB = ms[ms.length - 1] || years[0] || null;
  if (!all.includes(state.cmpA)) state.cmpA = ms[ms.length - 2] || state.cmpB;
  const build = (sel, val) => setChildren(sel,
    h('optgroup', { attrs: { label: 'Months' } }, [...ms].reverse().map((m) => option(m, monthLabel(m), m === val))),
    h('optgroup', { attrs: { label: 'Years' } }, [...years].reverse().map((y) => option(y, y, y === val))));
  build($('#cmp-a'), state.cmpA);
  build($('#cmp-b'), state.cmpB);
  const el = $('#compare');
  if (!state.cmpA || !state.cmpB) { setChildren(el, h('p', { class: 'empty', text: 'Not enough data to compare.' })); return; }
  const r = comparePeriods(viewTxs(), state.currency, state.cmpA, state.cmpB, state.excluded);
  const A = monthLabel(state.cmpA), B = monthLabel(state.cmpB);
  setChildren(el, h('table', { class: 'data' },
    h('caption', { class: 'sr-only', text: `Spending by category: ${A} compared with ${B}, ${state.currency}` }),
    h('thead', {}, h('tr', {},
      h('th', { attrs: { scope: 'col' }, text: 'Category' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: A }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: B }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: 'Change' }),
      h('th', { class: 'num', attrs: { scope: 'col' }, text: '%' }))),
    h('tbody', {}, r.rows.map((x) => h('tr', {},
      h('th', { attrs: { scope: 'row' } }, h('span', { class: 'cat-cell' }, h('span', { class: ['swatch', colorOf(x.name)] }), x.name)),
      h('td', { class: 'num', text: money0(x.a) }),
      h('td', { class: 'num', text: money0(x.b) }),
      h('td', { class: ['num', x.diff > 0 ? 'bad' : x.diff < 0 ? 'good' : ''], text: signed0(x.diff) }),
      h('td', { class: 'num', text: signedPct(x.pct) })))),
    h('tfoot', {}, h('tr', {},
      h('td', { text: 'Total' }),
      h('td', { class: 'num', text: money0(r.total.a) }),
      h('td', { class: 'num', text: money0(r.total.b) }),
      h('td', { class: ['num', r.total.diff > 0 ? 'bad' : 'good'], text: signed0(r.total.diff) }),
      h('td', { class: 'num', text: signedPct(r.total.pct) })))));
}

function renderCalc() {
  const a = Number($('#calc-a').value), b = Number($('#calc-b').value);
  const r = $('#calc-a').value !== '' && $('#calc-b').value !== '' ? percentDiff(a, b) : null;
  const cell = (label, value) => h('div', {}, h('span', { class: 'label', text: label }), h('strong', { text: value }));
  setChildren($('#calc-out'), r ? [
    cell('Change from A to B', signedPct(r.change)),
    cell('Absolute difference', signed2(r.absolute)),
    cell('Percentage difference', pct(r.difference)),
    cell('Ratio B / A', r.ratio == null ? '\u2013' : `${r.ratio.toFixed(3)}\u00D7`),
  ] : [cell('Result', 'Enter two numbers')]);
}

function renderPayees(a) {
  const list = a.payees.slice(0, 16);
  $('#payees-note').textContent = state.focus ? `Top payees in ${state.focus}.` : 'Names cleaned up from bank descriptions; store branches grouped by chain.';
  if (!list.length) { setChildren($('#payees'), h('li', { class: 'empty', text: 'No spending in this period.' })); return; }
  const max = list[0].spent || 1;
  setChildren($('#payees'), list.map((p, i) => h('li', {},
    h('span', { class: 'rank', text: String(i + 1) }),
    h('span', { class: 'p-name' }, h('button', { type: 'button', class: 'btn link', text: p.name, attrs: { 'aria-label': `${p.name}: show transactions` }, on: { click: () => showPayee(p.name) } })),
    h('span', { class: 'num', text: `${a.currency} ${money0(p.spent)}` }),
    h('span', { class: 'p-meta' },
      h('span', { class: ['swatch', colorOf(p.category)] }),
      `${p.category} \u00B7 ${p.count}\u00D7`,
      h('span', { class: 'p-bar', attrs: { 'aria-hidden': 'true' } }, h('span', { class: ['bar-fill', colorOf(p.category)], css: { width: `${(p.spent / max) * 100}%` } }))))));
}

const SORTS = {
  date: (x, y) => x.date.localeCompare(y.date),
  payee: (x, y) => x.payee.localeCompare(y.payee),
  category: (x, y) => x.category.localeCompare(y.category),
  amount: (x, y) => x.amount - y.amount,
};

function filteredTx() {
  if (!state.last) return [];
  const q = normalizeKey(state.txSearch);
  let rows = state.last.transactions;
  if (state.txKind === 'out') rows = rows.filter((t) => t.amount < 0);
  if (state.txKind === 'in') rows = rows.filter((t) => t.amount > 0);
  if (q) rows = rows.filter((t) => normalizeKey(`${t.payee} ${t.desc} ${t.category} ${t.person} ${t.account}`).includes(q));
  const cmp = SORTS[state.txSort.key];
  rows = [...rows].sort((x, y) => (state.txSort.dir === 'asc' ? cmp(x, y) : cmp(y, x)) || y.date.localeCompare(x.date));
  return rows;
}

function renderTx() {
  const rows = filteredTx();
  const shown = rows.slice(0, state.txLimit);
  $('#tx-count').textContent = `${rows.length.toLocaleString('en')} transaction${rows.length === 1 ? '' : 's'}${state.focus ? ` in ${state.focus}` : ''}${rows.length > shown.length ? ` \u00B7 showing ${shown.length}` : ''}`;
  const head = (key, label, cls) => {
    const sorted = state.txSort.key === key;
    return h('th', { class: cls, attrs: { scope: 'col', 'data-k': key, 'aria-sort': sorted ? (state.txSort.dir === 'asc' ? 'ascending' : 'descending') : 'none' } },
      h('button', { type: 'button', text: label, on: { click: () => { state.txSort = { key, dir: sorted && state.txSort.dir === 'desc' ? 'asc' : 'desc' }; renderTx(); $(`#tx th[data-k="${key}"] button`)?.focus(); } } }));
  };
  const table = h('table', { class: 'data' },
    h('caption', { class: 'sr-only', text: `Transactions in ${state.currency}. Column headers sort the table.` }),
    h('thead', {}, h('tr', {}, head('date', 'Date'), head('payee', 'Payee'), head('category', 'Category'),
      h('th', { class: 'hide-sm', attrs: { scope: 'col' }, text: 'Description' }), head('amount', 'Amount', 'num'),
      h('th', { class: 'hide-sm', attrs: { scope: 'col' }, text: 'Person' }),
      h('th', { class: 'hide-sm', attrs: { scope: 'col' }, text: 'Account' }))),
    h('tbody', {}, shown.length ? shown.map((t) => h('tr', {},
      h('td', { text: dayLabel(t.date) }),
      h('td', { text: t.payee }),
      h('td', {}, h('span', { class: 'cat-cell' }, h('span', { class: ['swatch', t.category === INCOME ? 'cx' : colorOf(t.category)] }), t.category)),
      h('td', { class: ['desc', 'hide-sm'], text: t.desc }),
      h('td', { class: ['num', t.amount > 0 ? 'amount-in' : ''], text: signed2(t.amount) }),
      h('td', { class: 'hide-sm', text: t.person }),
      h('td', { class: ['desc', 'hide-sm'], text: t.account })))
      : h('tr', {}, h('td', { attrs: { colspan: 7 }, class: 'empty', text: 'No matching transactions.' }))));
  setChildren($('#tx'), table);
  const more = $('#tx-more');
  more.hidden = rows.length <= shown.length;
  more.textContent = `Show ${Math.min(200, rows.length - shown.length)} more`;
}

// ---------- rules editor ----------
function renderRules() {
  const list = $('#rules');
  setChildren(list, state.ruleEntries.map(([cat, text], i) => {
    const catId = `rule-cat-${i}`, kwId = `rule-kw-${i}`;
    return h('div', { class: 'rule-row' },
      h('div', { class: 'field' },
        h('label', { class: 'label', htmlFor: catId, text: `Category ${i + 1}` }),
        h('input', { type: 'text', id: catId, value: cat, attrs: { maxlength: LIMITS.maxCategoryLength, spellcheck: 'false' }, on: { input: (e) => { state.ruleEntries[i][0] = e.target.value; } } })),
      h('div', { class: 'field' },
        h('label', { class: 'label', htmlFor: kwId, text: 'Keywords, comma separated' }),
        h('textarea', { id: kwId, attrs: { rows: 2, spellcheck: 'false', maxlength: 8000 }, on: { input: (e) => { state.ruleEntries[i][1] = e.target.value; } } }, text)),
      h('div', { class: 'rule-actions' },
        h('button', { type: 'button', class: 'btn small', text: '\u2191', disabled: i === 0, attrs: { 'aria-label': `Move rule ${cat} up` }, on: { click: () => moveRule(i, -1) } }),
        h('button', { type: 'button', class: 'btn small', text: '\u2193', disabled: i === state.ruleEntries.length - 1, attrs: { 'aria-label': `Move rule ${cat} down` }, on: { click: () => moveRule(i, 1) } }),
        h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove rule ${cat}` }, on: { click: () => { state.ruleEntries.splice(i, 1); renderRules(); } } })));
  }));
}

function moveRule(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.ruleEntries.length) return;
  [state.ruleEntries[i], state.ruleEntries[j]] = [state.ruleEntries[j], state.ruleEntries[i]];
  renderRules();
  $(`#rule-cat-${j}`)?.focus();
}

// ---------- file panel ----------
function fieldSelect(id, label, value, entries, onChange) {
  return h('div', { class: 'field' },
    h('label', { class: 'label', htmlFor: id, text: label }),
    h('select', { id, on: { change: (e) => onChange(e.target.value) } }, [...entries].map(([v, l]) => option(v, l, v === value))));
}

function updateFile(f, patch, structural = false) {
  Object.assign(f.overrides, patch);
  if (structural) { delete f.overrides.columns; delete f.overrides.monthCols; }
  const focusId = document.activeElement?.id;
  reprocess();
  if (focusId) document.getElementById(focusId)?.focus();
}

function renderFiles() {
  setChildren($('#files'), state.files.map((f) => {
    const remove = h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove ${cleanText(f.name, 80)}` }, on: { click: () => { state.files = state.files.filter((x) => x !== f); state.focus = null; reprocess(); setStatus('File removed.'); } } });
    if (!f.result) {
      return h('article', { class: 'file' }, h('div', { class: 'file-head' },
        h('span', { class: 'file-name', text: cleanText(f.name, 120) }), h('span', { class: 'chip warn', text: f.error || 'Unreadable' }), remove));
    }
    const r = f.result, st = r.settings, rs = r.records.stats;
    const kindLabel = KINDS.get(st.kind) || st.kind;
    const counts = st.kind === 'transactions'
      ? `${r.records.transactions.length.toLocaleString('en')} transactions`
      : `${r.records.budgets.length} budget lines \u00B7 ${r.records.transactions.length} actuals`;
    const head = h('div', { class: 'file-head' },
      h('span', { class: 'file-name', text: r.name }),
      h('span', { class: 'file-meta' },
        h('span', { class: 'chip', text: kindLabel }),
        h('span', { text: counts }),
        rs.skippedTotals ? h('span', { text: `${rs.skippedTotals} total/balance rows skipped` }) : null,
        rs.skippedInvalid ? h('span', { text: `${rs.skippedInvalid} rows without date or amount skipped` }) : null,
        h('span', { text: `${st.encoding.toUpperCase()} \u00B7 ${DELIMS.get(st.delimiter) || st.delimiter} \u00B7 ${st.currency}` }),
        r.warnings.map((w) => h('span', { class: 'chip warn', text: w }))),
      remove);
    const details = h('details', { on: { toggle: (e) => { f.open = e.target.open; } } });
    details.open = f.open;
    details.append(h('summary', { text: 'Detected settings and preview' }), fileBody(f));
    return h('article', { class: 'file', attrs: { 'aria-label': r.name } }, head, details);
  }));
}

function fileBody(f) {
  const r = f.result, st = r.settings, p = `f${f.id}`;
  const cols = st.columns;
  const fields = [
    fieldSelect(`${p}-enc`, 'Encoding', st.encoding, ENCODINGS.map((e) => [e, e.toUpperCase()]), (v) => updateFile(f, { encoding: v }, true)),
    fieldSelect(`${p}-delim`, 'Delimiter', st.delimiter, DELIMS, (v) => updateFile(f, { delimiter: v }, true)),
    h('div', { class: 'field' },
      h('label', { class: 'label', htmlFor: `${p}-hdr`, text: 'Header row (0 = none)' }),
      h('input', { type: 'number', id: `${p}-hdr`, value: st.headerRow + 1, attrs: { min: 0, max: Math.min(r.rows.length, LIMITS.maxHeaderScanRows * 10), step: 1 }, on: { change: (e) => { const n = Math.max(0, Math.floor(Number(e.target.value) || 0)); updateFile(f, { headerRow: n - 1 }, true); } } })),
    fieldSelect(`${p}-kind`, 'File type', st.kind, KINDS, (v) => updateFile(f, { kind: v })),
  ];
  if (st.kind === 'transactions' || cols.includes('month')) fields.push(fieldSelect(`${p}-date`, 'Date format', st.dateFormat, DATE_LABELS, (v) => updateFile(f, { dateFormat: v })));
  fields.push(fieldSelect(`${p}-dec`, 'Number format', st.decimal, DEC_LABELS, (v) => updateFile(f, { decimal: v })));
  if (st.kind === 'transactions' && cols.includes('amount')) {
    fields.push(fieldSelect(`${p}-sign`, 'Amount sign', st.sign, [['negative-out', 'Negative = money out'], ['positive-out', 'Positive = money out']], (v) => updateFile(f, { sign: v })));
  }
  fields.push(h('div', { class: 'field' },
    h('label', { class: 'label', htmlFor: `${p}-cur`, text: cols.includes('currency') ? 'Currency (fallback)' : 'Currency' }),
    h('input', { type: 'text', id: `${p}-cur`, value: st.currency, attrs: { maxlength: 3, pattern: '[A-Za-z]{3}', autocomplete: 'off', spellcheck: 'false', size: 5 }, on: { change: (e) => { const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); if (v.length === 3) updateFile(f, { currency: v }); else e.target.value = st.currency; } } })));
  if (st.kind === 'category') {
    fields.push(fieldSelect(`${p}-scope`, 'Budget amounts are', st.budgetScope, [['monthly', 'Per month (repeat every month)'], ['once', 'For one period only']], (v) => updateFile(f, { budgetScope: v })));
    fields.push(h('div', { class: 'field' },
      h('label', { class: 'label', htmlFor: `${p}-month`, text: 'Month for undated rows' }),
      h('input', { type: 'text', id: `${p}-month`, value: st.month, attrs: { maxlength: 7, pattern: '\\d{4}-\\d{2}', placeholder: 'YYYY-MM', size: 9, autocomplete: 'off' }, on: { change: (e) => { const v = e.target.value.trim(); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) updateFile(f, { month: v }); else e.target.value = st.month; } } })));
  }
  if (st.kind === 'wide') fields.push(fieldSelect(`${p}-wide`, 'Month columns hold', st.wideMeaning, [['budget', 'Budget'], ['actual', 'Actual spending']], (v) => updateFile(f, { wideMeaning: v })));

  const body = h('div', { class: 'file-body' }, h('div', { class: 'settings-grid' }, fields));
  for (const w of r.warnings) body.append(h('p', { class: 'warning', text: w }));
  body.append(preview(f));
  body.append(h('div', {}, h('button', { type: 'button', class: 'btn small link', text: 'Reset to detected settings', on: { click: () => { f.overrides = {}; reprocess(); } } })));
  return body;
}

function preview(f) {
  const r = f.result, st = r.settings, p = `f${f.id}`;
  const width = st.columns.length;
  const header = st.headerRow >= 0 ? r.rows[st.headerRow] : [];
  const data = r.rows.slice(st.headerRow + 1, st.headerRow + 9);
  const monthCols = st.kind === 'wide' ? st.monthCols : {};
  const roleRow = h('tr', {}, Array.from({ length: width }, (_, c) => {
    if (monthCols[c]) return h('th', { attrs: { scope: 'col' }, text: `Month: ${monthLabel(monthCols[c])}` });
    const id = `${p}-col-${c}`;
    return h('th', { attrs: { scope: 'col' } },
      h('label', { class: 'sr-only', htmlFor: id, text: `Role of column ${c + 1}${header[c] ? ` (${header[c]})` : ''}` }),
      h('select', { id, class: st.columns[c] === 'ignore' ? 'role-ignore' : '', on: { change: (e) => { const next = [...st.columns]; next[c] = e.target.value; updateFile(f, { columns: next }); } } },
        ROLES.map((role) => option(role, ROLE_LABELS.get(role), role === st.columns[c]))));
  }));
  const headRow = h('tr', {}, Array.from({ length: width }, (_, c) => h('th', { attrs: { scope: 'col' }, text: header[c] || `Column ${c + 1}` })));
  return h('div', { class: 'preview-wrap' }, h('table', { class: 'preview' },
    h('caption', { class: 'sr-only', text: `Preview of ${r.name}: column roles, header and first rows` }),
    h('thead', {}, roleRow, headRow),
    h('tbody', {}, data.map((row) => h('tr', {}, Array.from({ length: width }, (_, c) => h('td', { class: st.columns[c] === 'ignore' && !monthCols[c] ? 'is-ignored' : '', text: row[c] ?? '', attrs: { title: row[c] || null } })))))));
}

// ---------- export ----------
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { attrs: { href: url, download: name }, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const rangeTag = () => `${state.from || 'all'}_${state.to || 'all'}_${state.currency}`;

function exportSummary() {
  const a = state.last;
  if (!a) return;
  const rows = [['Category', 'Included', `Spent (${a.currency})`, 'Share', `Budget (${a.currency})`, 'Budget minus spent', 'Spent vs budget %', 'Status', 'Transactions']];
  for (const c of a.categories) rows.push([c.name, c.included ? 'yes' : 'no', c.spent, c.included ? Math.round(c.share * 10000) / 100 : 0, c.budget, c.budget ? c.diff : '', c.pct == null ? '' : Math.round(c.pct * 10000) / 100, STATUS.get(c.status), c.count]);
  rows.push([]);
  rows.push(['Total spent', '', a.totals.spent]);
  rows.push(['Monthly average', '', a.totals.avgMonthly]);
  rows.push(['Budget (budgeted categories)', '', a.totals.budget]);
  rows.push(['Income', '', a.totals.income]);
  rows.push(['Period', `${a.from} to ${a.to}`]);
  if (state.account || state.person) rows.push(['Filter', [state.account, state.person].filter(Boolean).join(' / ')]);
  rows.push([]);
  rows.push(['Person', `Spent (${a.currency})`, 'Share', 'Transactions']);
  for (const p of personSummary(viewTxs().filter((t) => t.currency === a.currency && t.month >= a.from && t.month <= a.to), state.excluded)) rows.push([p.name, p.spent, Math.round(p.share * 10000) / 100, p.count]);
  download(`budget-lens-summary_${rangeTag()}.csv`, toCSV(rows));
  setStatus('Summary exported.');
}

function exportTx() {
  const names = state.okFiles.map((f) => f.result.name);
  const rows = [['Date', 'Payee', 'Description', 'Category', 'Amount', 'Currency', 'Account', 'Card', 'Person', 'File']];
  for (const t of filteredTx()) rows.push([t.date, t.payee, t.desc, t.category, t.amount, t.currency, t.account, t.card ? `****${t.card}` : '', t.person, names[t.file] || '']);
  download(`budget-lens-transactions_${rangeTag()}.csv`, toCSV(rows));
  setStatus(`${rows.length - 1} transactions exported.`);
}

// ---------- theme ----------
const THEMES = ['system', 'light', 'dark'];
function cycleTheme() {
  const cur = document.documentElement.dataset.theme || 'system';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  if (next === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  const b = $('#theme-toggle');
  b.textContent = `Theme: ${next}`;
  b.setAttribute('aria-label', `Colour theme: ${next}`);
}

// ---------- wiring ----------
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function init() {
  const input = $('#file-input');
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer?.files || []); });
  // Never let a file dropped elsewhere navigate the tab away.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (!drop.contains(e.target)) addFiles(e.dataTransfer?.files || []); });

  $('#clear-btn').addEventListener('click', () => {
    state.files = [];
    state.focus = null;
    state.accounts = new Map();
    state.cardOwners = new Map();
    state.budgetEdits = new Map();
    state.person = '';
    state.account = '';
    state.excluded = new Set([TRANSFERS]);
    state.txSearch = '';
    $('#tx-search').value = '';
    state.preset = 'all';
    reprocess();
    setStatus('Everything cleared.');
    $('#file-input').focus();
  });

  $('#toolbar').addEventListener('submit', (e) => e.preventDefault());
  $('#preset').addEventListener('change', (e) => { state.preset = e.target.value; applyPreset(true); renderDashboard(); });
  $('#from').addEventListener('change', (e) => { state.preset = 'custom'; state.from = e.target.value; applyPreset(true); renderDashboard(); });
  $('#to').addEventListener('change', (e) => { state.preset = 'custom'; state.to = e.target.value; applyPreset(true); renderDashboard(); });
  $('#currency').addEventListener('change', (e) => { state.currency = e.target.value; state.focus = null; assignColors(); applyPreset(true); renderDashboard(); });
  $('#account').addEventListener('change', (e) => { state.account = e.target.value; state.focus = null; state.txLimit = 200; renderDashboard(); });
  $('#person').addEventListener('change', (e) => { state.person = e.target.value; state.focus = null; state.txLimit = 200; renderDashboard(); });
  $('#budget-suggest').addEventListener('click', suggestBudgets);
  $('#budget-export').addEventListener('click', exportBudget);
  $('#budget-reset').addEventListener('click', () => {
    state.budgetEdits = new Map([...state.budgetEdits].filter(([, e]) => e.currency !== state.currency));
    refreshBudgets();
    setStatus('Budget changes undone.');
  });
  // Nothing is stored: warn before the tab forgets budgets, people and account settings.
  window.addEventListener('beforeunload', (e) => {
    if (state.budgetEdits.size || state.cardOwners.size || state.accounts.size) { e.preventDefault(); e.returnValue = ''; }
  });
  $('#export-summary').addEventListener('click', exportSummary);
  $('#export-tx').addEventListener('click', exportTx);
  $('#print-btn').addEventListener('click', () => window.print());
  $('#theme-toggle').addEventListener('click', cycleTheme);

  $('#cmp-a').addEventListener('change', (e) => { state.cmpA = e.target.value; renderCompare(); });
  $('#cmp-b').addEventListener('change', (e) => { state.cmpB = e.target.value; renderCompare(); });
  $('#calc-a').addEventListener('input', renderCalc);
  $('#calc-b').addEventListener('input', renderCalc);

  $('#tx-search').addEventListener('input', debounce((e) => { state.txSearch = e.target.value.slice(0, 200); state.txLimit = 200; renderTx(); }, 150));
  $('#tx-kind').addEventListener('change', (e) => { state.txKind = e.target.value; state.txLimit = 200; renderTx(); });
  $('#tx-more').addEventListener('click', () => { state.txLimit += 200; renderTx(); });

  $('#use-file-cats').addEventListener('change', (e) => { state.useFileCategories = e.target.checked; recompute(); });
  $('#rule-add').addEventListener('click', () => {
    if (state.ruleEntries.length >= LIMITS.maxRules) return setStatus(`Up to ${LIMITS.maxRules} rules.`, true);
    state.ruleEntries.push(['New category', '']);
    renderRules();
    $(`#rule-cat-${state.ruleEntries.length - 1}`)?.focus();
  });
  $('#rules-apply').addEventListener('click', () => {
    state.rules = buildRules(state.ruleEntries);
    state.ruleEntries = state.rules.map((r) => [r.category, ruleText(r)]);
    state.focus = null;
    recompute();
    renderRules();
    setStatus(`${state.rules.length} rules applied.`);
  });
  $('#rules-reset').addEventListener('click', () => {
    state.ruleEntries = DEFAULT_RULES.map(([c, t]) => [c, t]);
    state.rules = buildRules(DEFAULT_RULES);
    recompute();
    renderRules();
    setStatus('Default rules restored.');
  });

  // Redraw size-dependent charts when the layout width changes.
  let lastW = 0;
  const ro = new ResizeObserver(debounce(() => {
    const w = $('#dashboard').clientWidth;
    if (state.last && w && Math.abs(w - lastW) > 4) { lastW = w; renderWhere(state.last); renderMonthly(state.last); }
  }, 120));
  ro.observe($('#dashboard'));

  renderAll();
}

init();
