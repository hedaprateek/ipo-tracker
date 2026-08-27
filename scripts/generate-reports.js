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
 * Without ANTHROPIC_API_KEY this exits 0 and leaves any existing reports alone,
 * so the data pipeline still works for anyone without a key.
 *
 *   node scripts/generate-reports.js
 *   node scripts/generate-reports.js --force    # ignore fingerprints
 */

const { relaunchWithSystemCa, preferIpv4 } = require('../lib/net');
if (relaunchWithSystemCa(__filename)) return;
preferIpv4();

const fs = require('fs');
const path = require('path');
const { nameKey } = require('../lib/sources');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MODEL = 'claude-opus-5';
const FORCE = process.argv.includes('--force');
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
- Use ONLY the data supplied in the message. You have no other information about the company: \
no financials, no RHP, no peer valuations. Never invent revenue, profit, P/E, promoter details \
or sector commentary you were not given.
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

function describe(ipo, history) {
  const lines = [
    `Company: ${ipo.company}`,
    `Board: ${ipo.board}${ipo.symbol ? ` (NSE symbol ${ipo.symbol})` : ''}`,
    `Status: ${ipo.status}`,
    `Issue window: ${ipo.start || 'unknown'} to ${ipo.end || 'unknown'}`,
    `Price band: ${ipo.priceBand || 'not announced'}`,
  ];

  if (ipo.issueSize) lines.push(`Shares offered: ${Number(ipo.issueSize).toLocaleString('en-IN')}`);

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

  if (ipo.subscription !== null && ipo.subscription !== undefined) {
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

  if (!stale.length) {
    console.log('every report is current — no API calls needed');
    writeJson('reports.json', { ok: true, updatedAt: now, model: MODEL, reports });
    return;
  }

  console.log(`${stale.length} need regenerating: ${stale.map((r) => r.symbol || r.name).join(', ')}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\nANTHROPIC_API_KEY is not set — skipping report generation.');
    console.log('Add it as a repository secret to enable the apply/avoid reads.');
    writeJson('reports.json', { ok: true, updatedAt: now, model: MODEL, reports });
    return;
  }

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    console.error('@anthropic-ai/sdk is not installed — run: npm install');
    process.exit(1);
  }

  const client = new Anthropic();
  let generated = 0;
  let spent = { input: 0, output: 0 };

  for (const ipo of stale) {
    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { format: { type: 'json_schema', schema: REPORT_SCHEMA } },
        messages: [
          {
            role: 'user',
            content:
              `Assess this IPO and decide whether it is worth applying to.\n\n${describe(ipo, history)}`,
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        console.warn(`  ${ipo.symbol || ipo.name}: declined (${response.stop_details?.category})`);
        continue;
      }

      const text = response.content.find((b) => b.type === 'text')?.text;
      if (!text) {
        console.warn(`  ${ipo.symbol || ipo.name}: no text block in response`);
        continue;
      }

      reports[ipo.key] = {
        name: ipo.company,
        symbol: ipo.symbol || null,
        fingerprint: fingerprint(ipo),
        generatedAt: now,
        model: response.model,
        report: JSON.parse(text),
      };

      spent.input += response.usage.input_tokens || 0;
      spent.output += response.usage.output_tokens || 0;
      generated++;
      console.log(`  ${ipo.symbol || ipo.name}: ${reports[ipo.key].report.verdict}`);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error('ANTHROPIC_API_KEY is invalid — stopping.');
        break;
      }
      if (err instanceof Anthropic.RateLimitError) {
        console.error('rate limited — stopping, the next run will pick up the rest.');
        break;
      }
      console.error(`  ${ipo.symbol || ipo.name}: ${err.message}`);
    }
  }

  writeJson('reports.json', { ok: true, updatedAt: now, model: MODEL, reports });

  const cost = (spent.input * 5 + spent.output * 25) / 1e6;
  console.log(
    `\ngenerated ${generated} report(s) · ${spent.input} in / ${spent.output} out tokens · ~$${cost.toFixed(3)}`
  );
})();
