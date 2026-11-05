import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDelimited } from '../src/ingest/csv.js';
import { mappings, applyMapping } from '../src/ingest/mappings.js';
import { loadCountry } from '../src/country.js';
import { runQualityChecks, applyResolutions, sha256Hex, CHECKS } from '../src/quality/index.js';
import { buildQualitySummary, validateQualitySummary, explainSummary } from '../src/quality/summary.js';
import { queriesToCsv } from '../src/quality/export.js';
import { levenshtein, jaroWinkler, closest } from '../src/quality/fuzzy.js';
import { generateRecords } from '../src/synthetic.js';
import { createAssistant } from '../src/assistant.js';

const pk = loadCountry('pk');
const TODAY = new Date('2026-11-05');
const load = (name, mapping = 'standard') =>
  applyMapping(parseDelimited(readFileSync(new URL(`../public/samples/${name}`, import.meta.url), 'utf8')), mappings[mapping]);
const messy = load('messy-hospital-export.csv');
const run = (records, opts = {}) => runQualityChecks(records, { country: pk, today: TODAY, ...opts });
const byCheck = (report, check) => report.queries.filter((q) => q.check === check);

test('fuzzy helpers', () => {
  assert.equal(levenshtein('Lahor', 'Lahore'), 1);
  assert.ok(jaroWinkler('ayesha sampleton', 'aisha sampleton') > 0.9);
  assert.ok(jaroWinkler('sana fixture', 'rabia dummy') < 0.85);
  assert.equal(closest('Lahor', ['Lahore', 'Multan']), 'Lahore');
  assert.equal(closest('Atlantis', ['Lahore', 'Multan']), null);
});

test('every check fires on the messy sample, at the planted rows', () => {
  const report = run(messy);
  const expectedChecks = Object.keys(CHECKS).filter((c) => c !== 'duplicate-file' && c !== 'missing-required');
  for (const c of expectedChecks) assert.ok(byCheck(report, c).length, `expected a ${c} query`);
  assert.deepEqual(byCheck(report, 'unknown-district')[0].fixes[0].ops, [{ op: 'set', line: 70, field: 'district', value: 'Lahore' }]);
  assert.match(byCheck(report, 'possible-id-typo')[0].message, /Lines 65, 66 and 67/);
  assert.equal(byCheck(report, 'conflicting-results')[0].fixes.length, 2);
  assert.match(byCheck(report, 'volume-spike')[0].message, /14 records dated 2026-10-28/);
  assert.match(byCheck(report, 'birth-date-heaping')[0].message, /8 of 77/);
  assert.match(byCheck(report, 'positivity-out-of-range')[0].message, /^hpv: 31\.2%/);
  // Two people sharing a CNIC are an identity conflict, not a "repeat screen".
  assert.equal(byCheck(report, 'over-screening').length, 1);
  assert.ok(report.score < 90 && report.score > 0);
});

test('clean synthetic data raises no queries', () => {
  const syn = generateRecords(pk, { count: 1500, today: TODAY });
  for (const src of ['lahore', 'karachi', 'kp', 'registry']) {
    const report = run(syn[src]);
    assert.deepEqual(report.queries.map((q) => q.message), [], src);
    assert.equal(report.score, 100);
  }
});

test('cross-row checks classify same-day results as one episode', () => {
  const person = { recordId: 'E1', cnic: '99101-7000001-1', givenName: 'Hira', familyName: 'Example', sex: 'female', dateOfBirth: '1980-02-02', district: 'Lahore', programme: 'cervical', event: 'screen' };
  const report = run([
    { ...person, eventDate: '2026-01-10', test: 'hpv', result: 'positive' },
    { ...person, eventDate: '2026-01-10', test: 'cytology', result: 'NILM' },
    { ...person, eventDate: '2026-04-20', test: 'hpv', result: 'negative' },
  ]);
  // HPV+ with normal cytology is an early-recall episode, not a normal result.
  assert.equal(byCheck(report, 'over-screening').length, 0);
});

