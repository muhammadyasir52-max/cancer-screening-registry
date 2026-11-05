#!/usr/bin/env node
// Submission kit: check data quality, de-identify a CSV/TSV export at the
// source, and send it to the national registry.
//
//   PSEUDONYM_KEY=... node scripts/submit.js --file export.csv --mapping standard \
//     --registry https://registry.example --key <org API key> \
//     [--quality-report queries.csv] [--block-on-critical] [--dry-run]
//
// Without a person reviewing queries, rows with critical quality queries are
// left out; --block-on-critical sends nothing until they are fixed. Use the
// facility portal to review and resolve queries interactively.
//
// Set REAL_DATA=1 only for real data under a signed agreement (removes the
// HL7 test-data label).

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDelimited } from '../src/ingest/csv.js';
import { mappings, applyMapping } from '../src/ingest/mappings.js';
import { loadCountry } from '../src/country.js';
import { submitRecords } from '../src/kit.js';
import { sha256Hex } from '../src/quality/index.js';
import { queriesToCsv } from '../src/quality/export.js';

const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    mapping: { type: 'string', default: 'standard' },
    registry: { type: 'string', default: 'http://localhost:3000' },
    key: { type: 'string', default: process.env.REGISTRY_API_KEY },
    country: { type: 'string', default: process.env.COUNTRY || 'pk' },
    'quality-report': { type: 'string' },
    'block-on-critical': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!args.file || !args.key || !mappings[args.mapping]) {
  console.error(`Usage: node scripts/submit.js --file <export> --key <API key> [--mapping ${Object.keys(mappings).join('|')}] [--registry URL] [--quality-report out.csv] [--block-on-critical] [--dry-run]`);
  process.exit(2);
}

const text = readFileSync(args.file, 'utf8');
const records = applyMapping(parseDelimited(text), mappings[args.mapping]);
const result = await submitRecords({
  records,
  registryUrl: args.registry.replace(/\/$/, ''),
  apiKey: args.key,
  secret: process.env.PSEUDONYM_KEY,
  country: loadCountry(args.country),
  source: basename(args.file),
  fileSha256: await sha256Hex(text),
  blockOnCritical: args['block-on-critical'],
  dryRun: args['dry-run'],
  synthetic: process.env.REAL_DATA !== '1',
});

const { report, summary: qs } = result.quality;
console.log(`Organisation: ${result.org.name}`);
console.log(`Data quality: ${qs.score}/100  (${Object.entries(qs.dimensions).map(([d, s]) => `${d} ${s}`).join(', ')})`);
const bySeverity = (s) => report.queries.filter((q) => q.severity === s).length;
console.log(`Queries: ${bySeverity('critical')} critical, ${bySeverity('warning')} warning, ${bySeverity('info')} info`);
for (const q of report.queries.filter((x) => x.severity === 'critical').slice(0, 10)) console.log(`  [critical] ${q.message}`);
if (args['quality-report']) {
  writeFileSync(args['quality-report'], queriesToCsv(report.queries));
  console.log(`Query list written to ${args['quality-report']} (record numbers only; no names or ID numbers)`);
}
console.log(`Rows: ${qs.rows} read, ${qs.sent} passed quality checks, ${qs.excluded} excluded; ${result.summary.accepted} ready to send (${result.summary.people} people)`);
console.log(`Removed before sending: ${JSON.stringify(result.summary.stripped)}`);
for (const e of result.errors.slice(0, 20)) console.log(`  line ${e.line} (${e.recordId}): ${e.problems.join('; ')}`);
if (result.blocked) console.log('Nothing sent: critical quality queries found (--block-on-critical). Fix them or review them in the facility portal.');
else console.log(result.response ? `Registry: ${JSON.stringify(result.response)}` : 'Nothing sent (dry run or no valid rows).');
