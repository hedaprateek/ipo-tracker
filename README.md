# IPO Tracker

Open, upcoming and recently closed IPOs (mainboard + SME), category-wise
subscription, live GMP with a trend that builds itself, an apply-or-avoid read
on each live issue, and a place to keep your PANs for allotment checks.

Plain HTML, CSS and JavaScript with no build step and no framework. One small
Node file serves it locally; a scheduled GitHub Action keeps the published copy
fed.

## Use it

**Published site** — https://hedaprateek.github.io/ipo-tracker/ — nothing to
install. A GitHub Action refreshes the data every 30 minutes.

**Locally, with live data on demand:**

```
cd IPO_Tracker
npm install          # only needed for the AI reports
node server.js
```

Then open **http://localhost:8787**. Pass a port if 8787 is taken: `node server.js 9000`.

## What each tab does

**IPOs** — three groups: open now, upcoming, and closed in the last 45 days.
Filter by name or symbol, board, or status; sort by closing date, GMP %,
subscription or name. Click any card for the detail view. Issues that have
already listed show their listing gain and current price in place of GMP.

**GMP & Trend** — every issue with a grey-market premium, sortable on any
column, above a chart comparing the six liveliest issues over time. The chart
plots GMP as a **percentage of issue price**, not rupees: a ₹335 premium on a
₹429 share and a ₹50 premium on an ₹82 share are comparable returns, but on a
rupee axis the cheaper issue is squashed flat. Click a legend name to hide a
series.

**My Applications** — your saved PANs and DP IDs, then one row per recently
closed IPO. Pick the registrar once (it is remembered) and click a name: the ID
is copied and the registrar's page opens.

**IPO detail** (click any card) — headline stats, the apply-or-avoid report,
the figures a decision turns on (issue size, lot size, minimum application,
allotment odds), subscription broken out by category, GMP history, and a
one-click allotment check. Each detail view has its own link — `#ipo=<key>` —
so a specific issue can be bookmarked or shared.

## Subscription by category

NSE publishes bids per investor category while an issue is live. The detail view
charts them against a 1× reference line:

| Category | Who |
|---|---|
| QIB | Institutions. The strongest quality signal. |
| bHNI | Non-institutional, bids above ₹10L |
| sHNI | Non-institutional, bids ₹2L–₹10L |
| Retail | Individual bids up to ₹2L |
| Employee | Reserved employee quota, where one exists |

A category with a **lower** multiple has **better** allotment odds, which is
what the report's category recommendation is built on.

## The apply-or-avoid report

Each open or near-term issue gets a structured read: a verdict (apply / avoid /
neutral) with confidence, a headline, the reasoning, points for and against,
which category gives the best odds, a risk level, and what could change the
call. It is generated from **only** the figures on this page — subscription
multiples, GMP, lot size and issue size. It has no access to the RHP, company
financials or peer valuations, and it says so.

This is an automated reading of public market signals for your own research,
not investment advice.

### Enabling it

Two providers are supported; whichever key is set is used, Gemini first.

