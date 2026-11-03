// The registry core: accepts de-identified submissions, runs the rules for
// every programme, keeps alerts (Flags) in sync, routes them to facilities, and
// produces anonymised statistics and extracts.

import { evaluate, isoDate, STATUS, OUTCOMES } from './rules.js';
import { programmes, programmeList, identifyObservation, identifyProcedure, programmeForSite } from './programmes/index.js';
import {
  buildFlag, buildProvenance, buildAuditEvent, flagCode, flagProgramme, districtOf, provinceOf,
  pseudonymOf, sourceRecordsOf, directIdentifierProblems, systems, codeIn,
} from './fhir.js';
import { agreementCovers, agreementOf, describeOrg, rolesOf } from './auth.js';
import { anonymise, fiveYearBand } from './kanon.js';

export class IngestError extends Error {
  constructor(problems) {
    super(problems.slice(0, 20).join('; ') + (problems.length > 20 ? `; …and ${problems.length - 20} more` : ''));
    this.status = 422;
    this.problems = problems;
  }
}

const CLINICAL = ['Observation', 'Procedure', 'Condition', 'Consent'];

export class Registry {
  constructor(store, { country, today = () => new Date() }) {
    this.store = store;
    this.country = country;
    this.today = today;
    this.version = 0;
    this.statsCache = null;
  }

  todayIso() { return isoDate(this.today()); }
  params(programmeId) { return this.country.programmes[programmeId]; }

  // --- Rules and alerts ----------------------------------------------------

  isOptedOut(patientId) {
    return this.store.forPatient('Consent', patientId).some((c) => c.status === 'active' && c.provision?.type === 'deny');
  }

  evaluatePatient(patientId, only = null) {
    const patient = this.store.read('Patient', patientId);
    if (!patient) return null;
    const input = {
      patient,
      observations: this.store.forPatient('Observation', patientId),
      procedures: this.store.forPatient('Procedure', patientId),
      conditions: this.store.forPatient('Condition', patientId),
      optedOut: this.isOptedOut(patientId),
    };
    const list = only ? [programmes[only]] : programmeList;
    return list.map((p) => evaluate(input, p, this.params(p.id), this.today()));
  }

