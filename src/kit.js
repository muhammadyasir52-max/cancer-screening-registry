// Submission kit core, used by scripts/submit.js and scripts/pull.js. Runs at
// the source: identifiers are removed here, before anything is sent.

import { buildSubmission } from './ingest/pipeline.js';

// `synthetic` labels resources as HL7 test data; turn it off only for real data
// sent under a signed agreement.
export async function submitRecords({ records, registryUrl, apiKey, secret, country, source, dryRun = false, synthetic = true, fetchImpl = fetch }) {
  if (!secret) throw new Error('PSEUDONYM_KEY is required (get it from the RHEAP key custodian)');
  const auth = { Authorization: `Bearer ${apiKey}` };
  const me = await fetchImpl(`${registryUrl}/api/me`, { headers: auth });
  if (!me.ok) throw new Error(`Registry rejected the API key (HTTP ${me.status})`);
  const org = await me.json();

  const { bundle, summary, errors } = await buildSubmission(records, { secret, country, orgId: org.id, synthetic });
  if (dryRun || summary.accepted === 0) return { org, summary, errors, response: null };

  const res = await fetchImpl(`${registryUrl}/fhir`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/fhir+json', 'X-Submission-Source': source },
    body: JSON.stringify(bundle),
  });
  const response = await res.json();
  if (!res.ok) throw new Error(`Registry rejected the submission: ${response.issue?.map((i) => i.diagnostics).join('; ')}`);
  return { org, summary, errors, response: response.summary };
}
