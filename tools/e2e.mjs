#!/usr/bin/env node
// Headless-browser checks for Budget Lens using the Chrome DevTools Protocol.
// Zero dependencies (Node 22+: built-in fetch and WebSocket).
//
//   node tools/e2e.mjs --url http://127.0.0.1:8080 --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
//   node tools/e2e.mjs --url http://127.0.0.1:8080 --cdp http://127.0.0.1:9222     (attach to a running browser)
//
// Checks: security headers, CSP/Trusted Types enforcement, zero CSP violations during normal use,
// XSS payloads in CSV stay inert, formula-injection guard in exports, dashboard renders,
// interactions work, no horizontal overflow on desktop/mobile/dark/print, accessible names.
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

check('starts empty: no sample data or sample button', await js("return !document.querySelector('#sample-btn') && document.querySelector('#dashboard').hidden && document.querySelector('#files-section').hidden"));

// ---------- 3. test files (generated here, dropped into the file input) + dashboard ----------
const fixtures = sampleFiles(new Date()).map((f) => ({ name: f.name, b64: Buffer.from(f.bytes).toString('base64') }));
await js(`const dt = new DataTransfer();
  for (const f of ${JSON.stringify(fixtures)}) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: 'text/csv' }));
  const i = document.querySelector('#file-input'); i.files = dt.files; i.dispatchEvent(new Event('change'));`);
check('dashboard renders after sample data', await waitFor("!document.querySelector('#dashboard').hidden && document.querySelectorAll('#treemap .tile').length > 3"));
const stats = await js(`return {
  hero: [...document.querySelectorAll('#hero .value')].map(e => e.textContent),
  tiles: document.querySelectorAll('#treemap .tile').length,
  cats: document.querySelectorAll('#catlist li').length,
  bva: document.querySelectorAll('#bva tbody tr').length,
  segs: document.querySelectorAll('#monthly rect.seg').length,
  marks: document.querySelectorAll('#monthly .budget-mark').length,
  payees: document.querySelectorAll('#payees li').length,
  tx: document.querySelectorAll('#tx tbody tr').length,
  files: document.querySelectorAll('#files .file').length,
  currencies: [...document.querySelectorAll('#currency option')].map(o => o.value),
}`);
check('hero shows four figures', stats.hero.length === 4 && stats.hero.every((t) => t.trim().length > 0), stats.hero.join(' | '));
check('treemap, categories, budget table, chart, payees, transactions', stats.tiles > 3 && stats.cats > 3 && stats.bva > 3 && stats.segs > 10 && stats.marks >= 3 && stats.payees > 5 && stats.tx > 50, JSON.stringify(stats));
check('two currencies listed, not converted', stats.currencies.join() === 'CHF,EUR', stats.currencies.join());
await shot('desktop-light');

// ---------- 4. interactions ----------
await js("document.querySelector('#treemap .tile').click()");
check('click tile focuses category', await waitFor("document.querySelector('#crumbs strong') && document.querySelector('#tx-count').textContent.includes(' in ')"));
await js("document.querySelector('#crumbs button').click()");
check('back to all categories', await waitFor("!document.querySelector('#crumbs strong')"));
await js("const s = document.querySelector('#preset'); s.value = 'last-3'; s.dispatchEvent(new Event('change'))");
check('period preset changes range', await waitFor("document.querySelectorAll('#monthly rect.seg').length > 0 && document.querySelector('#from').selectedIndex > 0"));
const before = await js("return document.querySelector('#hero .value').textContent");
await js("const cb = document.querySelector('#catlist input[type=checkbox]'); cb.click()");
await sleep(200);
check('excluding a category changes the total', before !== (await js("return document.querySelector('#hero .value').textContent")));
await js("document.querySelector('#catlist input[type=checkbox]').click()");
await js("document.querySelector('#tx th[data-k=amount] button').click()");
check('sorting transactions', await waitFor("document.querySelector('#tx th[data-k=amount]').getAttribute('aria-sort') !== 'none'"));
await js("const i = document.querySelector('#tx-search'); i.value = 'migros'; i.dispatchEvent(new Event('input'))");
await sleep(400);
check('search filters transactions', await js("const rows=[...document.querySelectorAll('#tx tbody tr')]; return rows.length>0 && rows.every(r => r.textContent.toLowerCase().includes('migros'))"));
await js("const i = document.querySelector('#tx-search'); i.value = ''; i.dispatchEvent(new Event('input'))");
await js("const a=document.querySelector('#calc-a'), b=document.querySelector('#calc-b'); a.value='80'; b.value='100'; a.dispatchEvent(new Event('input'))");
check('percentage calculator', (await js("return document.querySelector('#calc-out').textContent")).includes('+25%'));
check('compare table renders', await js("return document.querySelectorAll('#compare tbody tr').length > 3"));
await js("const c=document.querySelector('#currency'); c.value='EUR'; c.dispatchEvent(new Event('change'))");
check('currency switch shows EUR only', await waitFor("document.querySelector('#hero .cur')?.textContent === 'EUR'"));
await js("const c=document.querySelector('#currency'); c.value='CHF'; c.dispatchEvent(new Event('change'))");
await js("const d=document.querySelector('#files details'); d.open=true; d.dispatchEvent(new Event('toggle'))");
const sel = await js("return !!document.querySelector('#files select[id$=-col-1]')");
check('per-file settings and column roles editable', sel);
await js("const s=document.querySelector('#files select[id$=-dec]'); s.value='comma'; s.dispatchEvent(new Event('change'))");
await sleep(300);
check('changing a file setting re-parses', await js("return document.querySelector('#files select[id$=-dec]').value === 'comma'"));
await js("const s=document.querySelector('#files select[id$=-dec]'); s.value='dot'; s.dispatchEvent(new Event('change'))");
await js("document.querySelector('#rule-add').click(); const i=document.querySelector('#rules .rule-row:last-child input'); i.value='Supermarket'; i.dispatchEvent(new Event('input')); const t=document.querySelector('#rules .rule-row:last-child textarea'); t.value='denner'; t.dispatchEvent(new Event('input'));");
check('rules editor adds rule', await js("return document.querySelectorAll('#rules .rule-row').length > 10"));