test('checks stay fast on a large export', () => {
  // 30,000 rows with varied CNICs, names and birth dates, as a real export would have.
  const syn = generateRecords(pk, { count: 30000, seed: 7, today: TODAY });
  const big = [...syn.lahore, ...syn.karachi, ...syn.kp];
  assert.ok(big.length > 25000);
  const t0 = Date.now();
  const report = run(big);
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `took ${ms} ms`);
  assert.equal(report.rows, big.length);
});

test('the CNIC pre-filter never hides a real typo', () => {
  const p = { givenName: 'Sana', familyName: 'Example', sex: 'female', dateOfBirth: '1985-05-05', district: 'Lahore', programme: 'cervical', event: 'screen', eventDate: '2026-05-05', test: 'hpv', result: 'negative' };
  // Transposed adjacent digits: positions differ, digit counts are identical.
  const report = run([{ ...p, recordId: 'T1', cnic: '99101-1234567-1' }, { ...p, recordId: 'T2', cnic: '99101-1243567-1' }]);
  assert.equal(byCheck(report, 'possible-id-typo').length, 1);
});

test('missing required fields are critical', () => {
  const report = run([{ recordId: 'X', sex: 'female', dateOfBirth: '1980-01-01', district: 'Lahore', event: 'screen', eventDate: '2026-01-01', programme: 'cervical' }]);
  assert.equal(byCheck(report, 'missing-required')[0].severity, 'critical');
  assert.match(byCheck(report, 'missing-required')[0].message, /test, result/);
});

test('resolutions: fixes apply, excluded rows drop, unresolved critical rows drop, accepted rows stay', () => {
  const report = run(messy);
  const q = (check) => byCheck(report, check)[0];
  const untouched = applyResolutions(messy, report.queries, {});
  const resolutions = {
    [q('unknown-district').id]: { action: 'fix', fix: 0 },
    [q('exact-duplicate').id]: { action: 'fix', fix: 0 },
    [q('conflicting-results').id]: { action: 'fix', fix: 0 },
    [q('future-date').id]: { action: 'accept', reason: 'confirmed booking' },
    [q('missing-national-id').id]: { action: 'exclude' },
  };
  const out = applyResolutions(messy, report.queries, resolutions);
  assert.ok(out.records.some((r) => r._line === 70 && r.district === 'Lahore'), 'district fixed');
  assert.ok(!out.records.some((r) => r._line === 60), 'duplicate removed');
  assert.ok(!out.records.some((r) => r._line === 62), 'conflicting result removed');
  assert.ok(out.records.some((r) => r._line === 61), 'kept result stays');
  assert.ok(out.records.some((r) => r.eventDate === '2027-03-01'), 'accepted row stays');
  assert.ok(!out.records.some((r) => r.recordId === 'MH-3013'), 'excluded row dropped');
  assert.ok(!untouched.records.some((r) => r.eventDate === '2027-03-01'), 'unresolved critical row dropped');
  assert.equal(out.fixed, 3);
  assert.equal(messy[68].district, 'Lahor', 'input records are not mutated');
});

test('the quality summary carries counts only, and the validator rejects anything else', async () => {
  const report = run(messy);
  const resolved = applyResolutions(messy, report.queries, {});
  const fileSha256 = await sha256Hex(readFileSync(new URL('../public/samples/messy-hospital-export.csv', import.meta.url), 'utf8'));
  const summary = validateQualitySummary(buildQualitySummary({ ...report, sent: resolved.records.length, excluded: resolved.excludedLines.length, fileSha256 }));
  const text = JSON.stringify(summary);
  for (const r of messy) {
    for (const v of [r.cnic, r.givenName, r.familyName, r.recordId, r.dateOfBirth, r.phone].filter(Boolean)) {
      assert.ok(!text.includes(`"${v}"`) && !text.includes(v.replace(/-/g, '')), `summary leaks ${v}`);
    }
  }
  assert.ok(!/Line \d|Lines/.test(text), 'no line references');
  assert.throws(() => validateQualitySummary({ ...summary, note: 'Ayesha Sampleton 99101-1000001-2' }), /unknown field "note"/);
  assert.throws(() => validateQualitySummary({ ...summary, checks: { ...summary.checks, 'exact-duplicate': { ...summary.checks['exact-duplicate'], rows: 'Ayesha' } } }), /counts/);
  assert.throws(() => validateQualitySummary({ ...summary, checks: { 'free text here': { severity: 'info', queries: 1, rows: 1 } } }), /unknown check/);
  assert.throws(() => validateQualitySummary({ ...summary, fileSha256: 'not-a-hash' }), /fileSha256/);
  assert.throws(() => validateQualitySummary({ ...summary, score: 101 }), /score/);
});

