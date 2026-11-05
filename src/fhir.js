// FHIR R4 code systems, resource builders and checks.
// This module runs in Node and in the browser (no node: imports), because the
// facility portal de-identifies and builds FHIR resources client-side.

const BASE = 'https://example.org/cancer-registry/fhir';

export const systems = {
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  icdo3: 'http://terminology.hl7.org/CodeSystem/icd-o-3',
  pseudonym: `${BASE}/sid/pseudonym`,
  pseudonymWeak: `${BASE}/sid/pseudonym-weak`,
  sourceRecord: `${BASE}/sid/source-record`,
  programme: `${BASE}/CodeSystem/screening-programme`,
  localTest: `${BASE}/CodeSystem/screening-test`,
  localResult: `${BASE}/CodeSystem/screening-result`,
  followUp: `${BASE}/CodeSystem/follow-up`,
  alert: `${BASE}/CodeSystem/screening-alert`,
  orgRole: `${BASE}/CodeSystem/organization-role`,
  agreement: `${BASE}/StructureDefinition/data-sharing-agreement`,
  obsCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  flagCategory: 'http://terminology.hl7.org/CodeSystem/flag-category',
  flagPriority: 'http://hl7.org/fhir/flag-priority-code',
  actReason: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
  consentScope: 'http://terminology.hl7.org/CodeSystem/consentscope',
  consentCategory: 'http://loinc.org',
  auditType: 'http://terminology.hl7.org/CodeSystem/audit-event-type',
  provenanceActivity: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
};

// Generic result codes shared by several tests.
export const results = {
  positive: { system: systems.snomed, code: '10828004', display: 'Positive' },
  negative: { system: systems.snomed, code: '260385009', display: 'Negative' },
  invalid: { system: systems.snomed, code: '125154007', display: 'Specimen unsatisfactory for evaluation' },
};

export const alertCodes = {
  'never-screened': { display: 'Eligible and never screened', priority: 'PM' },
  overdue: { display: 'Screening overdue', priority: 'PM' },
  'abnormal-result': { display: 'Abnormal result: refer for diagnostic follow-up', priority: 'PH' },
  'follow-up-overdue': { display: 'Abnormal result with no follow-up recorded', priority: 'PH' },
};

// Every resource carries the HL7 "test health data" label while the registry
// runs on synthetic data, so demo records can never be mistaken for real ones.
export const testDataMeta = (synthetic = true) =>
  (synthetic ? { security: [{ system: systems.actReason, code: 'HTEST', display: 'test health data' }] } : {});

const orgRef = (orgId) => (orgId ? { reference: `Organization/${orgId}` } : undefined);

// --- Builders --------------------------------------------------------------

// A de-identified person. No name, phone, street address or full date of birth.
export function buildPatient({ pseudonym, weak = false, birthMonth, sex, district, province, country, orgId, localId, synthetic = true }) {
  const identifier = [{ system: weak ? systems.pseudonymWeak : systems.pseudonym, value: pseudonym }];
  if (localId) identifier.push({ system: systems.sourceRecord, value: localId, assigner: orgRef(orgId) });
  return {
    resourceType: 'Patient',
    meta: testDataMeta(synthetic),
    identifier,
    gender: sex,
    birthDate: birthMonth,
    address: [{ district, state: province, country }],
    managingOrganization: orgRef(orgId),
  };
}

export function buildObservation({ subject, date, test, value, orgId, synthetic = true }) {
  return {
    resourceType: 'Observation',
    meta: testDataMeta(synthetic),
    status: 'final',
    category: [{ coding: [{ system: systems.obsCategory, code: 'laboratory' }] }],
    code: { coding: [test.coding], text: test.label },
    subject,
    effectiveDateTime: date,
    performer: orgId ? [orgRef(orgId)] : undefined,
    valueCodeableConcept: { coding: [value], text: value.display },
  };
}

