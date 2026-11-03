// k-anonymity for record-level extracts.
//
// Quasi-identifiers (sex, age band, province, district, year) are generalised
// step by step for the whole extract until at most 5% of rows sit in groups
// smaller than k; rows still in small groups are then suppressed. The result
// guarantees every quasi-identifier combination appears at least k times.

export const QUASI_IDENTIFIERS = ['sex', 'ageBand', 'province', 'district', 'year'];

const LEVELS = [
  { name: 'none', apply: (r) => r },
  { name: 'district removed', apply: (r) => ({ ...r, district: '*' }) },
  { name: 'district removed, 10-year age bands', apply: (r) => ({ ...r, district: '*', ageBand: widen(r.ageBand) }) },
  { name: 'district and province removed, 10-year age bands', apply: (r) => ({ ...r, district: '*', province: '*', ageBand: widen(r.ageBand) }) },
];

function widen(band) {
  const lo = Number(String(band).split('-')[0]);
  if (Number.isNaN(lo)) return band;
  const start = Math.floor(lo / 10) * 10;
  return `${start}-${start + 9}`;
}

const keyOf = (r) => QUASI_IDENTIFIERS.map((q) => r[q]).join('|');

function groupSizes(rows) {
  const sizes = new Map();
  for (const r of rows) sizes.set(keyOf(r), (sizes.get(keyOf(r)) || 0) + 1);
  return sizes;
}

export function anonymise(rows, k, maxSuppression = 0.05) {
  let chosen = null;
  for (const level of LEVELS) {
    const generalised = rows.map(level.apply);
    const sizes = groupSizes(generalised);
    const small = generalised.filter((r) => sizes.get(keyOf(r)) < k).length;
    chosen = { level: level.name, generalised, sizes, small };
    if (small <= rows.length * maxSuppression) break;
  }
  const kept = chosen.generalised.filter((r) => chosen.sizes.get(keyOf(r)) >= k);
  return { rows: kept, k, generalisation: chosen.level, suppressed: rows.length - kept.length };
}

export const fiveYearBand = (age) => {
  const lo = Math.floor(age / 5) * 5;
  return `${lo}-${lo + 4}`;
};

// True when every quasi-identifier combination occurs at least k times.
export const isKAnonymous = (rows, k) => [...groupSizes(rows).values()].every((n) => n >= k);
