// Facility portal. The quality checks and de-identification run in this
// browser using the same modules as the submission kit.
import { parseDelimited } from './lib/ingest/csv.js';
import { mappings, applyMapping } from './lib/ingest/mappings.js';
import { buildSubmission } from './lib/ingest/pipeline.js';
import { programmeList } from './lib/programmes/index.js';
import { runQualityChecks, applyResolutions, sha256Hex, DIMENSIONS } from './lib/quality/index.js';
import { buildQualitySummary, explainSummary } from './lib/quality/summary.js';
import { queriesToCsv } from './lib/quality/export.js';
import {
  $, esc, badge, chrome, dataTable, loadingTable, percentBars, scoreRing, toast, downloadCsv, toCsv,
} from './ui.js';

chrome('portal');

const STATUS = {
  abnormal: ['Abnormal', 'critical'], overdue: ['Overdue', 'warning'], 'due-soon': ['Due soon', 'info'], 'up-to-date': ['Up to date', 'good'],
  diagnosed: ['Diagnosed', 'neutral'], 'opted-out': ['Opted out', 'neutral'], 'not-eligible': ['Not eligible', 'neutral'],
};
const statusBadge = (s) => badge(...(STATUS[s] || [s, 'neutral']));
const SEVERITY = { critical: 'critical', warning: 'warning', info: 'info' };

let key = '';
let me = null;
let country = null;
let assistantEnabled = false;
let alerts = [];
let alertsTable;
let worklistTable;
// Submission state
const sub = { text: '', fileName: '', fileSha256: '', records: [], report: null, resolutions: {}, filter: 'all', bundle: null, summary: null };

try { key = sessionStorage.getItem('registryKey') || ''; } catch { /* storage unavailable */ }

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${key}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.issue?.map((i) => i.diagnostics).join('; ') || `HTTP ${res.status}`);
  return data;
}

// --- Sign-in and overview ----------------------------------------------------

async function signIn() {
  me = await api('api/me');
  try { sessionStorage.setItem('registryKey', key); } catch { /* ignore */ }
  $('who').textContent = me.name;
  $('org-badges').innerHTML = [
    ...me.roles.map((r) => badge(r, 'neutral')),
    badge(`Agreement ${me.agreement.reference} · valid to ${me.agreement.validTo}`, 'good'),
  ].join(' ');
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  const canSee = me.roles.includes('facility') || me.roles.includes('admin');
  const canSubmit = me.roles.includes('submitter') || me.roles.includes('admin');
  document.querySelector('[data-tab="alerts"]').classList.toggle('hidden', !canSee);
  document.querySelector('[data-tab="worklist"]').classList.toggle('hidden', !canSee);
  document.querySelector('[data-tab="submit"]').classList.toggle('hidden', !canSubmit);
  await renderOverview(canSee);
  showTab(canSee ? 'alerts' : 'submit');
}

async function renderOverview(canSee) {
  const cards = [];
  if (canSee) {
    alerts = await api('api/facility/alerts');
    const high = alerts.filter((a) => a.priority === 'PH').length;
    cards.push(
      `<div class="card kpi"><div class="label">High-priority alerts</div><div class="value">${high.toLocaleString('en')}</div>${high ? badge('Abnormal results', 'critical') : ''}</div>`,
      `<div class="card kpi"><div class="label">Other alerts</div><div class="value">${(alerts.length - high).toLocaleString('en')}</div><div class="sub">Overdue or never screened</div></div>`,
    );
  }
  cards.push(
    `<div class="card kpi"><div class="label">Programmes covered</div><div class="value">${me.agreement.programmes.length}</div><div class="sub">${esc(me.agreement.programmes.join(', '))}</div></div>`,
    `<div class="card kpi"><div class="label">Agreement valid until</div><div class="value" style="font-size:1.35rem">${esc(me.agreement.validTo)}</div><div class="sub">${esc(me.agreement.reference)}</div></div>`,
  );
  $('overview').innerHTML = cards.join('');
}

function showTab(name) {
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (name === 'alerts') renderAlerts();
  if (name === 'worklist') loadWorklist();
}

// --- Alerts and worklist -------------------------------------------------------

