/**
 * Inline-SVG charts. No dependencies, no canvas.
 *
 * Two forms only, because the data has two jobs:
 *   lineChart — GMP over time (change over time, one or more series)
 *   barChart  — subscription by category (magnitude across named categories)
 *
 * Colours come from CSS custom properties defined in styles.css, so both
 * themes are handled in one place and the SVG never hardcodes a hex.
 * Every chart here has a table twin elsewhere in the page — tooltips enhance,
 * they never gate access to a value.
 */
(function (global) {
'use strict';

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Nice round tick values covering [lo, hi]. */
function ticks(lo, hi, count) {
  if (hi === lo) { hi = lo + 1; }
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const start = Math.floor(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + step / 2; v += step) {
    if (v >= lo - step / 2) out.push(Number(v.toFixed(10)));
  }
  return out;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-IN');
  return String(Number.isInteger(n) ? n : Number(n.toFixed(2)));
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** Shared floating tooltip, positioned against the chart wrapper. */
function makeTooltip(wrap) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  wrap.appendChild(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const w = wrap.clientWidth;
      const tw = tip.offsetWidth;
      // Keep the tip inside the card rather than letting it spill off-screen.
      tip.style.left = Math.max(4, Math.min(w - tw - 4, x - tw / 2)) + 'px';
      tip.style.top = Math.max(4, y - tip.offsetHeight - 12) + 'px';
    },
    hide() { tip.hidden = true; },
  };
}

// ---------------------------------------------------------------- line chart

/**
 * series: [{ name, color, points: [{t (ms), v}] }]
 * Single series gets no legend — the card title names it. Endpoints are
 * direct-labelled so a value is readable without hovering.
 */
function lineChart(wrap, series, opts) {
  opts = opts || {};
  wrap.textContent = '';
  wrap.classList.add('chart-wrap');

  const live = series.filter((s) => s.points && s.points.length);
  if (!live.length) {
    wrap.innerHTML = '<p class="chart-empty">No history recorded yet. ' +
      'Points are captured each time the data refreshes.</p>';
    return;
  }

  const W = opts.width || wrap.clientWidth || 640;
  const H = opts.height || 200;
  const padL = 44, padR = opts.labelRight === false ? 14 : 58, padT = 12, padB = 26;
  const plotW = Math.max(10, W - padL - padR);
  const plotH = Math.max(10, H - padT - padB);

  const all = live.flatMap((s) => s.points);
  const tLo = Math.min(...all.map((p) => p.t));
  const tHi = Math.max(...all.map((p) => p.t));
  let vLo = Math.min(...all.map((p) => p.v));
  let vHi = Math.max(...all.map((p) => p.v));
  if (vLo === vHi) { vLo = Math.min(0, vLo - 1); vHi = vHi + 1; }
  else { const pad = (vHi - vLo) * 0.12; vLo = Math.max(0, vLo - pad); vHi += pad; }

  const yTicks = ticks(vLo, vHi, 4);
  vLo = Math.min(vLo, yTicks[0]);
  vHi = Math.max(vHi, yTicks[yTicks.length - 1]);

  const X = (t) => padL + (tHi === tLo ? plotW / 2 : ((t - tLo) / (tHi - tLo)) * plotW);
  const Y = (v) => padT + plotH - ((v - vLo) / (vHi - vLo)) * plotH;
  const fv = (v) => (opts.prefix || '') + fmtNum(v) + (opts.suffix || '');

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
    role: 'img', 'aria-label': opts.ariaLabel || 'Line chart',
  }, wrap);

  // Gridlines: solid hairlines, one shade off the surface. Never dashed.
  for (const v of yTicks) {
    el('line', {
      x1: padL, x2: padL + plotW, y1: Y(v), y2: Y(v),
      stroke: 'var(--chart-grid)', 'stroke-width': 1,
    }, svg);
    el('text', {
      x: padL - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-tick',
    }, svg).textContent = fmtNum(v) + (opts.suffix || '');
  }

  el('line', {
    x1: padL, x2: padL + plotW, y1: padT + plotH, y2: padT + plotH,
    stroke: 'var(--chart-axis)', 'stroke-width': 1,
  }, svg);

  // Under two days every tick would print the same date, so switch to clock
  // time; past that the day is what distinguishes them.
  const spanHours = (tHi - tLo) / 36e5;
  const fmtX = spanHours <= 48
    ? (t) => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : fmtDay;

  const xCount = Math.max(2, Math.min(5, Math.floor(plotW / 90)));
  for (let i = 0; i < xCount; i++) {
    const t = tLo + ((tHi - tLo) * i) / (xCount - 1);
    el('text', {
      x: X(t), y: H - 8,
      'text-anchor': i === 0 ? 'start' : i === xCount - 1 ? 'end' : 'middle',
      class: 'chart-tick',
    }, svg).textContent = fmtX(t);
  }

  const endLabels = [];

  live.forEach((s, i) => {
    const pts = [...s.points].sort((a, b) => a.t - b.t);
    const d = pts.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    const color = s.color || `var(--series-${(i % 6) + 1})`;

    if (opts.area && live.length === 1) {
      el('polygon', {
        points: `${X(pts[0].t).toFixed(1)},${padT + plotH} ${d} ${X(pts[pts.length - 1].t).toFixed(1)},${padT + plotH}`,
        fill: color, opacity: 0.10,
      }, svg);
    }

    el('polyline', {
      points: d, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, svg);

    // A single reading has no line to read — show the dot so it is not blank.
    if (pts.length === 1) {
      el('circle', { cx: X(pts[0].t), cy: Y(pts[0].v), r: 4, fill: color }, svg);
    }

    const last = pts[pts.length - 1];
    // 2px surface ring keeps the endpoint legible where series overlap.
    el('circle', {
      cx: X(last.t), cy: Y(last.v), r: 4,
      fill: color, stroke: 'var(--chart-surface)', 'stroke-width': 2,
    }, svg);

    if (opts.labelRight !== false) {
      endLabels.push({
        node: el('text', {
          x: Math.min(W - 4, X(last.t) + 9), y: Y(last.v) + 4,
          class: 'chart-endlabel', fill: color,
        }, svg).appendChild(document.createTextNode(fv(last.v))).parentNode,
        y: Y(last.v) + 4,
      });
    }
  });

  // Series that end at similar values would print their labels on top of each
  // other, so push them apart just enough to stay readable.
  if (endLabels.length > 1) {
    endLabels.sort((a, b) => a.y - b.y);
    const MIN_GAP = 13;
    for (let i = 1; i < endLabels.length; i++) {
      const prev = endLabels[i - 1], cur = endLabels[i];
      if (cur.y - prev.y < MIN_GAP) {
        cur.y = prev.y + MIN_GAP;
        cur.node.setAttribute('y', cur.y);
      }
    }
    // Nudge the whole stack back up if it overran the plot.
    const overflow = endLabels[endLabels.length - 1].y - (padT + plotH + 4);
    if (overflow > 0) {
      for (const l of endLabels) l.node.setAttribute('y', l.y - overflow);
    }
  }

  // ---- hover layer: crosshair + nearest-point tooltip
  const tip = makeTooltip(wrap);
  const rule = el('line', {
    y1: padT, y2: padT + plotH, stroke: 'var(--chart-axis)', 'stroke-width': 1, opacity: 0,
  }, svg);
  const dots = live.map((s, i) => el('circle', {
    r: 4.5, fill: s.color || `var(--series-${(i % 6) + 1})`,
    stroke: 'var(--chart-surface)', 'stroke-width': 2, opacity: 0,
  }, svg));

  const hit = el('rect', {
    x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent',
  }, svg);

  function move(clientX) {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    const t = tLo + ((px - padL) / plotW) * (tHi - tLo);

    rule.setAttribute('x1', X(t));
    rule.setAttribute('x2', X(t));
    rule.setAttribute('opacity', 0.5);

    const rows = [];
    live.forEach((s, i) => {
      let best = null;
      for (const p of s.points) {
        if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      }
      if (!best) { dots[i].setAttribute('opacity', 0); return; }
      dots[i].setAttribute('cx', X(best.t));
      dots[i].setAttribute('cy', Y(best.v));
      dots[i].setAttribute('opacity', 1);
      rows.push(
        `<div class="tip-row"><span class="tip-swatch" style="background:${
          s.color || `var(--series-${(i % 6) + 1})`
        }"></span>${live.length > 1 ? `<span class="tip-name">${s.name}</span>` : ''}` +
        `<b>${fv(best.v)}</b></div>`
      );
      if (live.length === 1) rows.unshift(`<div class="tip-head">${fmtTime(best.t)}</div>`);
    });

    if (live.length > 1) rows.unshift(`<div class="tip-head">${fmtTime(t)}</div>`);
    tip.show(rows.join(''), (X(t) / W) * wrap.clientWidth, (padT + plotH / 3) * (wrap.clientHeight / H));
  }

  hit.addEventListener('mousemove', (e) => move(e.clientX));
  hit.addEventListener('mouseleave', () => {
    tip.hide();
    rule.setAttribute('opacity', 0);
    dots.forEach((d) => d.setAttribute('opacity', 0));
  });
  hit.addEventListener('touchmove', (e) => {
    if (e.touches[0]) move(e.touches[0].clientX);
  }, { passive: true });
}

