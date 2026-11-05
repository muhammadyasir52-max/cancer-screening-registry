import { programmeList } from './lib/programmes/index.js';
import { $, esc, badge, chrome, dataTable, loadingTable, toast } from './ui.js';

chrome('admin');

let key = '';
let audit = [];
let auditTable;
try { key = sessionStorage.getItem('adminKey') || ''; } catch { /* storage unavailable */ }

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}), Authorization: `Bearer ${key}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.issue?.map((i) => i.diagnostics).join('; ') || `HTTP ${res.status}`);
  return data;
}

const today = new Date().toISOString().slice(0, 10);
const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
function agreementState(a) {
  if (!a.reference || a.validTo < today || a.validFrom > today) return ['Expired or not started', 'critical'];
  if (a.validTo <= in60) return ['Expires soon', 'warning'];
  return ['Active', 'good'];
}
const when = (iso) => iso.replace('T', ' ').slice(0, 16);
const refused = (a) => Number(a.outcome) >= 400;

async function load() {
  ['orgs', 'imports', 'audit'].forEach((id) => loadingTable($(id), 5));
  const [orgs, imports, log] = await Promise.all([api('api/admin/organizations'), api('api/admin/imports'), api('api/admin/audit?limit=500')]);
  try { sessionStorage.setItem('adminKey', key); } catch { /* ignore */ }
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('head-actions').classList.remove('hidden');
  audit = log;

  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const scored = imports.filter((i) => typeof i.qualityScore === 'number');
  const avg = scored.length ? Math.round(scored.reduce((a, i) => a + i.qualityScore, 0) / scored.length) : null;
  $('summary').innerHTML = [
    ['Organisations', orgs.length, `${orgs.filter((o) => agreementState(o.agreement)[1] === 'good').length} with active agreements`],
    ['Imports, last 30 days', imports.filter((i) => i.recorded >= since30).length, `${imports.length} in total`],
    ['Average data quality', avg === null ? '—' : `${avg}/100`, `${scored.length} scored submissions`],
    ['Refused requests', log.filter(refused).length, 'In the latest 500 audit entries'],
  ].map(([l, v, s]) => `<div class="card kpi"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join('');

  dataTable($('orgs'), {
    columns: [
      { key: 'name', label: 'Organisation' },
      { key: 'roles', label: 'Roles', html: (o) => o.roles.map((r) => badge(r, 'neutral')).join(' '), text: (o) => o.roles.join(' ') },
      { key: 'reference', label: 'Agreement', html: (o) => `<span class="mono">${esc(o.agreement.reference)}</span>`, text: (o) => o.agreement.reference, sortValue: (o) => o.agreement.reference },
      { key: 'state', label: 'Status', html: (o) => badge(...agreementState(o.agreement)), sortValue: (o) => agreementState(o.agreement)[0] },
      { key: 'valid', label: 'Valid', html: (o) => esc(`${o.agreement.validFrom} → ${o.agreement.validTo}`), sortValue: (o) => o.agreement.validTo },
      { key: 'programmes', label: 'Programmes', html: (o) => esc(o.agreement.programmes.join(', ')), text: (o) => o.agreement.programmes.join(' ') },
      { key: 'purpose', label: 'Purpose', html: (o) => esc(o.agreement.purpose) },
    ],
    rows: orgs,
    pageSize: 15,
  });

  dataTable($('imports'), {
    columns: [
      { key: 'recorded', label: 'When', html: (i) => esc(when(i.recorded)) },
      { key: 'organization', label: 'Organisation' },
      { key: 'agreement', label: 'Agreement', html: (i) => `<span class="mono">${esc(i.agreement)}</span>` },
      { key: 'source', label: 'Source' },
      { key: 'qualityScore', label: 'Quality', num: true, sortValue: (i) => i.qualityScore ?? -1,
        html: (i) => (i.qualityScore === null ? '—' : badge(`${i.qualityScore}/100`, i.qualityScore >= 90 ? 'good' : i.qualityScore >= 75 ? 'warning' : 'critical')) },
      { key: 'records', label: 'Records', sortable: false,
        html: (i) => `${esc(`${i.counts.created ?? 0} new, ${i.counts.duplicates ?? 0} duplicate; ${i.counts.patientsCreated ?? 0} new people, ${i.counts.patientsUpdated ?? 0} linked`)}${i.counts.duplicateFile ? ` ${badge('File sent before', 'warning')}` : ''}` },
    ],
    rows: imports,
    pageSize: 10,
    empty: 'No imports yet.',
  });

  const orgNames = [...new Set(log.map((a) => a.organization || 'anonymous'))].sort();
  $('audit-org').innerHTML = `<option value="">All</option>${orgNames.map((n) => `<option>${esc(n)}</option>`).join('')}`;
  auditTable = null;
  renderAudit();
}

function renderAudit() {
  const org = $('audit-org').value;
  const onlyRefused = $('audit-result').value === 'refused';
  const rows = audit.filter((a) => (!org || (a.organization || 'anonymous') === org) && (!onlyRefused || refused(a)));
  const columns = [
    { key: 'recorded', label: 'When', html: (a) => esc(when(a.recorded)) },
    { key: 'organization', label: 'Organisation', html: (a) => esc(a.organization || 'anonymous') },
    { key: 'action', label: 'Action', html: (a) => esc({ R: 'Read', C: 'Create', U: 'Update', D: 'Delete', E: 'Execute' }[a.action] || a.action) },
    { key: 'path', label: 'Path', html: (a) => `<span class="mono">${esc(a.path)}</span>` },
    { key: 'outcome', label: 'Result', html: (a) => (refused(a) ? badge(`Refused (${a.outcome})`, 'critical') : badge(a.outcome, 'good')) },
  ];
  if (auditTable) auditTable.update(rows);
  else auditTable = dataTable($('audit'), { columns, rows, pageSize: 20, rowClass: (a) => (refused(a) ? 'refused' : '') });
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  key = $('api-key').value.trim();
  try { await load(); } catch (err) { $('signin-msg').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
});
$('audit-org').addEventListener('change', renderAudit);
$('audit-result').addEventListener('change', renderAudit);

$('open-add').addEventListener('click', () => { $('org-msg').innerHTML = ''; $('add-dialog').showModal(); });
$('close-add').addEventListener('click', () => $('add-dialog').close());
$('org-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { organization, apiKey } = await api('api/admin/organizations', {
      method: 'POST',
      body: JSON.stringify({
        name: f.get('name'),
        roles: f.getAll('roles'),
        agreement: { reference: f.get('reference'), validFrom: f.get('validFrom'), validTo: f.get('validTo'), purpose: f.get('purpose'), programmes: f.getAll('programmes') },
      }),
    });
    $('org-msg').innerHTML = `<div class="ok-box">Created <strong>${esc(organization.name)}</strong>. Give them this API key over a secure channel. It is shown once and is not stored:</div>
      <div class="keybox mono">${esc(apiKey)}</div>`;
    e.target.reset();
    load();
  } catch (err) { $('org-msg').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
});

$('run-rules').addEventListener('click', async () => {
  try {
    const r = await api('api/admin/rules/run', { method: 'POST' });
    toast(`Rules run for ${r.patients} people: ${r.opened} alerts opened, ${r.closed} closed.`);
  } catch (err) { toast(err.message); }
});

$('programme-checks').innerHTML = programmeList.map((p) =>
  `<label class="check"><input type="checkbox" name="programmes" value="${esc(p.id)}" checked> ${esc(p.name)}</label>`).join('');
if (key) load().catch(() => { key = ''; });
