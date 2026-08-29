#!/usr/bin/env node
/**
 * Generate a structured apply / avoid read for each actionable IPO.
 *
 * Runs after fetch-data.js and writes data/reports.json. Only open and
 * near-term upcoming issues get a report — you cannot act on a closed one.
 *
 * Cost control: each IPO carries a fingerprint of the facts that would change
 * the conclusion (status, GMP band, subscription bands). If the fingerprint is
 * unchanged, the stored report is reused and no request is made. Day-to-day
 * noise — an extra 0.2x of subscription, a ₹2 GMP tick — does not trigger a
 * regeneration, so a typical run costs nothing at all.
 *
 * Provider is chosen from whichever key is set — GEMINI_API_KEY (free tier) or
 * ANTHROPIC_API_KEY — see lib/llm.js. With neither, this exits 0 and leaves any
 * existing reports alone, so the data pipeline still works without a key.
 *
 *   node scripts/generate-reports.js
 *   node scripts/generate-reports.js --force      # ignore fingerprints
 *   node scripts/generate-reports.js --dry-run    # print a prompt, call nothing
 */

const { relaunchWithSystemCa, preferIpv4 } = require('../lib/net');
if (relaunchWithSystemCa(__filename)) return;
preferIpv4();

const fs = require('fs');
const path = require('path');
const { nameKey } = require('../lib/sources');
const llm = require('../lib/llm');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const now = new Date().toISOString();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 1), 'utf8');
}

/**
 * Reported financials, keyed the same way as everything else. Optional: the
 * file only exists once scripts/fetch-data.js has found a prospectus summary
 * for an issue, and a report is still worth writing without it.
 */
const fundamentals = readJson('fundamentals.json', {});

// ------------------------------------------------------------------ schema

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict', 'confidence', 'headline', 'rationale',
    'forPoints', 'againstPoints', 'categoryAdvice', 'riskLevel', 'watchFor',
  ],
  properties: {
    verdict: {
      type: 'string',
      enum: ['apply', 'avoid', 'neutral'],
      description:
        "'apply' if the signals favour applying, 'avoid' if they do not, " +
        "'neutral' when the evidence is genuinely mixed or too thin to lean either way.",
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description:
        'How much the available data supports the verdict. Use low when GMP is absent ' +
        'or the issue has not opened and there is little to go on.',
    },
    headline: {
      type: 'string',
      description: 'One sentence stating the call and its single strongest reason. Max 140 characters.',
    },
    rationale: {
      type: 'string',
      description:
        'Two to four sentences explaining the verdict, citing the actual numbers supplied ' +
        '(subscription multiples, GMP, implied listing gain). No preamble.',
    },
    forPoints: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string' },
      description: 'Concrete reasons in favour of applying, each grounded in the supplied data.',
    },
    againstPoints: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string' },
      description:
        'Concrete reasons against, or genuine risks. Never leave this empty — ' +
        'every IPO carries risk, and listing-gain estimates from GMP are unreliable.',
    },
    categoryAdvice: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'reason'],
      properties: {
        category: {
          type: 'string',
          enum: ['retail', 'shni', 'bhni', 'none'],
          description:
            "Which application category gives the best odds. 'none' when the verdict is " +
            "avoid, or when there is no basis to prefer one category.",
        },
        reason: {
          type: 'string',
          description:
            'Why that category, in terms of the relative subscription multiples supplied. ' +
            'A less-subscribed category has better allotment odds.',
        },
      },
    },
    riskLevel: { type: 'string', enum: ['low', 'moderate', 'high'] },
    watchFor: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string' },
      description: 'What could change this call before the issue closes.',
    },
  },
};

