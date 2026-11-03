// The same de-identification pipeline the submission kit uses, run in the browser.
import { parseDelimited } from './lib/ingest/csv.js';
import { mappings, applyMapping } from './lib/ingest/mappings.js';
import { buildSubmission } from './lib/ingest/pipeline.js';
import { programmeList } from './lib/programmes/index.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STATUS = {
  abnormal: ['Abnormal', 'bad'], overdue: ['Overdue', 'warn'], 'due-soon': ['Due soon', ''], 'up-to-date': ['Up to date', 'good'],
  diagnosed: ['Diagnosed', 'muted'], 'opted-out': ['Opted out', 'muted'], 'not-eligible': ['Not eligible', 'muted'],
};
const pill = (s) => `<span class="pill ${(STATUS[s] || ['', ''])[1]}">${esc((STATUS[s] || [s])[0])}</span>`;

let key = '';
let me = null;
let country = null;
let pending = null;

try { key = sessionStorage.getItem('registryKey') || ''; } catch { /* storage unavailable */ }

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${key}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.issue?.map((i) => i.diagnostics).join('; ') || `HTTP ${res.status}`);
  return data;
}

async function signIn() {
  me = await api('api/me');
  try { sessionStorage.setItem('registryKey', key); } catch { /* ignore */ }
  $('who').textContent = `${me.name} · ${me.roles.join(', ')} · agreement ${me.agreement.reference} (to ${me.agreement.validTo}) · ${me.agreement.programmes.join(', ')}`;
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  const canSee = me.roles.includes('facility') || me.roles.includes('admin');
  document.querySelector('[data-tab="alerts"]').classList.toggle('hidden', !canSee);
  document.querySelector('[data-tab="worklist"]').classList.toggle('hidden', !canSee);
  document.querySelector('[data-tab="submit"]').classList.toggle('hidden', !(me.roles.includes('submitter') || me.roles.includes('admin')));
  showTab(canSee ? 'alerts' : 'submit');
}

function showTab(name) {
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (name === 'alerts') loadAlerts();
  if (name === 'worklist') loadWorklist();
}

async function loadAlerts() {
  const alerts = await api('api/facility/alerts');
  $('alert-count').textContent = `(${alerts.length})`;
  $('alerts').innerHTML = `
    <thead><tr><th>Priority</th><th>Programme</th><th>Alert</th><th>Your record</th><th>Pseudonym</th><th>District</th><th>Since</th></tr></thead>
    <tbody>${alerts.slice(0, 300).map((a) => `<tr>
      <td>${a.priority === 'PH' ? '<span class="pill bad">High</span>' : '<span class="pill warn">Medium</span>'}</td>
      <td>${esc(a.programme)}</td><td>${esc(a.detail)}</td><td class="mono">${esc(a.localIds.join(', '))}</td>
      <td class="mono">${esc(a.person)}</td><td>${esc(a.district)}</td><td>${esc(a.since)}</td></tr>`).join('')}</tbody>`;
}

async function loadWorklist() {
  const q = new URLSearchParams({ programme: $('wl-programme').value });
  if ($('wl-status').value) q.set('status', $('wl-status').value);
  const rows = await api(`api/facility/worklist?${q}`);
  const shown = rows.slice(0, 300);
  $('worklist').innerHTML = `
    <thead><tr><th>Your record</th><th>Pseudonym</th><th>Sex</th><th>Age</th><th>District</th><th>Status</th><th>Last screen</th><th>Outcome</th><th>Due</th></tr></thead>
    <tbody>${shown.map((r) => `<tr><td class="mono">${esc(r.localIds.join(', '))}</td><td class="mono">${esc(r.person)}</td><td>${esc(r.sex)}</td>
      <td>${esc(r.age)}</td><td>${esc(r.district)}</td><td>${pill(r.status)}</td><td>${esc(r.lastScreen || 'never')}</td>
      <td>${esc(r.lastOutcome || '—')}</td><td>${esc(r.dueDate || '—')}</td></tr>`).join('')}</tbody>`;
  $('wl-note').textContent = rows.length > shown.length ? `Showing ${shown.length} of ${rows.length}.` : `${rows.length} people.`;
}

