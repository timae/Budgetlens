// Budget Lens UI. All state lives in memory for the lifetime of the tab.
// Pages are views selected by the URL hash; only the visible view is rendered.
import { LIMITS } from './limits.js';
import { ENCODINGS } from './csv.js';
import { KINDS, ROLES, ROLE_LABELS } from './detect.js';
import { processFile, prepareTransactions, collectBudgets } from './pipeline.js';
import { DEFAULT_RULES, TRANSFERS, INCOME, OTHER, buildRules, ruleText } from './categorize.js';
import { clusterAccounts, dedupe, defaultAccountName, fingerprint, markOwnTransfers, matchSaved } from './accounts.js';
import { analyze, comparePeriods, currencies, dataMonths, monthCoverage, percentDiff, presetRange } from './analyze.js';
import { normalizeKey, toCSV, cleanText } from './sanitize.js';
import { h, $, setChildren, option } from './dom.js';
import { drawBalance, drawMonthly, drawTreemap } from './charts.js';
import { money, money0, signed0, signed2, pct, signedPct, monthLabel, dayLabel } from './format.js';
import { ACCOUNT_KINDS, SHARED, UNASSIGNED, accountSummary, assignPeople, cardSummary, cleanPerson, personSummary } from './people.js';
import { applyBudgetEdits, budgetCSV, budgetKey, parseBudgetInput, suggestMonthly } from './budget.js';
import { CADENCES, detectRecurring, fixedCosts, fixedKey, fixedStatus, markFixed } from './recurring.js';
import { loadSettings, saveSettings, MAX_SETTINGS_BYTES } from './settings.js';
import { SPLIT_MODES, buildForecast, planBaseline, splitContribution } from './forecast.js';
import { addMonths } from './dates.js';
import { MANUAL_RHYTHMS, manualDue, manualMonthly, manualTransactions } from './manual.js';

const VIEWS = [
  ['overview', 'Overview'],
  ['spending', 'Spending'],
  ['budget', 'Budget'],
  ['fixed', 'Fixed costs'],
  ['plan', 'Forecast & goals'],
  ['people', 'People & accounts'],
  ['transactions', 'Transactions'],
  ['files', 'Files & rules'],
];
const STEPS = [
  ['files', 'Check files'],
  ['accounts', 'Accounts'],
  ['categories', 'Categories'],
  ['cards', 'Cards & people'],
  ['fixed', 'Fixed costs'],
  ['budget', 'Budgets'],
  ['done', 'Done'],
];

const state = {
  files: [], // {id, name, bytes, overrides, result, error, open, account}
  seq: 0,
  view: 'overview',
  step: 0,
  ruleEntries: DEFAULT_RULES.map(([c, t]) => [c, t]),
  rules: buildRules(DEFAULT_RULES),
  useFileCategories: true,
  txs: [],
  fileBudgets: [],
  budgets: [],
  okFiles: [],
  // Accounts are recognised by fingerprint (IBAN, or column layout + cards), never by file name.
  accountSettings: [], // [{iban, layout, cards[], name, kind, owner}]
  fileChoices: new Map(), // file id -> 'own' | file id it belongs with (user regrouping)
  clusters: [], // current accounts: {id, files[], iban, layout, bank, cards, name, kind, owner, saved}
  dupRemoved: new Map(), // file id -> transactions skipped because another file has them
  payeeRules: new Map(), // normalised payee -> category chosen by the user
  categoryAliases: new Map(), // normalised file category -> category
  ownNames: '', // words that identify transfers between own accounts
  coverage: new Map(),
  manualItems: [], // costs paid outside the loaded accounts: {name, category, amount, every, start, end, person, currency}
  // Forecast & goals. null = use what the data shows.
  plan: { scope: '', horizon: 12, balance: null, buffer: 0, variable: null, otherIncome: null, contributions: null, goals: [], splitMode: 'current', weights: new Map() },
  cardOwners: new Map(),
  budgetEdits: new Map(),
  fixedOverrides: new Map(),
  fixedManual: new Map(),
  fixed: [],
  currency: null,
  preset: 'all',
  from: null,
  to: null,
  person: '',
  account: '',
  excluded: new Set([TRANSFERS]),
  drill: { category: null, payee: null, month: null },
  colors: new Map(),
  cmpA: null,
  cmpB: null,
  calcA: '1200',
  calcB: '1350',
  txSearch: '',
  txKind: 'all',
  txSort: { key: 'date', dir: 'desc' },
  txLimit: 200,
  last: null,
};

