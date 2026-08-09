'use strict';

// Two single-series charts (see dataviz skill's "Categorical or ordinal?" --
// nominal categorical, one series, same slot-1 hue throughout, no legend
// box needed). Colors are sQUIZit's own brand orange, not the skill's
// generic reference palette, validated against this app's actual card
// surfaces via scripts/validate_palette.js before use:
//   light #F07824 vs surface #FFFFFF -> contrast WARN (2.83, below 3:1) --
//     relief required, satisfied here by ALWAYS-visible value labels (not
//     hover-only), never relying on the fill color alone to carry a value.
//   dark #C85E12 vs surface #211810  -> all checks pass (this hex is
//     sQUIZit's own light-mode --color-primary-dark token, reused here as a
//     fixed dark-mode chart color -- it happens to already sit in the
//     dark-mode categorical lightness band, unlike the dark theme's own UI
//     accent #FF9640, which is too light for a chart mark).
function chartMarkColor() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? '#C85E12' : '#F07824';
}
function chartSurfaceColor() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? '#211810' : '#FFFFFF';
}

let selectedStudentKey = null; // `${studentDigitalId}::${subject}` -- which roster row the line chart shows

function esc(str) { return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Called from renderRoster() in instructor.html with the current
// post-filter roster slice -- both charts re-render against that same
// slice, so the numbers always agree with the list below them.
function renderCharts(visibleRoster) {
  const withData = visibleRoster.filter((r) => r.hasData);
  renderComparisonChart(withData);

  // Keep the previously-selected student's line chart if they're still in
  // the filtered set; otherwise fall back to the top scorer, or nothing.
  const stillVisible = withData.find((r) => rosterKey(r) === selectedStudentKey);
  const toShow = stillVisible || withData[0] || null;
  selectedStudentKey = toShow ? rosterKey(toShow) : null;
  renderDetailChart(toShow);
}

function rosterKey(r) { return `${r.studentDigitalId}::${r.subject}`; }

/* ============ Cross-student comparison (horizontal bars) ============ */
// Nominal categorical, one series ("average score") -- every bar takes the
// SAME slot-1 hue, per the skill's "never color nominal bars by their
// value" rule. Horizontal, not vertical columns: student names don't fit
// under narrow vertical bars at this container width (480px, mobile-first).

function renderComparisonChart(rows) {
  const container = document.getElementById('chartsSection');
  let card = document.getElementById('comparisonChartCard');
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
    card.id = 'comparisonChartCard';
    container.appendChild(card);
  }

  if (!rows.length) {
    card.innerHTML = `<p class="section-heading">Average Scores</p><p class="empty-note">No students with quiz activity to compare yet.</p>`;
    return;
  }

  // A one-bar bar chart is a known anti-pattern (the comparison a bar chart
  // exists for needs at least two things to compare) -- a single student
  // gets a plain stat tile instead.
  if (rows.length === 1) {
    const only = rows[0];
    const name = [only.identity?.givenName, only.identity?.surname].filter(Boolean).join(' ') || 'Unnamed';
    card.innerHTML = `
      <p class="section-heading">Average Score</p>
      <p class="screen-sub" style="margin-top:4px;">${esc(name)}</p>
      <p style="font-size:2.4rem; font-weight:700; margin-top:var(--space-2);">${only.stats.averageScorePercent}%</p>
    `;
    return;
  }

  const color = chartMarkColor();
  const sorted = [...rows].sort((a, b) => b.stats.averageScorePercent - a.stats.averageScorePercent);
  const maxVal = 100; // fixed 0-100 domain -- a score is already a percentage, never rescale it to the observed range

  const rowsHtml = sorted.map((r, i) => {
    const name = [r.identity?.givenName, r.identity?.surname].filter(Boolean).join(' ') || 'Unnamed';
    const val = r.stats.averageScorePercent;
    const widthPct = Math.max(2, (val / maxVal) * 100);
    return `
      <div class="viz-bar-row" tabindex="0" role="img" aria-label="${esc(name)}, ${val}% average">
        <span class="viz-bar-label" title="${esc(name)}">${esc(name)}</span>
        <span class="viz-bar-track">
          <span class="viz-bar-fill" style="width:${widthPct}%; background:${color};"></span>
        </span>
        <span class="viz-bar-value">${val}%</span>
      </div>`;
  }).join('');

  card.innerHTML = `
    <p class="section-heading">Average Scores</p>
    <p class="screen-sub" style="margin-top:4px;">${sorted.length} student${sorted.length === 1 ? '' : 's'} with quiz activity, sorted highest to lowest.</p>
    <div class="viz-bar-list" style="margin-top:${'var(--space-3)'};">${rowsHtml}</div>
  `;

  card.querySelectorAll('.viz-bar-row').forEach((row, i) => {
    row.addEventListener('click', () => { selectedStudentKey = rosterKey(sorted[i]); renderDetailChart(sorted[i]); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedStudentKey = rosterKey(sorted[i]); renderDetailChart(sorted[i]); } });
  });
}

