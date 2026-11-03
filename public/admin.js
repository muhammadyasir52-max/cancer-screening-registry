import { programmeList } from './lib/programmes/index.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let key = '';
try { key = sessionStorage.getItem('adminKey') || ''; } catch { /* storage unavailable */ }

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}), Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.issue?.map((i) => i.diagnostics).join('; ') || `HTTP ${res.status}`);
  return data;
}

async function load() {
  const [orgs, imports, audit] = await Promise.all([api('api/admin/organizations'), api('api/admin/imports'), api('api/admin/audit')]);
  try { sessionStorage.setItem('adminKey', key); } catch { /* ignore */ }
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('orgs').innerHTML = `<thead><tr><th>Organisation</th><th>Roles</th><th>Agreement</th><th>Valid</th><th>Programmes</th><th>Purpose</th></tr></thead>
    <tbody>${orgs.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.roles.join(', '))}</td><td class="mono">${esc(o.agreement.reference)}</td>
      <td>${esc(o.agreement.validFrom)} → ${esc(o.agreement.validTo)}</td><td>${esc(o.agreement.programmes.join(', '))}</td><td>${esc(o.agreement.purpose)}</td></tr>`).join('')}</tbody>`;
  $('imports').innerHTML = `<thead><tr><th>When</th><th>Organisation</th><th>Agreement</th><th>Source</th><th>Records</th></tr></thead>
    <tbody>${imports.map((i) => `<tr><td>${esc(i.recorded.replace('T', ' ').slice(0, 19))}</td><td>${esc(i.organization)}</td><td class="mono">${esc(i.agreement)}</td>
      <td>${esc(i.source)}</td><td>${esc(`${i.counts.created} new, ${i.counts.duplicates} duplicate, ${i.counts.patientsCreated} new people, ${i.counts.patientsUpdated} linked`)}</td></tr>`).join('')}</tbody>`;
  $('audit').innerHTML = `<thead><tr><th>When</th><th>Organisation</th><th>Action</th><th>Path</th><th>Result</th></tr></thead>
    <tbody>${audit.map((a) => `<tr><td>${esc(a.recorded.replace('T', ' ').slice(0, 19))}</td><td>${esc(a.organization)}</td><td>${esc(a.action)}</td>
      <td class="mono">${esc(a.path)}</td><td>${esc(a.outcome)}</td></tr>`).join('')}</tbody>`;
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  key = $('api-key').value.trim();
  try { await load(); } catch (err) { $('signin-msg').textContent = err.message; }
});

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
    $('org-msg').innerHTML = `<div class="ok-box">Created <strong>${esc(organization.name)}</strong>. Give them this API key over a secure channel. It is shown once and not stored:</div>
      <div class="keybox mono">${esc(apiKey)}</div>`;
    e.target.reset();
    await load();
  } catch (err) { $('org-msg').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
});

$('run-rules').addEventListener('click', async () => {
  const r = await api('api/admin/rules/run', { method: 'POST' });
  $('rules-msg').textContent = `Rules run for ${r.patients} people: ${r.opened} alerts opened, ${r.closed} closed.`;
});

$('programme-checks').innerHTML = programmeList.map((p) =>
  `<label class="check"><input type="checkbox" name="programmes" value="${p.id}" checked> ${p.name}</label>`).join('');
if (key) load().catch(() => { key = ''; });