const SYSTEM = `You are an equity markets analyst writing short, structured reads on Indian IPOs \
for a retail investor's personal dashboard.

Ground rules:
- Use ONLY the data supplied in the message. Where a "Reported fundamentals" block is present, \
those figures are all you know about the business; where it is absent, you know nothing about \
the business at all. Never invent revenue, profit, P/E, promoter details or sector commentary \
you were not given.
- The profit figures arrive WITHOUT a sign, so a loss is indistinguishable from a profit by its \
number alone. Each period states whether expenses exceeded revenue — that, not the magnitude, \
tells you the direction. Never describe a company as profitable when its expenses exceeded \
revenue, however large the profit figure looks.
- Where fundamentals are given, weigh them against the sentiment. A rich P/E next to loss-making \
peers, or a heavy debt-to-equity, is a reason to be cautious even when the premium is fat; solid \
returns on a modest multiple can justify applying even when the premium is thin. Say which of the \
two is driving your call.
- When the data is thin — an issue that has not opened, no GMP, no subscription figures — say so \
plainly, set confidence to low, and lean 'neutral' rather than manufacturing a view.
- Grey market premium is an unofficial, thinly traded, easily manipulated indicator. Treat it as \
sentiment, never as a forecast, and say so when it is the main thing driving the call.
- Subscription multiples are the most reliable signal you have. QIB demand is the strongest \
quality signal; a category with a LOWER multiple has BETTER allotment odds for the applicant.
- Retail applies up to ₹2L, sHNI ₹2L-₹10L, bHNI above ₹10L. Only recommend sHNI or bHNI when the \
figures actually justify the larger cheque; retail is the default for most investors.
- Be direct. If the signals are weak, say avoid and explain why. Do not hedge everything into mush.
- This is an automated read of public market signals for one person's own use. It is not \
personalised investment advice, and the dashboard already tells the reader that — so do not \
spend output on disclaimers. Spend it on the numbers.`;

// -------------------------------------------------------------- selection

/** Coarse bands so ordinary drift does not trigger a paid regeneration. */
function band(value, edges) {
  if (value === null || value === undefined) return 'na';
  for (let i = 0; i < edges.length; i++) if (value < edges[i]) return String(i);
  return String(edges.length);
}

const SUB_EDGES = [0.5, 1, 2, 5, 10, 25, 50, 100];

function fingerprint(ipo) {
  const gmpPct = ipo.gmp !== null && ipo.price ? (ipo.gmp / ipo.price) * 100 : null;
  return [
    ipo.status,
    'g' + band(gmpPct, [0.5, 5, 12, 25, 45, 70, 100]),
    's' + band(ipo.subscription, SUB_EDGES),
    ...(ipo.categories || []).map((c) => c.key + band(c.times, SUB_EDGES)),
  ].join('|');
}

function classify(ipo, today) {
  if (ipo.start && today < ipo.start) return 'upcoming';
  if (ipo.end && today > ipo.end) return 'closed';
  return 'open';
}

/** Join the NSE row to its GMP row the same way the page does. */
function withGmp(ipos, gmpRows) {
  const byKey = new Map();
  for (const g of gmpRows) if (g.key) byKey.set(g.key, g);

  return ipos.map((ipo) => {
    const key = nameKey(ipo.company);
    let g = byKey.get(key) || null;
    if (!g) {
      for (const [k, row] of byKey) {
        if (key && (key.startsWith(k) || k.startsWith(key))) {
          if (!g || k.length > g.key.length) g = row;
        }
      }
    }
    return {
      ...ipo,
      key,
      gmp: g?.gmp ?? null,
      price: g?.price ?? null,
      estGainPct: g?.estGainPct ?? null,
      gmpTrend: g?.trend ?? null,
    };
  });
}

/** Cap price of the band, the price an applicant actually bids at. */
function capPrice(ipo) {
  if (ipo.price) return ipo.price;
  const nums = String(ipo.priceBand || '').replace(/,/g, '').match(/\d+(\.\d+)?/g);
  return nums?.length ? Math.max(...nums.map(Number)) : null;
}