// ----------------------------------------------------------------- bar chart

/**
 * rows: [{ label, value, note }]
 * One series, one colour — bar length already encodes magnitude, so hue is
 * not spent on it. `reference` draws a labelled rule (used for 1x subscribed).
 */
function barChart(wrap, rows, opts) {
  opts = opts || {};
  wrap.textContent = '';
  wrap.classList.add('chart-wrap');

  if (!rows.length) {
    wrap.innerHTML = '<p class="chart-empty">' +
      (opts.emptyText || 'No category data published yet.') + '</p>';
    return;
  }

  const maxValue = Math.max(...rows.map((r) => r.value), 0);
  // A 1x line is only worth drawing while it still sits inside the plot. Once
  // an issue is 300x subscribed it collapses onto the axis and its label lands
  // on top of the first bar, so drop it and let the numbers speak.
  const refVisible = !!opts.reference && opts.reference >= maxValue * 0.04;

  const rowH = 30, gap = 2, padL = opts.labelWidth || 140, padR = 56;
  const padT = refVisible ? 18 : 6;
  const padB = 22;
  const W = opts.width || wrap.clientWidth || 560;
  const H = padT + rows.length * rowH + padB;
  const plotW = Math.max(10, W - padL - padR);

  const maxV = Math.max(maxValue, refVisible ? opts.reference : 0);
  const xTicks = ticks(0, maxV, 4);
  const hi = Math.max(maxV, xTicks[xTicks.length - 1]);
  const X = (v) => padL + (v / hi) * plotW;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
    role: 'img', 'aria-label': opts.ariaLabel || 'Bar chart',
  }, wrap);

  for (const v of xTicks) {
    el('line', {
      x1: X(v), x2: X(v), y1: padT, y2: padT + rows.length * rowH,
      stroke: 'var(--chart-grid)', 'stroke-width': 1,
    }, svg);
    el('text', {
      x: X(v), y: H - 6, 'text-anchor': 'middle', class: 'chart-tick',
    }, svg).textContent = fmtNum(v) + (opts.suffix || '');
  }

  const tip = makeTooltip(wrap);

  rows.forEach((r, i) => {
    const y = padT + i * rowH;
    const barH = rowH - gap * 2 - 6;
    const w = Math.max(2, X(r.value) - padL);

    el('text', {
      x: padL - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'chart-catlabel',
    }, svg).textContent = r.label;

    // 4px rounded data-end, anchored flat against the baseline.
    el('rect', {
      x: padL, y: y + gap + 3, width: w, height: barH,
      rx: Math.min(4, w / 2), fill: r.color || 'var(--series-1)',
    }, svg);

    // Value always visible outside the bar end — never only in the tooltip.
    el('text', {
      x: Math.min(W - 4, padL + w + 8), y: y + rowH / 2 + 4, class: 'chart-value',
    }, svg).textContent = fmtNum(r.value) + (opts.suffix || '');

    const hit = el('rect', {
      x: 0, y, width: W, height: rowH, fill: 'transparent',
    }, svg);
    hit.addEventListener('mouseenter', () => {
      tip.show(
        `<div class="tip-head">${r.label}</div><div class="tip-row"><b>${
          fmtNum(r.value)}${opts.suffix || ''}</b></div>` +
        (r.note ? `<div class="tip-note">${r.note}</div>` : ''),
        (padL + w / 2) / W * wrap.clientWidth,
        (y + rowH / 2) * (wrap.clientHeight / H)
      );
    });
    hit.addEventListener('mouseleave', () => tip.hide());
  });

  if (refVisible) {
    const x = X(opts.reference);
    el('line', {
      x1: x, x2: x, y1: padT - 4, y2: padT + rows.length * rowH,
      stroke: 'var(--chart-ref)', 'stroke-width': 1.5,
    }, svg);
    // Label sits in the padding above the bars, never over the first row.
    // Flip it left of the line when the line is near the right edge.
    const nearRight = x > W - 130;
    el('text', {
      x: nearRight ? x - 5 : x + 5, y: padT - 8,
      'text-anchor': nearRight ? 'end' : 'start',
      class: 'chart-reflabel',
    }, svg).textContent = opts.referenceLabel || 'fully subscribed';
  }
}

