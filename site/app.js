const wallpaperEl = document.getElementById('wallpaper');
const alertsEl = document.getElementById('alerts');
const sectionsEl = document.getElementById('sections');

const VALID_MOTION = new Set(['none', 'subtle']);
const DEFAULT_UI = {
  timezone: 'Europe/Berlin',
  motion: 'subtle',
  gutters: {
    top: 56,
    bottom: 106,
    side: 28
  }
};
const GRID_COLUMNS = 12;
const CARD_GRID_GAP = 10;
const SECTION_CHROME_HEIGHT = 46;

let currentUi = { ...DEFAULT_UI, gutters: { ...DEFAULT_UI.gutters } };
let loadTimer = null;
let alertRotateTimer = null;
let alertRotateIndex = 0;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asNumber(value, fallback) {
  const next = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function clamp(value, min, max, fallback) {
  const next = asNumber(value, fallback);
  return Math.min(max, Math.max(min, next));
}

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function resolveUi(rawUi) {
  const ui = asObject(rawUi);
  const gutters = asObject(ui.gutters);
  return {
    timezone: isValidTimezone(ui.timezone) ? ui.timezone : DEFAULT_UI.timezone,
    motion: VALID_MOTION.has(ui.motion) ? ui.motion : DEFAULT_UI.motion,
    gutters: {
      top: clamp(gutters.top, 20, 180, DEFAULT_UI.gutters.top),
      bottom: clamp(gutters.bottom, 72, 240, DEFAULT_UI.gutters.bottom),
      side: clamp(gutters.side, 12, 80, DEFAULT_UI.gutters.side)
    }
  };
}

function applyFrameUi(ui) {
  const root = document.documentElement.style;
  currentUi = ui;
  root.setProperty('--gutter-top', `${ui.gutters.top}px`);
  root.setProperty('--gutter-bottom', `${ui.gutters.bottom}px`);
  root.setProperty('--gutter-side', `${ui.gutters.side}px`);
}

function cardPriority(card) {
  const fromLayout = asNumber(asObject(card.layout).priority, NaN);
  const fromCard = asNumber(card.priority, NaN);
  if (Number.isFinite(fromLayout)) return fromLayout;
  if (Number.isFinite(fromCard)) return fromCard;
  return 100;
}

function compactText(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function estimateTextLines(value, charsPerLine, maxLines) {
  const compact = compactText(value);
  if (!compact) return 0;
  const safeCharsPerLine = Math.max(1, charsPerLine);
  const lines = Math.max(1, Math.ceil(compact.length / safeCharsPerLine));
  return Math.min(maxLines, lines);
}

function estimateCardHeight(card, cardSpan, sectionSpan) {
  const safeCardSpan = clamp(cardSpan, 3, GRID_COLUMNS, 6);
  const safeSectionSpan = clamp(sectionSpan, 3, GRID_COLUMNS, 4);
  const widthScale = (safeSectionSpan / 4) * (safeCardSpan / GRID_COLUMNS);
  const charsPerLine = Math.max(14, Math.round(58 * widthScale));
  const hasChart = Boolean(card._chart);
  let base = 50;

  base += estimateTextLines(card.title, charsPerLine, 2) * 12;
  base += estimateTextLines(card.description, charsPerLine, 3) * 12;
  base += estimateTextLines(card.url, charsPerLine, 2) * 11;
  base += estimateTextLines(card.long_description, charsPerLine, 4) * 12;

  if (hasChart) {
    base += 98;
    if (card.long_description) base += 6;
  }

  return clamp(base, 82, 288, 140);
}

function chooseCardSpan(card, sectionSpan) {
  const hasChart = Boolean(card._chart);
  const titleLength = compactText(card.title).length;
  const descriptionLength = compactText(card.description).length;
  const longLength = compactText(card.long_description).length;
  const density = titleLength + descriptionLength + longLength;

  if (hasChart && longLength > 70) return 12;
  if (hasChart) return sectionSpan >= 6 ? 6 : 12;
  if (longLength > 120) return 12;
  if (density > 170) return 6;
  if (density < 48 && !card.url) return 4;
  return 6;
}

function buildLayoutRows(items, recalcHeightForSpan) {
  const remaining = [...items].sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    if (a.importance !== b.importance) return a.importance - b.importance;
    return a.stableKey.localeCompare(b.stableKey);
  });
  const rows = [];

  while (remaining.length) {
    const row = [];
    let used = 0;
    let rowHeight = 0;
    const seed = remaining.shift();

    row.push(seed);
    used += seed.span;
    rowHeight = Math.max(rowHeight, seed.height);

    while (used < GRID_COLUMNS) {
      const space = GRID_COLUMNS - used;
      let bestIndex = -1;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        if (candidate.span > space) continue;

        const leftoverAfter = space - candidate.span;
        const heightDelta = Math.abs(candidate.height - rowHeight);
        let score = leftoverAfter * 5 + heightDelta * 0.08 + candidate.importance * 0.015;
        if (candidate.span === space) score -= 3;

        if (score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }

      if (bestIndex < 0) break;

      const next = remaining.splice(bestIndex, 1)[0];
      row.push(next);
      used += next.span;
      rowHeight = Math.max(rowHeight, next.height);
    }

    if (used < GRID_COLUMNS && row.length) {
      const leftover = GRID_COLUMNS - used;
      const lastIndex = row.length - 1;
      const last = row[lastIndex];
      const nextSpan = last.span + leftover;
      row[lastIndex] = {
        ...last,
        span: nextSpan,
        height: recalcHeightForSpan ? recalcHeightForSpan(last.item, nextSpan) : last.height
      };
    }

    rows.push(row);
  }

  return rows;
}

