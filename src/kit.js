// Submission kit core, used by scripts/submit.js and scripts/pull.js. Runs at
// the source: quality checks and de-identification happen here, before
// anything is sent. Only de-identified FHIR and an aggregate quality summary
// leave the machine.

import { buildSubmission } from './ingest/pipeline.js';
import { runQualityChecks, applyResolutions } from './quality/index.js';
import { buildQualitySummary } from './quality/summary.js';

// Without a person reviewing queries, unresolved critical rows are excluded
// (or, with blockOnCritical, nothing is sent).
export function checkQuality(records, { country, fileSha256 = null }) {
  const report = runQualityChecks(records, { country, fileSha256 });
  const resolved = applyResolutions(records, report.queries, {});
  const summary = buildQualitySummary({ ...report, sent: resolved.records.length, excluded: resolved.excludedLines.length, fileSha256 });
  return { report, resolved, summary };
}

// `synthetic` labels resources as HL7 test data; turn it off only for real data
// sent under a signed agreement.
export async function submitRecords({ records, registryUrl, apiKey, secret, country, source, dryRun = false, synthetic = true, fileSha256 = null, blockOnCritical = false, fetchImpl = fetch }) {
  if (!secret) throw new Error('PSEUDONYM_KEY is required (get it from the RHEAP key custodian)');
  const auth = { Authorization: `Bearer ${apiKey}` };
  const me = await fetchImpl(`${registryUrl}/api/me`, { headers: auth });
  if (!me.ok) throw new Error(`Registry rejected the API key (HTTP ${me.status})`);
  const org = await me.json();

  const quality = checkQuality(records, { country, fileSha256 });
  const critical = quality.report.queries.filter((q) => q.severity === 'critical').length;
  const blocked = blockOnCritical && critical > 0;

  const { bundle, summary, errors } = await buildSubmission(quality.resolved.records, { secret, country, orgId: org.id, synthetic });
  if (dryRun || blocked || summary.accepted === 0) return { org, quality, summary, errors, blocked, response: null };

  const res = await fetchImpl(`${registryUrl}/fhir`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/fhir+json',
      'X-Submission-Source': source,
      'X-Quality-Summary': JSON.stringify(quality.summary),
    },
    body: JSON.stringify(bundle),
  });
  const response = await res.json();
  if (!res.ok) throw new Error(`Registry rejected the submission: ${response.issue?.map((i) => i.diagnostics).join('; ')}`);
  return { org, quality, summary, errors, blocked, response: response.summary };
}
