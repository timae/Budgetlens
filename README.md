# Budget Lens

Drop one or more CSV files (bank exports or budget sheets) and see where the money goes, how it compares to budget and how it changes over time. Everything runs in the browser; the server only hands out static files.

![Overview](docs/desktop-light.jpg)

![Guided setup](docs/setup.jpg)

![Spending drill-down](docs/spending.jpg)

## Security model

| Threat | Control |
| --- | --- |
| Financial data leaving the device | All parsing and analysis happen in the browser tab. The server has no upload endpoint, no database, no storage and accepts only `GET`/`HEAD` (everything else is `405`). CSP `connect-src 'none'` stops the page itself from making any network request (fetch, XHR, WebSocket, beacons). |
| Data lingering | No cookies, `localStorage`, `sessionStorage` or IndexedDB. Closing or reloading the tab forgets everything. The access log records method, path, status and duration only: no IPs, query strings or headers. |
| XSS from CSV content | The UI is built with DOM APIs only (`createElement`, `textContent`). There is no `innerHTML` or any other HTML sink, and CSP enforces Trusted Types with no policy allowed (`require-trusted-types-for 'script'; trusted-types 'none'`), so any sink use throws. There are no inline scripts or styles; styles are set through the CSSOM. |
| Third-party code | Go standard library only, no npm packages, no CDNs. The Archivo font is self-hosted (SIL OFL). CSP allows scripts, styles, fonts and images from the same origin only. |
| Hostile input | Limits on files (12), file size (15 MB), rows (100,000 per file, 300,000 total), columns (200) and cell length (1,000 characters). Control, zero-width and bidi-override characters are stripped from every cell. User-derived keys live in `Map`s, so names like `__proto__` are harmless. |
| Spreadsheet formula injection in exports | Text cells starting with `= + - @ \t \r %`, a pipe or a full-width variant get a leading `'`. Numbers stay numeric. |
| Framing, sniffing, leaks | `X-Frame-Options: DENY` and `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/COEP/CORP, a restrictive `Permissions-Policy`, `X-Robots-Tag: noindex`, HSTS. HTTP requests get a 308 to HTTPS based on `X-Forwarded-Proto`. |
| Server hardening | Embedded file allowlist (`.html .css .js .svg .png .woff2 .txt`); dotfiles and unknown types are never served. Clean-path check (no `..`, backslashes or encoded separators). Read, write and idle timeouts, a 16 KB header limit and graceful shutdown. The runtime image is distroless, static and runs as non-root with no shell. |
| Unwanted visitors | Deploio basic auth is on by default (`.deploio.yaml`). |

Full header set: see `securityHeaders` and `contentSecurityPolicy` in `server.go`.

## Deploy on Deploio

```sh
nctl auth login
nctl create app budget-lens \
  --git-url=https://github.com/<org>/budget-lens \
  --dockerfile \
  --basic-auth \
  --size=micro \
  --port=8080
