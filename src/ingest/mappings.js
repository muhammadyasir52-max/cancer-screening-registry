// Column mappings from source file layouts to the registry's canonical record.
//
// Canonical record fields:
//   recordId, cnic, givenName, familyName, sex, dateOfBirth, district, province,
//   phone, programme, event (screen | follow-up | diagnosis | opt-out),
//   eventDate, test, result, topography, morphology
//
// A mapping names the source column for each field (first match wins), optional
// value translations, optional transforms, and defaults for missing fields.

export const mappings = {
  standard: {
    label: 'Registry standard template (CSV)',
    columns: {
      recordId: ['record_id'], cnic: ['cnic'], givenName: ['given_name'], familyName: ['family_name'],
      sex: ['sex'], dateOfBirth: ['date_of_birth'], district: ['district'], province: ['province'],
      phone: ['phone'], programme: ['programme'], event: ['event'], eventDate: ['event_date'],
      test: ['test'], result: ['result'], topography: ['icdo3_topography'], morphology: ['icdo3_morphology'],
    },
    values: { sex: { f: 'female', female: 'female', m: 'male', male: 'male' } },
  },

  // CanReg5 is the IARC registry software used by many population-based cancer
  // registries. Variable names below are CanReg5's defaults; each registry's data
  // dictionary can rename them, so check against the registry's export first.
  canreg5: {
    label: 'CanReg5 export (cancer registry, tab separated)',
    columns: {
      recordId: ['RegNo', 'PatientRecordID', 'TumourID'], cnic: ['NationalID', 'CNIC', 'IDNumber'],
      givenName: ['FirstName', 'FirstN'], familyName: ['FamName', 'Surname'], sex: ['Sex'],
      dateOfBirth: ['BirthDate', 'BirthD'], district: ['Addr', 'District'], province: ['Province'],
      eventDate: ['IncidenceDate', 'IncidD', 'Incid'], topography: ['Topography', 'Top'], morphology: ['Morphology', 'Mor'],
      behaviour: ['Behaviour', 'Beh'],
    },
    values: { sex: { 1: 'male', 2: 'female' } },
    transforms: { dateOfBirth: 'yyyymmdd', eventDate: 'yyyymmdd', topography: 'canregTopography', morphology: 'canregMorphology' },
    defaults: { event: 'diagnosis' },
  },

  // Example of a hospital system export with its own headers and codes.
  'example-hospital': {
    label: 'Example hospital LIS export',
    columns: {
      recordId: ['MRN'], cnic: ['CNIC No'], givenName: ['First Name'], familyName: ['Last Name'],
      sex: ['Gender'], dateOfBirth: ['DOB'], district: ['District'], phone: ['Mobile'],
      eventDate: ['Report Date'], test: ['Test Code'], result: ['Result'],
    },
    values: {
      sex: { F: 'female', M: 'male' },
      test: { HPVDNA: 'hpv', PAP: 'cytology', MAMMO: 'mammography', FOBT: 'fit' },
      result: { POS: 'positive', NEG: 'negative', INV: 'invalid' },
    },
    transforms: { dateOfBirth: 'ddmmyyyy', eventDate: 'ddmmyyyy' },
    defaults: { event: 'screen' },
    derive: { programme: { hpv: 'cervical', cytology: 'cervical', mammography: 'breast', fit: 'colorectal' } },
  },
};

const transforms = {
  yyyymmdd: (v) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v),
  ddmmyyyy: (v) => {
    const m = v.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
  },
  // CanReg stores topography as digits after "C" (e.g. 539 -> C53.9).
  canregTopography: (v) => {
    const d = v.replace(/^C/i, '').replace('.', '');
    return /^\d{3}$/.test(d) ? `C${d.slice(0, 2)}.${d[2]}` : v;
  },
  canregMorphology: (v, row) => (/^\d{4}$/.test(v) ? `${v}/${row.behaviour || '3'}` : v),
};

export function applyMapping(rows, mapping) {
  return rows.map((src) => {
    const rec = {};
    for (const [field, names] of Object.entries(mapping.columns)) {
      const name = names.find((n) => src[n] !== undefined && src[n] !== '');
      if (name) rec[field] = src[name];
    }
    for (const [field, map] of Object.entries(mapping.values || {})) {
      if (rec[field] === undefined) continue;
      const hit = map[rec[field]] ?? map[String(rec[field]).toLowerCase()];
      if (hit) rec[field] = hit;
    }
    for (const [field, name] of Object.entries(mapping.transforms || {})) {
      if (rec[field] !== undefined) rec[field] = transforms[name](rec[field], rec);
    }
    for (const [field, value] of Object.entries(mapping.defaults || {})) rec[field] ??= value;
    for (const [field, map] of Object.entries(mapping.derive || {})) {
      if (rec[field] === undefined && rec.test) rec[field] = map[rec.test];
    }
    delete rec.behaviour;
    return rec;
  });
}