const DELIMS = new Map([[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']]);
const DATE_LABELS = new Map([['DMY', 'Day first (31.12.2026)'], ['MDY', 'Month first (12/31/2026)'], ['YMD', 'ISO (2026-12-31)'], ['serial', 'Excel serial number']]);
const DEC_LABELS = new Map([['dot', "1'234.50 (dot decimal)"], ['comma', '1.234,50 (comma decimal)']]);
const STATUS = new Map([['over', 'Over'], ['on', 'On budget'], ['near', 'Near limit'], ['under', 'Under'], ['none', 'No budget']]);

// ---------- small helpers ----------
function setStatus(msg, error = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', error);
}
const sectionHead = (title, note, id) => h('div', { class: 'section-head' }, h('h2', { id, text: title }), note ? h('p', { text: note }) : null);
const section = (title, note, ...children) => {
  const id = `h-${normalizeKey(title).replace(/ /g, '-')}`;
  return h('section', { class: 'section', attrs: { 'aria-labelledby': id } }, sectionHead(title, note, id), children);
};
const card = (title, ...children) => h('div', { class: 'card' }, h('h3', { class: 'card-title', text: title }), children);
const th = (text, cls) => h('th', { class: cls, attrs: { scope: 'col' }, text });
const link = (text, view) => h('a', { class: 'more-link', attrs: { href: `#${view}` }, text });
const swatch = (name) => h('span', { class: ['swatch', name === INCOME ? 'cx' : colorOf(name)] });
const catCell = (name) => h('span', { class: 'cat-cell' }, swatch(name), name);
const curSpan = (c) => h('span', { class: 'cur', text: c });
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function keepFocus(id, fn) {
  fn();
  if (id) document.getElementById(id)?.focus();
}

// ---------- files ----------

async function addFiles(list) {
  const files = [...list];
  if (!files.length) return;
  const wasEmpty = state.files.length === 0;
  const skipped = [];
  let settingsLoaded = false;
  const skippedNotes = [];
  for (const f of files) {
    const isJson = /\.json$/i.test(f.name) || f.type === 'application/json';
    if (isJson) {
      if (f.size > MAX_SETTINGS_BYTES) { skipped.push(`${cleanText(f.name, 60)} (settings file too large)`); continue; }
      try {
        const loaded = loadSettings(await f.text());
        applySettings(loaded);
        settingsLoaded = true;
        skippedNotes.push(...loaded.notes);
      } catch (e) {
        skipped.push(`${cleanText(f.name, 60)} (${e instanceof Error ? e.message : 'unreadable'})`);
      }
      continue;
    }
    if (state.files.length >= LIMITS.maxFiles) { skipped.push(`${cleanText(f.name, 60)} (file limit of ${LIMITS.maxFiles} reached)`); continue; }
    if (f.size > LIMITS.maxFileBytes) { skipped.push(`${cleanText(f.name, 60)} (over 15 MB)`); continue; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      state.files.push({ id: ++state.seq, name: f.name, bytes, overrides: {}, open: false });
    } catch {
      skipped.push(cleanText(f.name, 60));
    }
  }
  if (wasEmpty && state.files.length) {
    state.step = 0;
    if (location.hash !== '#setup') history.replaceState(null, '', '#setup');
    state.view = 'setup';
  }
  reprocess();
  const ok = state.files.filter((f) => f.result).length;
  const msg = [`${ok} file${ok === 1 ? '' : 's'} read in this browser.`];
  if (settingsLoaded) msg.push('Settings restored.', ...skippedNotes);
  if (skipped.length) msg.push(`Skipped: ${skipped.join(', ')}.`);
  setStatus(msg.join(' '), skipped.length > 0);
  if (state.view === 'setup') $('#main').focus();
}

function applySettings(s) {
  state.budgetEdits = s.budgetEdits;
  state.cardOwners = s.cardOwners;
  state.accountSettings = s.accountSettings;
  state.payeeRules = s.payeeRules;
  state.categoryAliases = s.categoryAliases;
  state.ownNames = s.ownNames;
  state.fixedOverrides = s.fixedOverrides;
  state.fixedManual = s.fixedManual;
  state.excluded = s.excluded.size ? s.excluded : new Set([TRANSFERS]);
  if (s.rules) {
    state.ruleEntries = s.rules;
    state.rules = buildRules(s.rules);
  }
  state.useFileCategories = s.useFileCategories;
  if (s.plan) state.plan = s.plan;
  state.manualItems = s.manualItems || [];
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

/** Account settings for a cluster: saved ones (matched by fingerprint) or defaults. */
function resolveCluster(c) {
  const idx = matchSaved(c, state.accountSettings);
  const saved = idx >= 0 ? state.accountSettings[idx] : null;
  const firstFile = state.okFiles[c.files[0]];
  return { ...c, name: saved?.name || defaultAccountName(c, firstFile?.name), kind: saved?.kind || 'shared', owner: saved?.owner || '', saved: idx, recognisable: !!(c.iban || c.cards.size) };
}

/** Change a cluster's name, type or owner; the setting is stored with the cluster's fingerprint. */
function updateAccount(cluster, patch) {
  let idx = matchSaved(cluster, state.accountSettings);
  if (idx < 0) {
    state.accountSettings.push({ iban: cluster.iban, layout: cluster.layout, cards: [...cluster.cards], name: cluster.name, kind: cluster.kind, owner: cluster.owner });
    idx = state.accountSettings.length - 1;
  }
  const cur = state.accountSettings[idx];
  state.accountSettings[idx] = { ...cur, ...patch, iban: cur.iban || cluster.iban, layout: cluster.layout, cards: [...new Set([...cur.cards, ...cluster.cards])] };
  recompute();
}

/** Names that mark transfers between the household's own accounts. */
function ownNameList() {
  const people = [...state.cardOwners.values(), ...state.accountSettings.map((a) => a.owner)];
  return [...state.ownNames.split(','), ...people].map((x) => x.trim()).filter(Boolean);
}

function recompute() {
  state.okFiles = state.files.filter((f) => f.result);
  const ok = state.okFiles.map((f) => f.result);
  let txs = prepareTransactions(ok, state.rules, { useFileCategories: state.useFileCategories, payeeRules: state.payeeRules, aliases: state.categoryAliases });
  // 1. Which files are the same bank account.
  const byFile = new Map();
  for (const t of txs) { if (!byFile.has(t.file)) byFile.set(t.file, []); byFile.get(t.file).push(t); }
  const fps = state.okFiles.map((f, i) => (f.result.settings.kind === 'transactions' ? fingerprint(f.result, byFile.get(i) || []) : null));
  const idxOf = new Map(state.okFiles.map((f, i) => [f.id, i]));
  const choices = new Map();
  for (const [fid, choice] of state.fileChoices) {
    if (!idxOf.has(fid)) continue;
    if (choice === 'own') choices.set(idxOf.get(fid), 'own');
    else if (idxOf.has(choice)) choices.set(idxOf.get(fid), idxOf.get(choice));
  }
  const { clusters, of } = clusterAccounts(fps, choices);
  state.clusters = clusters.map(resolveCluster);
  const clusterById = new Map(state.clusters.map((c) => [c.id, c]));
  // 2. Transactions that several exports of the same account contain are kept once.
  const d = dedupe(txs, (fi) => of[fi] || `file${fi}`);
  state.dupRemoved = new Map([...d.removed].map(([fi, n]) => [state.okFiles[fi].id, n]));
  // 3. Account, person, transfers between own accounts, fixed costs.
  txs = assignPeople(d.txs, { cardOwners: state.cardOwners, accountOfFile: (i) => clusterById.get(of[i]) || { name: state.okFiles[i].result.name, kind: 'shared', owner: '' } });
  txs = markOwnTransfers(txs, ownNameList());
  state.fixed = fixedCosts(detectRecurring(txs), state.fixedOverrides, state.fixedManual);
  txs = markFixed(txs, state.fixed);
  // Costs entered by hand, as monthly shares in the months each currency has data for.
  const manual = [];
  for (const cur of new Set(state.manualItems.map((m) => m.currency))) {
    const ms = [...new Set(txs.filter((t) => t.currency === cur && !t.synthetic).map((t) => t.month))].sort();
    if (ms.length) manual.push(...manualTransactions(state.manualItems.filter((m) => m.currency === cur), ms));
  }
  state.txs = [...txs, ...manual];
  state.fileBudgets = collectBudgets(ok);
  state.budgets = applyBudgetEdits(state.fileBudgets, state.budgetEdits);
  const cur = currencies(state.txs, state.budgets);
  if (!cur.includes(state.currency)) state.currency = cur[0] || 'CHF';
  if (state.person && !state.txs.some((t) => t.person === state.person)) state.person = '';
  if (state.account && !state.txs.some((t) => t.account === state.account)) state.account = '';
  assignColors();
  applyPreset(false);
  renderAll();
}

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

/** Transactions after the account and person filters. */
function viewTxs() {
  return state.txs.filter((t) => (!state.account || t.account === state.account) && (!state.person || t.person === state.person));
}
const inPeriod = (t) => t.currency === state.currency && (!state.from || (t.month >= state.from && t.month <= state.to));

function analysis(extra = {}) {
  state.coverage = monthCoverage(state.txs.filter((t) => t.currency === state.currency));
  return analyze(viewTxs(), state.budgets, { from: state.from, to: state.to, currency: state.currency, excluded: state.excluded, coverage: state.coverage, ...extra });
}

// ---------- shell: navigation and views ----------
function go(view) {
  if (location.hash !== `#${view}`) location.hash = view; // hashchange renders
  else { state.view = view; renderAll(); }
}

// Charts need their container in the document to measure it.
const afterRender = [];

function renderAll() {
  const has = state.files.length > 0;
  $('#intake').hidden = has;
  $('#app').hidden = !has;
  if (!has) { $('#main').replaceChildren(); return; }
  const hasData = state.txs.length > 0 || state.budgets.length > 0;
  if (!hasData && state.view !== 'setup') state.view = 'files';
  renderNav();
  $('#toolbar').hidden = state.view === 'setup' || state.view === 'files' || !hasData;
  if (!$('#toolbar').hidden) renderToolbar();
  state.last = hasData ? analysis() : null;
  const render = {
    setup: renderSetup, overview: renderOverview, spending: renderSpending, budget: renderBudgetView, fixed: renderFixedView, plan: renderPlanView,
    people: renderPeopleView, transactions: renderTransactionsView, files: renderFilesView,
  }[state.view] || renderOverview;
  afterRender.length = 0;
  setChildren($('#main'), render());
  afterRender.splice(0).forEach((fn) => fn());
  stackTables();
}

// On phones, wide editable tables become one card per row. Each cell gets its column name as a
// label, and explicit ARIA roles keep the table semantics when CSS changes the display.
const STACKED = '#bva, #accounts, #cards, #fixed-active, #fixed-suggested, #fixed-dismissed, #uncategorised, #aliases, #people-summary, #payee-rules, #plan-contrib, #plan-goals, #plan-split, #manual-table';
function stackTables() {
  for (const table of document.querySelectorAll(STACKED)) {
    table.classList.add('stack');
    table.setAttribute('role', 'table');
    const heads = [...table.querySelectorAll('thead th')].map((x) => x.textContent.trim());
    for (const part of table.querySelectorAll('thead, tbody, tfoot')) part.setAttribute('role', 'rowgroup');
    for (const tr of table.querySelectorAll('tr')) {
      tr.setAttribute('role', 'row');
      [...tr.children].forEach((cell, i) => {
        const inHead = cell.closest('thead');
        cell.setAttribute('role', inHead ? 'columnheader' : cell.tagName === 'TH' ? 'rowheader' : 'cell');
        if (!inHead && heads[i]) cell.setAttribute('data-label', heads[i]);
      });
    }
  }
}

function renderNav() {
  const setup = state.view === 'setup';
  setChildren($('#nav'),
    h('ul', {}, VIEWS.map(([id, label]) => h('li', {}, h('a', {
      attrs: { href: `#${id}`, 'aria-current': state.view === id ? 'page' : null }, class: state.view === id ? 'active' : '', text: label,
    })))),
    h('div', { class: 'nav-actions' },
      setup ? null : h('button', { type: 'button', class: 'btn small', text: 'Guided setup', on: { click: () => { state.step = 0; go('setup'); } } }),
      h('button', { type: 'button', class: 'btn small primary', text: 'Save settings', attrs: { title: 'Download your accounts, people, fixed costs, budgets and rules as a file' }, on: { click: exportSettings } })));
}

function renderToolbar() {
  const ms = months();
  $('#preset').value = state.preset;
  setChildren($('#from'), ms.map((m) => option(m, monthLabel(m), m === state.from)));
  setChildren($('#to'), ms.map((m) => option(m, monthLabel(m), m === state.to)));
  setChildren($('#currency'), currencies(state.txs, state.budgets).map((c) => option(c, c, c === state.currency)));
  const accts = [...new Set(state.txs.map((t) => t.account))].sort();
  setChildren($('#account'), option('', 'All accounts', !state.account), accts.map((n) => option(n, n, n === state.account)));
  const generic = (n) => n === SHARED || n === UNASSIGNED;
  const people = [...new Set(state.txs.map((t) => t.person))].sort((x, y) => generic(x) - generic(y) || x.localeCompare(y));
  setChildren($('#person'), option('', 'Everyone', !state.person), people.map((n) => option(n, n, n === state.person)));
}

// ---------- overview ----------
function figure(label, value, sub, cls) {
  return h('div', { class: 'figure' }, h('span', { class: 'label', text: label }), h('span', { class: ['value', cls] }, value), h('span', { class: 'sub' }, sub));
}

function activeFixed() {
  return state.fixed.filter((f) => f.active && f.currency === state.currency);
}

function hero(a) {
  const c = a.currency, t = a.totals;
  const period = !a.from ? 'No dated rows' : a.from === a.to ? monthLabel(a.from) : `${monthLabel(a.from)} \u2013 ${monthLabel(a.to)}`;
  const fx = activeFixed();
  const man = state.manualItems.filter((m) => m.currency === c && m.every > 0 && m.amount > 0);
  const fixedMonthly = fx.reduce((s, f) => s + (f.monthly || 0), 0) + man.reduce((s, m) => s + manualMonthly(m), 0);
  const partial = a.partialMonths.map((p) => `${monthLabel(p.month)} incomplete (days ${p.from}\u2013${p.to})`).join(' \u00B7 ');
  const avgSub = a.fullMonths.length
    ? `average of ${a.fullMonths.length} complete month${a.fullMonths.length === 1 ? '' : 's'}${partial ? ` \u00B7 ${partial}` : ''}`
    : `scaled from ${Math.round(a.effMonths * 10) / 10} months of data`;
  const items = [
    figure('Total spent', [curSpan(c), money0(t.spent)], `${period}${t.income ? ` \u00B7 income ${money0(t.income)}` : ''}`),
    figure('Monthly average', [curSpan(c), money0(t.avgMonthly)], avgSub),
    figure('Fixed costs', [curSpan(c), money0(fixedMonthly)], fx.length + man.length ? `expected per month \u00B7 ${fx.length + man.length} recurring${man.length ? ` (${man.length} not in files)` : ''} \u00B7 in period ${money0(t.fixed)}` : 'None confirmed yet'),
  ];
  if (t.budget > 0) {
    const over = t.variance < 0;
    items.push(figure('Vs budget', [curSpan(c), money0(Math.abs(t.variance))], `${over ? 'over' : 'under'} the ${money0(t.budget)} budget of budgeted categories (${signedPct(t.variancePct)})${t.unbudgeted > 0.5 ? ` \u00B7 ${money0(t.unbudgeted)} spent without a budget` : ''}`, over ? 'bad' : 'good'));
  } else items.push(figure('Vs budget', '\u2013', 'No budget yet'));
  const mom = t.mom;
  if (mom && mom.pct != null) items.push(figure('Month over month', signedPct(mom.pct), `${monthLabel(mom.lastMonth)}: ${money0(mom.last)} vs ${money0(mom.prev)} (complete months)`, mom.change > 0 ? 'bad' : 'good'));
  else items.push(figure('Month over month', '\u2013', 'Needs two complete months'));
  return h('section', { class: 'hero', attrs: { 'aria-label': 'Key figures' } }, items);
}

function renderOverview() {
  const a = state.last;
  if (!a) return emptyView();
  const chart = h('div', { class: 'chart' });
  const legend = h('div', { class: 'legend' });
  afterRender.push(() => monthlyChart(chart, legend, a, { onSelect: (m) => drillTo({ month: m }) }));
  const top = a.categories.filter((x) => x.included && x.spent > 0).slice(0, 7);
  const max = top[0]?.spent || 1;
  const fx = activeFixed().slice(0, 5);
  const over = a.categories.filter((x) => x.included && x.status === 'over').slice(0, 5);
  const people = personSummary(viewTxs().filter(inPeriod), state.excluded);
  return h('div', {},
    h('h2', { class: 'sr-only', text: 'Overview' }),
    hero(a),
    h('div', { class: 'ov-grid' },
      card('Month by month', h('p', { class: 'note', text: 'Select a month to see what made it up.' }), chart, legend),
      card('Top categories',
        h('ol', { class: 'barlist' }, top.map((x) => h('li', {},
          h('button', { type: 'button', class: 'barlist-name', attrs: { 'aria-label': `Drill into ${x.name}` }, on: { click: () => drillTo({ category: x.name, month: null }) } }, catCell(x.name)),
          h('span', { class: 'num', text: money0(x.spent) }),
          h('span', { class: 'barlist-bar', attrs: { 'aria-hidden': 'true' } }, h('span', { class: ['bar-fill', colorOf(x.name)], css: { width: `${(x.spent / max) * 100}%` } }))))),
        link('All categories \u2192', 'spending')),
      card('Fixed costs',
        fx.length ? h('ul', { class: 'mini-list' }, fx.map((f) => h('li', {}, h('span', { text: f.payee }), h('span', { class: 'num', text: `${money0(f.monthly ?? 0)} / month` })))) : h('p', { class: 'note', text: 'No recurring payments confirmed yet.' }),
        link('Review fixed costs \u2192', 'fixed')),
      card('Budget',
        a.totals.budget > 0
          ? (over.length ? h('ul', { class: 'mini-list' }, over.map((x) => h('li', {}, catCell(x.name), h('span', { class: 'num bad', text: signedPct(x.pct) })))) : h('p', { class: 'note good', text: 'Every budgeted category is within budget.' }))
          : h('p', { class: 'note', text: 'No budgets set yet.' }),
        link(a.totals.budget > 0 ? 'Open budget \u2192' : 'Set budgets \u2192', 'budget')),
      card('Forecast',
        (() => { const m = planModel(); const d = m.forecast.contributions - m.forecast.required; return h('ul', { class: 'mini-list' },
          h('li', {}, h('span', { text: 'Pay in per month' }), h('span', { class: 'num', text: money0(m.forecast.required) })),
          h('li', {}, h('span', { text: 'Paid in today' }), h('span', { class: 'num', text: money0(m.forecast.contributions) })),
          h('li', {}, h('span', { text: d >= 0 ? 'More than needed' : 'Short per month' }), h('span', { class: ['num', d >= -0.5 ? 'good' : 'bad'], text: money0(Math.abs(d)) })),
          h('li', {}, h('span', { text: 'Savings goals' }), h('span', { class: 'num', text: String(state.plan.goals.length) }))); })(),
        link('Forecast & goals \u2192', 'plan')),
      card('People',
        people.length ? h('ul', { class: 'mini-list' }, people.map((p) => h('li', {}, h('span', { text: p.name }), h('span', { class: 'num', text: `${money0(p.spent)} \u00B7 ${pct(p.share)}` })))) : h('p', { class: 'note', text: 'No spending in this period.' }),
        link('People & accounts \u2192', 'people'))));
}

function monthlyChart(chartEl, legendEl, a, { onSelect, selected, category, height } = {}) {
  const totals = new Map();
  for (const m of a.monthly) for (const [n, v] of m.byCat) totals.set(n, (totals.get(n) || 0) + v);
  let series = [...totals.entries()].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 7).map(([n]) => ({ name: n, cls: colorOf(n) }));
  let data = a.monthly;
  if (category) {
    series = [{ name: category, cls: colorOf(category) }];
    data = a.monthly.map((m) => ({ ...m, byCat: new Map([[category, m.byCat.get(category) || 0]]), total: Math.round((m.byCat.get(category) || 0) * 100) / 100, budget: 0 }));
  }
  drawMonthly(chartEl, data, series, { currency: a.currency, onSelect, selected, height });
  if (legendEl) {
    const legend = series.map((x) => h('span', {}, h('span', { class: ['swatch', x.cls] }), x.name));
    if (!category && totals.size > series.length) legend.push(h('span', {}, h('span', { class: ['swatch', 'cx'] }), 'Other categories'));
    if (data.some((m) => m.budget > 0)) legend.push(h('span', {}, h('span', { class: 'budget-key' }), 'Budget'));
    if (data.some((m) => m.full === false)) legend.push(h('span', {}, h('span', { class: 'partial-key' }), 'Incomplete month (lighter, budget prorated)'));
    setChildren(legendEl, legend);
  }
  // Same data as a table for screen readers (a div wrapper because tables ignore width/overflow).
  chartEl.append(h('div', { class: 'sr-only' }, h('table', {},
    h('caption', { text: `Spending per month in ${a.currency}${category ? `, ${category}` : ''}` }),
    h('thead', {}, h('tr', {}, th('Month'), th('Spent'), th('Budget'))),
    h('tbody', {}, data.map((m) => h('tr', {}, h('th', { attrs: { scope: 'row' }, text: monthLabel(m.month) }), h('td', { text: money0(m.total) }), h('td', { text: m.budget ? money0(m.budget) : '\u2013' })))))));
}

// ---------- spending (drill-down) ----------
function drillTo(patch, view = 'spending') {
  state.drill = { ...state.drill, ...patch };
  if (patch.category !== undefined && patch.payee === undefined) state.drill.payee = null;
  state.txLimit = 200;
  go(view);
}
function setDrill(d) {
  state.drill = d;
  state.txLimit = 200;
  renderAll();
}

function crumbs(a) {
  const d = state.drill;
  const sep = () => h('span', { class: 'sep', text: '\u203A', attrs: { 'aria-hidden': 'true' } });
  const parts = [h('button', { type: 'button', class: ['crumb', !d.category ? 'here' : ''], text: 'All categories', on: { click: () => setDrill({ ...d, category: null, payee: null }) } })];
  if (d.category) parts.push(sep(), h('button', { type: 'button', class: ['crumb', !d.payee ? 'here' : ''], on: { click: () => setDrill({ ...d, payee: null }) } }, catCell(d.category)));
  if (d.payee) parts.push(sep(), h('span', { class: ['crumb', 'here'], text: d.payee }));
  if (d.month) parts.push(h('span', { class: 'chip-filter' }, monthLabel(d.month), h('button', { type: 'button', text: '\u00D7', attrs: { 'aria-label': `Remove month filter ${monthLabel(d.month)}` }, on: { click: () => setDrill({ ...d, month: null }) } })));
  return h('nav', { class: 'crumbs', attrs: { 'aria-label': 'Drill-down' } }, parts,
    h('span', { class: 'muted crumb-meta', text: `${a.currency} \u00B7 ${d.month ? monthLabel(d.month) : `${monthLabel(a.from)} \u2013 ${monthLabel(a.to)}`}` }));
}

function stat(label, value, cls) {
  return h('div', { class: 'stat' }, h('span', { class: 'label', text: label }), h('strong', { class: cls, text: value }));
}

function renderSpending() {
  if (!state.last) return emptyView();
  const d = state.drill;
  const range = d.month ? { from: d.month, to: d.month } : {};
  const a = analysis({ ...range, focus: d.category });
  const map = h('div', { class: 'treemap', attrs: { role: 'group', 'aria-label': d.category ? `Payees in ${d.category}` : 'Spending by category' } });
  let items;
  if (d.category) {
    const cls = colorOf(d.category);
    const top = a.payees.slice(0, 40);
    const rest = a.payees.slice(40).reduce((s, p) => s + p.spent, 0);
    items = top.map((p) => ({ name: p.name, value: p.spent, cls: [cls, p.name === d.payee ? 'selected' : ''], hint: 'Press to see this payee.', onClick: () => setDrill({ ...d, payee: p.name }) }));
    if (rest > 0) items.push({ name: `${a.payees.length - 40} more payees`, value: rest, cls: 'cx', onClick: () => go('transactions') });
  } else {
    items = a.categories.filter((x) => x.included && x.spent > 0).map((x) => ({ name: x.name, value: x.spent, cls: colorOf(x.name), hint: 'Press to drill into this category.', onClick: () => setDrill({ ...d, category: x.name, payee: null }) }));
  }
  afterRender.push(() => drawTreemap(map, items, { currency: a.currency, emptyText: 'No spending here.' }));

  const chart = h('div', { class: 'chart' });
  const legend = h('div', { class: 'legend' });
  const periodA = analysis({ focus: d.category });
  afterRender.push(() => monthlyChart(chart, legend, periodA, { onSelect: (m) => setDrill({ ...d, month: d.month === m ? null : m }), selected: d.month, category: d.category, height: 220 }));

  return h('div', {},
    section(d.payee || d.category || 'Where the money goes', d.category ? 'Select a payee to see its payments. Select a month in the chart to narrow the period.' : 'Select a category to drill into it, then a payee. Select a month in the chart to narrow the period.',
      crumbs(a),
      h('div', { class: 'split' }, h('div', {}, map), detailPanel(a, periodA)),
      h('div', { class: 'month-strip' }, h('h3', { class: 'label', text: d.month ? `${monthLabel(d.month)} selected \u00B7 select it again to show the whole period` : 'Select a month' }), chart, legend)),
    d.category ? null : section('Categories', 'Untick a category to leave it out of every total.', categoryList(a)),
    section('Compare periods', 'Two months or two years side by side, by category.', compareBlock(), calcBlock()));
}

function detailPanel(a, periodA) {
  const d = state.drill;
  const c = a.currency;
  if (d.payee) {
    const txs = a.transactions.filter((t) => t.payee === d.payee).sort((x, y) => y.date.localeCompare(x.date));
    const spent = txs.reduce((s, t) => s - t.amount, 0);
    const key = fixedKey(c, d.payee);
    const item = state.fixed.find((f) => f.key === key);
    const isFixed = !!item?.active;
    return h('aside', { class: 'detail', attrs: { 'aria-label': `Details for ${d.payee}` } },
      h('h3', { text: d.payee }),
      h('div', { class: 'stats' },
        stat('Spent', `${c} ${money0(spent)}`),
        stat('Payments', String(txs.length)),
        stat('Average', txs.length ? money(spent / txs.length) : '\u2013'),
        stat('Last', txs[0] ? dayLabel(txs[0].date) : '\u2013')),
      h('p', { class: 'note', text: isFixed
        ? `Fixed cost: ${CADENCES.get(item.every).toLowerCase()}, ${item.amount == null ? 'any amount' : `${c} ${money(item.amount)}`}.`
        : item ? 'Looks like a recurring payment. Confirm it as a fixed cost?' : 'Not a fixed cost.' }),
      h('datalist', { id: 'category-list' }, knownCategories().map((x) => option(x, x))),
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'payee-cat', text: 'Category of this payee' }),
        h('input', { type: 'text', id: 'payee-cat', value: state.payeeRules.get(normalizeKey(d.payee)) || txs.find((t) => t.amount < 0)?.category || '', attrs: { list: 'category-list', maxlength: LIMITS.maxCategoryLength, autocomplete: 'off' },
          on: { change: (e) => { const v = e.target.value; setPayeeCategory(d.payee, v, 'payee-cat'); if (v) state.drill = { ...state.drill, category: cleanText(v, LIMITS.maxCategoryLength) }; renderAll(); } } })),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', text: isFixed ? 'Not a fixed cost' : 'Mark as fixed cost', on: { click: () => toggleFixed(key, d.payee, txs, !isFixed) } }),
        h('button', { type: 'button', class: 'btn small', text: 'Show all payments', on: { click: () => go('transactions') } })),
      h('table', { class: 'data compact' },
        h('caption', { class: 'sr-only', text: `Latest payments to ${d.payee}` }),
        h('thead', {}, h('tr', {}, th('Date'), th('Amount', 'num'))),
        h('tbody', {}, txs.slice(0, 8).map((t) => h('tr', {}, h('td', { text: dayLabel(t.date) }), h('td', { class: ['num', t.amount > 0 ? 'amount-in' : ''], text: signed2(t.amount) }))))));
  }
  if (d.category) {
    const cat = a.categories.find((x) => x.name === d.category) || { spent: 0, budget: 0, count: 0, fixed: 0, share: 0, status: 'none', pct: null };
    const whole = periodA.categories.find((x) => x.name === d.category);
    return h('aside', { class: 'detail', attrs: { 'aria-label': `Details for ${d.category}` } },
      h('h3', {}, catCell(d.category)),
      h('div', { class: 'stats' },
        stat('Spent', `${c} ${money0(cat.spent)}`),
        stat('Per month', money0(cat.spent / a.effMonths)),
        stat('Share', pct(whole ? whole.share : cat.share)),
        stat('Payments', String(cat.count)),
        stat('Fixed part', money0(cat.fixed || 0)),
        stat('Budget', cat.budget ? `${signedPct(cat.pct)} vs ${money0(cat.budget)}` : 'none', cat.status === 'over' ? 'bad' : cat.budget ? 'good' : '')),
      h('h4', { class: 'label', text: 'Top payees' }),
      h('ol', { class: 'mini-list' }, a.payees.slice(0, 6).map((p) => h('li', {},
        h('button', { type: 'button', class: 'btn link', text: p.name, on: { click: () => setDrill({ ...d, payee: p.name }) } }),
        h('span', { class: 'num', text: money0(p.spent) })))),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn small', text: 'Show transactions', on: { click: () => go('transactions') } })));
  }
  const t = a.totals;
  return h('aside', { class: 'detail', attrs: { 'aria-label': 'Summary' } },
    h('h3', { text: 'All spending' }),
    h('div', { class: 'stats' },
      stat('Spent', `${a.currency} ${money0(t.spent)}`),
      stat('Per month', money0(t.avgMonthly)),
      stat('Payments', String(a.transactions.filter((x) => x.amount < 0).length)),
      stat('Fixed part', `${money0(t.fixed)} \u00B7 ${t.spent ? pct(t.fixed / t.spent) : '\u2013'}`),
      stat('Categories', String(a.categories.filter((x) => x.included && x.spent > 0).length)),
      stat('Income', money0(t.income))),
    h('p', { class: 'note', text: 'Select a tile to drill into a category, then a payee.' }));
}