  // Re-run every programme for one person and open/close her or his Flags.
  refreshPatient(patientId) {
    const patient = this.store.read('Patient', patientId);
    if (!patient) return null;
    const today = this.todayIso();
    const orgId = patient.managingOrganization?.reference?.replace(/^Organization\//, '');
    const wanted = new Map();
    for (const e of this.evaluatePatient(patientId)) {
      for (const a of e.alerts) wanted.set(`${e.programme}|${a.code}`, { ...a, programme: e.programme });
    }
    const changes = { opened: 0, closed: 0 };
    for (const flag of this.store.forPatient('Flag', patientId)) {
      if (flag.status !== 'active') continue;
      const key = `${flagProgramme(flag)}|${flagCode(flag)}`;
      const want = wanted.get(key);
      if (want) {
        wanted.delete(key);
        if (flag.code.text !== want.detail) this.store.update({ ...flag, code: { ...flag.code, text: want.detail } });
      } else {
        this.store.update({ ...flag, status: 'inactive', period: { ...flag.period, end: today } });
        changes.closed++;
      }
    }
    for (const a of wanted.values()) {
      this.store.create(buildFlag({ patientId, programme: a.programme, code: a.code, start: today, detail: a.detail, orgId }));
      changes.opened++;
    }
    this.version++;
    return changes;
  }

  refreshAll() {
    const totals = { patients: 0, opened: 0, closed: 0 };
    for (const p of this.store.all('Patient')) {
      const c = this.refreshPatient(p.id);
      totals.patients++;
      totals.opened += c.opened;
      totals.closed += c.closed;
    }
    this.store.save();
    return totals;
  }

  // --- Data in ---------------------------------------------------------------

  /**
   * Apply a de-identified FHIR transaction Bundle from an organisation.
   * All-or-nothing: any problem rejects the whole Bundle.
   */
  ingestTransaction(bundle, org, { source = 'api' } = {}) {
    const today = this.todayIso();
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'transaction') throw new IngestError(['Body must be a FHIR transaction Bundle']);
    if (!agreementCovers(org, today)) throw new IngestError([`No active data-sharing agreement for ${org.name}`]);
    const entries = bundle.entry || [];
    const problems = [];
    const urnPatients = new Set();

    // 1. Validate everything first.
    entries.forEach((e, i) => {
      const r = e.resource;
      const at = `entry[${i}]`;
      if (!r) return problems.push(`${at}: missing resource`);
      if (r.resourceType === 'Patient') {
        directIdentifierProblems(r).forEach((p) => problems.push(`${at}: ${p}`));
        urnPatients.add(e.fullUrl);
        return;
      }
      if (!CLINICAL.includes(r.resourceType)) return problems.push(`${at}: ${r.resourceType} is not accepted`);
      const ref = (r.subject || r.patient)?.reference;
      if (!urnPatients.has(ref) && !this.#visiblePatient(ref, org)) problems.push(`${at}: subject must reference a Patient in this Bundle`);
      const prog = this.#programmeOf(r);
      if (prog === undefined) problems.push(`${at}: unrecognised ${r.resourceType} code`);
      else if (prog && !agreementCovers(org, today, prog)) problems.push(`${at}: the ${prog} programme is not covered by agreement ${agreementOf(org).reference}`);
      const date = r.effectiveDateTime || r.performedDateTime || r.onsetDateTime || r.dateTime;
      if (!/^\d{4}-\d{2}-\d{2}/.test(date || '')) problems.push(`${at}: a date is required`);
      else if (date.slice(0, 10) > today) problems.push(`${at}: date ${date} is in the future`);
    });
    if (problems.length) throw new IngestError(problems);

    // 2. Write, as one database transaction.
    const result = this.store.transaction(() => this.#write(entries, org, source));
    this.store.save();
    return result;
  }

  #write(entries, org, source) {
    const orgRef = { reference: `Organization/${org.id}` };
    const resolved = new Map();
    const touched = new Set();
    const targets = [];
    const counts = { patientsCreated: 0, patientsUpdated: 0, created: 0, duplicates: 0 };
    const response = [];

    for (const e of entries) {
      const r = structuredClone(e.resource);
      if (r.resourceType === 'Patient') {
        r.managingOrganization = orgRef;
        for (const id of r.identifier) if (id.system === systems.sourceRecord) id.assigner = orgRef;
        const pid = r.identifier.find((i) => i.system !== systems.sourceRecord);
        const existing = this.store.findByIdentifier(pid.system, pid.value);
        let saved;
        if (existing) {
          const ids = [...existing.identifier];
          for (const id of r.identifier) if (!ids.some((x) => x.system === id.system && x.value === id.value)) ids.push(id);
          // Alerts follow the latest facility that saw the person; a cancer
          // registry submitting a diagnosis does not take that over.
          const manager = rolesOf(org).includes('facility') ? orgRef : existing.managingOrganization;
          saved = this.store.update({ ...existing, identifier: ids, gender: r.gender, birthDate: r.birthDate, address: r.address, managingOrganization: manager });
          counts.patientsUpdated++;
          response.push({ response: { status: '200 OK', location: `Patient/${saved.id}` } });
        } else {
          saved = this.store.create(r);
          counts.patientsCreated++;
          response.push({ response: { status: '201 Created', location: `Patient/${saved.id}` } });
        }
        resolved.set(e.fullUrl, saved.id);
        touched.add(saved.id);
        targets.push(`Patient/${saved.id}`);
        continue;
      }
      const field = r.subject ? 'subject' : 'patient';
      const ref = r[field].reference;
      const patientId = resolved.get(ref) || ref.replace(/^Patient\//, '');
      r[field] = { reference: `Patient/${patientId}` };
      delete r.note;
      delete r.text;
      if (this.#isDuplicate(r, patientId)) {
        counts.duplicates++;
        response.push({ response: { status: '200 OK', outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'duplicate', diagnostics: 'Already recorded' }] } } });
        continue;
      }
      const saved = this.store.create(r);
      counts.created++;
      touched.add(patientId);
      targets.push(`${saved.resourceType}/${saved.id}`);
      response.push({ response: { status: '201 Created', location: `${saved.resourceType}/${saved.id}` } });
    }

