// Organisations, API keys, roles and data-sharing agreements.
//
// Every organisation that sends data in or takes data out is a FHIR
// Organization with: roles, an API key (stored only as a SHA-256 hash), and the
// data-sharing agreement that covers it (reference, validity, purpose, programmes).
//
// Roles:
//   submitter  may send records (only for programmes in its agreement)
//   facility   may see alerts and worklists for people it submitted
//   consumer   may take anonymised extracts (only for programmes in its agreement)
//   admin      manages organisations and reads the audit log

import { createHash, randomBytes } from 'node:crypto';
import { buildOrganization, codeIn, systems } from './fhir.js';
import { programmeList } from './programmes/index.js';

export const ROLES = ['submitter', 'facility', 'consumer', 'admin'];
const KEY_SYSTEM = 'https://example.org/cancer-registry/fhir/sid/api-key-sha256';

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');
export const newKey = () => `csr_${randomBytes(24).toString('base64url')}`;

export function createOrganization(store, { name, roles, agreement }, key = newKey()) {
  const bad = roles.filter((r) => !ROLES.includes(r));
  if (!name || !roles.length || bad.length) throw new Error(`name and roles (${ROLES.join(', ')}) are required`);
  if (!agreement?.reference || !agreement.validFrom || !agreement.validTo) {
    throw new Error('agreement.reference, validFrom and validTo are required');
  }
  const progs = agreement.programmes?.length ? agreement.programmes : programmeList.map((p) => p.id);
  const org = store.create(buildOrganization({ name, roles, agreement: { ...agreement, programmes: progs }, keyHash: hashKey(key) }));
  return { org, key };
}

export function authenticate(store, header) {
  const key = (header || '').replace(/^Bearer\s+/i, '');
  if (!key) return null;
  const org = store.findByIdentifier(KEY_SYSTEM, hashKey(key));
  return org?.active ? org : null;
}

export const rolesOf = (org) => (org?.type || []).map((t) => codeIn(t, systems.orgRole)).filter(Boolean);
export const hasRole = (org, ...roles) => rolesOf(org).some((r) => r === 'admin' || roles.includes(r));

export function agreementOf(org) {
  const ext = org?.extension?.find((e) => e.url === systems.agreement)?.extension || [];
  const get = (u) => ext.find((e) => e.url === u);
  return {
    reference: get('reference')?.valueString,
    validFrom: get('validFrom')?.valueDate,
    validTo: get('validTo')?.valueDate,
    purpose: get('purpose')?.valueString,
    programmes: ext.filter((e) => e.url === 'programme').map((e) => e.valueCode),
  };
}

export function agreementCovers(org, today, programme = null) {
  if (rolesOf(org).includes('admin')) return true;
  const a = agreementOf(org);
  if (!a.reference || today < a.validFrom || today > a.validTo) return false;
  return !programme || a.programmes.includes(programme);
}

// Public, non-secret view of an organisation.
export function describeOrg(org) {
  return { id: org.id, name: org.name, active: org.active, roles: rolesOf(org), agreement: agreementOf(org) };
}

// Make sure an admin organisation exists for the given key (from ADMIN_API_KEY).
export function ensureAdmin(store, key) {
  if (!key || authenticate(store, key)) return;
  createOrganization(store, {
    name: 'RHEAP registry administration',
    roles: ['admin'],
    agreement: { reference: 'RHEAP-INTERNAL', validFrom: '2000-01-01', validTo: '2999-12-31', purpose: 'Registry stewardship' },
  }, key);
}