function categoryList(a) {
  const rows = a.categories.filter((x) => x.spent !== 0 || x.budget > 0);
  return h('ul', { class: 'catlist', attrs: { 'aria-label': 'Categories' } }, rows.map((x, i) => {
    const id = `inc-${i}`;
    return h('li', { class: x.included ? '' : 'off' },
      h('input', {
        type: 'checkbox', id, checked: x.included, attrs: { 'aria-label': `Include ${x.name} in totals` },
        on: { change: (e) => keepFocus(id, () => { e.target.checked ? state.excluded.delete(x.name) : state.excluded.add(x.name); renderAll(); }) },
      }),
      h('span', { class: ['swatch', x.included ? colorOf(x.name) : 'cx'] }),
      h('span', { class: 'cat-name' }, x.included && x.spent > 0
        ? h('button', { type: 'button', text: x.name, attrs: { 'aria-label': `Drill into ${x.name}` }, on: { click: () => setDrill({ ...state.drill, category: x.name, payee: null }) } })
        : x.name),
      h('span', { class: 'cat-amt' }, money0(x.spent), h('span', { class: 'cat-share', text: x.included ? pct(x.share) : 'excluded' })),
      h('span', { class: 'cat-bar', attrs: { 'aria-hidden': 'true' } }, h('span', { class: ['bar-fill', colorOf(x.name)], css: { width: `${Math.max(0, x.share * 100)}%` } })));
  }));
}

function compareBlock() {
  const ms = dataMonths(viewTxs().filter((t) => t.currency === state.currency));
  const years = [...new Set(ms.map((m) => m.slice(0, 4)))];
  const all = [...ms, ...years];
  if (!all.includes(state.cmpB)) state.cmpB = ms[ms.length - 1] || years[0] || null;
  if (!all.includes(state.cmpA)) state.cmpA = ms[ms.length - 2] || state.cmpB;
  if (!state.cmpA) return h('p', { class: 'empty', text: 'Not enough data to compare.' });
  const sel = (id, val, key) => h('div', { class: 'field' },
    h('label', { class: 'label', htmlFor: id, text: key === 'cmpA' ? 'Period A' : 'Period B' }),
    h('select', { id, on: { change: (e) => keepFocus(id, () => { state[key] = e.target.value; renderAll(); }) } },
      h('optgroup', { attrs: { label: 'Months' } }, [...ms].reverse().map((m) => option(m, monthLabel(m), m === val))),
      h('optgroup', { attrs: { label: 'Years' } }, [...years].reverse().map((y) => option(y, y, y === val)))));
  const r = comparePeriods(viewTxs(), state.currency, state.cmpA, state.cmpB, state.excluded);
  const A = monthLabel(state.cmpA), B = monthLabel(state.cmpB);
  return h('div', {},
    h('div', { class: 'compare-controls' }, sel('cmp-a', state.cmpA, 'cmpA'), sel('cmp-b', state.cmpB, 'cmpB')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'compare' },
      h('caption', { class: 'sr-only', text: `Spending by category: ${A} compared with ${B}, ${state.currency}` }),
      h('thead', {}, h('tr', {}, th('Category'), th(A, 'num'), th(B, 'num'), th('Change', 'num'), th('%', 'num'))),
      h('tbody', {}, r.rows.map((x) => h('tr', {},
        h('th', { attrs: { scope: 'row' } }, h('button', { type: 'button', class: 'btn link', attrs: { 'aria-label': `Drill into ${x.name}` }, on: { click: () => setDrill({ category: x.name, payee: null, month: null }) } }, catCell(x.name))),
        h('td', { class: 'num', text: money0(x.a) }),
        h('td', { class: 'num', text: money0(x.b) }),
        h('td', { class: ['num', x.diff > 0 ? 'bad' : x.diff < 0 ? 'good' : ''], text: signed0(x.diff) }),
        h('td', { class: 'num', text: signedPct(x.pct) })))),
      h('tfoot', {}, h('tr', {},
        h('td', { text: 'Total' }), h('td', { class: 'num', text: money0(r.total.a) }), h('td', { class: 'num', text: money0(r.total.b) }),
        h('td', { class: ['num', r.total.diff > 0 ? 'bad' : 'good'], text: signed0(r.total.diff) }), h('td', { class: 'num', text: signedPct(r.total.pct) }))))));
}

function calcBlock() {
  const out = h('div', { class: 'calc-out', id: 'calc-out', attrs: { 'aria-live': 'polite' } });
  const update = () => {
    const a = Number(state.calcA), b = Number(state.calcB);
    const r = state.calcA !== '' && state.calcB !== '' ? percentDiff(a, b) : null;
    const cell = (label, value) => h('div', {}, h('span', { class: 'label', text: label }), h('strong', { text: value }));
    setChildren(out, r ? [
      cell('Change from A to B', signedPct(r.change)), cell('Absolute difference', signed2(r.absolute)),
      cell('Percentage difference', pct(r.difference)), cell('Ratio B / A', r.ratio == null ? '\u2013' : `${r.ratio.toFixed(3)}\u00D7`),
    ] : [cell('Result', 'Enter two numbers')]);
  };
  update();
  const input = (id, label, key) => h('div', { class: 'field' }, h('label', { htmlFor: id, text: label }),
    h('input', { type: 'number', id, value: state[key], attrs: { inputmode: 'decimal', step: 'any' }, on: { input: (e) => { state[key] = e.target.value; update(); } } }));
  return h('div', { class: 'panel' }, h('h3', { class: 'label', text: 'Percentage difference calculator' }),
    h('div', { class: 'calc' }, input('calc-a', 'From value', 'calcA'), input('calc-b', 'To value', 'calcB')), out);
}

// ---------- fixed costs ----------
function toggleFixed(key, payee, txs, makeFixed) {
  const item = state.fixed.find((f) => f.key === key);
  if (makeFixed) {
    if (item && item.source !== 'declared') state.fixedOverrides.set(key, { ...state.fixedOverrides.get(key), active: true });
    else {
      const amounts = txs.filter((t) => t.amount < 0).map((t) => -t.amount).sort((a, b) => a - b);
      const amount = amounts.length ? amounts[amounts.length >> 1] : null;
      const cat = txs.find((t) => t.amount < 0)?.category || 'Other';
      state.fixedManual.set(key, { key, payee, category: cat, currency: state.currency, amount, every: 1, account: txs.find((t) => t.amount < 0)?.account || '' });
    }
  } else if (state.fixedManual.has(key)) state.fixedManual.delete(key);
  else state.fixedOverrides.set(key, { ...state.fixedOverrides.get(key), active: false });
  recompute();
  setStatus(makeFixed ? `${payee} is now a fixed cost.` : `${payee} is not a fixed cost.`);
}

function setFixedOverride(key, patch, focusId) {
  if (state.fixedManual.has(key)) state.fixedManual.set(key, { ...state.fixedManual.get(key), ...patch });
  else state.fixedOverrides.set(key, { ...state.fixedOverrides.get(key), ...patch });
  keepFocus(focusId, recompute);
}