function renderAlerts() {
  const prog = $('al-programme').value;
  const prio = $('al-priority').value;
  const rows = alerts.filter((a) => (!prog || a.programme === prog) && (!prio || a.priority === prio));
  const columns = [
    { key: 'priority', label: 'Priority', html: (a) => (a.priority === 'PH' ? badge('High', 'critical') : badge('Medium', 'warning')), sortValue: (a) => a.priority },
    { key: 'programme', label: 'Programme' },
    { key: 'detail', label: 'Alert' },
    { key: 'localIds', label: 'Your record', html: (a) => `<span class="mono">${esc(a.localIds.join(', '))}</span>`, text: (a) => a.localIds.join(' ') },
    { key: 'person', label: 'Coded ID', html: (a) => `<span class="mono">${esc(a.person)}</span>` },
    { key: 'district', label: 'District' },
    { key: 'since', label: 'Since' },
  ];
  const tools = '<button type="button" class="btn secondary small" id="alerts-csv">Export CSV</button>';
  if (alertsTable) alertsTable.update(rows);
  else alertsTable = dataTable($('alerts'), { columns, rows, tools, empty: 'No active alerts.' });
  $('alerts').onclick = (e) => {
    if (e.target.id !== 'alerts-csv') return;
    downloadCsv('alerts.csv', toCsv(['priority', 'programme', 'alert', 'record', 'district', 'since'],
      rows.map((a) => [a.priority === 'PH' ? 'High' : 'Medium', a.programme, a.detail, a.localIds.join(' '), a.district, a.since])));
  };
}

async function loadWorklist() {
  loadingTable($('worklist'), 8);
  worklistTable = null;
  const q = new URLSearchParams({ programme: $('wl-programme').value });
  if ($('wl-status').value) q.set('status', $('wl-status').value);
  try {
    const rows = await api(`api/facility/worklist?${q}`);
    const columns = [
      { key: 'localIds', label: 'Your record', html: (r) => `<span class="mono">${esc(r.localIds.join(', '))}</span>`, text: (r) => r.localIds.join(' ') },
      { key: 'person', label: 'Coded ID', html: (r) => `<span class="mono">${esc(r.person)}</span>` },
      { key: 'sex', label: 'Sex' },
      { key: 'age', label: 'Age', num: true },
      { key: 'district', label: 'District' },
      { key: 'status', label: 'Status', html: (r) => statusBadge(r.status) },
      { key: 'lastScreen', label: 'Last screen', html: (r) => esc(r.lastScreen || 'never') },
      { key: 'lastOutcome', label: 'Outcome', html: (r) => esc(r.lastOutcome || '—') },
      { key: 'dueDate', label: 'Due', html: (r) => esc(r.dueDate || '—') },
    ];
    const tools = '<button type="button" class="btn secondary small" id="wl-csv">Export CSV</button>';
    worklistTable = dataTable($('worklist'), { columns, rows, tools, empty: 'Nobody in this list.' });
    $('worklist').onclick = (e) => {
      if (e.target.id !== 'wl-csv') return;
      downloadCsv('worklist.csv', toCsv(['record', 'sex', 'age', 'district', 'status', 'last_screen', 'outcome', 'due'],
        rows.map((r) => [r.localIds.join(' '), r.sex, r.age, r.district, r.status, r.lastScreen || '', r.lastOutcome || '', r.dueDate || ''])));
    };
  } catch (err) {
    $('worklist').innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}

// --- Submission: step 1 → 4 -------------------------------------------------------

function goto(step) {
  document.querySelectorAll('#stepper li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.toggleAttribute('aria-current', n === step);
    if (n === step) li.setAttribute('aria-current', 'step');
    li.classList.toggle('done', n < step);
  });
  document.querySelectorAll('[data-stepview]').forEach((v) => v.classList.toggle('hidden', Number(v.dataset.stepview) !== step));
  document.querySelector(`[data-stepview="${step}"] h2, [data-stepview="${step}"] .score-ring`)?.scrollIntoView({ block: 'nearest' });
}

const hashStoreKey = () => `submittedHashes:${me?.id}`;
function previousHashes() {
  try { return JSON.parse(localStorage.getItem(hashStoreKey()) || '[]'); } catch { return []; }
}
function rememberHash(h) {
  try { localStorage.setItem(hashStoreKey(), JSON.stringify([...new Set([...previousHashes(), h])].slice(-50))); } catch { /* ignore */ }
}