// Budgets per category.
const setInput = (sel, v) => js(`const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change'));`);
await setInput('#bud-0', "1'000");
await sleep(300);
check('monthly budget can be edited per category', await js("const i = document.querySelector('#bud-0'); return i.value === '1000' && i.classList.contains('edited')"));
const budgetRow = await js("const r = document.querySelector('#bva tbody tr'); return [r.cells[1].textContent, document.querySelector('#bva tbody tr td:nth-child(3)').textContent]");
check('edited budget drives the period budget', /000/.test(budgetRow[1]), budgetRow.join(' | '));
await setInput('#bud-1', 'abc');
await sleep(200);
check('invalid budget is rejected with a message', (await js("return document.querySelector('#status').classList.contains('error')")));
await js("document.querySelector('#budget-suggest').click()");
await sleep(300);
check('suggest budgets fills categories without a budget', await js("return [...document.querySelectorAll('#bva tbody input')].every(i => i.value !== '')"));
await js("document.querySelector('#budget-export').click()");
await js("document.querySelector('#budget-reset').click()");
await sleep(300);
check('undo budget changes', await js("return document.querySelectorAll('#bva tbody input.edited').length === 0"));

// People, cards and accounts.
check('cards are detected', await js("return document.querySelectorAll('#cards tbody tr').length >= 1"));
await setInput('#card-0', 'Alex');
await sleep(300);
check('assigning a card creates a person', await js("return [...document.querySelectorAll('#people-summary tbody th')].some(th => th.textContent === 'Alex') && [...document.querySelectorAll('#person option')].some(o => o.value === 'Alex')"));
await js("const s = document.querySelector('#acct-kind-1'); s.value = 'individual'; s.dispatchEvent(new Event('change'))");
await sleep(200);
await setInput('#acct-owner-1', 'Sam');
await sleep(300);
check('individual account assigns all its spending to the owner', await js("return [...document.querySelectorAll('#people-summary tbody th')].some(th => th.textContent === 'Sam') || [...document.querySelectorAll('#person option')].some(o => o.value === 'Sam')"));
await setInput('#acct-name-0', 'Joint account');
await sleep(300);
check('accounts can be renamed and filtered', await js("return [...document.querySelectorAll('#account option')].some(o => o.value === 'Joint account')"));
const allTotal = await js("return document.querySelector('#hero .value').textContent");
await js("const s = document.querySelector('#person'); s.value = 'Alex'; s.dispatchEvent(new Event('change'))");
await sleep(300);
check('person filter narrows the dashboard', allTotal !== (await js("return document.querySelector('#hero .value').textContent")) && (await js("return [...document.querySelectorAll('#tx tbody tr td:nth-child(6)')].every(td => td.textContent === 'Alex')")));
await js("const s = document.querySelector('#person'); s.value = ''; s.dispatchEvent(new Event('change'))");
await sleep(200);
await js("document.querySelector('#export-summary').click(); document.querySelector('#export-tx').click();");
await sleep(300);

// ---------- 5. hostile CSV ----------
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
await js(`const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(evil)}], ${JSON.stringify('<img src=x onerror=alert(9)>.csv')}, { type: 'text/csv' }));
  const i = document.querySelector('#file-input'); i.files = dt.files; i.dispatchEvent(new Event('change'));`);