function fixedTables({ compact = false } = {}) {
  const c = state.currency;
  // Overdue is judged against the newest data of the item's own account.
  const latestBy = new Map();
  let latestAll = '';
  for (const t of state.txs) {
    if (t.currency !== c) continue;
    if (t.date > (latestBy.get(t.account) || '')) latestBy.set(t.account, t.date);
    if (t.date > latestAll) latestAll = t.date;
  }
  const latestOf = (f) => latestBy.get(f.account) || latestAll;
  const paid = new Map();
  for (const t of state.txs) if (t.fixed && inPeriod(t)) { const k = fixedKey(t.currency, t.payee); paid.set(k, (paid.get(k) || 0) - t.amount); }
  const items = state.fixed.filter((f) => f.currency === c);
  const active = items.filter((f) => f.active);
  const suggested = items.filter((f) => !f.active && state.fixedOverrides.get(f.key)?.active !== false);
  const dismissed = items.filter((f) => !f.active && state.fixedOverrides.get(f.key)?.active === false);
  const monthly = active.reduce((s, f) => s + (f.monthly || 0), 0);
  const missing = active.filter((f) => fixedStatus(f, latestOf(f)) === 'missing');

  const activeTable = active.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'fixed-active' },
    h('caption', { class: 'sr-only', text: `Fixed costs in ${c}` }),
    h('thead', {}, h('tr', {}, th('Payee'), th('Category', 'hide-sm'), th('Rhythm'), th('Amount', 'num'), th('Per month', 'num'), th('Paid in period', 'num hide-sm'), th('Last paid', 'hide-sm'), th('Next expected', 'hide-sm'), th('Status'), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Actions' })))),
    h('tbody', {}, active.map((f, i) => {
      const st = fixedStatus(f, latestOf(f));
      return h('tr', {},
        h('th', { attrs: { scope: 'row' } }, compact ? f.payee : h('button', { type: 'button', class: 'btn link', text: f.payee, attrs: { 'aria-label': `Drill into ${f.payee}` }, on: { click: () => drillTo({ category: f.category, payee: f.payee, month: null }) } })),
        h('td', { class: 'hide-sm' }, catCell(f.category)),
        h('td', {}, h('select', { id: `fx-every-${i}`, attrs: { 'aria-label': `Rhythm of ${f.payee}` }, on: { change: (e) => setFixedOverride(f.key, { every: Number(e.target.value) }, `fx-every-${i}`) } },
          [...CADENCES].map(([v, l]) => option(String(v), l, v === f.every)))),
        h('td', { class: 'num' }, h('span', { class: 'budget-input' }, h('input', {
          type: 'text', id: `fx-amt-${i}`, value: f.amount == null ? '' : String(f.amount),
          attrs: { inputmode: 'decimal', placeholder: 'any', maxlength: 14, autocomplete: 'off', 'aria-label': `Expected amount for ${f.payee}; leave empty for any amount` },
          on: { change: (e) => { const v = parseBudgetInput(e.target.value); if (Number.isNaN(v)) { setStatus('Enter an amount like 1234.50, or leave it empty for any amount.', true); return; } setFixedOverride(f.key, { amount: v }, `fx-amt-${i}`); } },
        }))),
        h('td', { class: 'num', text: f.monthly == null ? '\u2013' : money(f.monthly) }),
        h('td', { class: 'num hide-sm', text: money(paid.get(f.key) || 0) }),
        h('td', { class: 'hide-sm', text: f.last ? dayLabel(f.last) : '\u2013' }),
        h('td', { class: 'hide-sm', text: f.next ? dayLabel(f.next) : '\u2013' }),
        h('td', {}, h('span', { class: ['pill', st === 'missing' ? 'over' : f.source === 'auto' ? 'none' : 'under'], text: st === 'missing' ? 'Overdue' : f.source === 'auto' ? 'Detected' : f.source === 'declared' ? 'Declared' : 'Confirmed', attrs: { title: f.reasons ? f.reasons.join(', ') : 'Declared by you' } })),
        h('td', {}, h('button', { type: 'button', class: 'btn small', text: 'Not fixed', attrs: { 'aria-label': `${f.payee} is not a fixed cost` }, on: { click: () => toggleFixed(f.key, f.payee, [], false) } })));
    })),
    h('tfoot', {}, h('tr', {}, h('td', { attrs: { colspan: 4 }, text: 'Total per month (expected)' }), h('td', { class: 'num', text: money(monthly) }), h('td', { class: 'num hide-sm', text: money([...paid.values()].reduce((x, y) => x + y, 0)) }), h('td', { attrs: { colspan: 4 }, class: 'muted', text: `${money0(monthly * 12)} per year` }))))) : h('p', { class: 'empty', text: 'No fixed costs yet. Confirm a suggestion below or add a payee.' });

  const suggestList = (list, restore) => h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: restore ? 'fixed-dismissed' : 'fixed-suggested' },
    h('caption', { class: 'sr-only', text: restore ? 'Payments marked as not fixed' : 'Suggested fixed costs' }),
    h('thead', {}, h('tr', {}, th('Payee'), th('Category', 'hide-sm'), th('Rhythm'), th('Amount', 'num'), th('Why', 'hide-sm'), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Actions' })))),
    h('tbody', {}, list.map((f) => h('tr', {},
      h('th', { attrs: { scope: 'row' }, text: f.payee }),
      h('td', { class: 'hide-sm' }, catCell(f.category)),
      h('td', { text: CADENCES.get(f.every) }),
      h('td', { class: 'num', text: f.amount == null ? 'any' : money(f.amount) }),
      h('td', { class: ['hide-sm', 'top-cats'], text: f.reasons ? f.reasons.join(' \u00B7 ') : 'declared' }),
      h('td', {}, h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small primary', text: restore ? 'Restore' : 'Yes, fixed', attrs: { 'aria-label': `${f.payee} is a fixed cost` }, on: { click: () => toggleFixed(f.key, f.payee, [], true) } }),
        restore ? null : h('button', { type: 'button', class: 'btn small', text: 'No', attrs: { 'aria-label': `${f.payee} is not a fixed cost` }, on: { click: () => toggleFixed(f.key, f.payee, [], false) } }))))))));

  // Any payee can be declared a fixed cost.
  const known = new Set(active.map((f) => f.key));
  const payees = new Map();
  for (const t of state.txs) {
    if (t.currency !== c || t.amount >= 0 || t.category === INCOME) continue;
    const k = fixedKey(c, t.payee);
    if (known.has(k)) continue;
    payees.set(k, { payee: t.payee, spent: (payees.get(k)?.spent || 0) - t.amount });
  }
  const options = [...payees.entries()].sort((a, b) => b[1].spent - a[1].spent).slice(0, 300);
  const add = h('div', { class: 'add-row' },
    h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'fx-add', text: 'Add a payee as fixed cost' }),
      h('select', { id: 'fx-add' }, option('', 'Choose a payee\u2026'), options.map(([k, p]) => option(k, `${p.payee} (${money0(p.spent)})`)))),
    h('button', { type: 'button', class: 'btn small', text: 'Add', on: { click: () => {
      const k = $('#fx-add').value;
      if (!k) return;
      toggleFixed(k, payees.get(k).payee, state.txs.filter((t) => fixedKey(t.currency, t.payee) === k), true);
    } } }));

  return h('div', { class: 'fixed-block' },
    h('div', { class: 'stats wide' },
      stat('Fixed per month', `${c} ${money0(monthly)}`),
      stat('Per year', money0(monthly * 12)),
      stat('Recurring payments', String(active.length)),
      stat('Overdue', String(missing.length), missing.length ? 'bad' : ''),
      stat('Paid in period', money0([...paid.values()].reduce((x, y) => x + y, 0)))),
    activeTable,
    suggested.length ? h('div', {}, h('h3', { class: 'sub-head', text: `Suggestions (${suggested.length})` }), h('p', { class: 'note', text: 'These come back regularly but are less certain. Confirm the ones that are fixed costs.' }), suggestList(suggested, false)) : null,
    add,
    dismissed.length ? h('details', { class: 'block' }, h('summary', { text: `Marked as not fixed (${dismissed.length})` }), suggestList(dismissed, true)) : null);
}

function renderFixedView() {
  return h('div', {}, section('Fixed costs', 'Payments that come back at a steady rhythm with a steady amount are detected automatically: rent, insurance, childcare, subscriptions. Confirm, adjust or add your own. Payments within 15% (or 5) of the expected amount count as fixed.', fixedTables()),
    section('Costs not in your files', 'Paid from an account you have not loaded, in cash or by salary deduction: gym, public transport, taxes. They count in categories, totals, budgets and per person as a monthly share (a yearly 6000 counts 500 a month), and in the forecast for all accounts in the months they are due.', manualEditor()));
}

// ---------- forecast & goals ----------
const HORIZONS = [6, 12, 24, 36];

/** Everything the plan needs, computed from the data plus the user's plan inputs. */
function planModel() {
  const p = state.plan;
  const c = state.currency;
  const scopeTxs = state.txs.filter((t) => t.currency === c && (!p.scope || t.account === p.scope));
  const cov = monthCoverage(scopeTxs);
  const fullMonths = [...cov].filter(([, v]) => v.full).map(([m]) => m).sort();
  const baseline = planBaseline(scopeTxs, fullMonths.slice(-6), { ownNames: ownNameList(), excluded: state.excluded, income: INCOME, transfers: TRANSFERS });
  const latest = scopeTxs.reduce((m, t) => (t.date > m ? t.date : m), '');
  const start = latest ? addMonths(latest.slice(0, 7), 1) : new Date().toISOString().slice(0, 7);
  // Latest balance from the files of the planned account(s).
  let fileBalance = null;
  for (const cl of state.clusters) {
    if (p.scope && cl.name !== p.scope) continue;
    let best = null;
    for (const fi of cl.files) {
      const b = state.okFiles[fi]?.result.hint?.balance;
      if (b && state.okFiles[fi].result.settings.currency === c && (!best || b.date > best.date)) best = b;
    }
    if (best) fileBalance = { amount: (fileBalance?.amount || 0) + best.amount, date: fileBalance && fileBalance.date > best.date ? fileBalance.date : best.date };
  }
  const fixed = state.fixed.filter((f) => f.active && f.currency === c && (!p.scope || !f.account || f.account === p.scope));
  const inputs = {
    start, months: p.horizon, buffer: p.buffer,
    balance: p.balance ?? fileBalance?.amount ?? 0,
    variable: p.variable ?? baseline.variable,
    otherIncome: p.otherIncome ?? baseline.otherIncome,
    contributions: p.contributions ?? baseline.contributions,
    fixed: fixed.map((f) => ({ payee: f.payee, amount: f.amount, every: f.every, next: f.next })),
    goals: p.goals,
    // Costs outside the files are paid from other accounts: only part of the all-accounts forecast.
    due: p.scope ? [] : state.manualItems.filter((x) => x.currency === c).flatMap((x) => manualDue(x, start, addMonths(start, p.horizon - 1)).map((d) => ({ ...d, payee: x.name }))),
  };
  const forecast = buildForecast(inputs);
  const needed = buildForecast({ ...inputs, contributions: [{ name: 'needed', monthly: forecast.required }] });
  const opts = { mode: p.splitMode, weights: p.weights };
  return { p, c, baseline, fullMonths, fileBalance, fixed, inputs, forecast, needed, split: splitContribution(forecast.required, inputs.contributions, opts), splitAvg: splitContribution(forecast.average, inputs.contributions, opts) };
}

function planNumber(id, label, value, placeholder, onSet, note) {
  return h('div', { class: 'field' },
    h('label', { class: 'label', htmlFor: id, text: label }),
    h('input', { type: 'text', id, value: value == null ? '' : String(value), attrs: { inputmode: 'decimal', autocomplete: 'off', placeholder: placeholder == null ? '' : String(placeholder), maxlength: 14 },
      on: { change: (e) => { const v = parseBudgetInput(e.target.value); if (Number.isNaN(v)) { setStatus(`Enter an amount like 1234.50 for \u201C${label}\u201D.`, true); return; } keepFocus(id, () => { onSet(v); renderAll(); }); } } }),
    note ? h('span', { class: 'note', text: note }) : null);
}

