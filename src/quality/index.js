// Data Quality Studio: checks a source's records BEFORE de-identification, on
// the source's own machine (browser or submission kit). Names and ID numbers
// are used here to find duplicates and typos; they never leave the machine.
// Only an aggregate summary (src/quality/summary.js) is sent to the registry.
//
// Each check raises "queries" that staff resolve: apply a suggested fix,
// exclude the affected rows, or accept with a reason. Unresolved critical
// queries exclude their rows from the submission.

import { programmes } from '../programmes/index.js';
import { normaliseNationalId } from '../ingest/deidentify.js';
import { levenshtein, jaroWinkler, normaliseName, closest } from './fuzzy.js';

export const DIMENSIONS = ['completeness', 'validity', 'uniqueness', 'consistency', 'plausibility', 'integrity'];
export const SEVERITIES = ['critical', 'warning', 'info'];

export const CHECKS = {
  'missing-required': { dimension: 'completeness', severity: 'critical', title: 'Required field missing' },
  'missing-national-id': { dimension: 'completeness', severity: 'warning', title: 'No CNIC (record links only by name and birth date)' },
  'invalid-date': { dimension: 'validity', severity: 'critical', title: 'Date not valid' },
  'future-date': { dimension: 'validity', severity: 'critical', title: 'Event date in the future' },
  'event-before-birth': { dimension: 'validity', severity: 'critical', title: 'Event before date of birth' },
  'invalid-national-id': { dimension: 'validity', severity: 'warning', title: 'CNIC format not valid' },
  'unknown-district': { dimension: 'validity', severity: 'critical', title: 'District not recognised' },
  'unknown-code': { dimension: 'validity', severity: 'critical', title: 'Programme, test or result code not recognised' },
  'exact-duplicate': { dimension: 'uniqueness', severity: 'warning', title: 'Exact duplicate row' },
  'conflicting-results': { dimension: 'uniqueness', severity: 'critical', title: 'Same test on the same day with different results' },
  'identity-conflict': { dimension: 'uniqueness', severity: 'critical', title: 'Same CNIC with a different name or birth date' },
  'possible-id-typo': { dimension: 'uniqueness', severity: 'warning', title: 'Probably the same person under two CNICs (typo)' },
  'record-id-conflict': { dimension: 'uniqueness', severity: 'critical', title: 'Same record number with different CNICs' },
  'sex-programme-mismatch': { dimension: 'consistency', severity: 'critical', title: 'Sex does not match the programme' },
  'implausible-age': { dimension: 'consistency', severity: 'warning', title: 'Age implausible for this test' },
  'event-after-opt-out': { dimension: 'consistency', severity: 'warning', title: 'Screening recorded after the person opted out' },
  'follow-up-without-abnormal': { dimension: 'consistency', severity: 'info', title: 'Follow-up with no abnormal result in this file' },
  'over-screening': { dimension: 'consistency', severity: 'info', title: 'Repeat screen within 6 months of a normal result' },
  'positivity-out-of-range': { dimension: 'plausibility', severity: 'warning', title: 'Positive rate outside the expected range' },
  'volume-spike': { dimension: 'plausibility', severity: 'warning', title: 'Unusual number of records on one day' },
  'birth-date-heaping': { dimension: 'plausibility', severity: 'info', title: 'Many estimated birth dates (1 January)' },
  'duplicate-file': { dimension: 'integrity', severity: 'warning', title: 'This exact file was submitted before' },
};