async function checkFile(e) {
  e.preventDefault();
  const file = $('file').files[0];
  if (!file) return;
  sub.text = await file.text();
  sub.fileName = file.name.slice(0, 100);
  sub.fileSha256 = await sha256Hex(sub.text);
  sub.records = applyMapping(parseDelimited(sub.text), mappings[$('mapping').value]);
  sub.report = runQualityChecks(sub.records, { country, fileSha256: sub.fileSha256, previousFileHashes: previousHashes() });
  sub.resolutions = {};
  sub.filter = 'all';
  renderQuality();
  goto(2);
}

function currentSummary() {
  const resolved = applyResolutions(sub.records, sub.report.queries, sub.resolutions);
  const summary = buildQualitySummary({
    ...sub.report, sent: resolved.records.length, excluded: resolved.excludedLines.length, fileSha256: sub.fileSha256, resolutions: sub.resolutions,
  });
  return { resolved, summary };
}

function decisionText(q) {
  const r = sub.resolutions[q.id];
  if (!r) return q.severity === 'critical' ? 'Unresolved: rows will be left out' : '';
  if (r.action === 'fix') return `Fixed: ${q.fixes[r.fix].label}`;
  if (r.action === 'exclude') return 'Rows excluded';
  return `Accepted${r.reason ? `: ${r.reason}` : ''}`;
}

function renderQuality() {
  const { report } = sub;
  const { resolved, summary } = currentSummary();
  const counts = { critical: 0, warning: 0, info: 0 };
  report.queries.forEach((q) => { counts[q.severity]++; });
  const rating = report.score >= 90 ? ['Good', 'good'] : report.score >= 75 ? ['Fair', 'warning'] : ['Needs attention', 'critical'];
  $('score-head').innerHTML = `${scoreRing(report.score)}<div><h2>Data quality ${report.score}/100</h2>
    <div class="actions" style="margin-top:6px">${badge(rating[0], rating[1])} ${badge(`${counts.critical} critical`, 'critical')} ${badge(`${counts.warning} warnings`, 'warning')} ${badge(`${counts.info} notes`, 'info')}</div>
    <p class="muted" style="margin-top:6px">${report.rows} rows checked in ${esc(sub.fileName)}</p></div>`;

  const filters = [['all', `All (${report.queries.length})`], ['critical', `Critical (${counts.critical})`], ['warning', `Warnings (${counts.warning})`], ['info', `Notes (${counts.info})`], ['open', 'Unresolved']];
  $('q-filters').innerHTML = filters.map(([id, label]) => `<button type="button" class="btn ${sub.filter === id ? '' : 'secondary'} small" data-filter="${id}" aria-pressed="${sub.filter === id}">${esc(label)}</button>`).join('');

  const order = { critical: 0, warning: 1, info: 2 };
  const list = report.queries
    .filter((q) => sub.filter === 'all' || (sub.filter === 'open' ? !sub.resolutions[q.id] : q.severity === sub.filter))
    .sort((a, b) => order[a.severity] - order[b.severity]);
  $('queries').innerHTML = list.length ? list.map((q) => {
    const r = sub.resolutions[q.id];
    return `<article class="query ${SEVERITY[q.severity]}${r ? ' resolved' : ''}" aria-label="${esc(q.title)}">
      <div class="q-head"><strong>${esc(q.title)}</strong>${badge(q.severity, SEVERITY[q.severity])}</div>
      <div class="q-msg">${esc(q.message)}</div>
      ${q.suggestion ? `<div class="q-sug">${esc(q.suggestion)}</div>` : ''}
      ${r || q.severity === 'critical' ? `<div class="q-sug"><strong>${esc(decisionText(q))}</strong></div>` : ''}
      <div class="actions" data-q="${esc(q.id)}">
        ${r ? '<button type="button" class="btn ghost small" data-act="undo">Undo</button>' : `
          ${q.fixes.map((f, i) => `<button type="button" class="btn small" data-act="fix" data-fix="${i}">${esc(f.label)}</button>`).join('')}
          ${q.lines.length ? '<button type="button" class="btn secondary small" data-act="exclude">Exclude rows</button>' : ''}
          <button type="button" class="btn secondary small" data-act="accept">Accept</button>
          <input type="text" class="hidden" data-reason placeholder="Reason (stays on this computer)" aria-label="Reason for accepting" maxlength="200">`}
      </div>
    </article>`;
  }).join('') : '<div class="empty">No queries in this view. 🎉</div>';

  $('dimensions').innerHTML = percentBars(DIMENSIONS.map((d) => ({ label: d[0].toUpperCase() + d.slice(1), value: report.dimensions[d] })), { valueLabel: 'Score' });
  const open = report.queries.filter((q) => q.severity === 'critical' && !sub.resolutions[q.id]).length;
  $('send-tally').innerHTML = `<strong>${resolved.records.length}</strong> of ${report.rows} rows will go to de-identification; <strong>${resolved.excludedLines.length}</strong> excluded.${open ? ` ${open} critical ${open === 1 ? 'query is' : 'queries are'} unresolved.` : ''}`;
  renderAssistant(summary);
}