function renderPlanView() {
  if (!state.last) return emptyView();
  const m = planModel();
  const { p, c, baseline, forecast: f, needed } = m;
  const accounts = [...new Set(state.clusters.map((cl) => cl.name))];
  const contributions = m.inputs.contributions;
  const editContrib = (fn, focusId) => keepFocus(focusId, () => { state.plan.contributions = fn((p.contributions ?? baseline.contributions).map((x) => ({ ...x }))); renderAll(); });
  const diff = f.contributions - f.required;
  const chart = h('div', { class: 'chart', id: 'plan-chart' });
  afterRender.push(() => drawBalance(chart, [
    { name: 'With today\u2019s contributions', cls: 'line-a', values: f.rows.map((r) => ({ month: r.month, value: r.closing })) },
    { name: `Paying in ${money0(f.required)} a month`, cls: 'line-b', values: needed.rows.map((r) => ({ month: r.month, value: r.closing })) },
  ], { currency: c, buffer: p.buffer }));

  const inputsPanel = h('div', { class: 'panel plan-inputs' },
    h('div', { class: 'settings-grid' },
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'plan-scope', text: 'Account' }),
        h('select', { id: 'plan-scope', on: { change: (e) => keepFocus('plan-scope', () => { state.plan = { ...state.plan, scope: e.target.value, balance: null, variable: null, otherIncome: null, contributions: null }; renderAll(); }) } },
          option('', 'All accounts', !p.scope), accounts.map((n) => option(n, n, n === p.scope)))),
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'plan-horizon', text: 'Months ahead' }),
        h('select', { id: 'plan-horizon', on: { change: (e) => keepFocus('plan-horizon', () => { state.plan.horizon = Number(e.target.value); renderAll(); }) } }, HORIZONS.map((n) => option(String(n), `${n} months`, n === p.horizon)))),
      planNumber('plan-balance', 'Balance today', p.balance, m.fileBalance?.amount ?? 0, (v) => { state.plan.balance = v; },
        m.fileBalance ? `From the file: ${money(m.fileBalance.amount)} on ${dayLabel(m.fileBalance.date)}` : 'No balance column in the files; enter it.'),
      planNumber('plan-buffer', 'Keep at least', p.buffer, 0, (v) => { state.plan.buffer = v ?? 0; }, 'The balance should not go below this.'),
      planNumber('plan-variable', 'Other spending per month', p.variable, baseline.variable, (v) => { state.plan.variable = v; },
        `Spending that is not a fixed cost. Average of ${baseline.months} complete month${baseline.months === 1 ? '' : 's'}: ${money0(baseline.variable)}.`),
      planNumber('plan-income', 'Other income per month', p.otherIncome, baseline.otherIncome, (v) => { state.plan.otherIncome = v; },
        `Salary, interest and refunds into this account. Average: ${money0(baseline.otherIncome)}.`)),
    h('h3', { class: 'sub-head', text: 'Paid in per month' }),
    h('p', { class: 'note', text: contributions.length ? 'Detected from transfers between your own accounts (names under People & accounts). Change or add people.' : 'Nobody pays in yet. Add the people who pay into this account.' }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'plan-contrib' },
      h('caption', { class: 'sr-only', text: 'Money paid in per person and month' }),
      h('thead', {}, h('tr', {}, th('Person'), th(`Per month (${c})`, 'num'), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Actions' })))),
      h('tbody', {}, contributions.map((x, i) => h('tr', {},
        h('td', {}, h('input', { type: 'text', id: `pc-name-${i}`, value: x.name, attrs: { list: 'people-list', maxlength: 40, autocomplete: 'off', 'aria-label': `Name of person ${i + 1}` }, on: { change: (e) => editContrib((list) => { list[i].name = cleanPerson(e.target.value) || list[i].name; return list; }, `pc-name-${i}`) } })),
        h('td', { class: 'num' }, h('span', { class: 'budget-input' }, h('input', { type: 'text', id: `pc-amt-${i}`, value: String(x.monthly), attrs: { inputmode: 'decimal', maxlength: 14, autocomplete: 'off', 'aria-label': `Monthly amount paid in by ${x.name}` },
          on: { change: (e) => { const v = parseBudgetInput(e.target.value); if (v == null || Number.isNaN(v)) { e.target.value = String(x.monthly); return; } editContrib((list) => { list[i].monthly = v; return list; }, `pc-amt-${i}`); } } }))),
        h('td', {}, h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove ${x.name}` }, on: { click: () => editContrib((list) => list.filter((_, j) => j !== i)) } }))))))),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn small', id: 'plan-add-person', text: 'Add person', on: { click: () => editContrib((list) => [...list, { name: `Person ${list.length + 1}`, monthly: 0 }].slice(0, 12), `pc-name-${contributions.length}`) } }),
      p.contributions ? h('button', { type: 'button', class: 'btn small link', text: 'Use detected amounts', on: { click: () => { state.plan.contributions = null; renderAll(); } } }) : null),
    h('h3', { class: 'sub-head', text: 'Savings goals' }),
    h('p', { class: 'note', text: 'Holidays, a new car, an emergency fund: what you want to have by when. The plan sets the monthly amount aside so each goal is reached in time.' }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'plan-goals' },
      h('caption', { class: 'sr-only', text: 'Savings goals' }),
      h('thead', {}, h('tr', {}, th('Goal'), th(`Amount (${c})`, 'num'), th('By (YYYY-MM)'), th(`Saved already`, 'num'), th('Per month', 'num'), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Actions' })))),
      h('tbody', {}, p.goals.length ? p.goals.map((g, i) => {
        const plan = f.goals[i];
        const set = (patch, id) => keepFocus(id, () => { state.plan.goals = state.plan.goals.map((x, j) => (j === i ? { ...x, ...patch } : x)); renderAll(); });
        const num = (key, id, label) => h('span', { class: 'budget-input' }, h('input', { type: 'text', id, value: String(g[key] || 0), attrs: { inputmode: 'decimal', maxlength: 14, autocomplete: 'off', 'aria-label': `${label} for ${g.name}` },
          on: { change: (e) => { const v = parseBudgetInput(e.target.value); if (Number.isNaN(v)) { e.target.value = String(g[key] || 0); return; } set({ [key]: v ?? 0 }, id); } } }));
        return h('tr', {},
          h('td', {}, h('input', { type: 'text', id: `goal-name-${i}`, value: g.name, attrs: { maxlength: 40, autocomplete: 'off', 'aria-label': `Name of goal ${i + 1}` }, on: { change: (e) => set({ name: cleanPerson(e.target.value) || g.name }, `goal-name-${i}`) } })),
          h('td', { class: 'num' }, num('amount', `goal-amt-${i}`, 'Target amount')),
          h('td', {}, h('input', { type: 'text', id: `goal-by-${i}`, value: g.by, attrs: { maxlength: 7, placeholder: 'YYYY-MM', autocomplete: 'off', 'aria-label': `Target month for ${g.name}` },
            on: { change: (e) => { const v = e.target.value.trim(); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) set({ by: v }, `goal-by-${i}`); else e.target.value = g.by; } } })),
          h('td', { class: 'num' }, num('saved', `goal-saved-${i}`, 'Amount saved already')),
          h('td', { class: 'num', text: plan.done ? 'reached' : `${money0(plan.monthly)} \u00D7 ${plan.months}` }),
          h('td', {}, h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove goal ${g.name}` }, on: { click: () => { state.plan.goals = state.plan.goals.filter((_, j) => j !== i); renderAll(); } } })));
      }) : h('tr', {}, h('td', { attrs: { colspan: 6 }, class: 'empty', text: 'No goals yet.' }))))),
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn small', id: 'plan-add-goal', text: 'Add goal', on: { click: () => {
      state.plan.goals = [...state.plan.goals, { name: `Goal ${state.plan.goals.length + 1}`, amount: 5000, saved: 0, by: addMonths(m.inputs.start, 11) }].slice(0, 20);
      keepFocus(`goal-name-${state.plan.goals.length - 1}`, renderAll);
    } } })));

  const verdict = f.contributions === 0 ? 'Nobody pays in yet.'
    : diff >= 0.5 ? `Today\u2019s contributions are ${money0(diff)} a month more than needed.`
      : diff <= -0.5 ? `Today\u2019s contributions are ${money0(-diff)} a month short.` : 'Today\u2019s contributions are just right.';
  const results = h('div', {},
    h('div', { class: 'stats wide plan-stats' },
      stat('Pay in per month', `${c} ${money0(f.required)}`),
      stat('Paid in today', money0(f.contributions)),
      stat('Difference', `${diff >= 0 ? '+' : '\u2212'}${money0(Math.abs(diff))}`, diff >= -0.5 ? 'good' : 'bad'),
      stat('Average need', money0(f.average))),
    h('p', { class: 'lead', id: 'plan-verdict', text: `${verdict} To cover fixed costs, other spending and goals and never drop below ${money0(p.buffer)}, ${money0(f.required)} a month must be paid in. The lowest point with today\u2019s contributions is ${money0(f.lowest.closing)} in ${monthLabel(f.lowest.month)}${f.shortfallMonths.length ? `; below the minimum in ${f.shortfallMonths.length} month${f.shortfallMonths.length === 1 ? '' : 's'}` : ''}.` }),
    m.split.length ? h('div', { class: 'split-mode' },
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'plan-split-mode', text: 'Split between people' }),
        h('select', { id: 'plan-split-mode', on: { change: (e) => keepFocus('plan-split-mode', () => { state.plan.splitMode = e.target.value; renderAll(); }) } },
          [...SPLIT_MODES].map(([v, l]) => option(v, l, v === p.splitMode)))),
      h('span', { class: 'note', text: { current: 'Keeps today\u2019s ratio of what each person pays in.', equal: 'Everyone pays the same.', income: 'Enter each person\u2019s net income per month; shares follow the incomes. Incomes stay in this tab and in your settings file only.', custom: 'Enter a percentage per person.' }[p.splitMode] })) : null,
    m.split.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'plan-split' },
      h('caption', { class: 'sr-only', text: 'Monthly amount per person to reach the plan' }),
      h('thead', {}, h('tr', {}, th('Person'), p.splitMode === 'income' ? th('Net income / month', 'num') : p.splitMode === 'custom' ? th('Share %', 'num') : null, th('Today', 'num'), th(`Needed (${SPLIT_MODES.get(p.splitMode).toLowerCase()})`, 'num'), th('Change', 'num'), th('On average', 'num hide-sm'))),
      h('tbody', {}, m.split.map((x, i) => h('tr', {},
        h('th', { attrs: { scope: 'row' }, text: `${x.name} (${pct(x.share)})` }),
        p.splitMode === 'income' || p.splitMode === 'custom' ? h('td', { class: 'num' }, h('span', { class: 'budget-input' }, h('input', {
          type: 'text', id: `split-w-${i}`, value: p.weights.has(x.name) ? String(p.weights.get(x.name)) : '',
          attrs: { inputmode: 'decimal', maxlength: 14, autocomplete: 'off', placeholder: p.splitMode === 'income' ? 'e.g. 8000' : 'e.g. 50', 'aria-label': `${p.splitMode === 'income' ? 'Net monthly income' : 'Share in percent'} of ${x.name}` },
          on: { change: (e) => { const v = parseBudgetInput(e.target.value); if (Number.isNaN(v)) { setStatus('Enter a number.', true); return; } keepFocus(`split-w-${i}`, () => { const w = new Map(state.plan.weights); if (v == null) w.delete(x.name); else w.set(x.name, v); state.plan.weights = w; renderAll(); }); } },
        }))) : null,
        h('td', { class: 'num', text: money0(x.current) }),
        h('td', { class: 'num', text: money0(x.amount) }),
        h('td', { class: ['num', x.change > 0 ? 'bad' : 'good'], text: signed0(x.change) }),
        h('td', { class: 'num hide-sm', text: money0(m.splitAvg[i]?.amount || 0) })))))) : null,
    h('p', { class: 'note', text: '\u201CNeeded\u201D keeps the balance above the minimum in every month, including months with yearly or quarterly bills. \u201COn average\u201D is enough over the whole period but can dip in expensive months.' }));

  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'plan-months' },
    h('caption', { class: 'sr-only', text: `Forecast per month in ${c} with today's contributions` }),
    h('thead', {}, h('tr', {}, th('Month'), th('Start', 'num hide-sm'), th('Paid in', 'num'), th('Fixed costs', 'num'), th('Other spending', 'num hide-sm'), th('To goals', 'num hide-sm'), th('End', 'num'))),
    h('tbody', {}, f.rows.map((r) => h('tr', { class: r.belowBuffer ? 'low' : '' },
      h('th', { attrs: { scope: 'row' }, text: monthLabel(r.month) }),
      h('td', { class: 'num hide-sm', text: money0(r.opening) }),
      h('td', { class: 'num', text: money0(r.moneyIn) }),
      h('td', { class: 'num', text: money0(r.fixed), attrs: { title: r.fixedItems.map((x) => `${x.payee} ${money0(x.amount)}`).join(', ') || null } }),
      h('td', { class: 'num hide-sm', text: money0(r.variable) }),
      h('td', { class: 'num hide-sm', text: money0(r.goals) }),
      h('td', { class: ['num', r.belowBuffer ? 'bad' : ''], text: money0(r.closing) }))))));

  return h('div', {},
    peopleLists(),
    section('Forecast & goals', `From ${monthLabel(f.start)} to ${monthLabel(f.end)} for ${p.scope || 'all accounts'}. Fixed costs are placed in the months they are due (${m.fixed.length} confirmed${p.scope ? '' : `, plus ${state.manualItems.filter((x) => x.currency === c).length} not in files`}, ${money0(f.fixedMonthly)} a month on average); other spending and income come from your complete months.${p.scope && state.manualItems.length ? ' Costs not in your files are left out here because they are paid from other accounts; choose All accounts to include them.' : ''}`,
      inputsPanel),
    section('What needs to be paid in', null, results),
    section('Balance month by month', 'Two lines: with today\u2019s contributions, and with the amount needed. The dashed line is the minimum you want to keep.', chart, h('div', { class: 'legend' },
      h('span', {}, h('span', { class: 'line-key line-a' }), 'With today\u2019s contributions'),
      h('span', {}, h('span', { class: 'line-key line-b' }), `Paying in ${money0(f.required)} a month`),
      h('span', {}, h('span', { class: 'budget-key' }), 'Minimum')), table));
}

// ---------- costs not in the files ----------
const MANUAL_PRESETS = [
  ['Gym', 'Leisure & travel', 1], ['Public transport', 'Transport', 1], ['Taxes', 'Taxes & fees', 12],
  ['Health insurance', 'Health', 1], ['Phone', 'Utilities & telecom', 1], ['Car insurance', 'Insurance', 12],
];

function addManual(name = 'New cost', category = OTHER, every = 1) {
  const latest = state.txs.filter((t) => !t.manual).reduce((m, t) => (t.date > m ? t.date : m), '');
  const first = state.txs.filter((t) => !t.manual && t.currency === state.currency).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  state.manualItems = [...state.manualItems, { name, category, amount: 0, every, start: (every === 12 ? latest : first || latest || new Date().toISOString()).slice(0, 7), end: '', person: '', currency: state.currency }].slice(0, 100);
  keepFocus(`man-amt-${state.manualItems.length - 1}`, recompute);
}

