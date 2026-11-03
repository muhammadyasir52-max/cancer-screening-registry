// Screening programmes. Each module describes its tests (with FHIR codings),
// the follow-up procedure that resolves an abnormal result, the ICD-O-3 sites
// it covers, and how to classify one screening episode.

import cervical from './cervical.js';
import breast from './breast.js';
import colorectal from './colorectal.js';
import oral from './oral.js';
import { hasCoding } from '../fhir.js';

export const programmes = { cervical, breast, colorectal, oral };
export const programmeList = Object.values(programmes);

// Which programme and test an Observation belongs to, and its result key.
export function identifyObservation(obs) {
  for (const p of programmeList) {
    for (const [key, test] of Object.entries(p.tests)) {
      if (!hasCoding(obs.code, test.coding)) continue;
      const value = obs.valueCodeableConcept;
      const result = Object.entries(test.results).find(([, v]) => hasCoding(value, v))?.[0];
      return { programme: p, testKey: key, result };
    }
  }
  return null;
}

export function identifyProcedure(proc) {
  return programmeList.find((p) => hasCoding(proc.code, p.followUp.coding)) || null;
}

// Map an ICD-O-3 topography code (e.g. "C53.9" or "C539") to a programme.
export function programmeForSite(topography) {
  const site = String(topography || '').toUpperCase().replace('.', '').slice(0, 3);
  return programmeList.find((p) => p.cancerSites.includes(site)) || null;
}