function renderAssistant(summary) {
  const local = explainSummary(summary);
  const body = `<ul class="muted" style="margin:6px 0 0;padding-left:18px">${local.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    <h3 style="margin-top:10px">Suggested next steps</h3>
    <ul style="margin:6px 0 0;padding-left:18px;font-size:0.88rem">${local.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
  if (!assistantEnabled) {
    $('assistant').innerHTML = `<div class="card-head" style="margin-bottom:6px"><div><h2>AI data assistant</h2></div>${badge('Preview', 'info')}</div>
      <p style="font-size:0.88rem"><strong>${esc(local.headline)}</strong></p>${body}
      <p class="muted" style="margin-top:10px">The AI assistant activates after funding. When it is on, it explains findings and answers questions using only these aggregate counts, never patient rows.</p>`;
    return;
  }
  $('assistant').innerHTML = `<div class="card-head" style="margin-bottom:6px"><div><h2>AI data assistant</h2></div>${badge('On', 'good')}</div>
    <p style="font-size:0.88rem"><strong>${esc(local.headline)}</strong></p>
    <form id="ask-form"><label>Ask about this report <input id="ask-q" maxlength="500" placeholder="What should we fix first?"></label><button class="btn small">Ask</button></form>
    <div id="ask-answer" aria-live="polite">${body}</div>
    <p class="muted" style="margin-top:8px">Only the aggregate counts above are sent to the assistant, never patient rows.</p>`;
  $('ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('ask-answer').innerHTML = '<div class="skeleton" style="margin-top:10px"></div>';
    try {
      const a = await api('api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: currentSummary().summary, question: $('ask-q').value }) });
      $('ask-answer').innerHTML = `${a.note ? `<p class="muted">${esc(a.note)}</p>` : ''}<p style="font-size:0.88rem">${esc(a.explanation)}</p>
        <ul style="padding-left:18px;font-size:0.88rem">${[...a.priorities, ...a.suggestedActions].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    } catch (err) { $('ask-answer').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
  });
}

$('queries').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const box = btn.closest('[data-q]');
  const id = box.dataset.q;
  const act = btn.dataset.act;
  if (act === 'undo') delete sub.resolutions[id];
  else if (act === 'fix') sub.resolutions[id] = { action: 'fix', fix: Number(btn.dataset.fix) };
  else if (act === 'exclude') sub.resolutions[id] = { action: 'exclude' };
  else if (act === 'accept') {
    const input = box.querySelector('[data-reason]');
    if (input.classList.contains('hidden')) {
      input.classList.remove('hidden');
      btn.textContent = 'Confirm accept';
      input.focus();
      return;
    }
    sub.resolutions[id] = { action: 'accept', reason: input.value.trim() };
  }
  renderQuality();
});
$('q-filters').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (b) { sub.filter = b.dataset.filter; renderQuality(); }
});
$('export-queries').addEventListener('click', () => downloadCsv(`quality-queries-${sub.fileName.replace(/\.\w+$/, '')}.csv`, queriesToCsv(sub.report.queries, sub.resolutions)));

