import {
  $, esc, fmt, pct, setThreshold, badge, chrome, percentBars, columnChart, cascade, stackedBar, heatStyle, dataTable,
} from './ui.js';

const body = document.body;
chrome('dashboard', { publicSite: body.dataset.publicSite === '1', sourceUrl: body.dataset.sourceUrl || '' });

let stats;
let current;
let districtTable;

const OUTCOME_LABELS = { negative: 'Normal', 'early-recall': 'Early recall', abnormal: 'Abnormal (referred)', inadequate: 'Inadequate test' };

function kpi(label, value, { sub = '', extra = '', status = '' } = {}) {
  return `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${status}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${extra}</div>`;
}

function renderTabs() {
  $('programme-tabs').innerHTML = stats.programmes.map((p) =>
    `<button type="button" role="tab" id="tab-${esc(p.id)}" data-id="${esc(p.id)}" aria-selected="${p.id === current.id}" tabindex="${p.id === current.id ? 0 : -1}">${esc(p.name)}</button>`).join('');
}

function renderKpis() {
  const t = current.totals;
  const who = current.sexes.length === 1 ? 'women' : 'people';
  const target = current.coverageTarget;
  const covStatus = target && t.coveragePct !== null
    ? badge(t.coveragePct >= target.percent ? 'At or above target' : `Below ${target.percent}% target`, t.coveragePct >= target.percent ? 'good' : 'warning')
    : '';
  const mini = t.coveragePct === null ? '' : `<div class="mini-track" role="img" aria-label="Coverage ${pct(t.coveragePct)}${target ? `, target ${target.percent}%` : ''}"><span style="width:${t.coveragePct}%"></span>${target ? `<i style="left:${target.percent}%"></i>` : ''}</div>`;
  $('kpis').innerHTML = [
    kpi(`Eligible ${who}`, fmt(t.eligible), { sub: `Aged ${current.eligibleAge.min}–${current.eligibleAge.max}` }),
    kpi('Coverage', pct(t.coveragePct), { sub: target ? target.label : 'Up to date with screening', extra: mini, status: covStatus ? `<div style="margin-top:4px">${covStatus}</div>` : '' }),
    kpi('Overdue', fmt(t.overdue), { sub: 'Past their due date' }),
    kpi('Never screened', fmt(t.neverScreened), { sub: 'No screening on record' }),
    kpi('Awaiting follow-up', fmt(t.abnormalAwaitingFollowUp), { sub: 'Abnormal result, no follow-up yet', status: t.abnormalAwaitingFollowUp ? `<div style="margin-top:4px">${badge('Needs action', 'critical')}</div>` : '' }),
    kpi('Screened, last 12 months', fmt(t.screenedLast12Months), { sub: 'People with a recent screen' }),
    kpi('Cancers recorded', fmt(t.cancersRecordedLast5Years), { sub: 'From cancer registries, last 5 years' }),
  ].join('');
}

function renderDistricts() {
  const prov = $('province-filter').value;
  const rows = current.byDistrict.filter((d) => !prov || d.province === prov);
  const columns = [
    { key: 'district', label: 'District' },
    { key: 'province', label: 'Province' },
    { key: 'eligible', label: 'Eligible', num: true, html: (r) => esc(fmt(r.eligible)), sortValue: (r) => r.eligible ?? -1 },
    { key: 'covered', label: 'Up to date', num: true, html: (r) => esc(fmt(r.covered)), sortValue: (r) => r.covered ?? -1 },
    { key: 'coveragePct', label: 'Coverage', num: true, html: (r) => `<span class="cell" style="display:inline-block;min-width:58px;padding:2px 6px;border-radius:4px;${heatStyle(r.coveragePct)}">${esc(pct(r.coveragePct))}</span>`, sortValue: (r) => r.coveragePct ?? -1 },
    { key: 'overdue', label: 'Overdue', num: true, html: (r) => esc(fmt(r.overdue)), sortValue: (r) => r.overdue ?? -1 },
    { key: 'neverScreened', label: 'Never screened', num: true, html: (r) => esc(fmt(r.neverScreened)), sortValue: (r) => r.neverScreened ?? -1 },
  ];
  if (districtTable) districtTable.update(rows);
  else districtTable = dataTable($('districts'), { columns, rows, pageSize: 30, searchable: false });
}