test('local explanation reflects resolved and open findings', () => {
  const report = run(messy);
  const q = byCheck(report, 'unknown-district')[0];
  const summary = buildQualitySummary({ ...report, sent: 70, excluded: 13, fileSha256: null, resolutions: { [q.id]: { action: 'fix', fix: 0 } } });
  const e = explainSummary(validateQualitySummary(summary));
  assert.match(e.headline, /^Data quality \d+\/100/);
  assert.ok(e.bullets.some((b) => /^Resolved at source:.*District not recognised/.test(b)));
  assert.ok(!e.bullets.some((b) => /^District not recognised/.test(b)), 'resolved check is not listed as open');
  assert.match(e.actions[0], /open critical/);
});

test('query CSV export has record numbers but no CNICs or names, and neutralises formulas', () => {
  const report = run(messy);
  const csv = queriesToCsv(report.queries);
  for (const r of messy) {
    if (r.cnic) assert.ok(!csv.includes(r.cnic), 'CNIC in export');
    assert.ok(!csv.includes(`${r.givenName} ${r.familyName}`), 'name in export');
  }
  assert.match(csv, /MH-3007/);
  const evil = queriesToCsv([{ ...report.queries[0], message: '=HYPERLINK("http://x")' }]);
  assert.match(evil, /"'=HYPERLINK/);
});

test('a repeated file is flagged as an integrity warning', async () => {
  const h = await sha256Hex('a,b\n1,2\n');
  const report = run(messy, { fileSha256: h, previousFileHashes: [h] });
  assert.equal(byCheck(report, 'duplicate-file').length, 1);
});

test('assistant: off by default; with a client it sends only the summary and returns structured advice', async () => {
  assert.equal(createAssistant({ enabled: undefined }).enabled, false);
  const report = run(messy);
  const summary = validateQualitySummary(buildQualitySummary({ ...report, sent: 69, excluded: 14, fileSha256: 'a'.repeat(64) }));
  let sent;
  const client = { beta: { messages: { create: async (req) => { sent = req; return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ explanation: 'x', priorities: ['p'], suggestedActions: ['a'] }) }] }; } } } };
  const answer = await createAssistant({ enabled: true, client }).ask(summary, 'What first?');
  assert.equal(answer.source, 'claude');
  assert.deepEqual(answer.priorities, ['p']);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(sent.output_config.format.type, 'json_schema');
  const payload = JSON.stringify(sent.messages);
  for (const r of messy) for (const v of [r.cnic, r.givenName && `${r.givenName} ${r.familyName}`, r.recordId].filter(Boolean)) assert.ok(!payload.includes(v), `assistant payload leaks ${v}`);
  assert.ok(!payload.includes('a'.repeat(64)), 'file hash is not sent to the assistant');

  const refusing = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  assert.equal((await createAssistant({ enabled: true, client: refusing }).ask(summary, '')).source, 'local');
  const failing = { beta: { messages: { create: async () => { throw Object.assign(new Error('down'), { status: 529 }); } } } };
  const badKey = { beta: { messages: { create: async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); } } } };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await createAssistant({ enabled: true, client: failing }).ask(summary, '')).source, 'local');
    // A misconfiguration is surfaced (502), not hidden behind the local answer.
    await assert.rejects(createAssistant({ enabled: true, client: badKey }).ask(summary, ''), (e) => e.status === 502);
  } finally {
    console.error = originalError;
  }
});