function packCards(cards, sectionSpan) {
  const entries = cards.map((card, index) => {
    const span = chooseCardSpan(card, sectionSpan);
    const height = estimateCardHeight(card, span, sectionSpan);
    return {
      item: card,
      span,
      height,
      importance: card._importance,
      stableKey: `${card.id || card.title || 'card'}-${index}`
    };
  });
  const rows = buildLayoutRows(entries, (card, nextSpan) => estimateCardHeight(card, nextSpan, sectionSpan));
  const rowHeights = rows.map((row) => row.reduce((max, entry) => Math.max(max, entry.height), 0));
  const cardsHeight = rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0)
    + CARD_GRID_GAP * Math.max(0, rowHeights.length - 1);
  const estimatedHeight = SECTION_CHROME_HEIGHT + cardsHeight;

  return {
    cards: rows.flat().map((entry) => ({ ...entry.item, _computedSpan: entry.span })),
    estimatedHeight,
    rowCount: rows.length
  };
}

function sectionSpanCandidates(cards) {
  const chartCount = cards.filter((card) => Boolean(card._chart)).length;
  const longCount = cards.filter((card) => compactText(card.long_description).length > 70).length;
  const candidates = new Set([4, 6]);

  if (cards.length <= 2 && chartCount === 0 && longCount === 0) candidates.add(3);
  if (cards.length >= 5 || chartCount >= 2 || longCount >= 2) candidates.add(8);
  if (cards.length >= 7) candidates.add(12);

  return [...candidates].sort((a, b) => a - b);
}

function buildSectionLayout(section, cards, sectionSpan) {
  const packed = packCards(cards, sectionSpan);
  return {
    ...section,
    _sourceCards: cards,
    cards: packed.cards,
    _computedSpan: sectionSpan,
    _estimatedHeight: packed.estimatedHeight,
    _rowCount: packed.rowCount,
    _importance: cards.reduce((lowest, card) => Math.min(lowest, card._importance), 100)
  };
}

function chooseSectionLayout(section, cards) {
  const candidates = sectionSpanCandidates(cards);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  candidates.forEach((span) => {
    const candidate = buildSectionLayout(section, cards, span);
    const score = candidate._estimatedHeight * (1 + span / 18) + candidate._rowCount * 8;

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });

  return best;
}

function packSections(sections) {
  const entries = sections.map((section, index) => ({
    item: section,
    span: section._computedSpan,
    height: section._estimatedHeight,
    importance: section._importance,
    stableKey: `${section.id || section.label || 'section'}-${index}`
  }));
  const rows = buildLayoutRows(entries, null);
  return rows.flat().map((entry) => {
    if (entry.item._sourceCards && entry.span !== entry.item._computedSpan) {
      return buildSectionLayout(entry.item, entry.item._sourceCards, entry.span);
    }
    return {
      ...entry.item,
      _computedSpan: entry.span
    };
  });
}

function sourceFromUrl(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
}

function clearAlertRotation() {
  if (!alertRotateTimer) return;
  clearInterval(alertRotateTimer);
  alertRotateTimer = null;
}

function renderAlertFrame(alert, count, index) {
  const severity = ['warning', 'critical'].includes(alert.severity) ? alert.severity : 'info';
  const position = count > 1 ? ` | ${index + 1}/${count}` : '';
  const animateClass = currentUi.motion === 'subtle' ? 'is-entering' : '';

  return `
    <article class="alert-item ${esc(severity)} ${animateClass}">
      <p class="alert-message">${esc(alert.message || 'Alert')}</p>
      <p class="alert-meta">${esc(severity)}${esc(position)}</p>
    </article>
  `;
}

