// The only quality information that leaves a source: aggregate counts and
// scores. No row, line number, record number, name, ID number, date or free
// text. The same validator runs in the browser before sending and on the
// server before storing (and before anything is shown to an AI assistant).

import { CHECKS, DIMENSIONS, SEVERITIES } from './index.js';

export const SUMMARY_SCHEMA = 'quality-summary/1';
const MAX_COUNT = 10_000_000;

// `resolutions` (optional) counts how many queries per check staff resolved
// (fixed, excluded or accepted); the decisions themselves stay at the source.
export function buildQualitySummary({ queries, score, dimensions, rows, sent, excluded, fileSha256, resolutions = {} }) {
  const checks = {};
  for (const q of queries) {
    const c = (checks[q.check] ||= { severity: CHECKS[q.check].severity, queries: 0, rows: 0, resolved: 0 });
    c.queries++;
    c.rows += q.lines.length;
    if (resolutions[q.id]) c.resolved++;
    if (SEVERITIES.indexOf(q.severity) < SEVERITIES.indexOf(c.severity)) c.severity = q.severity;
  }
  return { schema: SUMMARY_SCHEMA, fileSha256: fileSha256 || null, rows, sent, excluded, score, dimensions, checks };
}

const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;
const isScore = (n) => Number.isInteger(n) && n >= 0 && n <= 100;

/**
 * Returns a clean copy built only from known keys, or throws an Error listing problems.
 * Anything not on the whitelist is rejected, so free text cannot be smuggled through.
 */
export function validateQualitySummary(input) {
  const p = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Quality summary must be an object');
  const allowedTop = ['schema', 'fileSha256', 'rows', 'sent', 'excluded', 'score', 'dimensions', 'checks'];
  for (const k of Object.keys(input)) if (!allowedTop.includes(k)) p.push(`unknown field "${k}"`);
  if (input.schema !== SUMMARY_SCHEMA) p.push(`schema must be ${SUMMARY_SCHEMA}`);
  if (input.fileSha256 !== null && !/^[0-9a-f]{64}$/.test(input.fileSha256 || '')) p.push('fileSha256 must be 64 hex characters or null');
  for (const k of ['rows', 'sent', 'excluded']) if (!isCount(input[k])) p.push(`${k} must be a non-negative integer`);
  if (!isScore(input.score)) p.push('score must be an integer 0-100');
  const dims = input.dimensions;
  if (!dims || typeof dims !== 'object') p.push('dimensions missing');
  else {
    for (const k of Object.keys(dims)) if (!DIMENSIONS.includes(k)) p.push(`unknown dimension "${k}"`);
    for (const d of DIMENSIONS) if (!isScore(dims[d])) p.push(`dimension ${d} must be an integer 0-100`);
  }
  const checks = input.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) p.push('checks missing');
  else {
    for (const [id, c] of Object.entries(checks)) {
      if (!CHECKS[id]) { p.push(`unknown check "${id}"`); continue; }
      if (!c || typeof c !== 'object') { p.push(`check ${id} must be an object`); continue; }
      for (const k of Object.keys(c)) if (!['severity', 'queries', 'rows', 'resolved'].includes(k)) p.push(`check ${id}: unknown field "${k}"`);
      if (!SEVERITIES.includes(c.severity)) p.push(`check ${id}: bad severity`);
      if (!isCount(c.queries) || !isCount(c.rows) || !isCount(c.resolved ?? 0)) p.push(`check ${id}: counts must be non-negative integers`);
      else if ((c.resolved ?? 0) > c.queries) p.push(`check ${id}: resolved cannot exceed queries`);
    }
  }
  if (p.length) throw new Error(`Quality summary rejected: ${p.join('; ')}`);
  return {
    schema: SUMMARY_SCHEMA,
    fileSha256: input.fileSha256,
    rows: input.rows,
    sent: input.sent,
    excluded: input.excluded,
    score: input.score,
    dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, dims[d]])),
    checks: Object.fromEntries(Object.entries(checks).map(([id, c]) => [id, { severity: c.severity, queries: c.queries, rows: c.rows, resolved: c.resolved ?? 0 }])),
  };
}

// Plain-language explanation built locally from the summary. Shown while the
// AI assistant is switched off, and used as its fallback.
export function explainSummary(summary) {
  const order = { critical: 0, warning: 1, info: 2 };
  const open = (c) => c.queries - (c.resolved || 0);
  // Open findings first, by severity then size; fully resolved checks last.
  const found = Object.entries(summary.checks).sort((a, b) =>
    (open(a[1]) ? 0 : 1) - (open(b[1]) ? 0 : 1) || order[a[1].severity] - order[b[1].severity] || b[1].rows - a[1].rows);
  const rating = summary.score >= 90 ? 'good' : summary.score >= 75 ? 'fair' : 'needs attention';
  const bullets = found.filter(([, c]) => open(c)).slice(0, 6).map(([id, c]) => {
    const size = c.rows ? `${c.rows} row${c.rows === 1 ? '' : 's'}` : `${c.queries} finding${c.queries === 1 ? '' : 's'}`;
    const state = c.resolved ? `${c.severity}, ${c.resolved} of ${c.queries} resolved` : c.severity;
    return `${CHECKS[id].title}: ${size} (${state}).`;
  });
  const done = found.filter(([, c]) => !open(c)).map(([id]) => CHECKS[id].title);
  if (done.length) bullets.push(`Resolved at source: ${done.slice(0, 4).join('; ')}${done.length > 4 ? `; and ${done.length - 4} more` : ''}.`);
  const actions = [];
  const openCritical = found.filter(([, c]) => c.severity === 'critical' && open(c)).reduce((a, [, c]) => a + open(c), 0);
  if (openCritical) actions.push(`Resolve the ${openCritical} open critical ${openCritical === 1 ? 'query' : 'queries'} first: unresolved critical rows are left out of the submission.`);
  const isOpen = (id) => summary.checks[id] && open(summary.checks[id]);
  if (isOpen('possible-id-typo') || isOpen('identity-conflict')) actions.push('Check the CNICs flagged as conflicting, so the same person links correctly across facilities.');
  if (isOpen('positivity-out-of-range')) actions.push('Ask the laboratory to confirm how results are coded in the export.');
  if (isOpen('birth-date-heaping')) actions.push('Record actual birth dates where known; estimated ages affect who is invited.');
  if (!actions.length) actions.push('No action needed beyond a quick review.');
  return {
    headline: `Data quality ${summary.score}/100 (${rating}). ${summary.sent} of ${summary.rows} rows ready to send${summary.excluded ? `, ${summary.excluded} excluded` : ''}.`,
    bullets: bullets.length ? bullets : ['No issues found.'],
    actions,
  };
}
