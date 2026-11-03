import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDelimited } from '../src/ingest/csv.js';
import { mappings, applyMapping } from '../src/ingest/mappings.js';
import { buildSubmission } from '../src/ingest/pipeline.js';
import { pseudonymFor, normaliseNationalId } from '../src/ingest/deidentify.js';
import { directIdentifierProblems } from '../src/fhir.js';
import { loadCountry } from '../src/country.js';
import { generateRecords } from '../src/synthetic.js';

const pk = loadCountry('pk');
const secret = 'test-secret';
const sample = (name) => readFileSync(new URL(`../public/samples/${name}`, import.meta.url), 'utf8');
const load = (name, mapping) => applyMapping(parseDelimited(sample(name)), mappings[mapping]);

test('CNIC normalisation accepts dashed and plain forms only', () => {
  assert.equal(normaliseNationalId('99101-1000001-2', pk), '9910110000012');
  assert.equal(normaliseNationalId('9910110000012', pk), '9910110000012');
  assert.equal(normaliseNationalId('12345', pk), null);
  assert.equal(normaliseNationalId('99101-100000-12', pk), null);
});

test('same ID gives the same pseudonym; a different key gives a different one', async () => {
  const a = await pseudonymFor({ cnic: '99101-1000001-2' }, secret, pk);
  const b = await pseudonymFor({ cnic: '9910110000012' }, secret, pk);
  const c = await pseudonymFor({ cnic: '9910110000012' }, 'other-key', pk);
  assert.equal(a.pseudonym, b.pseudonym);
  assert.notEqual(a.pseudonym, c.pseudonym);
  assert.equal(a.weak, false);
  assert.ok(!a.pseudonym.includes('9910110000012'));
});

test('without an ID, falls back to a weak name+DOB pseudonym', async () => {
  const r = await pseudonymFor({ givenName: 'Zainab', familyName: 'Dummy', dateOfBirth: '1990-05-05', district: 'Rawalpindi' }, secret, pk);
  assert.equal(r.weak, true);
});

test('standard template: valid rows accepted, bad row rejected with reasons', async () => {
  const { summary, errors, bundle } = await buildSubmission(load('standard-template.csv', 'standard'), { secret, country: pk, orgId: 'o1' });
  assert.equal(summary.rows, 11);
  assert.equal(summary.accepted, 10);
  assert.equal(errors.length, 1);
  assert.match(errors[0].problems.join(' '), /unknown district/);
  assert.equal(summary.people, 7);
  assert.equal(bundle.type, 'transaction');
});

test('example hospital export and CanReg5 export map correctly', async () => {
  const hosp = await buildSubmission(load('example-hospital.csv', 'example-hospital'), { secret, country: pk, orgId: 'o1' });
  assert.equal(hosp.summary.accepted, 4, JSON.stringify(hosp.errors));
  assert.deepEqual(hosp.preview.map((p) => p.programme), ['cervical', 'breast', 'colorectal', 'cervical']);

  const canreg = await buildSubmission(load('canreg5-export.tsv', 'canreg5'), { secret, country: pk, orgId: 'o2' });
  assert.equal(canreg.summary.accepted, 3, JSON.stringify(canreg.errors));
  assert.deepEqual(canreg.preview.map((p) => p.programme), ['cervical', 'oral', 'breast']);
  const cond = canreg.bundle.entry.find((e) => e.resource.resourceType === 'Condition').resource;
  assert.equal(cond.bodySite[0].coding[0].code, 'C53.9');
  assert.equal(cond.code.coding[0].code, '8070/3');
});

test('nothing identifying leaves the source', async () => {
  const records = generateRecords(pk, { count: 400, today: new Date('2026-06-15') }).lahore;
  const { bundle } = await buildSubmission(records, { secret, country: pk, orgId: 'o1' });
  const text = JSON.stringify(bundle);
  for (const r of records) {
    assert.ok(!text.includes(r.cnic), 'leaks a CNIC');
    assert.ok(!text.includes(r.cnic.replace(/-/g, '')), 'leaks a CNIC');
    assert.ok(!text.includes(r.phone), 'leaks a phone number');
    assert.ok(!text.includes(`"${r.dateOfBirth}"`), 'leaks a full date of birth');
  }
  for (const name of ['Ayesha', 'Fatima', 'Usman', 'Sampleton', 'Placeholder']) assert.ok(!text.includes(name), `leaks name ${name}`);
  for (const e of bundle.entry) {
    if (e.resource.resourceType === 'Patient') assert.deepEqual(directIdentifierProblems(e.resource), []);
  }
});

test('the server-side guard catches identifiable Patients', () => {
  const p = directIdentifierProblems({
    resourceType: 'Patient', name: [{ family: 'X' }], telecom: [{ value: '1' }], birthDate: '1990-01-02',
    identifier: [{ system: 'http://nadra.gov.pk/fhir/sid/cnic', value: '9910110000012' }], address: [{ line: ['1 Road'] }],
  });
  assert.equal(p.length, 6);
});