```

The build stage runs `go vet` and `go test` on `golang:1.27-alpine`. A failing test fails the deploy. The runtime image is `gcr.io/distroless/static-debian12:nonroot`. For reproducible builds, pin both base images by digest.

`.deploio.yaml` sets the same defaults: `size: micro`, `port: 8080`, `enableBasicAuth: true` and a health probe on `/healthz`. Settings changed in Cockpit or with `nctl` take precedence over the file. Deploio checks app health with a TCP probe on the port by default. If your platform version doesn't support the `healthProbe` field, the TCP probe still applies and `/healthz` stays available for external monitoring.

**Basic-auth credentials**

```sh
nctl get app budget-lens --basic-auth-credentials   # show user and password
nctl update app budget-lens --change-basic-auth-password   # rotate
```

**Custom domain**

1. Find the default host (`*.deploio.app`) with `nctl get app budget-lens`.
2. At your DNS provider, add a CNAME from e.g. `budget.example.ch` to that default host. Also add the TXT record shown in Cockpit under *Hosts* (`"deploio-site-verification=…"`). Remove any AAAA records.
3. Add the host to the app: `nctl update app budget-lens --hosts="budget.example.ch"`. This replaces the existing list, so include any hosts you want to keep.
4. Deploio issues a Let's Encrypt certificate once DNS resolves.

## Run locally

```sh
go run .                                  # http://localhost:8080 (PORT overrides)
# or
docker build -t budget-lens . && docker run --rm -p 8080:8080 budget-lens
```

## Tests

```sh
go vet ./... && go test ./...             # server, headers, routing, gzip/ETag, static CSP checks on web/
node --test test/*.test.js                # parsing, detection, categorisation, analysis (Node 22+, no deps)
node tools/e2e.mjs --url http://127.0.0.1:8080 \
  --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # headless browser checks
```

`tools/e2e.mjs` drives Chrome over the DevTools protocol with no dependencies. It checks that the app starts empty, generates test files from `test/fixtures/sample.js` and drops them into the file input, then walks through the guided setup (accounts, cards, fixed costs, budgets), every page of the navigation, the drill-down from month to category to payee to transactions, fixed-cost confirmation and declaration, filters, sorting, search, the currency switch, per-file settings, rules, restoring a settings file and the exports. It also:

- Loads a CSV full of XSS, formula and bidi payloads and checks that nothing executes and nothing renders as HTML.
- Confirms Trusted Types and CSP block `innerHTML`, `fetch` and external images.
- Requires zero CSP violations and zero uncaught errors.
- Checks for horizontal overflow and clipped figures on desktop and mobile, in light and dark mode and in print.
- Checks that every control has an accessible name.

Screenshots and `report.json` go to `e2e-out/`. To attach to a browser that is already running, use `--cdp http://127.0.0.1:9222` instead of `--chrome`.

## Supported input

**Encodings:** UTF-8 (with or without BOM), UTF-16 LE/BE (BOM or zero-byte pattern), Windows-1252.
**Delimiters:** `,` `;` tab `|` (detected by consistency across lines, ignoring quoted text).
**Header row:** found by keyword and shape, so bank preambles (account number, period) and footers (disclaimers, totals) are skipped. Headerless files work too.
**Numbers:** `1'234.50`, `1’234.50`, `1,234.50`, `1 234.50`, `1.234,50`, `1 234,50`, `(45.00)`, `120.00-`, `−3.35`, `CHF 12.–`, with currency codes and symbols stripped.
**Dates:** `31.12.2026`, `31/12/26`, `12/31/2026` (detected when unambiguous), ISO with or without time, Excel serial numbers (under a date-like header), `1. Oktober 2026`, `Oct 5, 2026`, `3 févr. 2026`.

**Column roles,** detected from DE/FR/IT/EN headers and checked against the content:

| Role | Example headers |
| --- | --- |
| Date | Datum, Buchungsdatum, Booking date, Date de comptabilisation, Data contabile; value dates only as a fallback |
| Description | Buchungstext, Beschreibung1–3 (joined), Avisierungstext, Text, Libellé, Descrizione, Payee |
| Category | Kategorie, Category, Catégorie, Categoria, Posten, Position |
| Amount (±) | Betrag, Amount, Montant, Importo, Credit/Debit Amount |
| Money out / in | Belastung/Gutschrift, Lastschrift/Gutschrift, Debit/Credit, Soll/Haben (dated) |
| Budget / actual | Budget, Plan, Soll/Ist, Planned/Actual, Prévu/Réel, Previsto/Effettivo |
| Currency | Währung, Currency, Devise, Valuta (when the values are currency codes) |
| Debit/credit flag | S/H, DBIT/CRDT, D/C columns next to unsigned amounts |
| Ignored | Saldo/Balance, fees, IDs, references, IBAN, state, time |

**File types**

- **Bank exports.** UBS, PostFinance, ZKB, Raiffeisen and Revolut layouts are covered by tests; most other banks work through the same detection.
- **Category / Budget / Actual sheets,** including Soll/Ist. Actuals without dates are assigned to a month you choose.
- **Budget-only files.** Amounts count either per month (repeated over the selected period) or once for a chosen month.
- **Wide sheets with one column per month** (`Jan…Dez`, `2026-01`, `Oct 26`). They hold budgets by default, or actual spending when the file name says so; you can switch either way.
- **Totals.** `Total`, `Summe`, `Gesamt`, `Saldo` rows and columns are skipped.

Every detected setting can be changed per file under *Detected settings and preview*: encoding, delimiter, header row, file type, date and number format, sign convention, currency, budget scope and the role of each column. The live preview updates as you change them.

**Categories.** A category column from the file is used when present. Otherwise descriptions are matched against editable keyword rules for Swiss merchants (Migros, Coop, Denner, SBB, Helsana, Swisscom, ewz, Digitec Galaxus and others). The first matching rule wins. Keywords match whole words, and a trailing `*` matches word beginnings. Inflows that match a spending rule count as refunds; other inflows count as income. *Transfers & savings* is excluded from totals by default; any category can be toggled.

**Currencies** are never converted. The dashboard shows one currency at a time.

## Pages

| Page | What it shows |
| --- | --- |
| **Overview** | Total spent, monthly average, fixed costs per month, budget variance and month-over-month change; month-by-month chart; top categories, fixed costs, budget and people at a glance. |
| **Spending** | Treemap with drill-down: categories → payees → one payee's payments. A detail panel shows totals, average per month, share, fixed part and budget status at each level. Select any month in the chart to narrow everything to that month. Category include/exclude toggles, period comparison and the percentage calculator live here too. |
| **Budget** | Budget vs actual per category with editable monthly budgets. |
| **Fixed costs** | Detected and declared recurring payments (see below). |
| **People & accounts** | Spending per person, account types and owners, card owners. |
| **Transactions** | Searchable, sortable list. The drill-down from other pages arrives as removable filter chips; *Fixed costs only* shows the recurring part. |
| **Files & rules** | Add files, check and adjust every detected setting per file, edit category rules, save settings, clear everything. |

Pages are addressed by the URL fragment (`#spending`, `#fixed` …), so the browser's back button works. The period, currency, account and person filters above the pages apply everywhere.

## Guided setup

Dropping the first files starts a six-step setup. Every step can be skipped and the setup can be re-run any time (*Guided setup*).

1. **Check files.** What was detected per file: type, period, number of transactions and skipped rows. Each file opens to show its settings and a preview.
2. **Accounts.** Name each account and mark it shared or individual, with an owner.
3. **Cards & people.** Say who each card belongs to, and see the resulting spending per person.
4. **Fixed costs.** Confirm or dismiss the recurring payments that were found.
5. **Budgets.** Type monthly budgets, or let Budget Lens suggest them from average spending.
6. **Done.** Save the settings file for next time.

## Fixed costs

Payments to the same payee are treated as a fixed cost when they come back at a steady rhythm with a steady amount. The rhythm can be monthly, every two months, quarterly, half-yearly or yearly. Each payee is checked on:

- **Rhythm:** the typical gap between months with a payment, and how many gaps match it.
- **Amount:** the median payment and its robust deviation. For a payee with one large and several small payments, like an insurance premium plus excess bills, the monthly main payment is used.
- **Day of month:** how steady it is.
- **Frequency:** payees paid several times in most months, like supermarkets, are never fixed costs.
- **Category:** housing, insurance, utilities, childcare, subscriptions, health and taxes get a little more tolerance.

Clear cases are confirmed automatically. Less certain ones, and anything seen in only two months, are listed as suggestions. You can confirm or dismiss each, change its rhythm and expected amount (empty = any amount), or declare any payee a fixed cost. Payments within 15% (at least 5) of the expected amount count as fixed. *Overdue* flags a fixed cost whose next payment is more than 10 days late compared to the newest data.

Fixed costs show up as a figure in the overview, as the "fixed part" of each category and of each drill-down level, and as a filter and column in the transactions.

## Settings file

Nothing is stored in the browser. *Save settings* downloads `budget-lens-settings.json` with your accounts and their files, card owners, fixed-cost decisions, budgets, excluded categories and category rules. It contains no transactions. It does contain file names, account and person names, the last four digits of assigned cards, the payee names and expected amounts of fixed costs, and your budgets, so treat it as private. Drop the settings file in together with your CSV files next time to restore everything.

The loader treats the file as untrusted. It is limited to 1 MB and accepts only the expected shape. Every string is cleaned and limited in length, and keys are checked. Values go into `Map`s, so `__proto__` and similar keys cannot pollute objects. The tab asks for confirmation before closing while there are unsaved settings.

## Budgets

The *Budget vs actual* table has an editable **monthly budget** per category. A value typed there replaces any budget a file provides for that category; `0` removes it; an empty field falls back to the file. *Suggest from average spending* fills every category that has no budget with its monthly average, rounded up to the next 10. Monthly budgets are multiplied by the number of months in the selected period.

*Download budget CSV* saves the current monthly budgets as `Category, Monthly budget`, a file any spreadsheet can open and Budget Lens can load again. To keep everything else too, use *Save settings* (see below).

## People, cards and accounts

Each loaded bank export is an **account**. In *People and accounts* you can:

- **Name the account.** Give several files the same name (for example monthly exports) to treat them as one account.
- **Mark it shared or individual.** An individual account has an owner, and all of its spending counts as that person's.
- **Assign cards to people.** Card numbers are read from the descriptions (`xxxx 1234`, `Karte Nr. XXXX1234`, `*1234`). On a shared account, card payments count for the card's owner and everything else (rent, bills, standing orders) counts as *Shared*.

The summary shows spending, share and top categories per person. The *Account* and *Person* filters in the toolbar narrow the whole dashboard, compare table and exports. The transaction export includes account, card and person columns. Transfers from a personal account into a shared one land in *Transfers & savings*, which is excluded by default, so money moved between your own accounts isn't counted twice.

The app ships without any data: it starts empty and shows nothing until you add your own files.

## Layout

```
main.go, server.go     static server (embed, allowlist, headers, gzip, ETag, healthz, redirect, shutdown)
server_test.go         server and static front-end checks
web/                   everything that is served
  js/                  ES modules: csv, numbers, dates, detect, categorize, analyze, pipeline, people, budget,
                       recurring, settings (no DOM, unit-tested); app, charts, dom, format (UI)
  assets/              CSS and the Archivo font
test/                  node:test unit tests; fixtures/sample.js generates made-up bank files for tests
tools/e2e.mjs          headless-browser checks (dev only, not shipped)
```