/* ============ Per-student detail (line chart) ============ */
// Single series (one student's own timeline). Fixed 0-100 y-domain -- a
// score is already an absolute scale, so auto-fitting the domain to the
// observed min/max would visually exaggerate ordinary variation.

function renderDetailChart(row) {
  let card = document.getElementById('detailChartCard');
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
    card.id = 'detailChartCard';
    document.getElementById('chartsSection').appendChild(card);
  }

  if (!row) {
    card.innerHTML = `<p class="section-heading">Score Over Time</p><p class="empty-note">Select a student above to see their timeline.</p>`;
    return;
  }

  const name = [row.identity?.givenName, row.identity?.surname].filter(Boolean).join(' ') || 'Unnamed';
  const points = row.stats.timeline;
  const color = chartMarkColor();
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--color-border').trim() || '#e1e0d9';
  const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--color-text-muted').trim() || '#6B7280';

  card.innerHTML = `
    <p class="section-heading">Score Over Time -- ${esc(name)}</p>
    <p class="screen-sub" style="margin-top:4px;">${esc(row.subject)} &bull; ${points.length} attempt${points.length === 1 ? '' : 's'}</p>
    <div id="detailChartSvgWrap" style="margin-top:var(--space-3);"></div>
  `;

  const wrap = document.getElementById('detailChartSvgWrap');
  if (!points.length) {
    wrap.innerHTML = `<p class="empty-note">No quiz activity yet.</p>`;
    return;
  }
  wrap.innerHTML = buildLineChartSvg(points, color, gridColor, mutedColor);
  wireLineChartHover(wrap, points);
}

function buildLineChartSvg(points, color, gridColor, mutedColor) {
  const w = 400, h = 160, padL = 32, padR = 12, padT = 12, padB = 24;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const n = points.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH; // fixed 0-100 domain

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.scorePercent).toFixed(1)}`).join(' ');
  const gridLines = [0, 50, 100].map((v) => {
    const yy = y(v).toFixed(1);
    return `<line x1="${padL}" y1="${yy}" x2="${w - padR}" y2="${yy}" stroke="${gridColor}" stroke-width="1" />` +
           `<text x="${padL - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="${mutedColor}">${v}</text>`;
  }).join('');

  const dots = points.map((p, i) =>
    `<circle class="viz-line-dot" data-index="${i}" cx="${x(i).toFixed(1)}" cy="${y(p.scorePercent).toFixed(1)}" r="4" fill="${color}" stroke="${chartSurfaceColor()}" stroke-width="2" />`
  ).join('');

  const last = points[n - 1];
  const lastLabel = `<text x="${x(n - 1).toFixed(1)}" y="${(y(last.scorePercent) - 10).toFixed(1)}" text-anchor="end" font-size="11" font-weight="700" fill="${mutedColor}">${last.scorePercent}%</text>`;

  // Transparent hit-area rects (wider than the mark itself, per the "hit
  // target bigger than the mark" rule) drive hover/focus instead of the
  // 4px-radius dots directly.
  const hitAreas = points.map((p, i) =>
    `<rect class="viz-line-hit" data-index="${i}" x="${(x(i) - 12).toFixed(1)}" y="${padT}" width="24" height="${innerH}" fill="transparent" />`
  ).join('');

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%; height:160px; display:block;" role="img" aria-label="Score over time line chart">
      ${gridLines}
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${lastLabel}
      ${hitAreas}
    </svg>
    <div class="viz-tooltip" id="detailChartTooltip" hidden></div>
  `;
}

function wireLineChartHover(wrap, points) {
  const svg = wrap.querySelector('svg');
  const tooltip = wrap.querySelector('#detailChartTooltip');
  const show = (index) => {
    const p = points[index];
    if (!p) return;
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${esc(String(p.scorePercent))}%</strong><br>${esc(p.examTitle)}<br><span style="opacity:.7">${esc(p.date)}</span>`;
    const dot = svg.querySelector(`.viz-line-dot[data-index="${index}"]`);
    dot?.setAttribute('r', '6');
  };
  const hide = () => {
    tooltip.hidden = true;
    svg.querySelectorAll('.viz-line-dot').forEach((d) => d.setAttribute('r', '4'));
  };
  svg.querySelectorAll('.viz-line-hit').forEach((hit) => {
    const index = Number(hit.dataset.index);
    hit.addEventListener('pointerenter', () => show(index));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => show(index));
    hit.addEventListener('blur', hide);
  });
}
