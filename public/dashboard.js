const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let stats;
let current;
let threshold = 5;

const fmt = (n) => (n === null || n === undefined ? `<${threshold}` : n.toLocaleString());
const pct = (p) => (p === null || p === undefined ? '—' : `${p}%`);

const kpi = (label, value, cls = '') =>
  `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value ${cls}">${esc(value)}</div></div>`;

const bars = (rows, labelKey) => rows.map((r) => `
  <div class="bar-row">
    <span>${esc(r[labelKey])}</span>
    <span class="meter" role="img" aria-label="${esc(pct(r.coveragePct))} coverage"><span style="width:${r.coveragePct ?? 0}%"></span></span>
    <span class="num">${esc(pct(r.coveragePct))}</span>
  </div>`).join('');

const OUTCOME_LABELS = {
  negative: 'Normal / negative',
  'early-recall': 'Early recall',
  abnormal: 'Abnormal (referred)',
  inadequate: 'Inadequate test',
};

function renderTabs() {
  $('programme-tabs').innerHTML = stats.programmes.map((p) =>
    `<button type="button" role="tab" data-id="${esc(p.id)}" aria-selected="${p.id === current.id}">${esc(p.name)}</button>`).join('');
}

function renderDistricts() {
  const prov = $('province-filter').value;
  const rows = current.byDistrict.filter((d) => !prov || d.province === prov);
  $('district-table').innerHTML = `
    <thead><tr><th>District</th><th class="num">Eligible</th><th class="num">Covered</th><th class="num">Coverage</th><th class="num">Overdue</th></tr></thead>
    <tbody>${rows.map((d) => `<tr><td>${esc(d.district)}</td><td class="num">${esc(fmt(d.eligible))}</td>
      <td class="num">${esc(fmt(d.covered))}</td><td class="num">${esc(pct(d.coveragePct))}</td><td class="num">${esc(fmt(d.overdue))}</td></tr>`).join('')}</tbody>`;
}

function render() {
  const t = current.totals;
  const who = current.sexes.length === 1 ? 'women' : 'people';
  $('kpis').innerHTML = [
    kpi(`Eligible ${who} (${current.eligibleAge.min}–${current.eligibleAge.max})`, fmt(t.eligible)),
    kpi('Coverage', pct(t.coveragePct), t.coveragePct >= 70 ? 'good' : 'warn'),
    kpi('Overdue', fmt(t.overdue), 'warn'),
    kpi('Never screened', fmt(t.neverScreened), 'warn'),
    kpi('Abnormal, awaiting follow-up', fmt(t.abnormalAwaitingFollowUp), 'bad'),
    kpi('Screened in last 12 months', fmt(t.screenedLast12Months)),
    kpi('Cancers recorded by registries (5 yrs)', fmt(t.cancersRecordedLast5Years)),
  ].join('');
  $('age').innerHTML = bars(current.byAgeBand, 'band');
  $('province').innerHTML = bars(current.byProvince, 'province');

  const outcomes = Object.entries(current.outcomesLast12Months);
  const total = outcomes.reduce((a, [, n]) => a + (n || 0), 0);
  $('outcomes').innerHTML = outcomes.map(([k, n]) => `
    <div class="bar-row">
      <span>${esc(OUTCOME_LABELS[k] || k)}</span>
      <span class="meter"><span style="width:${total && n ? (n / total) * 100 : 0}%"></span></span>
      <span class="num">${esc(fmt(n))}</span>
    </div>`).join('');
  renderDistricts();
  renderTabs();
}

async function load() {
  const res = await fetch(document.body.dataset.statsUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  stats = await res.json();
  threshold = stats.suppressionThreshold;
  document.querySelectorAll('.threshold').forEach((el) => { el.textContent = threshold; });
  document.querySelectorAll('.threshold-minus').forEach((el) => { el.textContent = threshold - 1; });
  $('country-line').textContent = `${stats.country.name} · public dashboard · anonymised totals`;
  $('generated').textContent = `Figures as of ${stats.generatedOn} · ${fmt(stats.peopleOnRegister)} people on the register from ${stats.contributingOrganisations} contributing organisations${stats.syntheticData ? ' · synthetic data' : ''}.`;

  const provinces = [...new Set(stats.programmes[0].byDistrict.map((d) => d.province))];
  $('province-filter').innerHTML = `<option value="">All provinces</option>${provinces.map((p) => `<option>${esc(p)}</option>`).join('')}`;

  let saved = null;
  try { saved = localStorage.getItem('programme'); } catch { /* storage unavailable */ }
  current = stats.programmes.find((p) => p.id === saved) || stats.programmes[0];
  render();
}

$('programme-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  current = stats.programmes.find((p) => p.id === btn.dataset.id);
  try { localStorage.setItem('programme', current.id); } catch { /* ignore */ }
  render();
});
$('province-filter').addEventListener('change', renderDistricts);

load().catch((err) => { $('kpis').innerHTML = `<div class="card">Could not load statistics (${esc(err.message)}).</div>`; });
