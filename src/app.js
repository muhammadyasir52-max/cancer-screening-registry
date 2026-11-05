// HTTP layer. Public: anonymised statistics, the country pack, static pages and
// the browser-side ingest modules. Everything else needs an organisation API
// key, is checked against the organisation's roles and data-sharing agreement,
// and is written to the audit log.

import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCE_TYPES } from './store.js';
import { authenticate, hasRole, rolesOf, agreementCovers, createOrganization, describeOrg } from './auth.js';
import { programmes } from './programmes/index.js';
import { validateQualitySummary } from './quality/summary.js';
import { createAssistant } from './assistant.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const SRC_DIR = join(ROOT, 'src');
// Source modules the browser may load (de-identification and quality checks).
const BROWSER_MODULES = /^(fhir\.js|programmes\/\w+\.js|ingest\/\w+\.js|quality\/\w+\.js)$/;
const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp(registry, { assistant = createAssistant() } = {}) {
  const { store, country } = registry;

  const require = (org, ...roles) => {
    if (!org) throw new HttpError(401, 'Missing or invalid API key');
    if (!hasRole(org, ...roles)) throw new HttpError(403, `Requires role: ${roles.join(' or ')}`);
    // No access of any kind outside an organisation's agreement period.
    if (!agreementCovers(org, registry.todayIso())) throw new HttpError(403, 'No active data-sharing agreement');
  };

  async function handle(req, res, ctx) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;

    // --- Public -----------------------------------------------------------
    if (method === 'GET' && path === '/api/public/stats') return json(res, 200, registry.publicStats());
    if (method === 'GET' && path === '/api/public/country') return json(res, 200, country);
    if (method === 'GET' && path === '/api/public/assistant') return json(res, 200, { enabled: assistant.enabled });
    if (method === 'GET' && path === '/fhir/metadata') return json(res, 200, capabilityStatement(), FHIR_JSON);
    if (method === 'GET' && path.startsWith('/lib/')) return serveModule(res, path.slice(5));
    if (!path.startsWith('/fhir') && !path.startsWith('/api')) return serveStatic(res, path);

    // --- Authenticated ----------------------------------------------------
    const org = authenticate(store, req.headers.authorization);
    ctx.org = org;
    const isAdmin = rolesOf(org).includes('admin');
    const today = registry.todayIso();

    if (method === 'GET' && path === '/api/me') {
      require(org, 'submitter', 'facility', 'consumer');
      return json(res, 200, describeOrg(org));
    }

    if (method === 'POST' && path === '/fhir') {
      require(org, 'submitter');
      const quality = parseQualityHeader(req.headers['x-quality-summary']);
      const body = await readJson(req);
      const source = String(req.headers['x-submission-source'] || 'api').slice(0, 120);
      return json(res, 200, registry.ingestTransaction(body, org, { source, quality }), FHIR_JSON);
    }

    if (method === 'POST' && path === '/api/assistant') {
      require(org, 'submitter', 'facility');
      if (!assistant.enabled) {
        throw new HttpError(503, 'The AI assistant is not activated in this MVP. It will be enabled after funding and governance approval.');
      }
      const body = await readJson(req, 16_000);
      let summary;
      try {
        summary = validateQualitySummary(body.summary);
      } catch (err) {
        throw new HttpError(422, err.message);
      }
      const question = typeof body.question === 'string' ? body.question.slice(0, 500) : '';
      return json(res, 200, await assistant.ask(summary, question));
    }

    const fhir = path.match(/^\/fhir\/([A-Za-z]+)(?:\/([\w-]+))?$/);
    if (fhir && method === 'GET') {
      require(org, 'admin');
      const [, type, id] = fhir;
      if (!RESOURCE_TYPES.includes(type)) throw new HttpError(404, `Unsupported resource type ${type}`);
      if (id) {
        const r = store.read(type, id);
        if (!r) throw new HttpError(404, `${type}/${id} not found`);
        return json(res, 200, r, FHIR_JSON);
      }
      return json(res, 200, search(store, type, url.searchParams), FHIR_JSON);
    }

    if (method === 'GET' && path === '/api/facility/alerts') {
      require(org, 'facility');
      return json(res, 200, registry.facilityAlerts(org, { isAdmin }));
    }
    if (method === 'GET' && path === '/api/facility/worklist') {
      require(org, 'facility');
      const programme = url.searchParams.get('programme') || undefined;
      if (programme && !programmes[programme]) throw new HttpError(422, `Unknown programme ${programme}`);
      return json(res, 200, registry.facilityWorklist(org, { programme, status: url.searchParams.get('status') || undefined, isAdmin }));
    }

    if (method === 'GET' && path === '/api/export') {
      require(org, 'consumer');
      const programme = url.searchParams.get('programme');
      if (!programmes[programme]) throw new HttpError(422, `programme must be one of ${Object.keys(programmes).join(', ')}`);
      if (!agreementCovers(org, today, programme)) throw new HttpError(403, `No active agreement covering the ${programme} programme`);
      const result = registry.anonymisedExtract(programme);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${programme}-anonymised-${today}.ndjson"`,
        'X-K-Anonymity': String(result.k),
        'X-Generalisation': result.generalisation,
        'X-Suppressed-Rows': String(result.suppressed),
      });
      return res.end(result.rows.map((r) => JSON.stringify(r)).join('\n') + (result.rows.length ? '\n' : ''));
    }

    if (path.startsWith('/api/admin/')) {
      require(org, 'admin');
      if (method === 'GET' && path === '/api/admin/organizations') return json(res, 200, registry.organizations());
      if (method === 'POST' && path === '/api/admin/organizations') {
        const b = await readJson(req);
        try {
          const { org: created, key } = createOrganization(store, {
            name: String(b.name || '').trim(),
            roles: Array.isArray(b.roles) ? b.roles : [],
            agreement: b.agreement || {},
          });
          store.save();
          // The key is shown once and never stored in clear.
          return json(res, 201, { organization: describeOrg(created), apiKey: key });
        } catch (err) {
          throw new HttpError(422, err.message);
        }
      }
      if (method === 'GET' && path === '/api/admin/imports') return json(res, 200, registry.importHistory());
      if (method === 'GET' && path === '/api/admin/audit') return json(res, 200, registry.auditLog(Number(url.searchParams.get('limit')) || 200));
      if (method === 'POST' && path === '/api/admin/rules/run') return json(res, 200, registry.refreshAll());
    }

    throw new HttpError(404, 'Not found');
  }

  return async (req, res) => {
    const ctx = { org: null };
    let status = 500;
    try {
      await handle(req, res, ctx);
      status = res.statusCode;
    } catch (err) {
      status = err.status || 500;
      if (status === 500) console.error(err);
      const message = status === 500 ? 'Internal error' : err.message;
      json(res, status, operationOutcome(status, message, err.problems), FHIR_JSON);
    } finally {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path.startsWith('/fhir/') && path !== '/fhir/metadata' || path === '/fhir' || (path.startsWith('/api/') && !path.startsWith('/api/public/'))) {
        registry.audit({ orgId: ctx.org?.id, method: req.method, path, status });
      }
    }
  };
}