async function preview(e) {
  e.preventDefault();
  $('send').disabled = true;
  pending = null;
  const file = $('file').files[0];
  const mapping = mappings[$('mapping').value];
  const records = applyMapping(parseDelimited(await file.text()), mapping);
  const result = await buildSubmission(records, { secret: $('secret').value, country, orgId: me.id });
  const s = result.summary;
  $('submit-msg').innerHTML = `<div class="${s.accepted ? 'ok-box' : 'err-box'}">${s.rows} rows read · <strong>${s.accepted} ready to send</strong> · ${s.rejected} rejected · ${s.people} people.
    Removed before sending: ${s.stripped.names} names, ${s.stripped.nationalIds} ID numbers, ${s.stripped.phones} phone numbers; ${s.stripped.datesOfBirth} dates of birth cut to month.</div>`;
  $('preview').innerHTML = `
    ${result.errors.length ? `<h2 style="margin-top:14px">Rejected rows</h2><div class="table-scroll"><table><thead><tr><th>Line</th><th>Record</th><th>Problems</th></tr></thead>
      <tbody>${result.errors.slice(0, 100).map((x) => `<tr><td>${x.line}</td><td class="mono">${esc(x.recordId)}</td><td>${esc(x.problems.join('; '))}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <h2 style="margin-top:14px">What will be sent (first 50 events)</h2>
    <div class="table-scroll"><table><thead><tr><th>Pseudonym</th><th>Your record</th><th>Sex</th><th>Birth month</th><th>District</th><th>Event</th><th>Programme</th><th>Detail</th><th>Date</th></tr></thead>
    <tbody>${result.preview.slice(0, 50).map((r) => `<tr><td class="mono">${esc(r.person)}${r.weakLink ? ' <span class="pill warn" title="No valid ID number: linked by name and birth date">weak</span>' : ''}</td>
      <td class="mono">${esc(r.localId)}</td><td>${esc(r.sex)}</td><td>${esc(r.birthMonth)}</td><td>${esc(r.district)}</td><td>${esc(r.event)}</td>
      <td>${esc(r.programme)}</td><td>${esc(r.detail)}</td><td>${esc(r.date)}</td></tr>`).join('')}</tbody></table></div>`;
  if (s.accepted) {
    pending = { bundle: result.bundle, source: file.name.slice(0, 100) };
    $('send').disabled = false;
  }
}

async function send() {
  if (!pending) return;
  $('send').disabled = true;
  try {
    const res = await api('fhir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', 'X-Submission-Source': pending.source },
      body: JSON.stringify(pending.bundle),
    });
    const c = res.summary;
    $('submit-msg').innerHTML = `<div class="ok-box">Sent. ${c.created} new records, ${c.duplicates} already on file, ${c.patientsCreated} new people, ${c.patientsUpdated} linked to existing people.</div>`;
    $('preview').innerHTML = '';
    pending = null;
  } catch (err) {
    $('submit-msg').innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
    $('send').disabled = false;
  }
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  key = $('api-key').value.trim();
  try { await signIn(); } catch (err) { $('signin-msg').textContent = err.message; }
});
$('signout').addEventListener('click', () => {
  try { sessionStorage.removeItem('registryKey'); } catch { /* ignore */ }
  location.reload();
});
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
$('wl-programme').addEventListener('change', loadWorklist);
$('wl-status').addEventListener('change', loadWorklist);
$('submit-form').addEventListener('submit', (e) => preview(e).catch((err) => { $('submit-msg').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }));
$('send').addEventListener('click', send);

$('mapping').innerHTML = Object.entries(mappings).map(([id, m]) => `<option value="${id}">${esc(m.label)}</option>`).join('');
$('wl-programme').innerHTML = programmeList.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
country = await (await fetch('api/public/country')).json();
if (key) signIn().catch(() => { key = ''; });