function renderAlerts(alerts = []) {
  clearAlertRotation();

  const normalizedAlerts = alerts
    .map((entry) => asObject(entry))
    .filter((entry) => entry.message);

  if (!normalizedAlerts.length) {
    alertsEl.innerHTML = '';
    alertRotateIndex = 0;
    return;
  }

  const renderAt = (index) => {
    const nextIndex = index % normalizedAlerts.length;
    alertsEl.innerHTML = renderAlertFrame(normalizedAlerts[nextIndex], normalizedAlerts.length, nextIndex);
    alertRotateIndex = nextIndex;
  };

  renderAt(alertRotateIndex);

  if (normalizedAlerts.length <= 1) return;

  const rotateEveryMs = 5000;
  alertRotateTimer = setInterval(() => {
    renderAt(alertRotateIndex + 1);
  }, rotateEveryMs);
}

function normalizeChart(chartRaw) {
  const chart = asObject(chartRaw);
  const points = Array.isArray(chart.points)
    ? chart.points.map((value) => asNumber(value, NaN)).filter((value) => Number.isFinite(value))
    : [];

  if (points.length < 2) return null;

  const minPoint = Math.min(...points);
  const maxPoint = Math.max(...points);
  const kind = chart.kind === 'bars' ? 'bars' : 'sparkline';

  return {
    kind,
    points,
    min: minPoint,
    max: maxPoint,
    unit: typeof chart.unit === 'string' ? chart.unit : '',
    label: typeof chart.label === 'string' ? chart.label : ''
  };
}

function formatChartScale(value, unit) {
  const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  return `${numberFormat.format(value)}${unit}`;
}

