#!/usr/bin/env node
// Headless-browser checks for Budget Lens using the Chrome DevTools Protocol.
// Zero dependencies (Node 22+: built-in fetch and WebSocket).
//
//   node tools/e2e.mjs --url http://127.0.0.1:8080 --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
//   node tools/e2e.mjs --url http://127.0.0.1:8080 --cdp http://127.0.0.1:9222     (attach to a running browser)
//
// Checks: security headers, CSP/Trusted Types enforcement, zero CSP violations during normal use,
// XSS payloads in CSV stay inert, formula-injection guard in exports, dashboard renders,
// guided setup, navigation, drill-down, fixed costs, budgets, people and accounts, settings file,
// no horizontal overflow on every page (desktop/mobile/dark/print), accessible names.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleFiles } from '../test/fixtures/sample.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []));
const URL_ = args.url || 'http://127.0.0.1:8080';
const OUT = args.out || 'e2e-out';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

// ---------- browser ----------
let chrome;
async function endpoint() {
  if (args.cdp) return args.cdp;
  const port = 9300 + Math.floor(Math.random() * 500);
  chrome = spawn(args.chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bl-'))}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); return `http://127.0.0.1:${port}`; } catch { await sleep(200); } }
  throw new Error('Chrome did not start');
}
const base = await endpoint();
const target = (await (await fetch(`${base}/json`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else if (msg.method) events.push(msg);
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
async function js(expression) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
async function waitFor(expr, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await js(`return !!(${expr})`)) return true; await sleep(100); }
  return false;
}
async function shot(name, { full = true } = {}) {
  let restore = null;
  if (full) {
    const dims = await js('return [innerWidth, Math.min(document.documentElement.scrollHeight, 12000)]');
    restore = viewport;
    await send('Emulation.setDeviceMetricsOverride', { width: dims[0], height: dims[1], deviceScaleFactor: 1, mobile: viewport.mobile });
    await sleep(300);
  }
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  if (restore) await setViewport(restore);
}
let viewport = { width: 1280, height: 900, mobile: false };
async function setViewport(v) { viewport = v; await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile }); await sleep(250); }

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
// Record CSP violations, dialogs (XSS canaries) and errors before any page script runs.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__cspv = []; window.__xss = 0; window.__errors = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__cspv.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')));
  for (const k of ['alert', 'confirm', 'prompt']) window[k] = () => { window.__xss++; };
  window.addEventListener('error', (e) => window.__errors.push(String(e.message) + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') + ' ' + (e.error && e.error.stack || '').slice(0, 300)));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
` });

// ---------- 1. headers ----------
const res = await fetch(URL_);
const csp = res.headers.get('content-security-policy') || '';
check('CSP header present and strict', csp.includes("default-src 'none'") && csp.includes("connect-src 'none'") && csp.includes("require-trusted-types-for 'script'") && !csp.includes('unsafe'), csp.slice(0, 60) + '\u2026');
for (const [h, v] of [['x-frame-options', 'DENY'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'], ['cross-origin-opener-policy', 'same-origin'], ['cross-origin-embedder-policy', 'require-corp'], ['strict-transport-security', null], ['permissions-policy', null], ['x-robots-tag', null]]) {
  const got = res.headers.get(h);
  check(`header ${h}`, v ? got === v : !!got, got || 'missing');
}
check('POST is rejected', (await fetch(URL_, { method: 'POST', body: 'x' })).status === 405);
check('healthz', (await (await fetch(`${URL_}/healthz`)).text()) === 'ok\n');

// ---------- 2. load ----------
await setViewport(viewport);
await send('Page.navigate', { url: URL_ });
await waitFor("document.readyState === 'complete' && document.querySelector('#file-input')");
await sleep(400);
check('page loads with title', (await js('return document.title')) === 'Budget Lens');
check('font is self-hosted and loads', await js("await document.fonts.ready; return [...document.fonts].some(f => f.family.includes('Archivo') && f.status === 'loaded')"));
check('no storage or cookies used', await js("return document.cookie === '' && (()=>{try{return localStorage.length===0 && sessionStorage.length===0}catch{return true}})()"));
check('starts empty: upload only, no sample data', await js("return !document.querySelector('#sample-btn') && document.querySelector('#app').hidden && !document.querySelector('#intake').hidden"));
await shot('start');

const setInput = (sel, v) => js(`const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change', { bubbles: true }));`);
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
const clickText = (sel, text) => js(`const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) throw new Error('not found: ' + ${JSON.stringify(text)}); el.click();`);
const dropFiles = (inputSel, files) => js(`const dt = new DataTransfer();
  for (const f of ${JSON.stringify(files)}) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type || 'text/csv' }));
  const i = document.querySelector(${JSON.stringify(inputSel)}); i.files = dt.files; i.dispatchEvent(new Event('change'));`);
const b64 = (s) => Buffer.from(s).toString('base64');

// ---------- 3. guided setup ----------
const fixtures = sampleFiles(new Date()).map((f) => ({ name: f.name, b64: Buffer.from(f.bytes).toString('base64') }));
await dropFiles('#file-input', fixtures);
check('adding files starts the guided setup', await waitFor("document.querySelector('#setup-title')?.textContent.includes('Check files')"));
check('setup shows seven steps and the files', await js("return document.querySelectorAll('.stepper li').length === 7 && document.querySelectorAll('.step-body .file').length === 3"));
await shot('setup-files', { full: false });
await click('#step-next');
check('step 2: accounts', await waitFor("document.querySelector('#setup-title').textContent.includes('Accounts') && document.querySelector('#accounts')"));
check('accounts are recognised from the files', (await js("return document.querySelectorAll('#accounts tbody tr').length")) === 2);
const ids = ['0', '1'];
await setInput(`#acct-name-${ids[0]}`, 'Joint account');
await sleep(200);
await js(`const s = document.querySelector('#acct-kind-${ids[1]}'); s.value = 'individual'; s.dispatchEvent(new Event('change'))`);
await sleep(200);
await setInput(`#acct-owner-${ids[1]}`, 'Sam');
await sleep(200);
check('accounts can be named, typed and owned', await js(`return document.querySelector('#acct-name-${ids[0]}').value === 'Joint account' && document.querySelector('#acct-owner-${ids[1]}').value === 'Sam'`));
await click('#step-next');
check('step 3: categories review', await waitFor("document.querySelector('#setup-title').textContent.includes('Categories') && document.querySelector('.review')"));
if (await js("return !!document.querySelector('#pc-0')")) {
  const before = await js("return document.querySelectorAll('#uncategorised tbody tr').length");
  await setInput('#pc-0', 'Eating out');
  await sleep(300);
  check('a payee category can be set', (await js("return document.querySelectorAll('#uncategorised tbody tr').length")) < before || !(await js("return !!document.querySelector('#uncategorised')")));
}
await click('#step-next');
check('step 3: cards', await waitFor("document.querySelector('#setup-title').textContent.includes('Cards') && document.querySelector('#cards')"));
await setInput('#card-1234', 'Alex');
await sleep(300);
check('assigning a card creates a person', await js("return [...document.querySelectorAll('#people-summary tbody th')].some(th => th.textContent === 'Alex')"));
await click('#step-next');
check('step 4: fixed costs detected', await waitFor("document.querySelector('#setup-title').textContent.includes('Fixed') && document.querySelectorAll('#fixed-active tbody tr').length >= 4"));
const fixedNames = await js("return [...document.querySelectorAll('#fixed-active tbody th')].map(t => t.textContent)");
check('rent, childcare, insurance and phone are fixed costs', ['Immobilien Muster AG Mietzins', 'Kita Sonnenschein GmbH', 'Helsana', 'Wingo'].every((n) => fixedNames.includes(n)), fixedNames.join(', '));
await clickText('#fixed-active button', 'Not fixed');
await sleep(300);
check('a fixed cost can be dismissed', (await js("return document.querySelectorAll('#fixed-active tbody tr').length")) === fixedNames.length - 1 && await js("return !!document.querySelector('details.block')"));
await click('#step-next');
check('step 5: budgets', await waitFor("document.querySelector('#setup-title').textContent.includes('Budgets') && document.querySelector('#bva')"));
await setInput('#bud-0', "1'000");
await sleep(300);
check('monthly budget can be edited per category', await js("const i = document.querySelector('#bud-0'); return i.value === '1000' && i.classList.contains('edited')"));
await setInput('#bud-1', 'abc');
await sleep(200);
check('invalid budget is rejected with a message', await js("return document.querySelector('#status').classList.contains('error')"));
await click('#budget-suggest');
await sleep(300);
check('suggest fills categories without a budget', await js("return [...document.querySelectorAll('#bva tbody input')].every(i => i.value !== '')"));
await click('#step-next');
check('step 6: done', await waitFor("document.querySelector('#setup-title').textContent.includes('Done')"));
await click('#step-finish');
check('finish opens the overview', await waitFor("location.hash === '#overview' && document.querySelectorAll('#main .figure').length === 5"));

// ---------- 4. pages and drill-down ----------
const nav = await js("return [...document.querySelectorAll('#nav a')].map(a => a.textContent)");
check('navigation has all pages', nav.join('|') === 'Overview|Spending|Budget|Fixed costs|Forecast & goals|People & accounts|Transactions|Files & rules', nav.join('|'));
check('overview shows figures, chart and cards', await js("return document.querySelectorAll('#main .card').length === 6 && document.querySelectorAll('#main .chart rect.seg').length > 10 && document.querySelectorAll('#main .chart rect.hit').length >= 6"));
await shot('desktop-light');
await js("const hits = document.querySelectorAll('#main .chart rect.hit'); hits[hits.length - 2].dispatchEvent(new MouseEvent('click', { bubbles: true }))");
check('selecting a month drills into spending for that month', await waitFor("location.hash === '#spending' && document.querySelector('.crumbs .chip-filter')"));
await js("document.querySelector('.crumbs .chip-filter button').click()");
await sleep(300);
check('month filter can be removed', await js("return !document.querySelector('.crumbs .chip-filter')"));
await js("document.querySelector('#main .treemap .tile').click()");
check('tile drills into a category', await waitFor("document.querySelector('.crumbs .crumb.here .cat-cell') && document.querySelector('.detail h3 .cat-cell')"));
const category = await js("return document.querySelector('.detail h3').textContent");
await js("document.querySelector('.detail .mini-list button').click()");
check('payee drill shows payee details', await waitFor("document.querySelectorAll('.crumbs .crumb').length === 3 && document.querySelector('.detail table')"));
const payee = await js("return document.querySelector('.detail h3').textContent");
const toggleLabel = await js("return [...document.querySelectorAll('.detail .btn-row button')][0].textContent");
await js("[...document.querySelectorAll('.detail .btn-row button')][0].click()");
await sleep(400);
check('payee can be marked or unmarked as fixed cost', (await js("return [...document.querySelectorAll('.detail .btn-row button')][0].textContent")) !== toggleLabel, `${payee}: ${toggleLabel}`);
await js("[...document.querySelectorAll('.detail .btn-row button')][0].click()");
await sleep(300);
await clickText('.detail .btn-row button', 'Show all payments');
check('drill carries into transactions with filter chips', await waitFor("location.hash === '#transactions' && document.querySelectorAll('.chips .chip-filter').length === 2"));
check('transactions match the drill', await js(`return [...document.querySelectorAll('#tx tbody tr td:nth-child(2)')].every(td => td.textContent === ${JSON.stringify(payee)})`));
await js("document.querySelectorAll('.chips .chip-filter button')[0].click()");
await sleep(300);
check('removing chips clears the drill', await js("return !document.querySelector('.chips') && document.querySelectorAll('#tx tbody tr').length > 50"));
await js("document.querySelector('#tx th[data-k=amount] button').click()");
check('sorting transactions', await waitFor("document.querySelector('#tx th[data-k=amount]').getAttribute('aria-sort') !== 'none'"));
await js("const i = document.querySelector('#tx-search'); i.value = 'migros'; i.dispatchEvent(new Event('input'))");
await sleep(400);
check('search filters transactions', await js("const rows=[...document.querySelectorAll('#tx tbody tr')]; return rows.length>0 && rows.every(r => r.textContent.toLowerCase().includes('migros'))"));
await js("const i = document.querySelector('#tx-search'); i.value = ''; i.dispatchEvent(new Event('input'))");
await setInput('#tx-kind', 'fixed');
await sleep(300);
check('fixed-costs-only filter', await js("const rows=[...document.querySelectorAll('#tx tbody tr')]; return rows.length > 3 && rows.every(r => r.cells[5].textContent === 'Fixed')"));
await setInput('#tx-kind', 'all');

await js("location.hash = 'fixed'");
check('fixed costs page', await waitFor("document.querySelectorAll('#fixed-active tbody tr').length >= 3 && document.querySelector('#fx-add')"));
const before = await js("return document.querySelectorAll('#fixed-active tbody tr').length");
await js("const s = document.querySelector('#fx-add'); s.selectedIndex = 1; s.dispatchEvent(new Event('change'))");
await clickText('.add-row button', 'Add');
await sleep(300);
check('any payee can be declared a fixed cost', (await js("return document.querySelectorAll('#fixed-active tbody tr').length")) === before + 1);
await setInput('#fx-amt-0', '2000');
await sleep(300);
check('expected amount is editable', (await js("return document.querySelector('#fx-amt-0').value")) === '2000');

// Forecast & goals
await js("location.hash = 'plan'");
check('forecast page with balance chart and month table', await waitFor("document.querySelectorAll('#plan-months tbody tr').length === 12 && document.querySelectorAll('#plan-chart path.bal-line').length === 2"));
const req = async () => Number((await js("return document.querySelector('.plan-stats .stat strong').textContent")).replace(/[^0-9]/g, ''));
await setInput('#plan-income', '0');
await sleep(300);
const before0 = await req();
await click('#plan-add-goal');
await sleep(300);
await setInput('#goal-amt-0', '12000');
await sleep(300);
check('a savings goal raises the amount to pay in', (await req()) > before0, `${before0} -> ${await req()}`);
await click('#plan-add-person');
await sleep(200);
await setInput('#pc-name-0', 'Alex');
await sleep(200);
await click('#plan-add-person');
await sleep(200);
await setInput('#pc-name-1', 'Sam');
await sleep(200);
await setInput('#pc-amt-0', '3000');
await sleep(200);
await setInput('#plan-split-mode', 'equal');
await sleep(300);
const eq = await js("return [...document.querySelectorAll('#plan-split tbody tr')].map(r => r.cells[2].textContent)");
check('split: equal shares', eq.length === 2 && Math.abs(Number(eq[0].replace(/[^0-9]/g, '')) - Number(eq[1].replace(/[^0-9]/g, ''))) <= 1, eq.join(' / '));
await setInput('#plan-split-mode', 'income');
await sleep(300);
await setInput('#split-w-0', '9000');
await sleep(200);
await setInput('#split-w-1', '3000');
await sleep(300);
const inc = await js("return [...document.querySelectorAll('#plan-split tbody tr')].map(r => Number(r.cells[3].textContent.replace(/[^0-9]/g, '')))");
check('split: by net income (3:1)', Math.abs(inc[0] - 3 * inc[1]) <= 3, inc.join(' / '));
await setInput('#plan-buffer', '5000');
await sleep(300);
check('minimum balance is respected', await js("return document.querySelector('#plan-verdict').textContent.includes('5\u2019000')"));
await js('window.scrollTo(0, 0)');
await shot('desktop-plan');
await js("location.hash = 'budget'");
check('budget page keeps edits', await waitFor("document.querySelector('#bva input.edited')"));
await js("location.hash = 'people'");
check('people page shows people, accounts and cards', await waitFor("document.querySelector('#people-summary') && document.querySelector('#accounts') && document.querySelector('#cards')"));
await setInput('#person', 'Alex');
await sleep(300);
await js("location.hash = 'transactions'");
await waitFor("document.querySelector('#tx tbody tr')");
check('person filter applies across pages', await js("return [...document.querySelectorAll('#tx tbody tr')].every(r => r.cells[6].textContent === 'Alex')"));
await setInput('#person', '');
await sleep(200);
await js("location.hash = 'spending'");
await waitFor("document.querySelector('#compare')");
const cmpRows = await js("return document.querySelectorAll('#compare tbody tr').length");
const calcOut = await js("const a=document.querySelector('#calc-a'), b=document.querySelector('#calc-b'); a.value='80'; b.value='100'; a.dispatchEvent(new Event('input')); b.dispatchEvent(new Event('input')); return document.querySelector('#calc-out').textContent");
check('compare table and calculator', cmpRows > 3 && calcOut.includes('+25%'), `${cmpRows} rows; ${calcOut}`);
await setInput('#currency', 'EUR');
check('currency switch shows EUR only', await waitFor("location.hash === '#spending' && document.querySelector('.crumb-meta')?.textContent.startsWith('EUR')"));
await setInput('#currency', 'CHF');
await sleep(200);

await js("location.hash = 'files'");
check('files page with rules and settings', await waitFor("document.querySelectorAll('#main .file').length === 3 && document.querySelector('#rules')"));
await js("const d=document.querySelector('#main .file details'); d.open=true; d.dispatchEvent(new Event('toggle'))");
await sleep(200);
await setInput('[id$=-dec]', 'comma');
await sleep(300);
check('changing a file setting re-parses', await js("return document.querySelector('[id$=-dec]').value === 'comma'"));
await setInput('[id$=-dec]', 'dot');
await sleep(300);
await click('#rule-add');
check('rules editor adds rule', await js("return document.querySelectorAll('#rules .rule-row').length > 10"));

// Settings file: restore a card owner.
await dropFiles('#file-input-2', [{ name: 'budget-lens-settings.json', type: 'application/json', b64: b64(JSON.stringify({ app: 'budget-lens', version: 2, cards: [{ card: '1234', owner: 'Robin' }], accounts: [], budgets: [], fixed: {}, excluded: ['Transfers & savings'] })) }]);
await sleep(500);
await js("location.hash = 'people'");
check('settings file restores setup', await waitFor("document.querySelector('#card-1234')?.value === 'Robin'"));
// The same export loaded twice is counted once.
await js("location.hash = 'overview'");
await waitFor("document.querySelector('#main .figure .value')");
const totalBefore = await js("return document.querySelector('#main .figure .value').textContent");
await js("location.hash = 'files'");
await waitFor("document.querySelector('#file-input-2')");
await dropFiles('#file-input-2', [{ name: 'ZKB_again.csv', b64: fixtures[0].b64 }]);
await waitFor("document.querySelectorAll('#main .file').length === 4");
check('a file loaded twice is counted once', await js("return [...document.querySelectorAll('#main .file .chip')].some(c => c.textContent.includes('counted once'))"));
await js("location.hash = 'overview'");
await waitFor("document.querySelector('#main .figure .value')");
check('totals unchanged by the duplicate file', (await js("return document.querySelector('#main .figure .value').textContent")) === totalBefore, totalBefore);
await js("location.hash = 'files'");
await waitFor("document.querySelectorAll('#main .file').length === 4");
await js("[...document.querySelectorAll('#main .file')].find(f => f.textContent.includes('ZKB_again')).querySelector('.file-head button').click()");
await waitFor("document.querySelectorAll('#main .file').length === 3");
await click('#export-summary');
await click('#export-tx');
await sleep(300);

// ---------- 5. hostile CSV ----------
await js("location.hash = 'files'");
await waitFor("document.querySelector('#file-input-2')");
const ZW = String.fromCharCode(0x200b), RLO = String.fromCharCode(0x202e), BEL = String.fromCharCode(7);
const evil = [
  'Datum;Buchungstext;Kategorie;Betrag',
  '01.10.2026;"<img src=x onerror=alert(1)>";"<b>Bold</b>";-11.00',
  '02.10.2026;"<script>alert(2)</script>";Groceries;-12.00',
  '03.10.2026;"""><svg onload=alert(3)>";__proto__;-13.00',
  '04.10.2026;"javascript:alert(4)";constructor;-14.00',
  '05.10.2026;"=HYPERLINK(""http://evil.example"",""x"")";"=1+2";-15.00',
  `06.10.2026;"Mi${ZW}gros ${RLO}exe.gnp";"Food${BEL}";-16.00`,
].join('\n');
await dropFiles('#file-input-2', [{ name: '<img src=x onerror=alert(9)>.csv', b64: b64(evil) }]);
await waitFor("document.querySelectorAll('#main .file').length === 4");
await js("location.hash = 'spending'");
await waitFor("document.querySelector('#main .catlist')");
await sleep(300);
const xss = await js(`return {
  xss: window.__xss,
  imgs: document.querySelectorAll('img:not([src="/favicon.svg"])').length,
  scripts: [...document.scripts].filter(s => !s.src).length,
  handlers: document.querySelectorAll('[onload],[onerror]').length,
  links: [...document.querySelectorAll('a[href]')].filter(a => /^javascript:/i.test(a.getAttribute('href'))).length,
  literal: document.body.textContent.includes('<b>Bold</b>'),
  bold: document.querySelectorAll('#main b').length,
  proto: ({}).spent === undefined && Object.prototype.budget === undefined,
  bidi: /[\\u202A-\\u202E\\u2066-\\u2069\\u200B]/.test(document.body.textContent),
}`);
check('XSS payloads do not execute', xss.xss === 0 && xss.imgs === 0 && xss.scripts === 0 && xss.handlers === 0 && xss.links === 0, JSON.stringify(xss));
check('payloads are shown as literal text', xss.literal && xss.bold === 0);
check('no prototype pollution from category names', xss.proto);
check('bidi/zero-width characters stripped from UI', !xss.bidi);
const exported = await js(`const m = await import('/js/sanitize.js'); return m.toCSV([['=HYPERLINK("x")', '+1', '@A', -5]])`);
check('CSV export guards formula injection', exported.includes(`"'=HYPERLINK`) && exported.includes(`"'+1"`) && exported.includes(`"'@A"`) && exported.includes(',-5'), exported.trim());

// ---------- 6. CSP violations during normal use, then enforcement probes ----------
const violations = await js('return window.__cspv.slice()');
const errors = await js('return window.__errors.slice()');
check('zero CSP violations during normal use', violations.length === 0, violations.join(' | '));
check('zero uncaught errors', errors.length === 0, errors.join(' | '));
check('Trusted Types blocks innerHTML', (await js("try { document.createElement('div').innerHTML = '<b>x</b>'; return 'allowed'; } catch (e) { return 'blocked'; }")) === 'blocked');
// DevTools-evaluated code may be exempt from 'unsafe-eval' checks, so this is informational; the header check is authoritative.
console.log(`INFO  eval from DevTools context: ${await js("try { eval('1'); return 'allowed'; } catch (e) { return 'blocked'; }")} (CSP has no 'unsafe-eval')`);
check('CSP blocks network requests', (await js("try { await fetch('/healthz'); return 'allowed'; } catch (e) { return 'blocked'; }")) === 'blocked');
check('CSP blocks external images', (await js("return await new Promise(r => { const i = new Image(); i.onload = () => r('allowed'); i.onerror = () => r('blocked'); i.src = 'https://example.com/x.png'; setTimeout(() => r('blocked'), 3000); })")) === 'blocked');
const probeViolations = (await js('return window.__cspv.length')) - violations.length;

// ---------- 7. layout and accessibility on every page ----------
async function layout(name) {
  await sleep(350);
  const r = await js(`
    const vw = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > vw + 1 && !e.closest('.table-wrap,.preview-wrap,.sr-only'); }).map(e => e.tagName + '.' + e.className).slice(0, 5);
    const clipped = [...document.querySelectorAll('#main .figure .value, .stat strong')].filter(e => e.scrollWidth > e.clientWidth + 2).length;
    return { scrollW: document.documentElement.scrollWidth, vw, over, clipped, bg: getComputedStyle(document.body).backgroundColor };
  `);
  check(`${name}: no horizontal overflow`, r.scrollW <= r.vw + 1 && r.over.length === 0, `${r.scrollW}/${r.vw} ${r.over.join(',')}`);
  check(`${name}: figures fit`, r.clipped === 0);
  return r;
}
async function a11y(name) {
  const r = await js(`
    const unnamed = [...document.querySelectorAll('button, select, input, textarea, [role=button]')].filter(e => {
      if (e.type === 'hidden' || e.closest('[hidden]')) return false;
      const label = e.getAttribute('aria-label') || (e.labels && e.labels.length && e.labels[0].textContent.trim()) || e.textContent.trim() || e.getAttribute('title');
      return !label;
    }).map(e => e.id || e.outerHTML.slice(0, 60));
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    return { unnamed, dup, h1: document.querySelectorAll('h1').length, h2: document.querySelectorAll('#main h2').length, tablesWithoutHeaders: [...document.querySelectorAll('table')].filter(t => !t.querySelector('th')).length };
  `);
  check(`${name}: controls named, ids unique, headings, table headers`, r.unnamed.length === 0 && r.dup.length === 0 && r.h1 === 1 && r.h2 >= 1 && r.tablesWithoutHeaders === 0, JSON.stringify(r));
}
const pages = ['overview', 'spending', 'budget', 'fixed', 'plan', 'people', 'transactions', 'files', 'setup'];
for (const p of pages) {
  await js(`location.hash = '${p}'`);
  await sleep(300);
  await js('window.scrollTo(0, 0)');
  await layout(`desktop ${p}`);
  await a11y(p);
}
await js("location.hash = 'spending'");
await sleep(300);
await shot('desktop-spending');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
const dark = await layout('desktop dark spending');
check('dark mode switches palette', /rgb\(1[0-9], 1[0-9], 2[0-9]\)/.test(dark.bg), dark.bg);
await shot('desktop-dark');
await setViewport({ width: 390, height: 844, mobile: true });
for (const p of pages) {
  await js(`location.hash = '${p}'`);
  await sleep(300);
  await layout(`mobile ${p}`);
}
await js("location.hash = 'budget'");
await sleep(300);
check('mobile: editable tables become one card per row', await js("const t = document.querySelector('#bva'); const td = t.querySelector('tbody td[data-label]'); return t.classList.contains('stack') && getComputedStyle(t.querySelector('thead')).position === 'absolute' && getComputedStyle(t.querySelector('tbody tr')).display === 'block' && td && td.getAttribute('role') === 'cell'"));
await shot('mobile-budget');
await js("location.hash = 'overview'");
await sleep(300);
await shot('mobile-dark');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await js("location.hash = 'setup'");
await sleep(300);
await shot('mobile-light-setup');
await setViewport({ width: 1280, height: 900, mobile: false });
await js("location.hash = 'overview'");
await sleep(300);
await send('Emulation.setEmulatedMedia', { media: 'print', features: [] });
check('print view hides controls', await js("return getComputedStyle(document.querySelector('.toolbar')).display === 'none' && getComputedStyle(document.querySelector('#nav')).display === 'none'"));
await shot('print');
await send('Emulation.setEmulatedMedia', { media: '', features: [] });
check('no CSP violations after the probes', (await js('return window.__cspv.length')) === violations.length + probeViolations, String(await js('return window.__cspv.join(" | ")')));
check('still no uncaught errors', (await js('return window.__errors.length')) === 0, String(await js('return window.__errors.join(" | ")')));

ws.close();
if (chrome) chrome.kill();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}/`);
process.exit(failed.length ? 1 : 0);