function manualEditor() {
  const items = state.manualItems.map((m, i) => [m, i]).filter(([m]) => m.currency === state.currency);
  const set = (i, patch, id) => keepFocus(id, () => { state.manualItems = state.manualItems.map((x, j) => (j === i ? { ...x, ...patch } : x)); recompute(); });
  const monthly = items.reduce((s, [m]) => s + manualMonthly(m), 0);
  return h('div', { class: 'manual' },
    h('datalist', { id: 'manual-cats' }, knownCategories().map((x) => option(x, x))),
    peopleLists(),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'manual-table' },
      h('caption', { class: 'sr-only', text: `Costs paid outside the loaded accounts, ${state.currency}` }),
      h('thead', {}, h('tr', {}, th('Cost'), th('Category'), th(`Amount (${state.currency})`, 'num'), th('Rhythm'), th('From'), th('Until'), th('Paid by'), th('Per month', 'num'), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Actions' })))),
      h('tbody', {}, items.length ? items.map(([m, i]) => h('tr', {},
        h('td', {}, h('input', { type: 'text', id: `man-name-${i}`, value: m.name, attrs: { maxlength: 60, autocomplete: 'off', 'aria-label': `Name of cost ${i + 1}` }, on: { change: (e) => set(i, { name: cleanText(e.target.value, 60) || m.name }, `man-name-${i}`) } })),
        h('td', {}, h('input', { type: 'text', id: `man-cat-${i}`, value: m.category, attrs: { list: 'manual-cats', maxlength: LIMITS.maxCategoryLength, autocomplete: 'off', 'aria-label': `Category of ${m.name}` }, on: { change: (e) => set(i, { category: cleanText(e.target.value, LIMITS.maxCategoryLength) || OTHER }, `man-cat-${i}`) } })),
        h('td', { class: 'num' }, h('span', { class: 'budget-input' }, h('input', { type: 'text', id: `man-amt-${i}`, value: m.amount ? String(m.amount) : '', attrs: { inputmode: 'decimal', maxlength: 14, autocomplete: 'off', placeholder: '0', 'aria-label': `Amount of ${m.name} per payment` },
          on: { change: (e) => { const v = parseBudgetInput(e.target.value); if (Number.isNaN(v)) { setStatus('Enter an amount like 89 or 1234.50.', true); return; } set(i, { amount: v ?? 0 }, `man-amt-${i}`); } } }))),
        h('td', {}, h('select', { id: `man-every-${i}`, attrs: { 'aria-label': `How often ${m.name} is paid` }, on: { change: (e) => set(i, { every: Number(e.target.value) }, `man-every-${i}`) } }, [...MANUAL_RHYTHMS].map(([v, l]) => option(String(v), l, v === m.every)))),
        h('td', {}, h('input', { type: 'text', id: `man-start-${i}`, value: m.start, attrs: { maxlength: 7, placeholder: 'YYYY-MM', autocomplete: 'off', 'aria-label': `${m.every === 0 ? 'Month' : 'First month'} of ${m.name}` },
          on: { change: (e) => { const v = e.target.value.trim(); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) set(i, { start: v }, `man-start-${i}`); else e.target.value = m.start; } } })),
        h('td', {}, m.every === 0 ? h('span', { class: 'muted', text: '\u2013' }) : h('input', { type: 'text', id: `man-end-${i}`, value: m.end, attrs: { maxlength: 7, placeholder: 'open', autocomplete: 'off', 'aria-label': `Last month of ${m.name} (empty: no end)` },
          on: { change: (e) => { const v = e.target.value.trim(); if (!v || (/^\d{4}-(0[1-9]|1[0-2])$/.test(v) && v >= m.start)) set(i, { end: v }, `man-end-${i}`); else e.target.value = m.end; } } })),
        h('td', {}, h('input', { type: 'text', id: `man-person-${i}`, value: m.person, attrs: { list: 'people-list', maxlength: 40, autocomplete: 'off', placeholder: 'Shared', 'aria-label': `Who pays ${m.name}` }, on: { change: (e) => set(i, { person: cleanPerson(e.target.value) }, `man-person-${i}`) } })),
        h('td', { class: 'num', text: m.every ? money(manualMonthly(m)) : 'once' }),
        h('td', {}, h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove ${m.name}` }, on: { click: () => { state.manualItems = state.manualItems.filter((_, j) => j !== i); recompute(); } } }))))
        : h('tr', {}, h('td', { attrs: { colspan: 9 }, class: 'empty', text: 'Nothing added yet.' }))),
      items.length ? h('tfoot', {}, h('tr', {}, h('td', { attrs: { colspan: 7 }, text: 'Total per month' }), h('td', { class: 'num', text: money(monthly) }), h('td', {}))) : null)),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn small primary', id: 'man-add', text: 'Add a cost', on: { click: () => addManual() } }),
      h('span', { class: 'muted', text: 'Quick add:' }),
      MANUAL_PRESETS.map(([n, c, e]) => h('button', { type: 'button', class: 'btn small', text: n, attrs: { 'aria-label': `Add ${n}` }, on: { click: () => addManual(n, c, e) } }))));
}

// ---------- budget ----------
function setBudgetEdit(category, raw, inputId) {
  const v = parseBudgetInput(raw);
  if (Number.isNaN(v)) { setStatus(`"${cleanText(raw, 20)}" is not a valid amount for ${category}.`, true); return; }
  const key = budgetKey(state.currency, category);
  if (v == null) state.budgetEdits.delete(key);
  else state.budgetEdits.set(key, { category, amount: v, currency: state.currency });
  keepFocus(inputId, refreshBudgets);
}
function refreshBudgets() {
  state.budgets = applyBudgetEdits(state.fileBudgets, state.budgetEdits);
  renderAll();
}

function budgetTable(a) {
  const c = a.currency, t = a.totals;
  const rows = a.categories.filter((x) => x.included && (x.budget > 0 || x.spent > 0));
  if (!rows.length) return h('p', { class: 'empty', text: 'No spending in this period.' });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'bva' },
    h('caption', { class: 'sr-only', text: `Budget versus actual spending per category, ${c}. The monthly budget column is editable.` }),
    h('thead', {}, h('tr', {}, th('Category'), th('Monthly budget', 'num'), th('Budget (period)', 'num'), th('Actual', 'num'), th('Difference', 'num'), th('% vs budget', 'num'), th('Status'),
      h('th', { class: 'hide-sm', attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Bar' })))),
    h('tbody', {}, rows.map((x, i) => {
      const scale = Math.max(x.budget, x.spent, 1);
      const edit = state.budgetEdits.get(budgetKey(c, x.name));
      const monthly = x.budget ? Math.round((x.budget / a.effMonths) * 100) / 100 : 0;
      const id = `bud-${i}`;
      return h('tr', {},
        h('th', { attrs: { scope: 'row' } }, catCell(x.name)),
        h('td', { class: 'num' }, h('span', { class: 'budget-input' }, h('input', {
          type: 'text', id, value: edit ? String(edit.amount) : monthly ? String(monthly) : '', class: edit ? 'edited' : '',
          attrs: { inputmode: 'decimal', autocomplete: 'off', placeholder: 'none', maxlength: 14, 'aria-label': `Monthly budget for ${x.name} in ${c}${edit ? ' (changed here)' : ''}` },
          on: {
            change: (e) => setBudgetEdit(x.name, e.target.value, id),
            keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); document.getElementById(`bud-${i + 1}`)?.focus(); } },
          },
        }))),
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
      h('td', { class: 'num', text: t.budget ? money(t.budget / a.effMonths) : '\u2013' }),
      h('td', { class: 'num', text: money(t.budget) }),
      h('td', { class: 'num', text: money(t.spentBudgeted) }),
      h('td', { class: ['num', t.variance < 0 ? 'bad' : 'good'], text: t.budget ? signed2(t.variance) : '\u2013' }),
      h('td', { class: 'num', text: signedPct(t.variancePct) }),
      h('td', { attrs: { colspan: 2 }, class: 'muted', text: t.unbudgeted > 0.5 ? `${money(t.unbudgeted)} spent without a budget` : '' })))));
}

function budgetTools() {
  const edited = [...state.budgetEdits.values()].filter((e) => e.currency === state.currency).length;
  return h('div', { class: 'budget-tools' },
    h('button', { type: 'button', class: 'btn small', id: 'budget-suggest', text: 'Suggest from average spending', on: { click: suggestBudgets } }),
    h('button', { type: 'button', class: 'btn small', id: 'budget-export', text: 'Download budget CSV', on: { click: exportBudget } }),
    h('button', { type: 'button', class: 'btn small link', id: 'budget-reset', text: 'Undo budget changes', disabled: edited === 0, on: { click: () => { state.budgetEdits = new Map([...state.budgetEdits].filter(([, e]) => e.currency !== state.currency)); refreshBudgets(); setStatus('Budget changes undone.'); } } }));
}

function renderBudgetView() {
  const a = state.last;
  if (!a) return emptyView();
  const note = state.person || state.account
    ? `Showing ${[state.account, state.person].filter(Boolean).join(' \u00B7 ')} against the full budget. Monthly budgets are multiplied by the months in the period.`
    : 'Type a monthly budget per category or load a budget file. Monthly budgets are multiplied by the months in the period; incomplete months get the share of days the data covers.';
  return section('Budget vs actual', note, budgetTools(), budgetTable(a));
}

function suggestBudgets() {
  const a = state.last;
  if (!a) return;
  let n = 0;
  for (const x of a.categories) {
    if (!x.included || x.spent <= 0) continue;
    const key = budgetKey(a.currency, x.name);
    if (x.budget > 0 && !state.budgetEdits.has(key)) continue; // keep budgets that came from files
    state.budgetEdits.set(key, { category: x.name, amount: suggestMonthly(x.spent, a.effMonths), currency: a.currency });
    n++;
  }
  refreshBudgets();
  setStatus(n ? `Suggested monthly budgets for ${n} ${n === 1 ? 'category' : 'categories'} from average spending. Change any amount in the table.` : 'Every category already has a budget.');
}

function exportBudget() {
  const a = state.last;
  if (!a) return;
  const rows = a.categories.filter((x) => x.included && x.budget > 0).map((x) => {
    const edit = state.budgetEdits.get(budgetKey(a.currency, x.name));
    return { category: x.name, amount: edit ? edit.amount : Math.round((x.budget / a.effMonths) * 100) / 100 };
  });
  if (!rows.length) { setStatus('There are no budgets to download yet.', true); return; }
  download(`budget-lens-budget_${a.currency}.csv`, budgetCSV(rows));
  setStatus(`Budget for ${rows.length} categories downloaded.`);
}

// ---------- people and accounts ----------
function peopleSummaryTable() {
  const c = state.currency;
  const people = personSummary(state.txs.filter(inPeriod), state.excluded);
  if (!people.length) return h('p', { class: 'empty', text: 'No spending in this period.' });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'people-summary' },
    h('caption', { class: 'sr-only', text: `Spending per person in ${c} for the selected period` }),
    h('thead', {}, h('tr', {}, th('Person'), th(`Spent (${c})`, 'num'), th('Share', 'num'), th('Payments', 'num hide-sm'), th('Top categories', 'hide-sm'), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Filter' })))),
    h('tbody', {}, people.map((p) => {
      const on = state.person === p.name;
      return h('tr', {},
        h('th', { attrs: { scope: 'row' }, text: p.name }),
        h('td', { class: 'num', text: money0(p.spent) }),
        h('td', { class: 'num', text: pct(p.share) }),
        h('td', { class: 'num hide-sm', text: String(p.count) }),
        h('td', { class: ['top-cats', 'hide-sm'], text: p.top.map((x) => `${x.name} ${money0(x.spent)}`).join(' \u00B7 ') }),
        h('td', {}, state.view === 'setup' ? null : h('button', { type: 'button', class: 'btn small', text: on ? 'Show everyone' : 'Show only', attrs: { 'aria-label': on ? 'Show everyone' : `Show only ${p.name}` }, on: { click: () => { state.person = on ? '' : p.name; renderAll(); } } })));
    }))));
}

function peopleLists() {
  const named = [...new Set([...state.cardOwners.values(), ...state.accountSettings.map((x) => x.owner)].filter(Boolean))].sort();
  return [h('datalist', { id: 'people-list' }, named.map((n) => option(n, n)))];
}

function accountsTable() {
  const c = state.currency;
  if (!state.clusters.length) return h('p', { class: 'empty', text: 'No bank exports loaded.' });
  const sums = new Map(accountSummary(state.txs.filter(inPeriod), state.excluded).map((x) => [x.name, x]));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'accounts' },
    h('caption', { class: 'sr-only', text: 'Accounts found in your files: name them, mark them shared or individual and set the owner' }),
    h('thead', {}, h('tr', {}, th('Account'), th('Type'), th('Owner'), th('Files'), th(`Spent (${c})`, 'num'))),
    h('tbody', {}, state.clusters.map((cl, n) => h('tr', {},
      h('td', {},
        h('input', {
          type: 'text', id: `acct-name-${n}`, value: cl.name,
          attrs: { maxlength: 40, autocomplete: 'off', spellcheck: 'false', 'aria-label': `Name of account ${cl.name}` },
          on: { change: (e) => keepFocus(`acct-name-${n}`, () => updateAccount(cl, { name: cleanPerson(e.target.value) })) },
        }),
        h('span', { class: 'acct-id muted', text: [cl.iban ? `IBAN \u2026${cl.iban.slice(-4)}` : '', cl.cards.size ? `cards ${[...cl.cards].sort().join(', ')}` : '', cl.recognisable ? '' : 'not recognisable next time'].filter(Boolean).join(' \u00B7 ') })),
      h('td', {}, h('select', { id: `acct-kind-${n}`, attrs: { 'aria-label': `Type of account ${cl.name}` }, on: { change: (e) => keepFocus(`acct-kind-${n}`, () => updateAccount(cl, { kind: e.target.value })) } },
        [...ACCOUNT_KINDS].map(([v, l]) => option(v, l, v === cl.kind)))),
      h('td', {}, h('input', {
        type: 'text', id: `acct-owner-${n}`, value: cl.owner,
        attrs: { list: 'people-list', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: cl.kind === 'individual' ? 'e.g. Alex' : 'Not needed', 'aria-label': `Owner of account ${cl.name}` },
        on: { change: (e) => keepFocus(`acct-owner-${n}`, () => updateAccount(cl, { owner: cleanPerson(e.target.value) })) },
      })),
      h('td', {}, h('ul', { class: 'file-list' }, cl.files.map((fi) => {
        const f = state.okFiles[fi];
        const id = `acct-file-${f.id}`;
        const others = state.okFiles.filter((g, gi) => g !== f && fps_kind(g) && !cl.files.includes(gi));
        return h('li', {},
          h('span', { class: 'desc', text: f.result.name }),
          h('select', { id, attrs: { 'aria-label': `Account of file ${f.result.name}` }, on: { change: (e) => keepFocus(id, () => {
            const v = e.target.value;
            if (v === 'auto') state.fileChoices.delete(f.id);
            else if (v === 'own') state.fileChoices.set(f.id, 'own');
            else state.fileChoices.set(f.id, Number(v));
            recompute();
          }) } },
          option('auto', cl.files.length > 1 ? 'Same account (detected)' : 'Detected automatically', !state.fileChoices.has(f.id)),
          option('own', 'Separate account', state.fileChoices.get(f.id) === 'own'),
          others.map((g) => option(String(g.id), `Same account as ${g.result.name}`, state.fileChoices.get(f.id) === g.id))));
      }))),
      h('td', { class: 'num', text: money0(sums.get(cl.name)?.spent || 0) }))))));
}

const fps_kind = (f) => f.result.settings.kind === 'transactions';

function cardsTable() {
  const c = state.currency;
  const cards = cardSummary(state.txs);
  if (!cards.length) return h('p', { class: 'empty', text: 'No card numbers were found in the descriptions.' });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'cards' },
    h('caption', { class: 'sr-only', text: 'Cards found in the transactions; assign each to a person' }),
    h('thead', {}, h('tr', {}, th('Card'), th('Belongs to'), th('Payments', 'num'), th(`Spent (${c})`, 'num'))),
    h('tbody', {}, cards.map((cd) => h('tr', {},
      h('th', { attrs: { scope: 'row' }, text: `\u2022\u2022\u2022\u2022 ${cd.card}` }),
      h('td', {}, h('input', {
        type: 'text', id: `card-${cd.card}`, value: state.cardOwners.get(cd.card) || '',
        attrs: { list: 'people-list', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. Alex', 'aria-label': `Owner of card ending ${cd.card}` },
        on: { change: (e) => keepFocus(`card-${cd.card}`, () => { const v = cleanPerson(e.target.value); if (v) state.cardOwners.set(cd.card, v); else state.cardOwners.delete(cd.card); recompute(); }) },
      })),
      h('td', { class: 'num', text: String(cd.count) }),
      h('td', { class: 'num', text: money0(cd.spent.get(c) || 0) }))))));
}

function ownNamesField() {
  const suggested = ownNameList().filter((n) => !state.ownNames.includes(n));
  return h('div', { class: 'field own-names' },
    h('label', { class: 'label', htmlFor: 'own-names', text: 'Names in transfers between your own accounts' }),
    h('input', { type: 'text', id: 'own-names', value: state.ownNames, attrs: { maxlength: 200, autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. family names, comma separated' },
      on: { change: (e) => keepFocus('own-names', () => { state.ownNames = cleanText(e.target.value, 200); recompute(); }) } }),
    h('span', { class: 'note', text: `Payments whose text contains one of these names count as transfers, not income or spending. Person names are used too${suggested.length ? ` (${suggested.join(', ')})` : ''}. A payment out of one account and the same amount into another within 4 days is a transfer as well.` }));
}

function renderPeopleView() {
  return h('div', {},
    peopleLists(),
    section('People', 'Spending per person in the selected period. On shared accounts, card payments count for the card\u2019s owner and everything else counts as shared.', peopleSummaryTable()),
    section('Accounts', 'Files of the same account are grouped automatically (same IBAN, or same bank layout and cards). Mark an account as individual to count all of it for its owner.', accountsTable(), ownNamesField()),
    section('Cards', 'Card numbers found in the descriptions. Say who each card belongs to.', cardsTable()));
}

// ---------- categories review ----------
function knownCategories() {
  return [...new Set([...state.rules.map((r) => r.category), ...state.txs.map((t) => t.category), ...state.payeeRules.values()])].filter((c) => c && c !== OTHER).sort();
}

function setPayeeCategory(payee, category, focusId) {
  const k = normalizeKey(payee);
  const v = cleanText(category, LIMITS.maxCategoryLength);
  if (v) state.payeeRules.set(k, v);
  else state.payeeRules.delete(k);
  keepFocus(focusId, recompute);
}

function categoryReview({ limit = 25 } = {}) {
  const c = state.currency;
  const unknown = new Map();
  for (const t of state.txs) {
    if (t.currency !== c || t.amount >= 0 || t.category !== OTHER) continue;
    const u = unknown.get(t.payee) || { payee: t.payee, spent: 0, count: 0 };
    u.spent -= t.amount;
    u.count++;
    unknown.set(t.payee, u);
  }
  const rows = [...unknown.values()].sort((a, b) => b.spent - a.spent).slice(0, limit);
  const ruleCats = new Set(state.rules.map((r) => normalizeKey(r.category)));
  const fileCats = new Map();
  for (const f of state.okFiles) for (const t of f.result.records.transactions) if (t.rawCategory && !ruleCats.has(normalizeKey(t.rawCategory))) fileCats.set(normalizeKey(t.rawCategory), t.rawCategory);
  const list = h('datalist', { id: 'category-list' }, knownCategories().map((x) => option(x, x)));
  return h('div', { class: 'review' }, list,
    h('h3', { class: 'sub-head', text: rows.length ? `Payees without a category (${unknown.size})` : 'Every payee has a category' }),
    rows.length ? h('p', { class: 'note', text: 'Type or pick a category. It applies to every payment to this payee, now and in future files.' }) : null,
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'uncategorised' },
      h('caption', { class: 'sr-only', text: 'Biggest payees without a category' }),
      h('thead', {}, h('tr', {}, th('Payee'), th('Payments', 'num'), th(`Spent (${c})`, 'num'), th('Category'))),
      h('tbody', {}, rows.map((u, i) => h('tr', {},
        h('th', { attrs: { scope: 'row' }, text: u.payee }),
        h('td', { class: 'num', text: String(u.count) }),
        h('td', { class: 'num', text: money0(u.spent) }),
        h('td', {}, h('input', { type: 'text', id: `pc-${i}`, attrs: { list: 'category-list', maxlength: LIMITS.maxCategoryLength, autocomplete: 'off', placeholder: 'Choose a category', 'aria-label': `Category for ${u.payee}` },
          on: { change: (e) => setPayeeCategory(u.payee, e.target.value, `pc-${i}`) } }))))))) : null,
    fileCats.size ? h('div', {},
      h('h3', { class: 'sub-head', text: 'Categories from your files' }),
      h('p', { class: 'note', text: 'Your files bring their own category names. Map them onto one name so the same spending is not split in two.' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'aliases' },
        h('caption', { class: 'sr-only', text: 'Categories from files and the category they count as' }),
        h('thead', {}, h('tr', {}, th('In the file'), th('Counts as'))),
        h('tbody', {}, [...fileCats].map(([k, name], i) => h('tr', {},
          h('th', { attrs: { scope: 'row' }, text: name }),
          h('td', {}, h('input', { type: 'text', id: `alias-${i}`, value: state.categoryAliases.get(k) || '', attrs: { list: 'category-list', maxlength: LIMITS.maxCategoryLength, autocomplete: 'off', placeholder: `Keep \u201C${name}\u201D`, 'aria-label': `Category that ${name} counts as` },
            on: { change: (e) => keepFocus(`alias-${i}`, () => { const v = cleanText(e.target.value, LIMITS.maxCategoryLength); if (v) state.categoryAliases.set(k, v); else state.categoryAliases.delete(k); recompute(); }) } })))))))) : null);
}

function payeeCategoryTable() {
  if (!state.payeeRules.size) return h('p', { class: 'note', text: 'No payee categories yet. Set them in the guided setup or on a payee in Spending.' });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'payee-rules' },
    h('caption', { class: 'sr-only', text: 'Categories chosen per payee' }),
    h('thead', {}, h('tr', {}, th('Payee'), th('Category'), h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: 'Actions' })))),
    h('tbody', {}, [...state.payeeRules].map(([k, cat]) => h('tr', {},
      h('th', { attrs: { scope: 'row' }, text: k }),
      h('td', {}, catCell(cat)),
      h('td', {}, h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove category for ${k}` }, on: { click: () => { state.payeeRules.delete(k); recompute(); } } })))))));
}