function renderSparkline(points, min, max, minLabel, maxLabel) {
  const width = 360;
  const height = 64;
  const pad = 6;
  const span = Math.max(points.length - 1, 1);
  const range = max - min;
  const toX = (index) => pad + (index / span) * (width - pad * 2);
  const toY = (value) => {
    if (range <= 0) return height / 2;
    return height - pad - ((value - min) / range) * (height - pad * 2);
  };

  const path = points
    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${toX(index).toFixed(2)} ${toY(value).toFixed(2)}`)
    .join(' ');

  return `
    <svg class="mini-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <line class="chart-grid" x1="${pad}" y1="${pad}" x2="${(width - pad).toFixed(2)}" y2="${pad}"></line>
      <line class="chart-grid" x1="${pad}" y1="${(height - pad).toFixed(2)}" x2="${(width - pad).toFixed(2)}" y2="${(height - pad).toFixed(2)}"></line>
      <text class="chart-scale-label max" x="${(width - pad - 2).toFixed(2)}" y="${(pad + 1).toFixed(2)}" text-anchor="end" dominant-baseline="hanging">${esc(maxLabel)}</text>
      <text class="chart-scale-label min" x="${(width - pad - 2).toFixed(2)}" y="${(height - pad - 1).toFixed(2)}" text-anchor="end" dominant-baseline="ideographic">${esc(minLabel)}</text>
      <path class="chart-line" d="${path}"></path>
    </svg>
  `;
}

function renderBars(points, min, max, minLabel, maxLabel) {
  const width = 360;
  const height = 64;
  const pad = 6;
  const range = max - min;
  const innerWidth = width - pad * 2;
  const barSpace = innerWidth / points.length;
  const barWidth = Math.max(2, barSpace * 0.56);

  const bars = points
    .map((value, index) => {
      const normalized = range <= 0 ? 0.5 : (value - min) / range;
      const barHeight = Math.max(2, normalized * (height - pad * 2));
      const x = pad + index * barSpace + (barSpace - barWidth) / 2;
      const y = height - pad - barHeight;
      return `<rect class="chart-bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}"></rect>`;
    })
    .join('');

  return `
    <svg class="mini-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <line class="chart-grid" x1="${pad}" y1="${pad}" x2="${(width - pad).toFixed(2)}" y2="${pad}"></line>
      <line class="chart-grid" x1="${pad}" y1="${(height - pad).toFixed(2)}" x2="${(width - pad).toFixed(2)}" y2="${(height - pad).toFixed(2)}"></line>
      <text class="chart-scale-label max" x="${(width - pad - 2).toFixed(2)}" y="${(pad + 1).toFixed(2)}" text-anchor="end" dominant-baseline="hanging">${esc(maxLabel)}</text>
      <text class="chart-scale-label min" x="${(width - pad - 2).toFixed(2)}" y="${(height - pad - 1).toFixed(2)}" text-anchor="end" dominant-baseline="ideographic">${esc(minLabel)}</text>
      ${bars}
    </svg>
  `;
}

function renderChart(chart) {
  if (!chart) return '';

  const latest = chart.points[chart.points.length - 1];
  const first = chart.points[0];
  const delta = latest - first;
  const deltaPrefix = delta > 0 ? '+' : '';
  const deltaClass = delta >= 0 ? 'up' : 'down';
  const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const latestLabel = `${numberFormat.format(latest)}${chart.unit}`;
  const deltaLabel = `${deltaPrefix}${numberFormat.format(delta)}${chart.unit}`;
  const minLabel = `${numberFormat.format(chart.min)}${chart.unit}`;
  const maxLabel = `${numberFormat.format(chart.max)}${chart.unit}`;

  const chartMarkup = chart.kind === 'bars'
    ? renderBars(chart.points, chart.min, chart.max, minLabel, maxLabel)
    : renderSparkline(chart.points, chart.min, chart.max, minLabel, maxLabel);

  return `
    <div class="chart-wrap chart-${chart.kind}">
      ${chartMarkup}
      <div class="chart-meta">
        <span>${esc(latestLabel)}</span>
        <span class="delta ${deltaClass}">${esc(deltaLabel)}</span>
      </div>
    </div>
  `;
}

function renderCard(card) {
  const chart = card._chart || normalizeChart(card.chart);
  const source = sourceFromUrl(card.url);
  const chartMarkup = renderChart(chart);
  const metaParts = [source].filter(Boolean).map((part) => esc(part)).join(' | ');
  const metaMarkup = metaParts ? `<p class="card-meta">${metaParts}</p>` : '';
  const description = card.description ? `<p class="card-copy">${esc(card.description)}</p>` : '';
  const longDescription = card.long_description ? `<p class="card-long-description">${esc(card.long_description)}</p>` : '';
  const legendMarkup = chart && chart.label ? `<span class="card-legend">${esc(chart.label)}</span>` : '';
  const cardClasses = ['card-item'];

  if (chart) cardClasses.push('has-chart');
  if (card.long_description) cardClasses.push('has-long-copy');

  return `
    <article class="${cardClasses.join(' ')}" style="--card-span:${asNumber(card._computedSpan, 6)}">
      <div class="card-head">
        <h3 class="card-title">${esc(card.title || '')}</h3>
        ${legendMarkup}
      </div>
      ${description}
      ${chartMarkup}
      ${metaMarkup}
      ${longDescription}
    </article>
  `;
}

function renderSections(sections = []) {
  const normalizedSections = sections
    .map((entry) => asObject(entry))
    .filter((section) => Object.keys(section).length > 0 && !section.hidden)
    .map((section) => {
      const cards = (Array.isArray(section.cards) ? section.cards : [])
        .map((card) => asObject(card))
        .filter((card) => Object.keys(card).length > 0)
        .filter((card) => !card.hidden && card.title)
        .map((card, index) => ({
          ...card,
          _importance: cardPriority(card),
          _chart: normalizeChart(card.chart),
          _stable: `${card.id || card.title || 'card'}-${index}`
        }))
        .sort((a, b) => {
          if (a._importance !== b._importance) return a._importance - b._importance;
          return a._stable.localeCompare(b._stable);
        });

      if (!cards.length) return null;

      return chooseSectionLayout(section, cards);
    })
    .filter(Boolean);

  const packedSections = packSections(normalizedSections);

  sectionsEl.innerHTML = packedSections
    .map((section) => {
      const cards = section.cards.map(renderCard).join('');
      const span = asNumber(section._computedSpan, 4);
      return `
        <section class="section-panel" style="--section-span:${span}">
          <p class="section-label">${esc(section.label || '')}</p>
          <div class="cards-grid">${cards}</div>
        </section>
      `;
    })
    .join('');
}

function pulseRefresh() {
  // Animations removed by design.
}

function scheduleNextLoad(ttlSeconds) {
  clearTimeout(loadTimer);
  const safeTtl = clamp(ttlSeconds, 5, 600, 30);
  loadTimer = setTimeout(load, safeTtl * 1000);
}

async function load() {
  let ttlSeconds = 30;
  try {
    const response = await fetch('./data/dashboard.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    ttlSeconds = asNumber(data.ttl_seconds, 30);

    const ui = resolveUi(data.ui);
    applyFrameUi(ui);

    renderAlerts(Array.isArray(data.alerts) ? data.alerts : []);
    renderSections(Array.isArray(data.sections) ? data.sections : []);
    pulseRefresh();
  } catch (error) {
    renderAlerts([
      {
        id: 'data-unavailable',
        severity: 'critical',
        message: `Data unavailable (${error.message})`
      }
    ]);
    sectionsEl.innerHTML = '';
  } finally {
    scheduleNextLoad(ttlSeconds);
  }
}

window.addEventListener('beforeunload', clearAlertRotation);

load();
