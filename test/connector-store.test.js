import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullFromFhir } from '../src/connectors/fhir.js';
import { openStore } from '../src/store.js';
import { programmes } from '../src/programmes/index.js';
import { buildPatient } from '../src/fhir.js';

test('FHIR connector pulls screening events and their patients, following paging', async () => {
  const fit = programmes.colorectal.tests.fit;
  const hospital = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/fhir+json' }); res.end(JSON.stringify(b)); };
    if (url.pathname === '/fhir/Observation' && !url.searchParams.get('page')) {
      return send({ resourceType: 'Bundle', link: [{ relation: 'next', url: `http://127.0.0.1:${hospital.address().port}/fhir/Observation?page=2` }],
        entry: [{ resource: { resourceType: 'Observation', id: 'o1', subject: { reference: 'Patient/p1' }, code: { coding: [fit.coding] }, effectiveDateTime: '2026-05-01', valueCodeableConcept: { coding: [fit.results.positive] } } }] });
    }
    if (url.pathname === '/fhir/Observation') {
      return send({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'o2', subject: { reference: 'Patient/p1' }, code: { coding: [{ system: 'http://loinc.org', code: '0000-0' }] } } }] });
    }
    if (url.pathname === '/fhir/Procedure') {
      return send({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Procedure', id: 'pr1', subject: { reference: 'Patient/p1' }, code: { coding: [programmes.colorectal.followUp.coding] }, performedDateTime: '2026-05-20' } }] });
    }
    if (url.pathname === '/fhir/Patient/p1') {
      return send({ resourceType: 'Patient', id: 'p1', name: [{ given: ['Imran'], family: 'Fixture' }], gender: 'male', birthDate: '1966-08-19',
        identifier: [{ system: 'urn:cnic', value: '99202-2000003-5' }], address: [{ district: 'Hyderabad' }] });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => hospital.listen(0, r));
  try {
    const { records, skipped } = await pullFromFhir({ baseUrl: `http://127.0.0.1:${hospital.address().port}/fhir`, nationalIdSystem: 'urn:cnic' });
    assert.deepEqual(records.map((r) => [r.event, r.programme, r.test, r.result, r.cnic]), [
      ['screen', 'colorectal', 'fit', 'positive', '99202-2000003-5'],
      ['follow-up', 'colorectal', undefined, undefined, '99202-2000003-5'],
    ]);
    assert.equal(skipped.length, 1);
  } finally {
    hospital.close();
  }
});

test('SQLite store persists resources and indexes across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  const file = join(dir, 'test.db');
  try {
    let store = await openStore({ kind: 'sqlite', file });
    const p = store.create(buildPatient({ pseudonym: 'abc', birthMonth: '1980-01', sex: 'female', district: 'Lahore', province: 'Punjab', country: 'PK' }));
    store.update({ ...p, gender: 'male' });
    store.backend.db.close();

    store = await openStore({ kind: 'sqlite', file });
    const again = store.findByIdentifier('https://example.org/cancer-registry/fhir/sid/pseudonym', 'abc');
    assert.equal(again.id, p.id);
    assert.equal(again.gender, 'male');
    assert.equal(again.meta.versionId, '2');
    store.backend.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