// ---------- transactions ----------
const SORTS = {
  date: (x, y) => x.date.localeCompare(y.date),
  payee: (x, y) => x.payee.localeCompare(y.payee),
  category: (x, y) => x.category.localeCompare(y.category),
  amount: (x, y) => x.amount - y.amount,
};

function filteredTx() {
  const d = state.drill;
  const q = normalizeKey(state.txSearch);
  let rows = viewTxs().filter((t) => t.currency === state.currency && (d.month ? t.month === d.month : !state.from || (t.month >= state.from && t.month <= state.to)));
  if (d.category) rows = rows.filter((t) => t.category === d.category);
  if (d.payee) rows = rows.filter((t) => t.payee === d.payee);
  if (state.txKind === 'out') rows = rows.filter((t) => t.amount < 0);
  if (state.txKind === 'in') rows = rows.filter((t) => t.amount > 0);
  if (state.txKind === 'fixed') rows = rows.filter((t) => t.fixed);
  if (q) rows = rows.filter((t) => normalizeKey(`${t.payee} ${t.desc} ${t.category} ${t.person} ${t.account}`).includes(q));
  const cmp = SORTS[state.txSort.key];
  return [...rows].sort((x, y) => (state.txSort.dir === 'asc' ? cmp(x, y) : cmp(y, x)) || y.date.localeCompare(x.date));
}

function renderTxTable(container, countEl, moreBtn) {
  const rows = filteredTx();
  const shown = rows.slice(0, state.txLimit);
  const total = rows.reduce((s, t) => s + t.amount, 0);
  countEl.textContent = `${rows.length.toLocaleString('en')} transaction${rows.length === 1 ? '' : 's'} \u00B7 net ${signed2(total)}${rows.length > shown.length ? ` \u00B7 showing ${shown.length}` : ''}`;
  const head = (key, label, cls) => {
    const sorted = state.txSort.key === key;
    return h('th', { class: cls, attrs: { scope: 'col', 'data-k': key, 'aria-sort': sorted ? (state.txSort.dir === 'asc' ? 'ascending' : 'descending') : 'none' } },
      h('button', { type: 'button', text: label, on: { click: () => { state.txSort = { key, dir: sorted && state.txSort.dir === 'desc' ? 'asc' : 'desc' }; renderTxTable(container, countEl, moreBtn); container.querySelector(`th[data-k="${key}"] button`)?.focus(); } } }));
  };
  setChildren(container, h('table', { class: 'data' },
    h('caption', { class: 'sr-only', text: `Transactions in ${state.currency}. Column headers sort the table.` }),
    h('thead', {}, h('tr', {}, head('date', 'Date'), head('payee', 'Payee'), head('category', 'Category'), th('Description', 'hide-sm'), head('amount', 'Amount', 'num'), th('Fixed', 'hide-sm'), th('Person', 'hide-sm'), th('Account', 'hide-sm'))),
    h('tbody', {}, shown.length ? shown.map((t) => h('tr', {},
      h('td', { text: dayLabel(t.date) }),
      h('td', {}, h('button', { type: 'button', class: 'btn link', text: t.payee, attrs: { 'aria-label': `Drill into ${t.payee}` }, on: { click: () => drillTo({ category: t.category, payee: t.payee }) } })),
      h('td', {}, catCell(t.category)),
      h('td', { class: ['desc', 'hide-sm'], text: t.desc }),
      h('td', { class: ['num', t.amount > 0 ? 'amount-in' : ''], text: signed2(t.amount) }),
      h('td', { class: 'hide-sm', text: t.fixed ? 'Fixed' : '' }),
      h('td', { class: 'hide-sm', text: t.person }),
      h('td', { class: ['desc', 'hide-sm'], text: t.account })))
      : h('tr', {}, h('td', { attrs: { colspan: 8 }, class: 'empty', text: 'No matching transactions.' })))));
  moreBtn.hidden = rows.length <= shown.length;
  moreBtn.textContent = `Show ${Math.min(200, rows.length - shown.length)} more`;
}

function renderTransactionsView() {
  const d = state.drill;
  const chips = [];
  if (d.category) chips.push(['Category', d.category, { category: null, payee: null }]);
  if (d.payee) chips.push(['Payee', d.payee, { payee: null }]);
  if (d.month) chips.push(['Month', monthLabel(d.month), { month: null }]);
  const container = h('div', { class: 'table-wrap', id: 'tx' });
  const count = h('p', { class: 'muted', id: 'tx-count' });
  const more = h('button', { type: 'button', class: 'btn small', id: 'tx-more', on: { click: () => { state.txLimit += 200; renderTxTable(container, count, more); } } });
  afterRender.push(() => renderTxTable(container, count, more));
  return section('Transactions', 'Search, sort and filter. Select a payee to drill into it.',
    chips.length ? h('div', { class: 'chips', attrs: { 'aria-label': 'Active filters' } }, chips.map(([k, v, patch]) => h('span', { class: 'chip-filter' }, `${k}: ${v}`,
      h('button', { type: 'button', text: '\u00D7', attrs: { 'aria-label': `Remove filter ${k} ${v}` }, on: { click: () => setDrill({ ...d, ...patch }) } })))) : null,
    h('div', { class: 'tx-tools' },
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'tx-search', text: 'Search' }),
        h('input', { type: 'search', id: 'tx-search', value: state.txSearch, attrs: { placeholder: 'Payee, description, category, person', autocomplete: 'off', spellcheck: 'false', maxlength: 200 },
          on: { input: debounce((e) => { state.txSearch = e.target.value.slice(0, 200); state.txLimit = 200; renderTxTable(container, count, more); }, 150) } })),
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'tx-kind', text: 'Show' }),
        h('select', { id: 'tx-kind', on: { change: (e) => { state.txKind = e.target.value; state.txLimit = 200; renderTxTable(container, count, more); } } },
          [['all', 'All'], ['out', 'Money out'], ['in', 'Money in'], ['fixed', 'Fixed costs only']].map(([v, l]) => option(v, l, v === state.txKind)))),
      count),
    container, h('div', { class: 'more' }, more));
}

// ---------- files & rules ----------
function fieldSelect(id, label, value, entries, onChange) {
  return h('div', { class: 'field' },
    h('label', { class: 'label', htmlFor: id, text: label }),
    h('select', { id, on: { change: (e) => onChange(e.target.value) } }, [...entries].map(([v, l]) => option(v, l, v === value))));
}

function updateFile(f, patch, structural = false) {
  Object.assign(f.overrides, patch);
  if (structural) { delete f.overrides.columns; delete f.overrides.monthCols; }
  keepFocus(document.activeElement?.id, reprocess);
}