function render() {
  renderTabs();
  renderKpis();
  const c = current.cascade;
  $('cascade-note').textContent = `People screened in the last ${c.windowMonths} months, and what happened next`;
  $('cascade').innerHTML = cascade([
    { label: 'Screened', value: c.screened },
    { label: 'Abnormal result', value: c.abnormal },
    { label: 'Followed up', value: c.followedUp },
    { label: 'Cancer diagnosed', value: c.diagnosed },
  ]);
  $('monthly').innerHTML = columnChart(current.monthly);
  $('age').innerHTML = percentBars(current.byAgeBand.map((b) => ({ label: b.band, value: b.coveragePct, note: `${fmt(b.eligible)} eligible` })), { target: current.coverageTarget });
  $('province').innerHTML = percentBars(current.byProvince.map((b) => ({ label: b.province, value: b.coveragePct, note: `${fmt(b.eligible)} eligible` })), { target: current.coverageTarget });
  $('outcomes').innerHTML = stackedBar(Object.entries(current.outcomesLast12Months).map(([k, v]) => ({ label: OUTCOME_LABELS[k] || k, value: v })));
  districtTable = null;
  renderDistricts();
}

function select(id, focus = false) {
  current = stats.programmes.find((p) => p.id === id) || stats.programmes[0];
  try { localStorage.setItem('programme', current.id); } catch { /* storage unavailable */ }
  render();
  if (focus) $(`tab-${current.id}`)?.focus();
}

async function load() {
  const res = await fetch(body.dataset.statsUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  stats = await res.json();
  setThreshold(stats.suppressionThreshold);
  document.querySelectorAll('.threshold').forEach((el) => { el.textContent = stats.suppressionThreshold; });
  document.querySelectorAll('.threshold-minus').forEach((el) => { el.textContent = stats.suppressionThreshold - 1; });
  $('title').textContent = `National Cancer Screening Registry · ${stats.country.name}`;
  const q = stats.dataQuality;
  $('meta').innerHTML = [
    `<span class="chip">As of <strong>${esc(stats.generatedOn)}</strong></span>`,
    `<span class="chip"><strong>${esc(fmt(stats.peopleOnRegister))}</strong> people on register</span>`,
    `<span class="chip"><strong>${esc(stats.contributingOrganisations)}</strong> contributing organisations</span>`,
    `<span class="chip" title="Average quality score of submissions in the last 90 days">Data quality <strong>${q?.score === null || q?.score === undefined ? '—' : `${q.score}/100`}</strong>${q?.submissions ? ` (${q.submissions} checked)` : ''}</span>`,
  ].join('');
  $('generated').textContent = `Figures as of ${stats.generatedOn}${stats.syntheticData ? ' · synthetic demonstration data' : ''}. Coverage means eligible people whose screening is up to date. Screening ages and intervals are illustrative.`;

  const provinces = [...new Set(stats.programmes[0].byDistrict.map((d) => d.province))];
  $('province-filter').innerHTML = `<option value="">All provinces</option>${provinces.map((p) => `<option>${esc(p)}</option>`).join('')}`;
  let saved = null;
  try { saved = localStorage.getItem('programme'); } catch { /* storage unavailable */ }
  select(saved);
}

$('programme-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) select(b.dataset.id);
});
// Arrow-key navigation between tabs.
$('programme-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const ids = stats.programmes.map((p) => p.id);
  const i = ids.indexOf(current.id);
  select(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length], true);
});
$('province-filter').addEventListener('change', renderDistricts);

load().catch((err) => { $('kpis').innerHTML = `<div class="card err-box">Could not load statistics (${esc(err.message)}).</div>`; });
