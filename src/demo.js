// Demo set-up: synthetic organisations with well-known demo API keys, and a
// synthetic population submitted through the real de-identification pipeline.
// Never use these keys outside a demo.

import { createOrganization } from './auth.js';
import { generateRecords } from './synthetic.js';
import { buildSubmission } from './ingest/pipeline.js';
import { addDays, isoDate } from './rules.js';

export const DEMO_SECRET = 'demo-pseudonymisation-key-not-for-real-data';

export const DEMO_ORGS = {
  admin: { name: 'RHEAP registry administration (demo)', roles: ['admin'], key: 'demo-admin-key', ref: 'RHEAP-INTERNAL' },
  lahore: { name: 'Demo Teaching Hospital, Lahore', roles: ['submitter', 'facility'], key: 'demo-lahore-key', ref: 'DSA-2026-001' },
  karachi: { name: 'Demo General Hospital, Karachi', roles: ['submitter', 'facility'], key: 'demo-karachi-key', ref: 'DSA-2026-002' },
  kp: { name: 'Demo Mobile Screening Unit, Khyber Pakhtunkhwa', roles: ['submitter', 'facility'], key: 'demo-kp-key', ref: 'DSA-2026-003', programmes: ['cervical', 'breast', 'oral'] },
  registry: { name: 'Demo Population Cancer Registry', roles: ['submitter'], key: 'demo-registry-key', ref: 'DSA-2026-004' },
  research: { name: 'Demo University Research Group', roles: ['consumer'], key: 'demo-research-key', ref: 'DAR-2026-010', programmes: ['cervical', 'breast'], purpose: 'Coverage and outcome research' },
};

export async function seedDemo(registry, { count = 2500, seed = 2026 } = {}) {
  const { store, country } = registry;
  const today = isoDate(registry.today());
  const orgs = {};
  for (const [id, o] of Object.entries(DEMO_ORGS)) {
    ({ org: orgs[id] } = createOrganization(store, {
      name: o.name,
      roles: o.roles,
      agreement: {
        reference: o.ref,
        validFrom: addDays(today, -365),
        validTo: addDays(today, 730),
        purpose: o.purpose || (o.roles.includes('submitter') ? 'Contribute screening and cancer data to the national registry' : 'Registry stewardship'),
        programmes: o.programmes,
      },
    }, o.key));
  }

  const records = generateRecords(country, { count, seed, today: registry.today() });
  const totals = {};
  // Screening sources first, then the cancer registry, as would happen in practice.
  for (const src of ['lahore', 'karachi', 'kp', 'registry']) {
    const { bundle, errors } = await buildSubmission(records[src], { secret: DEMO_SECRET, country, orgId: orgs[src].id });
    if (errors.length) throw new Error(`Synthetic data for ${src} failed validation: ${JSON.stringify(errors[0])}`);
    totals[src] = registry.ingestTransaction(bundle, orgs[src], { source: 'synthetic demo data' }).summary;
  }
  store.save();
  return { orgs, totals };
}
