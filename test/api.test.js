import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { Registry } from '../src/registry.js';
import { createApp } from '../src/app.js';
import { loadCountry } from '../src/country.js';
import { seedDemo, DEMO_SECRET } from '../src/demo.js';
import { submitRecords } from '../src/kit.js';
import { parseDelimited } from '../src/ingest/csv.js';
import { mappings, applyMapping } from '../src/ingest/mappings.js';

let server;
let base;
const pk = loadCountry('pk');

before(async () => {
  const registry = new Registry(new Store(), { country: pk });
  await seedDemo(registry, { count: 400 });
  server = createServer(createApp(registry));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, key) => fetch(base + path, { headers: key ? { Authorization: `Bearer ${key}` } : {} });

test('public endpoints need no key and carry no identifiers', async () => {
  const res = await get('/api/public/stats');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const stats = await res.json();
  assert.deepEqual(stats.programmes.map((p) => p.id), ['cervical', 'breast', 'colorectal', 'oral']);
  assert.equal((await get('/fhir/metadata')).status, 200);
  assert.equal((await get('/')).status, 200);
});

test('only whitelisted source modules are served to browsers', async () => {
  assert.equal((await get('/lib/ingest/pipeline.js')).status, 200);
  assert.equal((await get('/lib/server.js')).status, 404);
  assert.equal((await get('/lib/auth.js')).status, 404);
  assert.equal((await get('/lib/../package.json')).status, 404);
});

test('authentication and roles are enforced', async () => {
  assert.equal((await get('/api/me')).status, 401);
  assert.equal((await get('/api/me', 'wrong-key')).status, 401);
  assert.equal((await get('/api/facility/alerts', 'demo-research-key')).status, 403);
  assert.equal((await get('/api/export?programme=cervical', 'demo-lahore-key')).status, 403);
  assert.equal((await get('/fhir/Patient', 'demo-lahore-key')).status, 403);
  assert.equal((await get('/api/admin/audit', 'demo-karachi-key')).status, 403);
  const post = await fetch(`${base}/fhir`, { method: 'POST', headers: { Authorization: 'Bearer demo-research-key' }, body: '{}' });
  assert.equal(post.status, 403);
});

test('facilities see only their own people', async () => {
  const lahore = await (await get('/api/facility/alerts', 'demo-lahore-key')).json();
  const karachi = await (await get('/api/facility/alerts', 'demo-karachi-key')).json();
  assert.ok(lahore.length > 0 && karachi.length > 0);
  assert.ok(lahore.every((a) => a.localIds.every((id) => id.startsWith('LHR-'))));
  assert.ok(karachi.every((a) => a.localIds.every((id) => id.startsWith('KHI-'))));
});

test('consumers get k-anonymous NDJSON only for programmes in their agreement', async () => {
  const res = await get('/api/export?programme=cervical', 'demo-research-key');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-k-anonymity'), '5');
  const rows = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length > 0);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['ageBand', 'diagnosed', 'district', 'lastOutcome', 'programme', 'province', 'sex', 'status', 'year']);
  assert.equal((await get('/api/export?programme=colorectal', 'demo-research-key')).status, 403);
});

test('the submission kit de-identifies a hospital export and the registry accepts it', async () => {
  const records = applyMapping(parseDelimited(readFileSync(new URL('../public/samples/example-hospital.csv', import.meta.url), 'utf8')), mappings['example-hospital']);
  const result = await submitRecords({ records, registryUrl: base, apiKey: 'demo-karachi-key', secret: DEMO_SECRET, country: pk, source: 'example-hospital.csv' });
  assert.equal(result.summary.accepted, 4);
  assert.equal(result.response.created, 4);
  const again = await submitRecords({ records, registryUrl: base, apiKey: 'demo-karachi-key', secret: DEMO_SECRET, country: pk, source: 'example-hospital.csv' });
  assert.equal(again.response.duplicates, 4);
});