async function toReview() {
  const { resolved, summary } = currentSummary();
  const result = await buildSubmission(resolved.records, { secret: $('secret').value, country, orgId: me.id });
  sub.bundle = result.summary.accepted ? result.bundle : null;
  sub.summary = summary;
  const s = result.summary;
  $('review-summary').innerHTML = `<div class="${s.accepted ? 'ok-box' : 'err-box'}"><strong>${s.accepted} events for ${s.people} people ready to send.</strong>
    Removed on this computer before sending: ${s.stripped.names} names, ${s.stripped.nationalIds} CNICs, ${s.stripped.phones} phone numbers; ${s.stripped.datesOfBirth} birth dates cut to month.
    Data quality ${summary.score}/100 is sent with the file as counts only.</div>`;
  $('review-errors').innerHTML = result.errors.length ? `<div class="err-box">${result.errors.length} row(s) could not be converted: ${result.errors.slice(0, 5).map((x) => `line ${x.line} (${esc(x.problems.join('; '))})`).join(' · ')}</div>` : '';
  dataTable($('review-table'), {
    columns: [
      { key: 'person', label: 'Coded ID', html: (r) => `<span class="mono">${esc(r.person)}</span>${r.weakLink ? ` ${badge('weak link', 'warning')}` : ''}` },
      { key: 'localId', label: 'Your record', html: (r) => `<span class="mono">${esc(r.localId)}</span>` },
      { key: 'sex', label: 'Sex' }, { key: 'birthMonth', label: 'Birth month' }, { key: 'district', label: 'District' },
      { key: 'event', label: 'Event' }, { key: 'programme', label: 'Programme' }, { key: 'detail', label: 'Detail' }, { key: 'date', label: 'Date' },
    ],
    rows: result.preview,
    pageSize: 15,
  });
  $('send').disabled = !sub.bundle;
  goto(3);
}

async function send() {
  if (!sub.bundle) return;
  $('send').disabled = true;
  try {
    const res = await api('fhir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', 'X-Submission-Source': sub.fileName, 'X-Quality-Summary': JSON.stringify(sub.summary) },
      body: JSON.stringify(sub.bundle),
    });
    rememberHash(sub.fileSha256);
    const c = res.summary;
    $('send-result').innerHTML = `<div class="ok-box"><strong>Sent.</strong> ${c.created} new records, ${c.duplicates} already on file, ${c.patientsCreated} new people, ${c.patientsUpdated} linked to people already on the register.
      Quality score ${sub.summary.score}/100 recorded with this import.${c.duplicateFile ? ' <br>Note: this exact file had been submitted before.' : ''}</div>`;
    toast('Submission received by the registry');
    goto(4);
    renderOverview(me.roles.includes('facility') || me.roles.includes('admin'));
    alertsTable = null;
  } catch (err) {
    $('review-errors').innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
    $('send').disabled = false;
  }
}

// --- Wiring ----------------------------------------------------------------

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  key = $('api-key').value.trim();
  try { await signIn(); } catch (err) { $('signin-msg').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
});
$('signout').addEventListener('click', () => {
  try { sessionStorage.removeItem('registryKey'); } catch { /* ignore */ }
  location.reload();
});
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
$('al-programme').addEventListener('change', renderAlerts);
$('al-priority').addEventListener('change', renderAlerts);
$('wl-programme').addEventListener('change', loadWorklist);
$('wl-status').addEventListener('change', loadWorklist);
$('file-form').addEventListener('submit', (e) => checkFile(e).catch((err) => toast(`Could not read the file: ${err.message}`)));
$('to-review').addEventListener('click', () => toReview().catch((err) => toast(err.message)));
$('send').addEventListener('click', send);
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => goto(Number(b.dataset.goto))));

$('mapping').innerHTML = Object.entries(mappings).map(([id, m]) => `<option value="${esc(id)}">${esc(m.label)}</option>`).join('');
$('wl-programme').innerHTML = programmeList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
$('al-programme').innerHTML += programmeList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
try {
  [country, { enabled: assistantEnabled }] = await Promise.all([
    fetch('api/public/country').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    fetch('api/public/assistant').then((r) => (r.ok ? r.json() : { enabled: false })),
  ]);
  if (key) signIn().catch(() => { key = ''; });
} catch (err) {
  $('signin-msg').innerHTML = `<div class="err-box">Could not reach the registry (${esc(err.message)}). Check the connection and reload the page.</div>`;
  $('signin-form').querySelector('button').disabled = true;
}