function fileCards() {
  return h('div', { class: 'files' }, state.files.map((f) => {
    const remove = h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove ${cleanText(f.name, 80)}` }, on: { click: () => { state.files = state.files.filter((x) => x !== f); state.drill = { category: null, payee: null, month: null }; reprocess(); setStatus('File removed.'); } } });
    if (!f.result) {
      return h('article', { class: 'file' }, h('div', { class: 'file-head' }, h('span', { class: 'file-name', text: cleanText(f.name, 120) }), h('span', { class: 'chip warn', text: f.error || 'Unreadable' }), remove));
    }
    const r = f.result, st = r.settings, rs = r.records.stats;
    const counts = st.kind === 'transactions'
      ? `${r.records.transactions.length.toLocaleString('en')} transactions`
      : `${r.records.budgets.length} budget lines \u00B7 ${r.records.transactions.length} actuals`;
    const dates = r.records.transactions.filter((t) => !t.synthetic).map((t) => t.date).sort();
    const head = h('div', { class: 'file-head' },
      h('span', { class: 'file-name', text: r.name }),
      h('span', { class: 'file-meta' },
        h('span', { class: 'chip', text: KINDS.get(st.kind) || st.kind }),
        h('span', { text: counts }),
        dates.length ? h('span', { text: `${dayLabel(dates[0])} \u2013 ${dayLabel(dates[dates.length - 1])}` }) : null,
        rs.skippedTotals ? h('span', { text: `${rs.skippedTotals} total/balance rows skipped` }) : null,
        rs.skippedInvalid ? h('span', { text: `${rs.skippedInvalid} rows without date or amount skipped` }) : null,
        state.dupRemoved.get(f.id) ? h('span', { class: 'chip', text: `${state.dupRemoved.get(f.id)} also in another file, counted once` }) : null,
        acctOfFile(f) ? h('span', { text: `Account: ${acctOfFile(f)}` }) : null,
        h('span', { text: `${st.encoding.toUpperCase()} \u00B7 ${DELIMS.get(st.delimiter) || st.delimiter} \u00B7 ${st.currency}` }),
        r.warnings.map((w) => h('span', { class: 'chip warn', text: w }))),
      remove);
    const details = h('details', { on: { toggle: (e) => { f.open = e.target.open; } } });
    details.open = f.open || r.warnings.length > 0;
    details.append(h('summary', { text: 'Detected settings and preview' }), fileBody(f));
    return h('article', { class: 'file', attrs: { 'aria-label': r.name } }, head, details);
  }));
}

function acctOfFile(f) {
  const i = state.okFiles.indexOf(f);
  return state.clusters.find((c) => c.files.includes(i))?.name || '';
}

function fileBody(f) {
  const r = f.result, st = r.settings, p = `f${f.id}`;
  const cols = st.columns;
  const fields = [
    fieldSelect(`${p}-enc`, 'Encoding', st.encoding, ENCODINGS.map((e) => [e, e.toUpperCase()]), (v) => updateFile(f, { encoding: v }, true)),
    fieldSelect(`${p}-delim`, 'Delimiter', st.delimiter, DELIMS, (v) => updateFile(f, { delimiter: v }, true)),
    h('div', { class: 'field' },
      h('label', { class: 'label', htmlFor: `${p}-hdr`, text: 'Header row (0 = none)' }),
      h('input', { type: 'number', id: `${p}-hdr`, value: st.headerRow + 1, attrs: { min: 0, max: Math.min(r.rows.length, LIMITS.maxHeaderScanRows * 10), step: 1 }, on: { change: (e) => updateFile(f, { headerRow: Math.max(0, Math.floor(Number(e.target.value) || 0)) - 1 }, true) } })),
    fieldSelect(`${p}-kind`, 'File type', st.kind, KINDS, (v) => updateFile(f, { kind: v })),
  ];
  if (st.kind === 'transactions' || cols.includes('month')) fields.push(fieldSelect(`${p}-date`, 'Date format', st.dateFormat, DATE_LABELS, (v) => updateFile(f, { dateFormat: v })));
  fields.push(fieldSelect(`${p}-dec`, 'Number format', st.decimal, DEC_LABELS, (v) => updateFile(f, { decimal: v })));
  if (st.kind === 'transactions' && cols.includes('amount')) fields.push(fieldSelect(`${p}-sign`, 'Amount sign', st.sign, [['negative-out', 'Negative = money out'], ['positive-out', 'Positive = money out']], (v) => updateFile(f, { sign: v })));
  fields.push(h('div', { class: 'field' },
    h('label', { class: 'label', htmlFor: `${p}-cur`, text: cols.includes('currency') ? 'Currency (fallback)' : 'Currency' }),
    h('input', { type: 'text', id: `${p}-cur`, value: st.currency, attrs: { maxlength: 3, pattern: '[A-Za-z]{3}', autocomplete: 'off', spellcheck: 'false', size: 5 }, on: { change: (e) => { const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); if (v.length === 3) updateFile(f, { currency: v }); else e.target.value = st.currency; } } })));
  if (st.kind === 'category') {
    fields.push(fieldSelect(`${p}-scope`, 'Budget amounts are', st.budgetScope, [['monthly', 'Per month (repeat every month)'], ['once', 'For one period only']], (v) => updateFile(f, { budgetScope: v })));
    fields.push(h('div', { class: 'field' },
      h('label', { class: 'label', htmlFor: `${p}-month`, text: 'Month for undated rows' }),
      h('input', { type: 'text', id: `${p}-month`, value: st.month, attrs: { maxlength: 7, pattern: '\\d{4}-\\d{2}', placeholder: 'YYYY-MM', size: 9, autocomplete: 'off' }, on: { change: (e) => { const v = e.target.value.trim(); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) updateFile(f, { month: v }); else e.target.value = st.month; } } })));
  }
  if (st.kind === 'wide') {
    fields.push(fieldSelect(`${p}-wide`, 'Month columns hold', st.wideMeaning, [['budget', 'Budget'], ['actual', 'Actual spending']], (v) => updateFile(f, { wideMeaning: v })));
    fields.push(h('div', { class: 'field' },
      h('label', { class: 'label', htmlFor: `${p}-year`, text: 'Year of the month columns' }),
      h('input', { type: 'number', id: `${p}-year`, value: st.year, attrs: { min: 1990, max: 2100, step: 1 }, on: { change: (e) => { const y = Math.floor(Number(e.target.value)); if (y >= 1990 && y <= 2100) updateFile(f, { year: y, monthCols: undefined }, true); else e.target.value = st.year; } } })));
  }
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

function addFilesBox() {
  const input = h('input', { type: 'file', id: 'file-input-2', attrs: { multiple: true, accept: '.csv,.tsv,.txt,.json,text/csv,text/plain,application/json' }, on: { change: (e) => { addFiles(e.target.files); e.target.value = ''; } } });
  return h('label', { class: 'drop small', htmlFor: 'file-input-2' }, h('strong', { text: 'Add more files' }), h('span', { class: 'hint muted', text: 'CSV exports, budget sheets or a saved settings file.' }), input);
}

function rulesEditor() {
  const list = h('div', { class: 'rules-list', id: 'rules' });
  const draw = () => setChildren(list, state.ruleEntries.map(([cat, text], i) => {
    const catId = `rule-cat-${i}`, kwId = `rule-kw-${i}`;
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= state.ruleEntries.length) return;
      [state.ruleEntries[i], state.ruleEntries[j]] = [state.ruleEntries[j], state.ruleEntries[i]];
      keepFocus(`rule-cat-${j}`, draw);
    };
    return h('div', { class: 'rule-row' },
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: catId, text: `Category ${i + 1}` }),
        h('input', { type: 'text', id: catId, value: cat, attrs: { maxlength: LIMITS.maxCategoryLength, spellcheck: 'false' }, on: { input: (e) => { state.ruleEntries[i][0] = e.target.value; } } })),
      h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: kwId, text: 'Keywords, comma separated' }),
        h('textarea', { id: kwId, attrs: { rows: 2, spellcheck: 'false', maxlength: 8000 }, on: { input: (e) => { state.ruleEntries[i][1] = e.target.value; } } }, text)),
      h('div', { class: 'rule-actions' },
        h('button', { type: 'button', class: 'btn small', text: '\u2191', disabled: i === 0, attrs: { 'aria-label': `Move rule ${cat} up` }, on: { click: () => move(-1) } }),
        h('button', { type: 'button', class: 'btn small', text: '\u2193', disabled: i === state.ruleEntries.length - 1, attrs: { 'aria-label': `Move rule ${cat} down` }, on: { click: () => move(1) } }),
        h('button', { type: 'button', class: 'btn small', text: 'Remove', attrs: { 'aria-label': `Remove rule ${cat}` }, on: { click: () => { state.ruleEntries.splice(i, 1); draw(); } } })));
  }));
  draw();
  return h('div', {},
    h('label', { class: 'cat-cell' }, h('input', { type: 'checkbox', id: 'use-file-cats', checked: state.useFileCategories, on: { change: (e) => { state.useFileCategories = e.target.checked; recompute(); } } }), 'Use categories from files when they have a category column'),
    list,
    h('div', { class: 'rules-foot' },
      h('button', { type: 'button', class: 'btn small', id: 'rule-add', text: 'Add rule', on: { click: () => {
        if (state.ruleEntries.length >= LIMITS.maxRules) { setStatus(`Up to ${LIMITS.maxRules} rules.`, true); return; }
        state.ruleEntries.push(['New category', '']);
        keepFocus(`rule-cat-${state.ruleEntries.length - 1}`, draw);
      } } }),
      h('button', { type: 'button', class: 'btn small primary', id: 'rules-apply', text: 'Apply rules', on: { click: () => {
        state.rules = buildRules(state.ruleEntries);
        state.ruleEntries = state.rules.map((r) => [r.category, ruleText(r)]);
        state.drill = { category: null, payee: null, month: null };
        recompute();
        setStatus(`${state.rules.length} rules applied.`);
      } } }),
      h('button', { type: 'button', class: 'btn small link', text: 'Reset to defaults', on: { click: () => {
        state.ruleEntries = DEFAULT_RULES.map(([c, t]) => [c, t]);
        state.rules = buildRules(DEFAULT_RULES);
        recompute();
        setStatus('Default rules restored.');
      } } })));
}

function renderFilesView() {
  return h('div', {},
    section('Files', 'Check what was detected. Every setting can be changed per file.',
      h('div', { class: 'files-top' }, addFilesBox(),
        h('div', { class: 'btn-col' },
          h('button', { type: 'button', class: 'btn small', text: 'Run guided setup', on: { click: () => { state.step = 0; go('setup'); } } }),
          h('button', { type: 'button', class: 'btn small', text: 'Save settings', on: { click: exportSettings } }),
          h('button', { type: 'button', class: 'btn small link', id: 'clear-btn', text: 'Clear everything', on: { click: clearAll } }))),
      fileCards()),
    section('Payee categories', 'Categories you chose for single payees. They win over file categories and keyword rules.', payeeCategoryTable()),
    section('Category rules', 'Used when a file has no category column. The first rule with a matching keyword wins. Keywords match whole words; end one with * to match word beginnings.', rulesEditor()));
}

// ---------- guided setup ----------
function renderSetup() {
  const step = Math.min(state.step, STEPS.length - 1);
  const [id, title] = STEPS[step];
  const hasData = state.txs.length > 0 || state.budgets.length > 0;
  const stepper = h('ol', { class: 'stepper', attrs: { 'aria-label': 'Setup steps' } }, STEPS.map(([, label], i) => h('li', { class: [i === step ? 'current' : '', i < step ? 'done' : ''] },
    h('button', { type: 'button', attrs: { 'aria-current': i === step ? 'step' : null }, on: { click: () => { state.step = i; renderAll(); } } }, h('span', { class: 'step-no', text: String(i + 1) }), label))));
  const bodies = {
    files: () => [
      h('p', { class: 'lead', text: `${state.okFiles.length} of ${state.files.length} file${state.files.length === 1 ? '' : 's'} read. Check the type, period and number of transactions of each file. Open a file to fix anything that was guessed wrong.` }),
      fileCards(),
    ],
    accounts: () => [
      peopleLists(),
      h('p', { class: 'lead', text: `${state.clusters.length} account${state.clusters.length === 1 ? '' : 's'} found. Files of the same account are grouped by IBAN, or by bank layout and card numbers. Name each account and say whether it is shared, like a household account, or belongs to one person.` }),
      accountsTable(),
      ownNamesField(),
    ],
    categories: () => [
      h('p', { class: 'lead', text: 'Most payments are categorised by keyword. These payees were not recognised. Give the biggest ones a category; the rest stay in \u201COther\u201D.' }),
      categoryReview(),
    ],
    cards: () => [
      peopleLists(),
      h('p', { class: 'lead', text: 'Who uses which card? On a shared account, card payments then count for that person, and rent, bills and transfers count as shared.' }),
      cardsTable(),
      h('h3', { class: 'sub-head', text: 'Spending per person' }),
      peopleSummaryTable(),
    ],
    fixed: () => [
      h('p', { class: 'lead', text: 'These payments come back at a steady rhythm. Confirm which ones are fixed costs; you can change this later.' }),
      fixedTables({ compact: true }),
      h('h3', { class: 'sub-head', text: 'Costs not in your files' }),
      h('p', { class: 'note', text: 'Anything paid from an account you have not loaded: gym, public transport, taxes. Add them so totals and the forecast are complete.' }),
      manualEditor(),
    ],
    budget: () => state.last ? [
      h('p', { class: 'lead', text: 'Set a monthly budget per category, or let Budget Lens suggest one from your average spending. You can skip this.' }),
      budgetTools(), budgetTable(state.last),
    ] : [h('p', { class: 'lead', text: 'No spending found yet, so there is nothing to budget.' })],
    done: () => [
      h('p', { class: 'lead', text: 'Setup is complete. Save your settings to restore accounts, people, fixed costs and budgets next time: drop the settings file in together with your CSV files.' }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', text: 'Save settings file', on: { click: exportSettings } }),
        h('button', { type: 'button', class: 'btn', text: 'Open the overview', on: { click: () => go(hasData ? 'overview' : 'files') } })),
    ],
  };
  const last = step === STEPS.length - 1;
  const goStep = (n) => { state.step = n; renderAll(); $('#main').focus(); };
  return h('section', { class: 'section setup', attrs: { 'aria-labelledby': 'setup-title' } },
    h('div', { class: 'section-head' }, h('h2', { id: 'setup-title', text: `Setup \u00B7 ${title}` }), h('p', { text: `Step ${step + 1} of ${STEPS.length}` })),
    stepper,
    h('div', { class: 'step-body' }, bodies[id]()),
    h('div', { class: 'step-nav' },
      h('button', { type: 'button', class: 'btn', id: 'step-back', text: '\u2190 Back', disabled: step === 0, on: { click: () => goStep(step - 1) } }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn link', id: 'step-skip', text: 'Skip setup', on: { click: () => go(hasData ? 'overview' : 'files') } }),
      last ? h('button', { type: 'button', class: 'btn primary', id: 'step-finish', text: 'Finish', on: { click: () => go(hasData ? 'overview' : 'files') } })
        : h('button', { type: 'button', class: 'btn primary', id: 'step-next', text: 'Next \u2192', on: { click: () => goStep(step + 1) } })));
}

function emptyView() {
  return section('No data yet', 'The loaded files contain no transactions or budgets. Check the file settings.', h('p', {}, link('Open Files & rules \u2192', 'files')));
}

// ---------- export ----------
function download(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
  const rows = [['Category', 'Included', `Spent (${a.currency})`, 'Share', 'Fixed part', `Budget (${a.currency})`, 'Budget minus spent', 'Spent vs budget %', 'Status', 'Transactions']];
  for (const c of a.categories) rows.push([c.name, c.included ? 'yes' : 'no', c.spent, c.included ? Math.round(c.share * 10000) / 100 : 0, c.fixed, c.budget, c.budget ? c.diff : '', c.pct == null ? '' : Math.round(c.pct * 10000) / 100, STATUS.get(c.status), c.count]);
  rows.push([]);
  rows.push(['Total spent', '', a.totals.spent]);
  rows.push(['Monthly average', '', a.totals.avgMonthly]);
  rows.push(['Fixed costs in period', '', a.totals.fixed]);
  rows.push(['Budget (budgeted categories)', '', a.totals.budget]);
  rows.push(['Income', '', a.totals.income]);
  rows.push(['Period', `${a.from} to ${a.to}`]);
  if (state.account || state.person) rows.push(['Filter', [state.account, state.person].filter(Boolean).join(' / ')]);
  rows.push([]);
  rows.push(['Person', `Spent (${a.currency})`, 'Share', 'Transactions']);
  for (const p of personSummary(viewTxs().filter(inPeriod), state.excluded)) rows.push([p.name, p.spent, Math.round(p.share * 10000) / 100, p.count]);
  rows.push([]);
  rows.push(['Fixed cost', 'Category', 'Rhythm (months)', `Amount (${a.currency})`, 'Per month']);
  for (const f of activeFixed()) rows.push([f.payee, f.category, f.every, f.amount ?? '', f.monthly ?? '']);
  download(`budget-lens-summary_${rangeTag()}.csv`, toCSV(rows));
  setStatus('Summary exported.');
}

function exportTx() {
  const names = state.okFiles.map((f) => f.result.name);
  const rows = [['Date', 'Payee', 'Description', 'Category', 'Amount', 'Currency', 'Fixed', 'Account', 'Card', 'Person', 'File']];
  for (const t of filteredTx()) rows.push([t.date, t.payee, t.desc, t.category, t.amount, t.currency, t.fixed ? 'yes' : '', t.account, t.card ? `****${t.card}` : '', t.person, names[t.file] || '']);
  download(`budget-lens-transactions_${rangeTag()}.csv`, toCSV(rows));
  setStatus(`${rows.length - 1} transactions exported.`);
}

function exportSettings() {
  const text = saveSettings(state);
  download('budget-lens-settings.json', text, 'application/json');
  setStatus('Settings saved. Drop this file in together with your CSV files next time.');
}

function clearAll() {
  Object.assign(state, {
    files: [], accountSettings: [], fileChoices: new Map(), payeeRules: new Map(), categoryAliases: new Map(), ownNames: '', cardOwners: new Map(), budgetEdits: new Map(),
    fixedOverrides: new Map(), fixedManual: new Map(), person: '', account: '', preset: 'all', txSearch: '',
    excluded: new Set([TRANSFERS]), drill: { category: null, payee: null, month: null },
    plan: { scope: '', horizon: 12, balance: null, buffer: 0, variable: null, otherIncome: null, contributions: null, goals: [], splitMode: 'current', weights: new Map() },
    manualItems: [],
  });
  history.replaceState(null, '', location.pathname);
  state.view = 'overview';
  reprocess();
  setStatus('Everything cleared.');
  $('#file-input').focus();
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
function viewFromHash() {
  const v = location.hash.slice(1);
  return VIEWS.some(([id]) => id === v) || v === 'setup' ? v : 'overview';
}

function init() {
  const input = $('#file-input');
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer?.files || []); });
  // Files dropped anywhere are added; the tab never navigates to a dropped file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (!drop.contains(e.target)) addFiles(e.dataTransfer?.files || []); });

  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v === state.view) return;
    state.view = v;
    renderAll();
    if (!$('#app').hidden) {
      $('#main').focus({ preventScroll: true });
      if (window.scrollY > $('#app').offsetTop) window.scrollTo(0, $('#app').offsetTop);
    }
  });

  $('#toolbar').addEventListener('submit', (e) => e.preventDefault());
  $('#preset').addEventListener('change', (e) => { state.preset = e.target.value; applyPreset(true); renderAll(); });
  $('#from').addEventListener('change', (e) => { state.preset = 'custom'; state.from = e.target.value; applyPreset(true); renderAll(); });
  $('#to').addEventListener('change', (e) => { state.preset = 'custom'; state.to = e.target.value; applyPreset(true); renderAll(); });
  $('#currency').addEventListener('change', (e) => { state.currency = e.target.value; state.drill = { category: null, payee: null, month: null }; assignColors(); applyPreset(true); renderAll(); });
  $('#account').addEventListener('change', (e) => { state.account = e.target.value; state.txLimit = 200; renderAll(); });
  $('#person').addEventListener('change', (e) => { state.person = e.target.value; state.txLimit = 200; renderAll(); });
  $('#export-summary').addEventListener('click', exportSummary);
  $('#export-tx').addEventListener('click', exportTx);
  $('#print-btn').addEventListener('click', () => window.print());
  $('#theme-toggle').addEventListener('click', cycleTheme);

  // Nothing is stored: warn before the tab forgets the user's setup.
  window.addEventListener('beforeunload', (e) => {
    if (state.files.length && (state.budgetEdits.size || state.cardOwners.size || state.accountSettings.length || state.payeeRules.size || state.categoryAliases.size || state.fixedOverrides.size || state.fixedManual.size || state.plan.goals.length || state.plan.weights.size || state.manualItems.length)) { e.preventDefault(); e.returnValue = ''; }
  });

  // Redraw size-dependent charts when the layout width changes.
  let lastW = 0;
  new ResizeObserver(debounce(() => {
    const w = $('#app').clientWidth;
    if (!state.files.length || !w || Math.abs(w - lastW) <= 4) return;
    const redraw = lastW !== 0;
    lastW = w;
    if (redraw && ['overview', 'spending'].includes(state.view)) renderAll();
  }, 150)).observe($('#app'));

  state.view = viewFromHash();
  renderAll();
}

init();