// ------------------------------------------------------------- scatter chart

/**
 * points: [{ x, y, name }] — one dot per IPO, predicted against actual.
 *
 * The third form, because the question is a third shape: not change over time
 * and not magnitude across categories, but whether two numbers agree. Both
 * axes share one domain so the y=x reference sits at a true 45° and distance
 * from it reads directly as error — squeezing the axes independently would
 * make a badly calibrated forecast look well behaved.
 */
function scatterChart(wrap, points, opts) {
  opts = opts || {};
  wrap.textContent = '';
  wrap.classList.add('chart-wrap');

  const live = (points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!live.length) {
    wrap.innerHTML = '<p class="chart-empty">Nothing graded yet.</p>';
    return;
  }

  const W = opts.width || wrap.clientWidth || 640;
  const H = opts.height || 260;
  const padL = 44, padR = 14, padT = 12, padB = 34;
  const plotW = Math.max(10, W - padL - padR);
  const plotH = Math.max(10, H - padT - padB);

  // One domain for both axes, always including zero so the sign of a miss is
  // visible rather than cropped away.
  const vals = live.flatMap((p) => [p.x, p.y]).concat(0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || 1;
  lo -= pad; hi += pad;

  const tk = ticks(lo, hi, 4);
  lo = Math.min(lo, tk[0]);
  hi = Math.max(hi, tk[tk.length - 1]);

  const X = (v) => padL + ((v - lo) / (hi - lo)) * plotW;
  const Y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
  const fv = (v) => fmtNum(Number(v.toFixed(1))) + (opts.suffix || '');

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
    role: 'img', 'aria-label': opts.ariaLabel || 'Scatter chart',
  }, wrap);

  for (const v of tk) {
    el('line', {
      x1: padL, x2: padL + plotW, y1: Y(v), y2: Y(v),
      stroke: 'var(--chart-grid)', 'stroke-width': 1,
    }, svg);
    el('text', {
      x: padL - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-tick',
    }, svg).textContent = fmtNum(v) + (opts.suffix || '');
    el('text', {
      x: X(v), y: H - 14, 'text-anchor': 'middle', class: 'chart-tick',
    }, svg).textContent = fmtNum(v) + (opts.suffix || '');
  }

  // y = x: every dot on this line is a premium that called the gain exactly.
  el('line', {
    x1: X(lo), y1: Y(lo), x2: X(hi), y2: Y(hi),
    stroke: 'var(--chart-ref)', 'stroke-width': 1.5,
  }, svg);
  // Parked in the lower-right triangle: a dot lands there only when the premium
  // badly overstated a gain, which is the sparse corner. The line's own end is
  // where the extremes sit, so a label there collides with them.
  el('text', {
    x: X(lo + (hi - lo) * 0.78), y: Y(lo + (hi - lo) * 0.28),
    'text-anchor': 'middle', class: 'chart-reflabel',
  }, svg).textContent = opts.referenceLabel || 'GMP exactly right';

  el('text', {
    x: padL + plotW / 2, y: H - 2, 'text-anchor': 'middle', class: 'chart-axislabel',
  }, svg).textContent = opts.xLabel || 'predicted';
  el('text', {
    x: 10, y: padT + plotH / 2, 'text-anchor': 'middle', class: 'chart-axislabel',
    transform: `rotate(-90 10 ${padT + plotH / 2})`,
  }, svg).textContent = opts.yLabel || 'actual';

  const tip = makeTooltip(wrap);

  // One hue for every dot. Whether an issue beat its premium is already written
  // in which side of the reference line it sits on, so spending colour on the
  // same fact would double-encode it — and the obvious green/red pair is the
  // one deuteranopes cannot separate (ΔE 4.1).
  const color = opts.color || 'var(--series-1)';
  for (const p of live) {
    el('circle', {
      cx: X(p.x), cy: Y(p.y), r: 4.5, fill: color,
      stroke: 'var(--chart-surface)', 'stroke-width': 2, opacity: 0.9,
    }, svg);
  }

  // Nearest-point layer rather than per-dot handlers: a 9px target is one you
  // have to hit dead-centre, and dots overlap where issues priced alike.
  const ring = el('circle', {
    r: 8, fill: 'none', stroke: color, 'stroke-width': 2, opacity: 0,
  }, svg);
  const hit = el('rect', {
    x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent',
  }, svg);

  function move(clientX, clientY) {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    const py = ((clientY - box.top) / box.height) * H;

    let best = null, bestD = Infinity;
    for (const p of live) {
      const d = (X(p.x) - px) ** 2 + (Y(p.y) - py) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return;

    ring.setAttribute('cx', X(best.x));
    ring.setAttribute('cy', Y(best.y));
    ring.setAttribute('opacity', 1);

    const beat = best.y >= best.x;
    tip.show(
      `<div class="tip-head">${best.name || ''}</div>` +
      `<div class="tip-row"><span class="tip-name">${opts.xLabel || 'predicted'}</span><b>${fv(best.x)}</b></div>` +
      `<div class="tip-row"><span class="tip-name">${opts.yLabel || 'actual'}</span><b>${fv(best.y)}</b></div>` +
      `<div class="tip-note">${beat ? 'beat' : 'fell short of'} the premium by ${fv(Math.abs(best.y - best.x))}</div>`,
      (X(best.x) / W) * wrap.clientWidth,
      Y(best.y) * (wrap.clientHeight / H)
    );
  }

  hit.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  hit.addEventListener('mouseleave', () => {
    tip.hide();
    ring.setAttribute('opacity', 0);
  });
  hit.addEventListener('touchmove', (e) => {
    if (e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
}

global.Charts = { lineChart, barChart, scatterChart, ticks, fmtNum };

})(window);
