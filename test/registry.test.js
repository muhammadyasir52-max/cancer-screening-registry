import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Registry, suppress } from '../src/registry.js';
import { createOrganization } from '../src/auth.js';
import { loadCountry } from '../src/country.js';
import { buildSubmission } from '../src/ingest/pipeline.js';
import { seedDemo, DEMO_SECRET } from '../src/demo.js';
import { isKAnonymous } from '../src/kanon.js';
import { flagCode, flagProgramme, sourceRecordsOf } from '../src/fhir.js';

const pk = loadCountry('pk');
const today = () => new Date('2026-06-15');
const agreement = (programmes) => ({ reference: 'DSA-T', validFrom: '2026-01-01', validTo: '2027-01-01', programmes });

function setup() {
  const store = new Store();
  const registry = new Registry(store, { country: pk, today });
  const hosp = createOrganization(store, { name: 'H', roles: ['submitter', 'facility'], agreement: agreement() }).org;
  const other = createOrganization(store, { name: 'H2', roles: ['submitter', 'facility'], agreement: agreement(['cervical']) }).org;
  const creg = createOrganization(store, { name: 'CR', roles: ['submitter'], agreement: agreement() }).org;
  return { store, registry, hosp, other, creg };
}

const person = { cnic: '99101-1000001-2', givenName: 'Ayesha', familyName: 'Sampleton', sex: 'female', dateOfBirth: '1984-03-12', district: 'Lahore' };
const submit = async (registry, org, records) => {
  const { bundle, errors } = await buildSubmission(records, { secret: 's', country: pk, orgId: org.id });
  assert.deepEqual(errors, []);
  return registry.ingestTransaction(bundle, org);
};

test('submission creates a de-identified person, results and an alert routed to the facility', async () => {
  const { store, registry, hosp } = setup();
  const res = await submit(registry, hosp, [
    { ...person, recordId: 'H-1', event: 'screen', programme: 'cervical', eventDate: '2026-06-01', test: 'hpv', result: 'positive' },
    { ...person, recordId: 'H-1', event: 'screen', programme: 'cervical', eventDate: '2026-06-01', test: 'cytology', result: 'HSIL' },
  ]);
  assert.deepEqual(res.summary, { patientsCreated: 1, patientsUpdated: 0, created: 2, duplicates: 0 });
  const [p] = store.all('Patient');
  assert.equal(p.name, undefined);
  assert.equal(p.birthDate, '1984-03');
  const alerts = registry.facilityAlerts(hosp);
  assert.deepEqual(alerts.map((a) => `${a.programme}:${a.code}`).sort(), ['breast:never-screened', 'cervical:abnormal-result', 'oral:never-screened']);
  assert.equal(alerts[0].code, 'abnormal-result'); // high priority first
  assert.deepEqual(alerts[0].localIds, ['H-1']);
  assert.equal(store.all('Provenance').length, 1);
});

test('re-submitting the same file is idempotent', async () => {
  const { store, registry, hosp } = setup();
  const rec = [{ ...person, recordId: 'H-1', event: 'screen', programme: 'oral', eventDate: '2026-05-01', test: 'ove', result: 'normal' }];
  await submit(registry, hosp, rec);
  const again = await submit(registry, hosp, rec);
  assert.equal(again.summary.duplicates, 1);
  assert.equal(store.all('Observation').length, 1);
});

test('two sources link the same person by pseudonym; facilities see only their own record numbers', async () => {
  const { store, registry, hosp, other } = setup();
  await submit(registry, hosp, [{ ...person, recordId: 'H-1', event: 'screen', programme: 'oral', eventDate: '2026-05-01', test: 'ove', result: 'normal' }]);
  await submit(registry, other, [{ ...person, recordId: 'K-9', event: 'screen', programme: 'cervical', eventDate: '2026-05-02', test: 'via', result: 'negative' }]);
  assert.equal(store.all('Patient').length, 1);
  assert.deepEqual(sourceRecordsOf(store.all('Patient')[0]).map((s) => s.localId), ['H-1', 'K-9']);
  assert.deepEqual(registry.facilityWorklist(other, { programme: 'cervical' }).map((r) => r.localIds), [['K-9']]);
});

