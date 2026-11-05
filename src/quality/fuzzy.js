// String similarity helpers for duplicate and typo detection. No dependencies.

export function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Jaro-Winkler similarity in [0, 1]; robust to the small spelling variations
// common in transliterated names (e.g. "Ayesha" / "Aisha").
export function jaroWinkler(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export const normaliseName = (s) => String(s || '').normalize('NFKD').replace(/[^\p{L}]/gu, '').toLowerCase();

// The closest candidate within a distance limit, or null.
export function closest(value, candidates, maxDistance = 2) {
  const v = String(value || '').toLowerCase().trim();
  if (!v) return null;
  let best = null;
  for (const c of candidates) {
    const d = levenshtein(v, String(c).toLowerCase());
    if (d <= maxDistance && (!best || d < best.distance)) best = { value: c, distance: d };
  }
  return best?.value ?? null;
}
