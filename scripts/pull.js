#!/usr/bin/env node
// Connector run: pull screening data from a source FHIR server, de-identify it
// locally, and send it to the national registry.
//
//   PSEUDONYM_KEY=... node scripts/pull.js --source https://emr.local/fhir --source-token <token> \
//     --national-id-system <identifier system URI for CNIC> --since 2026-01-01 \
//     --registry https://registry.example --key <org API key> [--dry-run]

import { parseArgs } from 'node:util';
import { pullFromFhir } from '../src/connectors/fhir.js';
import { loadCountry } from '../src/country.js';
import { submitRecords } from '../src/kit.js';

const { values: args } = parseArgs({
  options: {
    source: { type: 'string' },
    'source-token': { type: 'string', default: process.env.SOURCE_TOKEN },
    'national-id-system': { type: 'string', default: 'http://nadra.gov.pk/fhir/sid/cnic' },
    since: { type: 'string', default: '1900-01-01' },
    registry: { type: 'string', default: 'http://localhost:3000' },
    key: { type: 'string', default: process.env.REGISTRY_API_KEY },
    country: { type: 'string', default: process.env.COUNTRY || 'pk' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!args.source || !args.key) {
  console.error('Usage: node scripts/pull.js --source <FHIR base URL> --key <API key> [--since YYYY-MM-DD] [--dry-run]');
  process.exit(2);
}

const { records, skipped } = await pullFromFhir({
  baseUrl: args.source, token: args['source-token'], since: args.since, nationalIdSystem: args['national-id-system'],
});
console.log(`Pulled ${records.length} events from ${args.source} (${skipped.length} skipped)`);
const result = await submitRecords({
  records,
  registryUrl: args.registry.replace(/\/$/, ''),
  apiKey: args.key,
  secret: process.env.PSEUDONYM_KEY,
  country: loadCountry(args.country),
  source: `FHIR connector ${new URL(args.source).host}`,
  dryRun: args['dry-run'],
  synthetic: process.env.REAL_DATA !== '1',
});
console.log(`Accepted ${result.summary.accepted}, rejected ${result.summary.rejected}`);
console.log(result.response ? `Registry: ${JSON.stringify(result.response)}` : 'Nothing sent (dry run or no valid rows).');