function inr(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} crore`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} lakh`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function describe(ipo, history) {
  const lines = [
    `Company: ${ipo.company}`,
    `Board: ${ipo.board}${ipo.symbol ? ` (NSE symbol ${ipo.symbol})` : ''}`,
    `Status: ${ipo.status}`,
    `Issue window: ${ipo.start || 'unknown'} to ${ipo.end || 'unknown'}`,
    `Price band: ${ipo.priceBand || 'not announced'}`,
  ];

  const cap = capPrice(ipo);
  const lot = ipo.info?.lotSize || null;

  if (ipo.issueSize) {
    const shares = Number(ipo.issueSize);
    const size = cap ? ` (about ${inr(shares * cap)} at the ₹${cap} cap price)` : '';
    lines.push(`Total issue size: ${shares.toLocaleString('en-IN')} shares${size}`);
  }

  if (lot) {
    const min = cap ? ` = ${inr(lot * cap)} minimum application` : '';
    lines.push(`Lot size: ${lot} shares${min}`);
  }
  if (ipo.info?.faceValue) lines.push(`Face value: ₹${ipo.info.faceValue}`);
  if (ipo.info?.issueType) lines.push(`Issue type: ${ipo.info.issueType}`);

  // Retail allotment is a lottery once the category is oversubscribed, so the
  // multiple is directly the odds of getting a single lot.
  const retail = (ipo.categories || []).find((c) => c.key === 'retail');
  if (retail && retail.times > 1) {
    lines.push(
      `Retail allotment odds: roughly 1 in ${retail.times.toFixed(1)} applications ` +
      `get a lot, since retail is ${retail.times.toFixed(2)}x subscribed`
    );
  }

  if (lot && ipo.gmp !== null && ipo.gmp !== undefined) {
    lines.push(`Gain on one lot at the current GMP: ${inr(lot * ipo.gmp)}`);
  }

  if (ipo.gmp !== null) {
    const pct = ipo.price ? ` (${((ipo.gmp / ipo.price) * 100).toFixed(1)}% of the ₹${ipo.price} cap price)` : '';
    lines.push(`Grey market premium: ₹${ipo.gmp}${pct}, trend ${ipo.gmpTrend || 'unknown'}`);
    if (ipo.estGainPct !== null) lines.push(`Implied listing gain from GMP: ${ipo.estGainPct}%`);
  } else {
    lines.push('Grey market premium: none quoted');
  }

  const points = history[ipo.key]?.points || [];
  if (points.length >= 3) {
    const recent = points.slice(-8).map((p) => p.gmp);
    lines.push(
      `GMP over the last ${recent.length} readings (oldest first): ${recent.join(', ')}`
    );
  }

  // A 0.00x on an issue that has not opened is an absence of data, not weak
  // demand, and reads as the latter if passed through unqualified.
  if (ipo.status === 'upcoming') {
    lines.push('Overall subscription: bidding has not opened yet');
  } else if (ipo.subscription !== null && ipo.subscription !== undefined) {
    lines.push(`Overall subscription: ${ipo.subscription.toFixed(2)}x`);
  }

  if (ipo.categories?.length) {
    lines.push('Category-wise subscription:');
    for (const c of ipo.categories) {
      lines.push(`  - ${c.label}: ${c.times.toFixed(2)}x`);
    }
  } else if (ipo.status === 'open') {
    lines.push('Category-wise subscription: not published yet');
  }

  // Everything above is demand and sentiment. What follows is what the company
  // reports, which is the half a premium cannot tell you.
  const f = fundamentals[ipo.key];
  if (f) {
    const k = f.kpis || {};
    lines.push('', 'Reported fundamentals (from the prospectus):');

    const fin = (f.financials || []).filter((x) => x.revenue !== null);
    for (const x of fin) {
      // The source strips the minus sign from a loss, so profit is passed as a
      // magnitude with the direction stated separately. Left unqualified, a
      // loss-making year reads to the model as a strong profit.
      lines.push(
        `  - ${x.period}: revenue ₹${x.revenue} cr, expenses ₹${x.expense ?? '?'} cr, ` +
        `profit magnitude ₹${x.pat ?? '?'} cr (sign not published; ` +
        `${x.spentMore ? 'expenses EXCEEDED revenue this period, so treat it as a loss' : 'revenue exceeded expenses'})`
      );
    }

    const kv = [
      ['Return on net worth', k.ronw, '%'],
      ['Return on equity', k.roe, '%'],
      ['Return on capital employed', k.roce, '%'],
      ['EBITDA margin', k.ebitdaMargin, '%'],
      ['PAT margin', k.patMargin, '%'],
      ['Debt to equity', k.debtEquity, ''],
      ['Earnings per share', k.eps, ' rupees'],
    ].filter(([, v]) => v !== null && v !== undefined);
    for (const [label, v, unit] of kv) lines.push(`  - ${label}: ${v}${unit}`);

    const cap2 = capPrice(ipo);
    if (cap2 && k.eps > 0) {
      lines.push(`  - P/E at the ₹${cap2} cap price: ${(cap2 / k.eps).toFixed(1)}x`);
    }

    if (f.peers?.length) {
      lines.push('  Listed peers (a negative P/E means the peer is loss-making):');
      for (const p of f.peers) {
        lines.push(`    - ${p.company}: P/E ${p.pe ?? '?'}, RoNW ${p.ronw ?? '?'}%, EPS ${p.eps ?? '?'}`);
      }
    }
  }

  return lines.join('\n');
}