    if (targets.length) {
      this.store.create(buildProvenance({ targets, orgId: org.id, agreementRef: agreementOf(org).reference, recorded: new Date().toISOString(), source, counts }));
    }
    for (const id of touched) this.refreshPatient(id);
    return { resourceType: 'Bundle', type: 'transaction-response', entry: response, summary: counts };
  }

  // Programme id for a clinical resource; null if not programme-specific; undefined if unrecognised.
  #programmeOf(r) {
    if (r.resourceType === 'Observation') return identifyObservation(r)?.programme.id;
    if (r.resourceType === 'Procedure') return identifyProcedure(r)?.id;
    if (r.resourceType === 'Condition') return programmeForSite(codeIn(r.bodySite?.[0], systems.icdo3))?.id ?? null;
    return null;
  }

  #visiblePatient(ref, org) {
    const p = this.store.read('Patient', String(ref || '').replace(/^Patient\//, ''));
    return p && this.visibleTo(p, org.id);
  }

  #isDuplicate(r, patientId) {
    const key = (x) => [x.code?.coding?.[0]?.code, x.bodySite?.[0]?.coding?.[0]?.code, x.valueCodeableConcept?.coding?.[0]?.code,
      (x.effectiveDateTime || x.performedDateTime || x.onsetDateTime || x.dateTime || '').slice(0, 10)].join('|');
    const k = key(r);
    return this.store.forPatient(r.resourceType, patientId).some((x) => key(x) === k);
  }

  // --- Facility views (identifiable only to the facility that submitted) ----

  visibleTo(patient, orgId) {
    return patient.managingOrganization?.reference === `Organization/${orgId}`
      || sourceRecordsOf(patient).some((s) => s.orgId === orgId);
  }

  #patientsFor(org, isAdmin) {
    return this.store.all('Patient').filter((p) => isAdmin || this.visibleTo(p, org.id));
  }

  facilityWorklist(org, { programme, status, isAdmin = false } = {}) {
    const rows = [];
    for (const p of this.#patientsFor(org, isAdmin)) {
      const localIds = sourceRecordsOf(p).filter((s) => isAdmin || s.orgId === org.id).map((s) => s.localId);
      for (const e of this.evaluatePatient(p.id, programme || null)) {
        if (status ? e.status !== status : e.status === STATUS.NOT_ELIGIBLE) continue;
        rows.push({ patientId: p.id, person: pseudonymOf(p).slice(0, 10), localIds, sex: p.gender, district: districtOf(p), ...e });
      }
    }
    return rows.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  }

  facilityAlerts(org, { isAdmin = false } = {}) {
    const out = [];
    for (const p of this.#patientsFor(org, isAdmin)) {
      const localIds = sourceRecordsOf(p).filter((s) => isAdmin || s.orgId === org.id).map((s) => s.localId);
      for (const f of this.store.forPatient('Flag', p.id)) {
        if (f.status !== 'active') continue;
        out.push({
          id: f.id, code: flagCode(f), programme: flagProgramme(f), detail: f.code.text, since: f.period?.start,
          priority: f.extension?.[0]?.valueCodeableConcept?.coding?.[0]?.code,
          patientId: p.id, person: pseudonymOf(p).slice(0, 10), localIds, district: districtOf(p),
        });
      }
    }
    return out.sort((a, b) => (a.priority === b.priority ? b.since.localeCompare(a.since) : a.priority === 'PH' ? -1 : 1));
  }

  importHistory() {
    return this.store.all('Provenance').map((pv) => {
      const orgId = pv.agent?.[0]?.who?.reference?.replace(/^Organization\//, '');
      return {
        id: pv.id, recorded: pv.recorded, organization: this.store.read('Organization', orgId)?.name || orgId,
        agreement: pv.policy?.[0]?.replace('urn:agreement:', ''), source: pv.entity?.[0]?.what?.display,
        counts: JSON.parse(pv.extension?.[0]?.valueString || '{}'),
      };
    }).sort((a, b) => b.recorded.localeCompare(a.recorded));
  }

  organizations() {
    return this.store.all('Organization').map(describeOrg);
  }

  // --- Audit ---------------------------------------------------------------

  audit({ orgId, method, path, status }) {
    const action = { GET: 'R', POST: 'C', PUT: 'U', DELETE: 'D' }[method] || 'E';
    this.store.create(buildAuditEvent({ orgId, action, path, outcome: status, recorded: new Date().toISOString() }));
  }

  auditLog(limit = 200) {
    return this.store.all('AuditEvent').slice(-limit).reverse().map((a) => ({
      recorded: a.recorded, action: a.action, outcome: a.outcomeDesc, path: a.entity?.[0]?.what?.display,
      organization: a.agent?.[0]?.who?.reference
        ? this.store.read('Organization', a.agent[0].who.reference.replace(/^Organization\//, ''))?.name : 'anonymous',
    }));
  }

  // --- Data out: anonymised -------------------------------------------------

  #populationRows(programmeId) {
    const rows = [];
    for (const p of this.store.all('Patient')) {
      const [e] = this.evaluatePatient(p.id, programmeId);
      if (e.status === STATUS.OPTED_OUT) continue;
      rows.push({ e, sex: p.gender, district: districtOf(p), province: provinceOf(p) });
    }
    return rows;
  }

  // Record-level extract, generalised and suppressed to k-anonymity.
  anonymisedExtract(programmeId) {
    const rows = this.#populationRows(programmeId)
      .filter(({ e }) => e.eligible || e.lastScreen || e.diagnosed)
      .map(({ e, sex, district, province }) => ({
        programme: programmeId,
        sex,
        ageBand: fiveYearBand(e.age),
        province,
        district,
        year: e.lastScreen ? e.lastScreen.slice(0, 4) : 'never',
        status: e.status,
        lastOutcome: e.lastOutcome || 'none',
        diagnosed: Boolean(e.diagnosed),
      }));
    return anonymise(rows, this.country.kAnonymity);
  }

  // Aggregate statistics for the public dashboard, with small-number suppression.
  publicStats() {
    const today = this.todayIso();
    if (this.statsCache?.version === this.version && this.statsCache.today === today) return this.statsCache.stats;
    const t = this.country.suppressionThreshold;
    const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
    const fiveYearsAgo = `${Number(today.slice(0, 4)) - 5}${today.slice(4)}`;

    const out = programmeList.map((prog) => {
      const all = this.#populationRows(prog.id);
      const eligible = all.filter((r) => r.e.eligible && r.e.status !== STATUS.DIAGNOSED);
      const { min, max } = this.params(prog.id).eligibleAge;
      const bands = [];
      for (let lo = min; lo <= max; lo += 10) bands.push([lo, Math.min(lo + 9, max)]);
      const recent = all.filter((r) => r.e.lastScreen && r.e.lastScreen > yearAgo);
      const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, suppress(recent.filter((r) => r.e.lastOutcome === o).length, t)]));
      const provinces = Object.keys(this.country.regions);
      const totals = {
        ...summarise(eligible, t),
        abnormalAwaitingFollowUp: suppress(all.filter((r) => r.e.status === STATUS.ABNORMAL).length, t),
        screenedLast12Months: suppress(recent.length, t),
        cancersRecordedLast5Years: suppress(all.filter((r) => r.e.diagnosed && r.e.diagnosed > fiveYearsAgo).length, t),
      };
      const byAgeBand = bands.map(([lo, hi]) => ({ band: `${lo}–${hi}`, ...summarise(eligible.filter((r) => r.e.age >= lo && r.e.age <= hi), t) }));
      const byProvince = provinces.map((pr) => ({ province: pr, ...summarise(eligible.filter((r) => r.province === pr), t) }));
      const byDistrict = provinces.flatMap((pr) => this.country.regions[pr].map((d) => ({
        province: pr, district: d, ...summarise(eligible.filter((r) => r.district === d), t),
      })));
      // Complementary suppression, so hidden cells cannot be recovered by subtraction.
      protectAgainstDifferencing(byAgeBand, totals);
      protectAgainstDifferencing(byProvince, totals);
      for (const pr of byProvince) protectAgainstDifferencing(byDistrict.filter((d) => d.province === pr.province), pr);
      return {
        id: prog.id, name: prog.name, eligibleAge: { min, max }, sexes: prog.sexes,
        totals, byAgeBand, byProvince, byDistrict, outcomesLast12Months: outcomes,
      };
    });

    const sources = new Set(this.store.all('Provenance').map((pv) => pv.agent?.[0]?.who?.reference));
    const stats = {
      generatedOn: today,
      country: { code: this.country.code, name: this.country.name },
      syntheticData: this.store.all('Patient').some((p) => p.meta?.security?.some((s) => s.code === 'HTEST')),
      suppressionThreshold: t,
      contributingOrganisations: sources.size,
      peopleOnRegister: suppress(this.store.all('Patient').length, t),
      programmes: out,
    };
    this.statsCache = { version: this.version, today, stats };
    return stats;
  }
}

