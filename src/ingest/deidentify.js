// Pseudonymisation. Runs at the source (in the submission kit or the facility's
// browser) so that names, phone numbers and national ID numbers never leave it.
//
// The pseudonym is HMAC-SHA256(key, national ID). The same person submitted by
// two hospitals gets the same pseudonym, so records link up, but without the key
// the pseudonym cannot be turned back into an ID number.

const enc = new TextEncoder();
const keyCache = new Map();

async function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  return keyCache.get(secret);
}

async function hmac(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function normaliseNationalId(raw, country) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!new RegExp(country.nationalId.pattern).test(value)) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length === country.nationalId.digits ? digits : null;
}

const norm = (s) => String(s || '').normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/**
 * Returns { pseudonym, weak }. Uses the national ID when valid. Otherwise falls
 * back to name + date of birth + district, marked weak because typos or name
 * changes stop records linking.
 */
export async function pseudonymFor(rec, secret, country) {
  const id = normaliseNationalId(rec.cnic, country);
  if (id) return { pseudonym: await hmac(secret, `${country.code}:id:${id}`), weak: false };
  if (!rec.givenName || !rec.familyName || !rec.dateOfBirth) return null;
  const basis = [norm(rec.givenName), norm(rec.familyName), rec.dateOfBirth, norm(rec.district)].join('|');
  return { pseudonym: await hmac(secret, `${country.code}:weak:${basis}`), weak: true };
}