export function buildProcedure({ subject, date, coding, label, orgId, synthetic = true }) {
  return {
    resourceType: 'Procedure',
    meta: testDataMeta(synthetic),
    status: 'completed',
    code: { coding: [coding], text: label },
    subject,
    performedDateTime: date,
    performer: orgId ? [{ actor: orgRef(orgId) }] : undefined,
  };
}

// A cancer diagnosis, typically imported from an existing cancer registry.
export function buildCondition({ subject, date, topography, morphology, orgId, synthetic = true }) {
  return {
    resourceType: 'Condition',
    meta: testDataMeta(synthetic),
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
    code: { coding: [{ system: systems.icdo3, code: morphology || '8000/3' }], text: `ICD-O-3 ${morphology || '8000/3'}` },
    bodySite: [{ coding: [{ system: systems.icdo3, code: topography }], text: `ICD-O-3 topography ${topography}` }],
    subject,
    onsetDateTime: date,
    recorder: orgRef(orgId),
  };
}

// The person has opted out of the registry's use of her or his data.
export function buildOptOut({ subject, date, orgId, synthetic = true }) {
  return {
    resourceType: 'Consent',
    meta: testDataMeta(synthetic),
    status: 'active',
    scope: { coding: [{ system: systems.consentScope, code: 'patient-privacy' }] },
    category: [{ coding: [{ system: systems.consentCategory, code: '59284-0', display: 'Patient Consent' }] }],
    patient: subject,
    dateTime: date,
    organization: orgId ? [orgRef(orgId)] : undefined,
    policyRule: { text: 'Opt-out of cancer screening registry processing' },
    provision: { type: 'deny' },
  };
}

export function buildFlag({ patientId, programme, code, start, detail, orgId }) {
  const def = alertCodes[code];
  return {
    resourceType: 'Flag',
    meta: testDataMeta(),
    extension: [{
      url: 'http://hl7.org/fhir/StructureDefinition/flag-priority',
      valueCodeableConcept: { coding: [{ system: systems.flagPriority, code: def.priority }] },
    }],
    status: 'active',
    category: [{ coding: [{ system: systems.flagCategory, code: 'clinical', display: 'Clinical' }] }],
    code: {
      coding: [{ system: systems.alert, code, display: def.display }, { system: systems.programme, code: programme }],
      text: detail || def.display,
    },
    subject: { reference: `Patient/${patientId}` },
    period: { start },
    author: orgRef(orgId),
  };
}

export function buildOrganization({ name, roles, agreement, keyHash }) {
  return {
    resourceType: 'Organization',
    active: true,
    name,
    type: roles.map((r) => ({ coding: [{ system: systems.orgRole, code: r }] })),
    extension: [{
      url: systems.agreement,
      extension: [
        { url: 'reference', valueString: agreement.reference },
        { url: 'validFrom', valueDate: agreement.validFrom },
        { url: 'validTo', valueDate: agreement.validTo },
        { url: 'purpose', valueString: agreement.purpose || '' },
        ...agreement.programmes.map((p) => ({ url: 'programme', valueCode: p })),
      ],
    }],
    // SHA-256 of the organisation's API key. The key itself is never stored.
    identifier: [{ system: `${BASE}/sid/api-key-sha256`, value: keyHash }],
  };
}

const IMPORT_COUNTS = `${BASE}/StructureDefinition/import-counts`;
const QUALITY_SUMMARY = `${BASE}/StructureDefinition/quality-summary`;

export function buildProvenance({ targets, orgId, agreementRef, recorded, source, counts, quality }) {
  const extension = [{ url: IMPORT_COUNTS, valueString: JSON.stringify(counts) }];
  if (quality) extension.push({ url: QUALITY_SUMMARY, valueString: JSON.stringify(quality) });
  return {
    resourceType: 'Provenance',
    target: targets.map((reference) => ({ reference })),
    recorded,
    policy: agreementRef ? [`urn:agreement:${agreementRef}`] : undefined,
    activity: { coding: [{ system: systems.provenanceActivity, code: 'CREATE' }] },
    agent: [{ who: orgRef(orgId) }],
    entity: [{ role: 'source', what: { display: source || 'submission' } }],
    extension,
  };
}