// ------------------------------------------------------------------- main

(async () => {
  const iposFile = readJson('ipos.json', null);
  const gmpFile = readJson('gmp.json', null);
  const history = readJson('gmp-history.json', {});
  const existing = readJson('reports.json', { reports: {} });

  if (!iposFile?.ipos?.length) {
    console.error('no ipos.json — run scripts/fetch-data.js first');
    process.exit(1);
  }

  const today = now.slice(0, 10);
  const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

  const merged = withGmp(iposFile.ipos, gmpFile?.gmp || [])
    .map((r) => ({ ...r, status: classify(r, today) }))
    .filter((r) => r.status === 'open' || (r.status === 'upcoming' && r.start && r.start <= horizon));

  console.log(`${merged.length} actionable IPOs (open or opening within 14 days)`);

  const reports = { ...(existing.reports || {}) };
  const stale = merged.filter((r) => FORCE || reports[r.key]?.fingerprint !== fingerprint(r));

  // Drop reports for issues that are no longer actionable.
  const live = new Set(merged.map((r) => r.key));
  for (const key of Object.keys(reports)) if (!live.has(key)) delete reports[key];

  const provider = llm.pickProvider();
  const label = provider ? llm.describeProvider(provider) : null;

  const finish = () =>
    writeJson('reports.json', {
      ok: true, updatedAt: now, provider: provider || null, model: label, reports,
    });

  if (!stale.length) {
    console.log('every report is current — no API calls needed');
    return finish();
  }

  console.log(`${stale.length} need regenerating: ${stale.map((r) => r.symbol || r.name).join(', ')}`);

  if (DRY_RUN) {
    console.log(`\n--- prompt for ${stale[0].symbol || stale[0].company} ---\n`);
    console.log(describe(stale[0], history));
    console.log('\n--- no request made (--dry-run) ---');
    return;
  }

  if (!provider) {
    console.log('\nNo model API key set — skipping report generation.');
    console.log('Set GEMINI_API_KEY (free tier) or ANTHROPIC_API_KEY to enable the');
    console.log('apply/avoid reads. Everything else still publishes without one.');
    return finish();
  }

  console.log(`using ${label}\n`);

  let generated = 0;
  const spent = { input: 0, output: 0 };

  for (const ipo of stale) {
    try {
      const result = await llm.complete(provider, {
        system: SYSTEM,
        schema: REPORT_SCHEMA,
        prompt: `Assess this IPO and decide whether it is worth applying to.\n\n${describe(ipo, history)}`,
      });

      reports[ipo.key] = {
        name: ipo.company,
        symbol: ipo.symbol || null,
        fingerprint: fingerprint(ipo),
        generatedAt: now,
        model: result.model,
        report: result.data,
      };

      spent.input += result.usage.input;
      spent.output += result.usage.output;
      generated++;
      console.log(`  ${ipo.symbol || ipo.name}: ${result.data.verdict}`);
    } catch (err) {
      if (err instanceof llm.FatalLlmError) {
        console.error(`\n${err.message}`);
        console.error('stopping — the next run picks up where this left off.');
        break;
      }
      console.error(`  ${ipo.symbol || ipo.name}: ${err.message}`);
    }
  }

  finish();

  const cost = llm.estimateCost(provider, spent);
  const money = provider === 'gemini' ? 'free tier' : `~$${cost.toFixed(3)}`;
  console.log(
    `\ngenerated ${generated} report(s) · ${spent.input} in / ${spent.output} out tokens · ${money}`
  );
})();