test('admins create organisations; keys are returned once and work immediately', async () => {
  const res = await fetch(`${base}/api/admin/organizations`, {
    method: 'POST',
    headers: { Authorization: 'Bearer demo-admin-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Clinic', roles: ['submitter', 'facility'], agreement: { reference: 'DSA-NEW', validFrom: '2026-01-01', validTo: '2030-01-01' } }),
  });
  assert.equal(res.status, 201);
  const { apiKey } = await res.json();
  assert.match(apiKey, /^csr_/);
  const me = await (await get('/api/me', apiKey)).json();
  assert.equal(me.name, 'New Clinic');
  const orgs = JSON.stringify(await (await get('/api/admin/organizations', 'demo-admin-key')).json());
  assert.ok(!orgs.includes(apiKey), 'API key must not be retrievable');
});

test('an organisation whose agreement has expired loses all access', async () => {
  const res = await fetch(`${base}/api/admin/organizations`, {
    method: 'POST',
    headers: { Authorization: 'Bearer demo-admin-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Lapsed Clinic', roles: ['submitter', 'facility'], agreement: { reference: 'DSA-OLD', validFrom: '2020-01-01', validTo: '2021-01-01' } }),
  });
  const { apiKey } = await res.json();
  assert.equal((await get('/api/facility/alerts', apiKey)).status, 403);
  assert.equal((await get('/api/me', apiKey)).status, 403);
});

test('quality summaries are validated, stored with the import, and repeated files are flagged', async () => {
  const records = applyMapping(parseDelimited(readFileSync(new URL('../public/samples/messy-hospital-export.csv', import.meta.url), 'utf8')), mappings.standard);
  const first = await submitRecords({ records, registryUrl: base, apiKey: 'demo-lahore-key', secret: DEMO_SECRET, country: pk, source: 'messy.csv', fileSha256: 'b'.repeat(64) });
  assert.ok(first.response.created > 0);
  assert.equal(first.response.duplicateFile, undefined);
  const again = await submitRecords({ records, registryUrl: base, apiKey: 'demo-lahore-key', secret: DEMO_SECRET, country: pk, source: 'messy.csv', fileSha256: 'b'.repeat(64) });
  assert.equal(again.response.duplicateFile, true);
  const imports = await (await get('/api/admin/imports', 'demo-admin-key')).json();
  assert.equal(imports[0].qualityScore, first.quality.summary.score);
  assert.ok(imports[0].counts.duplicateFile);
  const stats = await (await get('/api/public/stats')).json();
  assert.ok(stats.dataQuality.submissions >= 2);

  const bad = await fetch(`${base}/fhir`, {
    method: 'POST',
    headers: { Authorization: 'Bearer demo-lahore-key', 'X-Quality-Summary': JSON.stringify({ schema: 'quality-summary/1', patientName: 'Ayesha' }) },
    body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: [] }),
  });
  assert.equal(bad.status, 422);
  const tooBig = await fetch(`${base}/fhir`, { method: 'POST', headers: { Authorization: 'Bearer demo-lahore-key', 'X-Quality-Summary': 'x'.repeat(9000) }, body: '{}' });
  assert.equal(tooBig.status, 413);

  const blocked = await submitRecords({ records, registryUrl: base, apiKey: 'demo-lahore-key', secret: DEMO_SECRET, country: pk, source: 'messy.csv', blockOnCritical: true });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.response, null);
});

test('the AI assistant is switched off in the MVP', async () => {
  assert.deepEqual(await (await get('/api/public/assistant')).json(), { enabled: false });
  const res = await fetch(`${base}/api/assistant`, { method: 'POST', headers: { Authorization: 'Bearer demo-lahore-key' }, body: '{}' });
  assert.equal(res.status, 503);
  assert.equal((await fetch(`${base}/api/assistant`, { method: 'POST', body: '{}' })).status, 401);
});

test('browser modules for quality checks are served; server modules are not', async () => {
  assert.equal((await get('/lib/quality/index.js')).status, 200);
  assert.equal((await get('/lib/assistant.js')).status, 404);
  assert.equal((await get('/lib/kit.js')).status, 404);
});

test('every authenticated request is audited, including refusals', async () => {
  await get('/api/facility/alerts', 'demo-research-key');
  const log = await (await get('/api/admin/audit', 'demo-admin-key')).json();
  assert.ok(log.some((a) => a.path === '/api/facility/alerts' && a.outcome === '403' && a.organization === 'Demo University Research Group'));
  assert.ok(log.some((a) => a.path === '/fhir' && a.outcome === '200'));
});