function search(store, type, params) {
  let results = store.all(type);
  const subject = params.get('patient') || params.get('subject');
  if (subject) results = results.filter((r) => (r.subject || r.patient)?.reference === (subject.includes('/') ? subject : `Patient/${subject}`));
  const status = params.get('status');
  if (status) results = results.filter((r) => r.status === status);
  const identifier = params.get('identifier');
  if (identifier) {
    const [sys, val] = identifier.includes('|') ? identifier.split('|') : [null, identifier];
    results = results.filter((r) => r.identifier?.some((i) => i.value === val && (!sys || i.system === sys)));
  }
  const count = Math.min(Number(params.get('_count')) || 50, 500);
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: results.length,
    entry: results.slice(0, count).map((r) => ({ fullUrl: `${type}/${r.id}`, resource: r, search: { mode: 'match' } })),
  };
}

function capabilityStatement() {
  return {
    resourceType: 'CapabilityStatement',
    status: 'draft',
    date: new Date().toISOString().slice(0, 10),
    kind: 'instance',
    software: { name: 'Open Cancer Screening Registry (MVP)' },
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    rest: [{
      mode: 'server',
      security: { description: 'Bearer API key per organisation. Roles: submitter, facility, consumer, admin.' },
      interaction: [{ code: 'transaction', documentation: 'De-identified submissions only. Patients may carry only pseudonym and source-record identifiers.' }],
      resource: RESOURCE_TYPES.map((type) => ({
        type,
        interaction: [{ code: 'read' }, { code: 'search-type' }],
        searchParam: [{ name: 'patient', type: 'reference' }, { name: 'status', type: 'token' }, { name: 'identifier', type: 'token' }],
      })),
    }],
  };
}

function operationOutcome(status, diagnostics, problems) {
  const code = { 401: 'security', 403: 'forbidden', 404: 'not-found', 422: 'invalid' }[status] || 'exception';
  return {
    resourceType: 'OperationOutcome',
    issue: problems?.length
      ? problems.slice(0, 100).map((p) => ({ severity: 'error', code, diagnostics: p }))
      : [{ severity: 'error', code, diagnostics }],
  };
}

async function serveModule(res, rel) {
  if (!BROWSER_MODULES.test(rel)) throw new HttpError(404, 'Not found');
  const body = await readFile(join(SRC_DIR, rel));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME['.js'] });
  res.end(body);
}

async function serveStatic(res, path) {
  const rel = normalize(path === '/' ? 'index.html' : path.slice(1));
  if (rel.startsWith('..')) throw new HttpError(404, 'Not found');
  const file = join(PUBLIC_DIR, extname(rel) ? rel : `${rel}.html`);
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

function json(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(JSON.stringify(body));
}

// The aggregate quality summary sent alongside a submission (never rows).
function parseQualityHeader(value) {
  if (!value) return null;
  if (value.length > 8192) throw new HttpError(413, 'X-Quality-Summary too large');
  try {
    return validateQualitySummary(JSON.parse(value));
  } catch (err) {
    throw new HttpError(422, err instanceof SyntaxError ? 'X-Quality-Summary is not valid JSON' : err.message);
  }
}

async function readJson(req, limit = 50_000_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, 'Body too large');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}
