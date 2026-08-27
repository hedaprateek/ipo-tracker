# IPO Tracker

Open, upcoming and recently closed IPOs (mainboard + SME), live GMP with a
trend that builds itself, and a place to keep your PANs for allotment checks.

Plain HTML and one small Node file. No build step, no dependencies, no accounts.

## Use it

**Published site** — https://hedaprateek.github.io/ipo-tracker/ — nothing to
install. A GitHub Action refreshes the data every 30 minutes.

**Locally, with live data on demand:**

```
cd IPO_Tracker
node server.js
```

Then open **http://localhost:8787**. Pass a port if 8787 is taken: `node server.js 9000`.

You can also double-click `index.html`, but that has no data source and falls
back to public CORS proxies that are usually down — see
[How data reaches the page](#how-data-reaches-the-page).

## What each tab does

**IPOs** — three groups: open now, upcoming, and closed in the last 45 days.
Each card shows the dates, price band, live subscription multiple from NSE,
current GMP and the estimated listing gain. Filter by name, or narrow to
Mainboard / SME.

**GMP & Trend** — every IPO with a grey-market premium, sortable on any column.
The *Change* column and the sparkline come from snapshots this app records
itself, so they read "collecting…" on day one and fill in as you keep using it.
Leave *Auto-refresh* on during an issue window to build a denser trend.

**My Applications** — your saved PANs and DP IDs, then one row per recently
closed IPO. Pick the registrar once (it is remembered for that IPO) and click a
name: the ID is copied to your clipboard and the registrar's page opens, so you
only solve the CAPTCHA and paste.

## Where the data comes from

| What | Source | Notes |
|---|---|---|
| Issue calendar, price band, subscription | NSE public APIs | Official. Subscription updates through the day. |
| GMP, estimated listing gain, SME issues | ipowatch.in | Unofficial grey-market quotes. |
| GMP history | this app | Written to `data/gmp-history.json`, one point per IPO per hour. |

## Honest limitations

**Allotment status cannot be automated.** Every registrar — MUFG Intime, KFin,
Bigshare, Maashitla, Cameo and the rest — puts a CAPTCHA on allotment lookup,
and BSE blocks scripted calls. No web page can check allotment for you, and any
site claiming otherwise is making you re-enter the CAPTCHA anyway. This app
removes the tedious part instead: it stores the IDs, picks the registrar, and
copies the PAN so the lookup is one click plus one CAPTCHA.

**GMP is not a price.** It is an unofficial premium quoted by grey-market
dealers, it is thinly traded, and it moves fast near listing. Treat it as
sentiment, not as a forecast.

**Trend needs time.** The sparkline shows only what this app has recorded. It is
empty on first run by design — nobody publishes free historical GMP.

**Registrar is not auto-detected.** NSE does not publish it in the issue feed,
so you choose it once per IPO from the dropdown.

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
It runs `scripts/fetch-data.js` every 30 minutes and commits the result, which is
also what accumulates `data/gmp-history.json` — so the trend on the published
site is shared by everyone rather than rebuilt per browser. If only one upstream
fails, the other still updates and the old file is left alone. Run it by hand
from the Actions tab with **Run workflow**.

Both `server.js` and the fetch script share [`lib/sources.js`](lib/sources.js),
so there is one place where the parsing lives.

If your machine runs TLS-inspecting security software (Kaspersky, Zscaler,
Netskope), Node would normally reject every upstream with *"self-signed
certificate in certificate chain"*. Both entry points re-launch themselves with
`--use-system-ca` so they trust the same certificates Windows does. Needs Node
22.15+ locally — check with `node --version`.

## Your data

PANs, DP IDs and registrar choices live in your browser's `localStorage`. They
are never sent anywhere — not to the server, not to the repo, not to NSE or IPO
Watch, and nothing personal is ever committed. They stay on whichever device you
entered them on, and clearing site data removes them.

`data/*.json` is committed on purpose — that is how the published site gets its
data. It contains only public IPO and GMP figures.
