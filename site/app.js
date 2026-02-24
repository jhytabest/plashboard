const titleEl = document.getElementById('title');
const summaryEl = document.getElementById('summary');
const generatedEl = document.getElementById('generated');
const alertsEl = document.getElementById('alerts');
const sectionsEl = document.getElementById('sections');

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderAlerts(alerts = []) {
  if (!alerts.length) {
    alertsEl.innerHTML = '';
    return;
  }

  alertsEl.innerHTML = alerts
    .map((a) => {
      const level = esc(a.severity || 'info');
      const when = a.updated_at ? new Date(a.updated_at).toLocaleString() : '-';
      return `
        <article class="alert ${level}">
          <strong>${esc(a.message)}</strong>
          <span>${esc(level)} · ${esc(when)}</span>
        </article>
      `;
    })
    .join('');
}

function renderMetrics(metrics = []) {
  if (!metrics.length) return '';
  return `
    <div class="metrics">
      ${metrics
        .map((m) => `<div class="metric"><span>${esc(m.key)}</span><span>${esc(m.value)}</span></div>`)
        .join('')}
    </div>
  `;
}

function renderSections(sections = []) {
  sectionsEl.innerHTML = sections
    .map((section) => {
      const cards = (section.cards || [])
        .map((card) => {
          const tags = (card.tags || []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('');
          const link = card.url ? `<a href="${esc(card.url)}" target="_blank" rel="noreferrer">Open</a>` : '';
          return `
            <article class="card">
              <div class="row">
                <strong>${esc(card.title)}</strong>
                <span class="badge ${esc(card.status)}">${esc(card.status)}</span>
              </div>
              <p>${esc(card.description || '')}</p>
              <div class="row">
                <small>${esc(card.type || '')}</small>
                ${link}
              </div>
              <div class="tags">${tags}</div>
              ${renderMetrics(card.metrics)}
            </article>
          `;
        })
        .join('');

      return `
        <section class="section">
          <h2>${esc(section.label)}</h2>
          <div class="grid">${cards}</div>
        </section>
      `;
    })
    .join('');
}

async function load() {
  try {
    const response = await fetch('./data/dashboard.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    titleEl.textContent = data.title || 'Plash Dashboard';
    summaryEl.textContent = data.summary || '';
    generatedEl.textContent = `updated ${new Date(data.generated_at).toLocaleString()}`;

    renderAlerts(data.alerts || []);
    renderSections(data.sections || []);
  } catch (error) {
    summaryEl.textContent = `Failed to load dashboard data: ${error.message}`;
    generatedEl.textContent = 'stale';
    alertsEl.innerHTML = '<article class="alert critical"><strong>Data unavailable</strong><span>check /data/dashboard.json</span></article>';
    sectionsEl.innerHTML = '';
  }
}

load();
setInterval(load, 30000);