test('a cancer registry diagnosis links to the person, closes alerts and does not take over alert routing', async () => {
  const { store, registry, hosp, creg } = setup();
  await submit(registry, hosp, [{ ...person, recordId: 'H-1', event: 'screen', programme: 'breast', eventDate: '2026-05-20', test: 'mammography', result: '5' }]);
  assert.ok(store.all('Flag').some((f) => f.status === 'active' && flagProgramme(f) === 'breast' && flagCode(f) === 'abnormal-result'));
  await submit(registry, creg, [{ ...person, recordId: 'CR-1', event: 'diagnosis', eventDate: '2026-06-05', topography: 'C50.9', morphology: '8500/3' }]);
  assert.ok(!store.all('Flag').some((f) => f.status === 'active' && flagProgramme(f) === 'breast'));
  assert.equal(store.all('Patient')[0].managingOrganization.reference, `Organization/${hosp.id}`);
});

test('agreements restrict programmes, and identifiable or invalid bundles are rejected whole', async () => {
  const { store, registry, other } = setup();
  const { bundle } = await buildSubmission([{ ...person, recordId: 'K-1', event: 'screen', programme: 'oral', eventDate: '2026-05-01', test: 'ove', result: 'normal' }], { secret: 's', country: pk, orgId: other.id });
  assert.throws(() => registry.ingestTransaction(bundle, other), /not covered by agreement/);

  const named = structuredClone(bundle);
  named.entry[0].resource.name = [{ family: 'Sampleton' }];
  assert.throws(() => registry.ingestTransaction(named, other), /Patient.name is not accepted/);
  assert.equal(store.all('Patient').length, 0);

  const future = structuredClone(bundle);
  future.entry[1].resource.effectiveDateTime = '2030-01-01';
  assert.throws(() => registry.ingestTransaction(future, other), /in the future/);
});

test('expired agreements block submissions', async () => {
  const store = new Store();
  const registry = new Registry(store, { country: pk, today });
  const old = createOrganization(store, { name: 'Old', roles: ['submitter'], agreement: { reference: 'X', validFrom: '2020-01-01', validTo: '2021-01-01' } }).org;
  const { bundle } = await buildSubmission([{ ...person, event: 'opt-out', eventDate: '2026-01-01' }], { secret: 's', country: pk, orgId: old.id });
  assert.throws(() => registry.ingestTransaction(bundle, old), /No active data-sharing agreement/);
});

test('opt-out removes the person from alerts and statistics', async () => {
  const { registry, hosp } = setup();
  await submit(registry, hosp, [{ ...person, recordId: 'H-1', event: 'opt-out', eventDate: '2026-06-01' }]);
  assert.equal(registry.facilityAlerts(hosp).length, 0);
  assert.equal(registry.publicStats().programmes[0].totals.eligible, 0);
});

test('small counts are suppressed', () => {
  assert.equal(suppress(0, 5), 0);
  assert.equal(suppress(4, 5), null);
  assert.equal(suppress(5, 5), 5);
});

test('no hidden statistic can be recovered by subtraction', async () => {
  const registry = new Registry(new Store(), { country: pk, today });
  await seedDemo(registry, { count: 2500 });
  const s = registry.publicStats();
  const leaks = [];
  const check = (parts, total, label) => {
    for (const key of ['eligible', 'covered', 'overdue', 'neverScreened']) {
      const hidden = parts.filter((p) => p[key] === null).length;
      if (total[key] !== null && hidden === 1) leaks.push(`${label} ${key}: one hidden part under a visible total`);
      if (total[key] === null && hidden === 0 && parts.length) leaks.push(`${label} ${key}: hidden total with all parts visible`);
    }
  };
  for (const p of s.programmes) {
    check(p.byAgeBand, p.totals, `${p.id} age`);
    check(p.byProvince, p.totals, `${p.id} provinces`);
    for (const pr of p.byProvince) check(p.byDistrict.filter((d) => d.province === pr.province), pr, `${p.id} ${pr.province}`);
  }
  assert.deepEqual(leaks, []);
});

test('public statistics and extracts carry no identifiers and extracts are k-anonymous', async () => {
  const store = new Store();
  const registry = new Registry(store, { country: pk, today });
  await seedDemo(registry, { count: 800 });
  const stats = JSON.stringify(registry.publicStats());
  for (const p of store.all('Patient')) {
    assert.ok(!stats.includes(p.id));
    for (const id of p.identifier) assert.ok(!stats.includes(id.value));
  }
  for (const prog of ['cervical', 'breast', 'colorectal', 'oral']) {
    const ex = registry.anonymisedExtract(prog);
    assert.ok(ex.rows.length > 0, prog);
    assert.ok(isKAnonymous(ex.rows, pk.kAnonymity), prog);
    const text = JSON.stringify(ex.rows);
    assert.ok(!store.all('Patient').some((p) => text.includes(p.id)));
  }
  assert.equal(JSON.parse(stats).syntheticData, true);
  assert.ok(DEMO_SECRET);
});