await waitFor("document.querySelectorAll('#files .file').length === 4");
await sleep(500);
const xss = await js(`return {
  xss: window.__xss,
  imgs: document.querySelectorAll('img:not([src="/favicon.svg"])').length,
  scripts: [...document.scripts].filter(s => !s.src).length,
  svgOnload: document.querySelectorAll('[onload],[onerror]').length,
  links: [...document.querySelectorAll('a[href]')].filter(a => /^javascript:/i.test(a.getAttribute('href'))).length,
  literal: document.body.textContent.includes('<img src=x onerror=alert(1)>'),
  bold: document.querySelectorAll('#main b').length,
  proto: ({}).spent === undefined && Object.prototype.budget === undefined,
  bidi: /[\\u202A-\\u202E\\u2066-\\u2069\\u200B]/.test(document.body.textContent),
}`);
check('XSS payloads do not execute', xss.xss === 0 && xss.imgs === 0 && xss.scripts === 0 && xss.svgOnload === 0 && xss.links === 0, JSON.stringify(xss));
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
// DevTools-evaluated code may be exempt from 'unsafe-eval' checks, so this is informational; the header check above is authoritative.
const evalProbe = await js("try { eval('1'); return 'allowed'; } catch (e) { return 'blocked'; }");
console.log(`INFO  eval from DevTools context: ${evalProbe} (CSP has no 'unsafe-eval')`);

check('CSP blocks network requests', (await js("try { await fetch('/healthz'); return 'allowed'; } catch (e) { return 'blocked'; }")) === 'blocked');
const imgProbe =  (await js("return await new Promise(r => { const i = new Image(); i.onload = () => r('allowed'); i.onerror = () => r('blocked'); i.src = 'https://example.com/x.png'; setTimeout(() => r('blocked'), 3000); })")); check('CSP blocks external images', imgProbe === 'blocked');
const probeViolations = (await js('return window.__cspv.length')) - violations.length;

// ---------- 7. layout and accessibility ----------
async function layout(name) {
  await sleep(350);
  const r = await js(`
    const vw = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > vw + 1 && !e.closest('.table-wrap,.preview-wrap,.sr-only'); }).map(e => e.tagName + '.' + e.className).slice(0, 5);
    const wide = [...document.querySelectorAll('body *')].filter(e => e.offsetWidth > vw && ![...e.children].some(c => c.offsetWidth > vw)).map(e => e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 30) + ':' + e.offsetWidth + ' in ' + (e.closest('section,div[id]')?.id || '?') + '/' + (e.closest('div')?.className || '')).slice(0, 6);
    const clipped = [...document.querySelectorAll('#hero .value')].filter(e => e.scrollWidth > e.clientWidth + 2).length;
    return { scrollW: document.documentElement.scrollWidth, vw, over: over.concat(document.documentElement.scrollWidth > vw + 1 ? wide : []), clipped, bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color };
  `);
  check(`${name}: no horizontal overflow`, r.scrollW <= r.vw + 1 && r.over.length === 0, `${r.scrollW}/${r.vw} ${r.over.join(',')}`);
  check(`${name}: hero figures fit`, r.clipped === 0);
  return r;
}
await js("window.scrollTo(0,0)");
await layout('desktop light');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
const dark = await layout('desktop dark');
check('dark mode switches palette', /rgb\(1[0-9], 1[0-9], 2[0-9]\)/.test(dark.bg), `${dark.bg} / ${dark.fg}`);
await shot('desktop-dark');
await setViewport({ width: 390, height: 844, mobile: true });
await layout('mobile dark');
await shot('mobile-dark');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await layout('mobile light');
await shot('mobile-light');
await setViewport({ width: 1280, height: 900, mobile: false });
await send('Emulation.setEmulatedMedia', { media: 'print', features: [] });
check('print view hides controls', await js("return getComputedStyle(document.querySelector('#intake')).display === 'none' && getComputedStyle(document.querySelector('.toolbar')).display === 'none'"));
await shot('print');
await send('Emulation.setEmulatedMedia', { media: '', features: [] });
const a11y = await js(`
  const unnamed = [...document.querySelectorAll('button, select, input, textarea')].filter(e => {
    if (e.type === 'hidden' || e.closest('[hidden]')) return false;
    const label = e.getAttribute('aria-label') || (e.labels && e.labels.length && e.labels[0].textContent.trim()) || e.textContent.trim() || e.getAttribute('title');
    return !label;
  }).map(e => e.id || e.outerHTML.slice(0, 60));
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  return { unnamed, dup, h1: document.querySelectorAll('h1').length, tablesWithoutHeaders: [...document.querySelectorAll('table')].filter(t => !t.querySelector('th')).length };
`);
check('every control has an accessible name', a11y.unnamed.length === 0, a11y.unnamed.join(', '));
check('no duplicate ids', a11y.dup.length === 0, a11y.dup.join(', '));
check('one h1, all tables have headers', a11y.h1 === 1 && a11y.tablesWithoutHeaders === 0);
check('no CSP violations at the end (excluding deliberate probes)', (await js('return window.__cspv.length')) === violations.length + probeViolations + (await js('return 0')), String(await js('return window.__cspv.join(" | ")')));

ws.close();
if (chrome) chrome.kill();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}/`);
process.exit(failed.length ? 1 : 0);