// Expected share of "positive" results per test (illustrative ranges for the
// demo; a programme should set these from its own laboratory baselines).
const POSITIVITY = {
  hpv: { positive: ['positive'], min: 0.03, max: 0.3 },
  via: { positive: ['positive'], min: 0.02, max: 0.2 },
  mammography: { positive: ['0', '4', '5', '6'], min: 0.02, max: 0.2 },
  fit: { positive: ['positive'], min: 0.02, max: 0.15 },
  ove: { positive: ['suspicious'], min: 0.01, max: 0.15 },
};
const MIN_RESULTS_FOR_RATE = 30;
// Penalty per percent of rows affected, and fixed penalties for dataset-level findings.
const WEIGHT = { critical: 3, warning: 1, info: 0.2 };
const DATASET_PENALTY = { critical: 25, warning: 12, info: 5 };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s) => DATE.test(s || '') && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const ageAt = (dob, date) => {
  const b = new Date(dob); const d = new Date(date);
  let a = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) a--;
  return a;
};
const daysApart = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;
function digitCountDifference(a, b) {
  const counts = new Array(10).fill(0);
  for (const c of a) counts[c.charCodeAt(0) - 48]++;
  for (const c of b) counts[c.charCodeAt(0) - 48]--;
  return counts.reduce((s, n) => s + Math.abs(n), 0);
}

/**
 * Run every check.
 * @param records canonical records (see src/ingest/mappings.js), in file order
 * @param options { country, today?, previousFileHashes?, fileSha256? }
 * @returns {{ queries, score, dimensions, rows }}
 */