const COUNT_KEYS = ['eligible', 'covered', 'overdue', 'neverScreened'];

// Complementary suppression between a total and its parts:
// - a visible total with exactly one hidden part would reveal that part
//   (total minus the visible parts), so a second part is hidden;
// - a hidden total whose parts are all visible would be revealed by summing
//   them, so one part is hidden.
export function protectAgainstDifferencing(parts, total) {
  for (const key of COUNT_KEYS) {
    const hiddenCount = () => parts.filter((p) => p[key] === null).length;
    const hideSmallest = () => {
      const visible = parts.filter((p) => p[key] !== null && p[key] > 0).sort((a, b) => a[key] - b[key]);
      if (!visible.length) return false;
      visible[0][key] = null;
      return true;
    };
    if (total[key] === null) {
      if (hiddenCount() === 0) hideSmallest();
    } else {
      while (hiddenCount() === 1 && hideSmallest());
    }
  }
  for (const p of parts) if (p.covered === null || p.eligible === null) p.coveragePct = null;
}

// Counts from 1 to threshold-1 become null ("fewer than N"); zero stays zero.
export function suppress(n, threshold) {
  return n > 0 && n < threshold ? null : n;
}

function summarise(group, t) {
  const eligible = group.length;
  const covered = group.filter((r) => r.e.status === STATUS.UP_TO_DATE || r.e.status === STATUS.DUE_SOON).length;
  const small = eligible < t;
  // A percentage would reveal a suppressed count, so hide it too.
  const hidePct = small || eligible === 0 || suppress(covered, t) === null;
  return {
    eligible: suppress(eligible, t),
    covered: small ? null : suppress(covered, t),
    overdue: small ? null : suppress(group.filter((r) => r.e.status === STATUS.OVERDUE).length, t),
    neverScreened: small ? null : suppress(group.filter((r) => r.e.neverScreened).length, t),
    coveragePct: hidePct ? null : Math.round((covered / eligible) * 1000) / 10,
  };
}