| Provider | Secret | Model | Cost |
|---|---|---|---|
| **Google Gemini** | `GEMINI_API_KEY` | `gemini-3.7-flash` | Free tier |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-opus-5` | ~cents/day |

Get a [Gemini key](https://aistudio.google.com/apikey) (free) or an
[Anthropic key](https://console.anthropic.com/), then add it as a repository
secret — Settings → Secrets and variables → Actions → New repository secret.
Locally, export the same variable before running the script. Without a key
everything else still works and the report section says it is not configured.

Optional repository *variables*: `IPO_LLM_PROVIDER` (`gemini` or `anthropic`)
forces one when both keys exist, and `GEMINI_MODEL` overrides the model.

### Keeping it cheap

Each IPO carries a fingerprint of the facts that would change the conclusion —
status, GMP band, subscription bands. If nothing material moved, the stored
report is reused and no request is made, so most of the 48 daily runs call
nothing at all. Only open and near-term issues are covered; closed ones are
skipped because you cannot act on them.

```
node scripts/generate-reports.js --dry-run   # print a prompt, call nothing
node scripts/generate-reports.js --force     # regenerate every report
```

A normal run prints the token count and, on Anthropic, an estimated cost.

## How data reaches the page

NSE and IPO Watch send no `Access-Control-Allow-Origin` header, so the browser
cannot read them directly. The page tries three sources and uses the first that
answers — the mode it picked is shown in the status bar.

| Mode | When | How |
|---|---|---|
| `server` | `node server.js` is running | Proxies both upstreams same-origin, caching 60s (NSE) and 5min (GMP). Always current. |
| `static` | GitHub Pages | Reads `data/*.json` committed by the scheduled Action. Up to 30 minutes stale. |
| `proxy` | `file://`, no server | Public CORS proxies. Usually rate-limited or down; shows a banner saying so. |

The Action is [`.github/workflows/fetch-data.yml`](.github/workflows/fetch-data.yml).
It runs `scripts/fetch-data.js` every 30 minutes, then `scripts/generate-reports.js`,
and commits the result — which is also what accumulates
`data/gmp-history.json`, so the trend on the published site is shared by
everyone rather than rebuilt per browser. If one upstream fails the other still
updates and the old file is left alone. Run it by hand from the Actions tab with
**Run workflow**.

## Layout

```
index.html              markup
styles.css              all styling, both themes
js/charts.js            inline-SVG line and bar charts
js/app.js               fetching, merging, filtering, rendering
lib/sources.js          NSE + IPO Watch parsing, shared by server and Action
lib/net.js              TLS / DNS workarounds
server.js               local static server + same-origin proxy
scripts/fetch-data.js   writes data/*.json
scripts/generate-reports.js   writes data/reports.json
```

`lib/sources.js` is the single place upstream parsing lives, so `server.js` and
the scheduled fetch cannot drift apart.

## Charts

Colours come from a categorical palette validated for colour-vision deficiency
in both themes (adjacent-pair ΔE ≥ 8 in OKLab, contrast checked against the
actual surfaces). Every chart has a table twin — the GMP table carries every
value the comparison chart shows — so no value is reachable only by hovering.

**Time range.** The GMP charts have a range control — 6h, 24h, 3d, 7d, 30d,
All — shared by the GMP tab and the per-IPO chart, and remembered between
visits.

History comes from two places. Each IPO's page on IPO Watch carries a
day-by-day GMP table going back one to two weeks, and `fetch-data.js`
**backfills** from it, so a fresh deploy starts with real history instead of
nothing. On top of that the app records its own reading on every run, which is
hourly rather than daily and keeps accruing past what IPO Watch retains.
Backfilled days never displace a reading the app took itself.

Ranges wider than the history actually held are **disabled**, with the recorded
span shown beside them ("16 days recorded"). Offering a window that redraws the
identical line makes the control look broken when nothing changes, so only
windows that would show something different stay clickable, plus All. If a
window holds fewer than two readings the chart says so and suggests widening,
rather than drawing a misleading flat line.

## After an IPO lists

Grey market premium is a pre-listing guess; once shares trade it is worthless.
Listed issues therefore drop GMP entirely and show what actually happened:

- **Listed at** — closing price on listing day, and the gain against the issue price
- **Trading now** — latest price, and the gain against the issue price
- **Since listing** — whether it held its opening pop
- **One lot today** — what a single lot is now worth against what it cost

Prices come from Yahoo Finance (`SYMBOL.NS`), covering issues listed in the
last 180 days. NSE's own quote endpoint refuses scripted access — it returns
403 even after its cookie handshake — so it is not usable here.

## Honest limitations

**Allotment status cannot be automated.** Every registrar — MUFG Intime, KFin,
Bigshare, Maashitla, Cameo and the rest — puts a CAPTCHA on allotment lookup,
and BSE blocks scripted calls. No web page can check allotment for you. This app
removes the tedious part instead: it stores the IDs, remembers the registrar,
and copies the PAN so the lookup is one click plus one CAPTCHA.

**GMP is not a price.** It is an unofficial premium quoted by grey-market
dealers, thinly traded and easily manipulated. Treat it as sentiment.

**Trend needs time.** The sparklines and charts show only what has been
recorded. They are empty on first run by design — nobody publishes free
historical GMP.

**Category bids are live-only.** NSE publishes them while an issue is open and
briefly after; upcoming issues show nothing until bidding starts.

**Registrar is not auto-detected.** NSE does not publish it in the issue feed,
so you choose it once per IPO.

## Local environment notes

If your machine runs TLS-inspecting security software (Kaspersky, Zscaler,
Netskope), Node rejects every upstream with *"self-signed certificate in
certificate chain"*. Both entry points re-launch themselves with
`--use-system-ca` so they trust the same certificates Windows does — needs Node
22.15+. `npm install` needs the same treatment:

```
NODE_OPTIONS="--use-system-ca" npm install
```

## Your data

PANs, DP IDs, registrar choices, theme and filters live in your browser's
`localStorage`. They are never sent anywhere — not to the server, not to the
repo, not to NSE, IPO Watch or Anthropic — and nothing personal is ever
committed. They stay on whichever device you entered them on.

`data/*.json` is committed on purpose: that is how the published site gets its
data. It contains only public IPO figures and the generated reports.