const extJson = (resource, url) => {
  const v = resource.extension?.find((e) => e.url === url)?.valueString;
  return v ? JSON.parse(v) : null;
};
export const importCountsOf = (provenance) => extJson(provenance, IMPORT_COUNTS) || {};
export const qualityOf = (provenance) => extJson(provenance, QUALITY_SUMMARY);

export function buildAuditEvent({ orgId, action, path, outcome, recorded, entity }) {
  return {
    resourceType: 'AuditEvent',
    type: { system: systems.auditType, code: 'rest', display: 'RESTful Operation' },
    action, // C, R, U, D or E (execute)
    recorded,
    outcome: outcome === 200 || outcome === 201 ? '0' : outcome >= 500 ? '8' : '4',
    outcomeDesc: String(outcome),
    agent: [{ who: orgId ? orgRef(orgId) : { display: 'anonymous' }, requestor: true }],
    source: { observer: { display: 'cancer-screening-registry' } },
    entity: [{ what: { display: path }, ...(entity ? { description: entity } : {}) }],
  };
}

// --- Reading helpers -------------------------------------------------------

export const patientIdOf = (resource) =>
  (resource.subject || resource.patient)?.reference?.replace(/^Patient\//, '');

export const hasCoding = (concept, { system, code }) =>
  (concept?.coding || []).some((c) => c.system === system && c.code === code);

export const codeIn = (concept, system) => (concept?.coding || []).find((c) => c.system === system)?.code;

export const flagCode = (flag) => codeIn(flag.code, systems.alert);
export const flagProgramme = (flag) => codeIn(flag.code, systems.programme);

export const districtOf = (patient) => patient.address?.[0]?.district || 'Unknown';
export const provinceOf = (patient) => patient.address?.[0]?.state || 'Unknown';

export const pseudonymOf = (patient) =>
  patient.identifier?.find((i) => i.system === systems.pseudonym || i.system === systems.pseudonymWeak)?.value;

export const sourceRecordsOf = (patient) =>
  (patient.identifier || []).filter((i) => i.system === systems.sourceRecord)
    .map((i) => ({ localId: i.value, orgId: i.assigner?.reference?.replace(/^Organization\//, '') }));

// --- De-identification guard -------------------------------------------------

const ALLOWED_PATIENT_IDENTIFIERS = [systems.pseudonym, systems.pseudonymWeak, systems.sourceRecord];

// The central registry refuses any Patient that carries direct identifiers.
// Returns a list of problems; empty means the resource is acceptable.
export function directIdentifierProblems(patient) {
  const problems = [];
  if (patient.name?.length) problems.push('Patient.name is not accepted (de-identify at source)');
  if (patient.telecom?.length) problems.push('Patient.telecom is not accepted');
  if (patient.photo?.length) problems.push('Patient.photo is not accepted');
  if (patient.contact?.length) problems.push('Patient.contact is not accepted');
  if ((patient.address || []).some((a) => a.line?.length || a.postalCode || a.text || a.city)) {
    problems.push('Patient.address may only contain district, state (province) and country');
  }
  if (patient.birthDate && !/^\d{4}(-\d{2})?$/.test(patient.birthDate)) {
    problems.push('Patient.birthDate must be generalised to YYYY-MM');
  }
  for (const id of patient.identifier || []) {
    if (!ALLOWED_PATIENT_IDENTIFIERS.includes(id.system)) problems.push(`Identifier system ${id.system} is not accepted`);
  }
  if (!pseudonymOf(patient)) problems.push('Patient needs a pseudonym identifier');
  return problems;
}
