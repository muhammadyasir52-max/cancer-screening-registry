// Source-side pipeline: canonical records -> validated, de-identified FHIR
// transaction Bundle. Runs in Node (submission kit) and in the browser
// (facility portal). Nothing identifying is put into the Bundle.

import { programmes, programmeForSite } from '../programmes/index.js';
import { buildPatient, buildObservation, buildProcedure, buildCondition, buildOptOut, systems } from '../fhir.js';
import { pseudonymFor } from './deidentify.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENTS = ['screen', 'follow-up', 'diagnosis', 'opt-out'];

function provinceFor(district, country) {
  return Object.entries(country.regions).find(([, ds]) => ds.includes(district))?.[0];
}

// Check one canonical record. Returns a list of problems.
export function checkRecord(rec, country) {
  const p = [];
  if (!EVENTS.includes(rec.event)) p.push(`event must be one of ${EVENTS.join(', ')}`);
  if (!['female', 'male'].includes(rec.sex)) p.push('sex must be female or male');
  if (!DATE.test(rec.dateOfBirth || '')) p.push('date of birth must be YYYY-MM-DD');
  if (!DATE.test(rec.eventDate || '')) p.push('event date must be YYYY-MM-DD');
  if (rec.eventDate && rec.dateOfBirth && rec.eventDate < rec.dateOfBirth) p.push('event date is before date of birth');
  if (!rec.district || !provinceFor(rec.district, country)) p.push(`unknown district "${rec.district || ''}"`);
  if (rec.event === 'screen' || rec.event === 'follow-up') {
    const prog = programmes[rec.programme];
    if (!prog) p.push(`unknown programme "${rec.programme || ''}"`);
    else if (rec.event === 'screen') {
      const test = prog.tests[rec.test];
      if (!test) p.push(`unknown ${prog.id} test "${rec.test || ''}" (expected ${Object.keys(prog.tests).join(', ')})`);
      else if (!test.results[rec.result]) p.push(`unknown ${rec.test} result "${rec.result || ''}" (expected ${Object.keys(test.results).join(', ')})`);
    }
  }
  if (rec.event === 'diagnosis' && !/^C\d{2}(\.\d)?$/i.test(rec.topography || '')) p.push('diagnosis needs an ICD-O-3 topography like C53.9');
  return p;
}

/**
 * Build a FHIR transaction Bundle from canonical records.
 * @returns {Promise<{bundle, summary, preview, errors}>}
 */
export async function buildSubmission(records, { secret, country, orgId, synthetic = true, uuid = () => crypto.randomUUID() }) {
  const errors = [];
  const people = new Map(); // pseudonym -> { fullUrl, patient }
  const entries = [];
  const preview = [];
  const stripped = { names: 0, nationalIds: 0, phones: 0, datesOfBirth: 0 };

  for (const [i, rec] of records.entries()) {
    const line = i + 2; // header is line 1
    const problems = checkRecord(rec, country);
    const pid = problems.length ? null : await pseudonymFor(rec, secret, country);
    if (!problems.length && !pid) problems.push('needs a valid national ID, or name and date of birth');
    if (problems.length) {
      errors.push({ line, recordId: rec.recordId || '', problems });
      continue;
    }

    if (rec.givenName || rec.familyName) stripped.names++;
    if (rec.cnic) stripped.nationalIds++;
    if (rec.phone) stripped.phones++;
    stripped.datesOfBirth++;

    let person = people.get(pid.pseudonym);
    if (!person) {
      const patient = buildPatient({
        pseudonym: pid.pseudonym,
        weak: pid.weak,
        birthMonth: rec.dateOfBirth.slice(0, 7),
        sex: rec.sex,
        district: rec.district,
        province: provinceFor(rec.district, country),
        country: country.code,
        orgId,
        localId: rec.recordId,
        synthetic,
      });
      const system = pid.weak ? systems.pseudonymWeak : systems.pseudonym;
      person = { fullUrl: `urn:uuid:${uuid()}`, patient };
      people.set(pid.pseudonym, person);
      entries.push({
        fullUrl: person.fullUrl,
        resource: patient,
        request: { method: 'PUT', url: `Patient?identifier=${encodeURIComponent(`${system}|${pid.pseudonym}`)}` },
      });
    }

    const subject = { reference: person.fullUrl };
    const resource = toResource(rec, subject, orgId, synthetic);
    entries.push({ fullUrl: `urn:uuid:${uuid()}`, resource, request: { method: 'POST', url: resource.resourceType } });
    preview.push({
      person: pid.pseudonym.slice(0, 10),
      weakLink: pid.weak,
      localId: rec.recordId || '',
      sex: rec.sex,
      birthMonth: rec.dateOfBirth.slice(0, 7),
      district: rec.district,
      event: rec.event,
      programme: rec.programme || programmeForSite(rec.topography)?.id || '',
      detail: rec.event === 'screen' ? `${rec.test} ${rec.result}` : rec.event === 'diagnosis' ? `${rec.topography} ${rec.morphology || ''}`.trim() : '',
      date: rec.eventDate,
    });
  }

  return {
    bundle: { resourceType: 'Bundle', type: 'transaction', entry: entries },
    summary: { rows: records.length, accepted: preview.length, rejected: errors.length, people: people.size, stripped },
    preview,
    errors,
  };
}

function toResource(rec, subject, orgId, synthetic) {
  switch (rec.event) {
    case 'screen': {
      const test = programmes[rec.programme].tests[rec.test];
      return buildObservation({ subject, date: rec.eventDate, test, value: test.results[rec.result], orgId, synthetic });
    }
    case 'follow-up': {
      const f = programmes[rec.programme].followUp;
      return buildProcedure({ subject, date: rec.eventDate, coding: f.coding, label: f.label, orgId, synthetic });
    }
    case 'diagnosis':
      return buildCondition({ subject, date: rec.eventDate, topography: rec.topography.toUpperCase(), morphology: rec.morphology, orgId, synthetic });
    default:
      return buildOptOut({ subject, date: rec.eventDate, orgId, synthetic });
  }
}
