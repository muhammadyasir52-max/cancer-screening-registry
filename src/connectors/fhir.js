// Connector for sources that already run a FHIR R4 server (hospital EMR,
// laboratory system or regional registry). Pulls screening Observations and
// follow-up Procedures changed since a date, plus the Patients they refer to,
// and turns them into canonical records for the de-identification pipeline.
// It runs inside the source's network, as part of the submission kit.

import { programmeList, identifyObservation, identifyProcedure } from '../programmes/index.js';

async function* pages(url, headers, fetchImpl) {
  let next = url;
  while (next) {
    const res = await fetchImpl(next, { headers });
    if (!res.ok) throw new Error(`${next}: HTTP ${res.status}`);
    const bundle = await res.json();
    yield bundle.entry?.map((e) => e.resource) || [];
    next = bundle.link?.find((l) => l.relation === 'next')?.url || null;
  }
}

export async function pullFromFhir({ baseUrl, token, since = '1900-01-01', nationalIdSystem, fetchImpl = fetch }) {
  const headers = { Accept: 'application/fhir+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const base = baseUrl.replace(/\/$/, '');
  const testCodes = programmeList.flatMap((p) => Object.values(p.tests).map((t) => `${t.coding.system}|${t.coding.code}`));
  const followCodes = programmeList.map((p) => `${p.followUp.coding.system}|${p.followUp.coding.code}`);

  const clinical = [];
  for await (const page of pages(`${base}/Observation?code=${encodeURIComponent(testCodes.join(','))}&_lastUpdated=gt${since}&_count=200`, headers, fetchImpl)) clinical.push(...page);
  for await (const page of pages(`${base}/Procedure?code=${encodeURIComponent(followCodes.join(','))}&_lastUpdated=gt${since}&_count=200`, headers, fetchImpl)) clinical.push(...page);

  const patients = new Map();
  const records = [];
  const skipped = [];
  for (const r of clinical) {
    const ref = r.subject?.reference;
    if (!ref) { skipped.push(`${r.resourceType}/${r.id}: no subject`); continue; }
    if (!patients.has(ref)) {
      const res = await fetchImpl(`${base}/${ref}`, { headers });
      patients.set(ref, res.ok ? await res.json() : null);
    }
    const person = toPerson(patients.get(ref), nationalIdSystem);
    if (!person) { skipped.push(`${r.resourceType}/${r.id}: patient ${ref} unavailable`); continue; }
    if (r.resourceType === 'Observation') {
      const id = identifyObservation(r);
      if (!id?.result) { skipped.push(`Observation/${r.id}: unrecognised result`); continue; }
      records.push({ ...person, event: 'screen', programme: id.programme.id, test: id.testKey, result: id.result, eventDate: (r.effectiveDateTime || '').slice(0, 10) });
    } else {
      const prog = identifyProcedure(r);
      records.push({ ...person, event: 'follow-up', programme: prog.id, eventDate: (r.performedDateTime || '').slice(0, 10) });
    }
  }
  return { records, skipped };
}

function toPerson(p, nationalIdSystem) {
  if (!p) return null;
  const name = p.name?.[0] || {};
  return {
    recordId: p.id,
    cnic: p.identifier?.find((i) => i.system === nationalIdSystem)?.value,
    givenName: (name.given || []).join(' '),
    familyName: name.family,
    sex: p.gender,
    dateOfBirth: p.birthDate,
    district: p.address?.[0]?.district,
  };
}