export function runQualityChecks(records, { country, today = new Date(), previousFileHashes = [], fileSha256 = null } = {}) {
  const now = new Date(today).toISOString().slice(0, 10);
  const districts = Object.values(country.regions).flat();
  const queries = [];
  let seq = 0;
  const add = (check, rows, message, extra = {}) => {
    const def = CHECKS[check];
    queries.push({
      id: `q${++seq}`,
      check,
      dimension: def.dimension,
      severity: extra.severity || def.severity,
      title: def.title,
      lines: rows.map((r) => r.line),
      recordIds: [...new Set(rows.map((r) => r.rec.recordId).filter(Boolean))],
      message,
      suggestion: extra.suggestion || '',
      fixes: extra.fixes || [],
    });
  };

  const rows = records.map((rec, i) => ({ rec, line: i + 2, cnic: normaliseNationalId(rec.cnic, country) }));

  // --- Row-level checks ----------------------------------------------------
  const noId = [];
  for (const r of rows) {
    const { rec } = r;
    const required = ['event', 'eventDate', 'dateOfBirth', 'sex', 'district'];
    if (rec.event === 'screen') required.push('programme', 'test', 'result');
    if (rec.event === 'follow-up') required.push('programme');
    if (rec.event === 'diagnosis') required.push('topography');
    const missing = required.filter((f) => !rec[f]);
    if (missing.length) add('missing-required', [r], `Line ${r.line}: missing ${missing.join(', ')}`, { suggestion: 'Complete the fields in the source system and re-export, or exclude the row.' });

    if (!rec.cnic) noId.push(r);
    else if (!r.cnic) add('invalid-national-id', [r], `Line ${r.line}: the ${country.nationalId.name} is not in a valid format`, { suggestion: `Correct the ${country.nationalId.name}; until then the person links only by name and birth date.` });

    for (const f of ['eventDate', 'dateOfBirth']) {
      if (rec[f] && !isRealDate(rec[f])) add('invalid-date', [r], `Line ${r.line}: ${f === 'eventDate' ? 'event date' : 'date of birth'} "${rec[f]}" is not a real date (YYYY-MM-DD)`);
    }
    if (isRealDate(rec.eventDate) && rec.eventDate > now) add('future-date', [r], `Line ${r.line}: event date ${rec.eventDate} is in the future`, { suggestion: 'Usually a day/month swap or a typo in the year.' });
    if (isRealDate(rec.eventDate) && isRealDate(rec.dateOfBirth) && rec.eventDate < rec.dateOfBirth) {
      add('event-before-birth', [r], `Line ${r.line}: event ${rec.eventDate} is before birth ${rec.dateOfBirth}`);
    }

    if (rec.district && !districts.includes(rec.district)) {
      const match = closest(rec.district, districts, 3);
      add('unknown-district', [r], `Line ${r.line}: district "${rec.district}" is not recognised`, match ? {
        suggestion: `Did you mean "${match}"?`,
        fixes: [{ label: `Change to ${match}`, ops: [{ op: 'set', line: r.line, field: 'district', value: match }] }],
      } : { suggestion: 'Use a district name from the country list.' });
    }

    if (rec.event === 'screen' || rec.event === 'follow-up') {
      const prog = programmes[rec.programme];
      if (rec.programme && !prog) {
        const match = closest(rec.programme, Object.keys(programmes));
        add('unknown-code', [r], `Line ${r.line}: programme "${rec.programme}" is not recognised`, match ? {
          suggestion: `Did you mean "${match}"?`, fixes: [{ label: `Change to ${match}`, ops: [{ op: 'set', line: r.line, field: 'programme', value: match }] }],
        } : {});
      } else if (prog && rec.event === 'screen') {
        const test = prog.tests[rec.test];
        if (rec.test && !test) {
          const match = closest(rec.test, Object.keys(prog.tests));
          add('unknown-code', [r], `Line ${r.line}: ${prog.id} test "${rec.test}" is not recognised`, match ? {
            suggestion: `Did you mean "${match}"?`, fixes: [{ label: `Change to ${match}`, ops: [{ op: 'set', line: r.line, field: 'test', value: match }] }],
          } : { suggestion: `Expected one of: ${Object.keys(prog.tests).join(', ')}` });
        } else if (test && rec.result && !test.results[rec.result]) {
          const keys = Object.keys(test.results);
          const match = closest(rec.result, keys);
          add('unknown-code', [r], `Line ${r.line}: ${rec.test} result "${rec.result}" is not recognised`, match ? {
            suggestion: `Did you mean "${match}"?`, fixes: [{ label: `Change to ${match}`, ops: [{ op: 'set', line: r.line, field: 'result', value: match }] }],
          } : { suggestion: `Expected one of: ${keys.join(', ')}` });
        }
      }
      if (prog && rec.sex && !prog.sexes.includes(rec.sex)) {
        add('sex-programme-mismatch', [r], `Line ${r.line}: ${rec.sex} recorded in the ${prog.name.toLowerCase()} programme`, { suggestion: 'Check the sex field or the programme.' });
      }
      if (prog && isRealDate(rec.dateOfBirth) && isRealDate(rec.eventDate) && rec.eventDate >= rec.dateOfBirth) {
        const age = ageAt(rec.dateOfBirth, rec.eventDate);
        const { min, max } = country.programmes[prog.id].eligibleAge;
        if (age < 10 || age > 110) add('implausible-age', [r], `Line ${r.line}: age ${age} at the event`, { severity: 'critical', suggestion: 'Check the date of birth.' });
        else if (age < min - 10 || age > max + 15) add('implausible-age', [r], `Line ${r.line}: age ${age} is far outside the ${prog.id} range (${min}–${max})`, { suggestion: 'Check the date of birth.' });
      }
    }
  }
  if (noId.length) {
    add('missing-national-id', noId, `${noId.length} row(s) have no ${country.nationalId.name}`, { suggestion: 'Add the CNIC where available so records link reliably across facilities.' });
  }

  // --- Duplicates and identity -------------------------------------------
  const seen = new Map();
  for (const r of rows) {
    const key = JSON.stringify(Object.keys(r.rec).sort().map((k) => [k, r.rec[k]]));
    if (seen.has(key)) {
      add('exact-duplicate', [seen.get(key), r], `Line ${r.line} repeats line ${seen.get(key).line} exactly`, {
        suggestion: 'Keep one copy.',
        fixes: [{ label: `Remove line ${r.line}`, ops: [{ op: 'drop', line: r.line }] }],
      });
    } else seen.set(key, r);
  }

  const personKey = (r) => r.cnic || (r.rec.recordId ? `rid:${r.rec.recordId}` : `n:${normaliseName(r.rec.givenName)}|${normaliseName(r.rec.familyName)}|${r.rec.dateOfBirth}`);

  // Conflicting results: same person, test and day, different results.
  const byTest = new Map();
  for (const r of rows) {
    if (r.rec.event !== 'screen' || !r.rec.test) continue;
    const k = `${personKey(r)}|${r.rec.programme}|${r.rec.test}|${r.rec.eventDate}`;
    if (!byTest.has(k)) byTest.set(k, []);
    byTest.get(k).push(r);
  }
  for (const group of byTest.values()) {
    const results = [...new Set(group.map((r) => r.rec.result))];
    if (results.length < 2) continue;
    add('conflicting-results', group, `Lines ${group.map((r) => r.line).join(', ')}: ${group[0].rec.test} on ${group[0].rec.eventDate} recorded as ${results.join(' and ')}`, {
      suggestion: 'Check the laboratory report and keep the correct result.',
      fixes: group.map((keep) => ({
        label: `Keep "${keep.rec.result}" (line ${keep.line})`,
        ops: group.filter((g) => g !== keep).map((g) => ({ op: 'drop', line: g.line })),
      })),
    });
  }

  // Identity conflicts: one CNIC, different names or birth dates.
  const byCnic = new Map();
  for (const r of rows) {
    if (!r.cnic) continue;
    if (!byCnic.has(r.cnic)) byCnic.set(r.cnic, []);
    byCnic.get(r.cnic).push(r);
  }
  for (const group of byCnic.values()) {
    const dobs = new Set(group.map((r) => r.rec.dateOfBirth));
    const names = group.map((r) => `${normaliseName(r.rec.givenName)} ${normaliseName(r.rec.familyName)}`.trim());
    const nameClash = names.some((n) => n && names.some((m) => m && jaroWinkler(n, m) < 0.85));
    if (dobs.size > 1 || nameClash) {
      add('identity-conflict', group, `CNIC used on lines ${group.map((r) => r.line).join(', ')} with ${dobs.size > 1 ? 'different birth dates' : 'different names'}`, {
        suggestion: 'One CNIC may be mistyped, or a CNIC was entered on another person\'s record. Correct it before sending.',
      });
    }
  }

  // Possible CNIC typo: two CNICs one or two keystrokes apart, same birth date, similar name.
  // Compared only within the same birth date, so large exports stay fast.
  const byDob = new Map();
  for (const [cnic, g] of byCnic) {
    const dob = g[0].rec.dateOfBirth;
    if (!byDob.has(dob)) byDob.set(dob, []);
    byDob.get(dob).push({ cnic, r: g[0], count: g.length });
  }
  for (const people of byDob.values()) for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i]; const b = people[j];
      // Cheap, exact pre-filter: each edit changes the digit counts by at most 2,
      // so edit distance <= 2 implies a digit-count difference <= 4.
      if (digitCountDifference(a.cnic, b.cnic) > 4) continue;
      if (levenshtein(a.cnic, b.cnic) > 2) continue;
      const na = `${normaliseName(a.r.rec.givenName)} ${normaliseName(a.r.rec.familyName)}`;
      const nb = `${normaliseName(b.r.rec.givenName)} ${normaliseName(b.r.rec.familyName)}`;
      if (jaroWinkler(na, nb) < 0.9) continue;
      const [keep, change] = a.count >= b.count ? [a, b] : [b, a];
      const changeRows = byCnic.get(change.cnic);
      const keepRows = byCnic.get(keep.cnic);
      add('possible-id-typo', [...keepRows, ...changeRows], `Lines ${keepRows.map((r) => r.line).join(', ')} and ${changeRows.map((r) => r.line).join(', ')}: CNICs differ by one or two digits, with the same birth date and a similar name`, {
        suggestion: 'If this is one person, use one CNIC so the records link.',
        fixes: [{ label: `Use the CNIC from line ${keepRows[0].line} on lines ${changeRows.map((r) => r.line).join(', ')}`, ops: changeRows.map((r) => ({ op: 'set', line: r.line, field: 'cnic', value: keep.r.rec.cnic })) }],
      });
    }
  }

  // Record number reused with different CNICs.
  const byRid = new Map();
  for (const r of rows) {
    if (!r.rec.recordId || !r.cnic) continue;
    if (!byRid.has(r.rec.recordId)) byRid.set(r.rec.recordId, []);
    byRid.get(r.rec.recordId).push(r);
  }
  for (const [rid, group] of byRid) {
    if (new Set(group.map((r) => r.cnic)).size > 1) add('record-id-conflict', group, `Record ${rid} appears with different CNICs on lines ${group.map((r) => r.line).join(', ')}`);
  }

  // --- Cross-row consistency per person -----------------------------------
  // Keyed with birth date too, so two people wrongly sharing a CNIC (an identity
  // conflict, reported above) are not mixed up here.
  const byPerson = new Map();
  for (const r of rows) {
    const k = `${personKey(r)}|${r.rec.dateOfBirth}`;
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(r);
  }
  for (const group of byPerson.values()) {
    const optOut = group.filter((r) => r.rec.event === 'opt-out').map((r) => r.rec.eventDate).sort()[0];
    if (optOut) {
      const after = group.filter((r) => r.rec.event === 'screen' && r.rec.eventDate > optOut);
      if (after.length) add('event-after-opt-out', after, `Lines ${after.map((r) => r.line).join(', ')}: screening after an opt-out on ${optOut}`, { suggestion: 'Confirm the person re-consented, or exclude these rows.' });
    }
    // Same-day results for a programme form one episode (e.g. HPV + cytology)
    // and are classified together, as the registry's rules engine does.
    const episodes = new Map(); // "programme|date" -> { prog, date, results, rows }
    for (const r of group) {
      const prog = programmes[r.rec.programme];
      if (r.rec.event !== 'screen' || !prog || !isRealDate(r.rec.eventDate) || !prog.tests[r.rec.test]?.results[r.rec.result]) continue;
      const k = `${prog.id}|${r.rec.eventDate}`;
      if (!episodes.has(k)) episodes.set(k, { prog, date: r.rec.eventDate, results: {}, rows: [] });
      const ep = episodes.get(k);
      ep.results[r.rec.test] = r.rec.result;
      ep.rows.push(r);
    }
    const eps = [...episodes.values()].map((ep) => ({ ...ep, outcome: ep.prog.classifyEpisode(ep.results) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const fu of group.filter((r) => r.rec.event === 'follow-up')) {
      const prog = programmes[fu.rec.programme];
      if (!prog) continue;
      const abnormal = eps.some((ep) => ep.prog.id === prog.id && ep.date <= fu.rec.eventDate && ep.outcome === 'abnormal');
      if (!abnormal) add('follow-up-without-abnormal', [fu], `Line ${fu.line}: ${prog.followUp.label.toLowerCase()} with no abnormal ${prog.id} result in this file`, { suggestion: 'Fine if the abnormal result was submitted earlier or elsewhere.' });
    }
    for (let i = 1; i < eps.length; i++) {
      const prev = eps.slice(0, i).reverse().find((ep) => ep.prog.id === eps[i].prog.id);
      const cur = eps[i];
      if (!prev || prev.outcome !== 'negative') continue;
      const gap = daysApart(prev.date, cur.date);
      if (gap < 183) {
        const lines = [...prev.rows, ...cur.rows];
        add('over-screening', lines, `Lines ${lines.map((r) => r.line).join(', ')}: repeat ${cur.prog.id} screen ${Math.round(gap)} days after a normal result`);
      }
    }
  }

  // --- Dataset-level plausibility -----------------------------------------
  for (const [test, spec] of Object.entries(POSITIVITY)) {
    const results = rows.filter((r) => r.rec.event === 'screen' && r.rec.test === test && r.rec.result);
    if (results.length < MIN_RESULTS_FOR_RATE) continue;
    const rate = results.filter((r) => spec.positive.includes(r.rec.result)).length / results.length;
    if (rate < spec.min || rate > spec.max) {
      add('positivity-out-of-range', [], `${test}: ${(rate * 100).toFixed(1)}% positive across ${results.length} results (expected ${spec.min * 100}–${spec.max * 100}%)`, {
        suggestion: rate > spec.max ? 'Check how the laboratory export codes results (e.g. "invalid" exported as positive).' : 'Check that positive results are being exported.',
      });
    }
  }

  const perDay = new Map();
  for (const r of rows) if (isRealDate(r.rec.eventDate)) perDay.set(r.rec.eventDate, (perDay.get(r.rec.eventDate) || 0) + 1);
  // Each day is compared with the other active days within 30 days of it, so
  // steady growth in activity is not mistaken for a spike.
  const days = [...perDay.entries()];
  for (const [day, n] of days) {
    if (n < 10) continue;
    const local = days.filter(([d]) => d !== day && daysApart(d, day) <= 30).map(([, c]) => c).sort((a, b) => a - b);
    if (local.length < 5) continue;
    const median = local[Math.floor(local.length / 2)];
    const mad = local.map((c) => Math.abs(c - median)).sort((a, b) => a - b)[Math.floor(local.length / 2)] || 1;
    if (n >= 4 * median && n > median + 6 * mad) {
      add('volume-spike', [], `${n} records dated ${day}, against a typical ${median} per day around that date`, { suggestion: 'Possible double entry or a batch dated with the upload day instead of the test day.' });
    }
  }

  const dobs = [...new Map(rows.filter((r) => isRealDate(r.rec.dateOfBirth)).map((r) => [personKey(r), r.rec.dateOfBirth])).values()];
  const janFirst = dobs.filter((d) => d.endsWith('-01-01')).length;
  if (dobs.length >= 20 && janFirst >= 5 && janFirst / dobs.length >= 0.05) {
    add('birth-date-heaping', [], `${janFirst} of ${dobs.length} people (${Math.round((janFirst / dobs.length) * 100)}%) have a 1 January birth date`, {
      suggestion: 'These are probably estimated ages. Ages near programme limits may be wrong; record actual birth dates where known.',
    });
  }

  if (fileSha256 && previousFileHashes.includes(fileSha256)) {
    add('duplicate-file', [], 'This exact file has already been submitted from this computer', { suggestion: 'Re-sending is safe (duplicates are ignored) but usually not intended.' });
  }

  return { queries, ...scoreQueries(queries, rows.length), rows: rows.length };
}

// Score 0-100 per dimension and overall. Row-level queries cost in proportion
// to the share of rows affected; dataset-level findings cost a fixed amount.
export function scoreQueries(queries, rowCount) {
  const dimensions = Object.fromEntries(DIMENSIONS.map((d) => [d, 100]));
  for (const d of DIMENSIONS) {
    let penalty = 0;
    for (const q of queries.filter((x) => x.dimension === d)) {
      penalty += q.lines.length && rowCount ? (q.lines.length / rowCount) * 100 * WEIGHT[q.severity] : DATASET_PENALTY[q.severity];
    }
    dimensions[d] = Math.max(0, Math.round(100 - penalty));
  }
  // Average of the mean and the weakest dimension: a file can't score well by
  // being strong in dimensions it has no problems in (e.g. integrity).
  const values = DIMENSIONS.map((d) => dimensions[d]);
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  const score = Math.round((mean + Math.min(...values)) / 2);
  return { score, dimensions };
}

/**
 * Apply staff decisions. resolutions: { [queryId]: { action: 'fix', fix: index } | { action: 'exclude' } | { action: 'accept', reason } }.
 * Unresolved critical queries exclude their rows.
 */
export function applyResolutions(records, queries, resolutions = {}) {
  const drop = new Set();
  const sets = [];
  const tally = { fixed: 0, excluded: 0, accepted: 0, autoExcluded: 0 };
  for (const q of queries) {
    const r = resolutions[q.id];
    if (r?.action === 'fix' && q.fixes[r.fix]) {
      for (const op of q.fixes[r.fix].ops) (op.op === 'drop' ? drop.add(op.line) : sets.push(op));
      tally.fixed++;
    } else if (r?.action === 'exclude') {
      q.lines.forEach((l) => drop.add(l));
      tally.excluded++;
    } else if (r?.action === 'accept') {
      tally.accepted++;
    } else if (q.severity === 'critical') {
      q.lines.forEach((l) => drop.add(l));
      tally.autoExcluded++;
    }
  }
  // _line keeps the original file line so later messages still point at the file.
  const out = records.map((rec, i) => ({ ...rec, _line: rec._line ?? i + 2 }));
  for (const s of sets) out[s.line - 2][s.field] = s.value;
  const kept = out.filter((_, i) => !drop.has(i + 2));
  return { records: kept, excludedLines: [...drop].sort((a, b) => a - b), ...tally };
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
