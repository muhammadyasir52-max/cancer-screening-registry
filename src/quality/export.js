// Query list as CSV for fixing in the source system. Contains record numbers
// and messages only, never names or ID numbers. Stays at the source.

const cell = (v) => {
  const s = String(v ?? '');
  // Quote, and neutralise spreadsheet formula injection (=, +, -, @ at the start).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function queriesToCsv(queries, resolutions = {}) {
  const header = ['query', 'severity', 'check', 'lines', 'record_numbers', 'message', 'suggestion', 'decision'];
  const rows = queries.map((q) => [
    q.id, q.severity, q.title, q.lines.join(' '), q.recordIds.join(' '), q.message, q.suggestion,
    resolutions[q.id]?.action ? `${resolutions[q.id].action}${resolutions[q.id].reason ? `: ${resolutions[q.id].reason}` : ''}` : (q.severity === 'critical' ? 'unresolved (rows excluded)' : 'unresolved'),
  ]);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
