#!/usr/bin/env node
// Submission kit: de-identify a CSV/TSV export at the source and send it to the
// national registry.
//
//   PSEUDONYM_KEY=... node scripts/submit.js --file export.csv --mapping standard \
//     --registry https://registry.example --key <org API key> [--dry-run]
//
// Set REAL_DATA=1 only for real data under a signed agreement (removes the
// HL7 test-data label).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDelimited } from '../src/ingest/csv.js';
import { mappings, applyMapping } from '../src/ingest/mappings.js';
import { loadCountry } from '../src/country.js';
import { submitRecords } from '../src/kit.js';

const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    mapping: { type: 'string', default: 'standard' },
    registry: { type: 'string', default: 'http://localhost:3000' },
    key: { type: 'string', default: process.env.REGISTRY_API_KEY },
    country: { type: 'string', default: process.env.COUNTRY || 'pk' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!args.file || !args.key || !mappings[args.mapping]) {
  console.error(`Usage: node scripts/submit.js --file <export> --key <API key> [--mapping ${Object.keys(mappings).join('|')}] [--registry URL] [--dry-run]`);
  process.exit(2);
}

const records = applyMapping(parseDelimited(readFileSync(args.file, 'utf8')), mappings[args.mapping]);
const result = await submitRecords({
  records,
  registryUrl: args.registry.replace(/\/$/, ''),
  apiKey: args.key,
  secret: process.env.PSEUDONYM_KEY,
  country: loadCountry(args.country),
  source: basename(args.file),
  dryRun: args['dry-run'],
  synthetic: process.env.REAL_DATA !== '1',
});

console.log(`Organisation: ${result.org.name}`);
console.log(`Rows: ${result.summary.rows}, accepted: ${result.summary.accepted}, rejected: ${result.summary.rejected}, people: ${result.summary.people}`);
console.log(`Removed before sending: ${JSON.stringify(result.summary.stripped)}`);
for (const e of result.errors.slice(0, 20)) console.log(`  line ${e.line} (${e.recordId}): ${e.problems.join('; ')}`);
if (result.errors.length > 20) console.log(`  …and ${result.errors.length - 20} more rejected rows`);
console.log(result.response ? `Registry: ${JSON.stringify(result.response)}` : 'Nothing sent (dry run or no valid rows).');
