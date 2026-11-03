// FHIR resource store. Resources are held in memory with indexes, and written
// through to a persistence backend: none (tests), a JSON file (small demos) or
// SQLite via Node's built-in node:sqlite (default for the server).
// For production, replace with a FHIR server such as HAPI FHIR on PostgreSQL.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RESOURCE_TYPES = ['Patient', 'Observation', 'Procedure', 'Condition', 'Consent', 'Flag', 'Organization', 'Provenance', 'AuditEvent'];

const subjectOf = (r) => (r.subject || r.patient)?.reference || null;

export class Store {
  constructor(backend = null) {
    this.backend = backend;
    this.data = Object.fromEntries(RESOURCE_TYPES.map((t) => [t, new Map()]));
    this.byPatient = new Map(); // "Patient/id" -> Set of "Type/id"
    this.byIdentifier = new Map(); // "system|value" -> "Type/id"
    for (const r of backend?.load() || []) this.#index(r);
  }

  #index(r, prev = null) {
    if (prev) this.#unindex(prev);
    this.data[r.resourceType].set(r.id, r);
    const subj = subjectOf(r);
    if (subj) {
      if (!this.byPatient.has(subj)) this.byPatient.set(subj, new Set());
      this.byPatient.get(subj).add(`${r.resourceType}/${r.id}`);
    }
    for (const id of r.identifier || []) this.byIdentifier.set(`${id.system}|${id.value}`, `${r.resourceType}/${r.id}`);
  }

  #unindex(r) {
    const subj = subjectOf(r);
    this.byPatient.get(subj)?.delete(`${r.resourceType}/${r.id}`);
    for (const id of r.identifier || []) this.byIdentifier.delete(`${id.system}|${id.value}`);
  }

  create(resource) {
    const r = structuredClone(resource);
    r.id = randomUUID();
    r.meta = { ...(r.meta || {}), versionId: '1', lastUpdated: new Date().toISOString() };
    this.#index(r);
    this.backend?.write(r);
    return r;
  }

  update(resource) {
    const prev = this.read(resource.resourceType, resource.id);
    if (!prev) throw new Error(`${resource.resourceType}/${resource.id} not found`);
    const r = structuredClone(resource);
    r.meta = { ...(r.meta || {}), versionId: String(Number(prev.meta.versionId) + 1), lastUpdated: new Date().toISOString() };
    this.#index(r, prev);
    this.backend?.write(r);
    return r;
  }

  read(type, id) {
    return this.data[type]?.get(id) || null;
  }

  all(type) {
    return [...(this.data[type]?.values() || [])];
  }

  forPatient(type, patientId) {
    const refs = this.byPatient.get(`Patient/${patientId}`);
    if (!refs) return [];
    const out = [];
    for (const ref of refs) {
      const [t, id] = ref.split('/');
      if (t === type) out.push(this.data[t].get(id));
    }
    return out;
  }

  findByIdentifier(system, value) {
    const ref = this.byIdentifier.get(`${system}|${value}`);
    if (!ref) return null;
    const [t, id] = ref.split('/');
    return this.data[t].get(id) || null;
  }

  // Run fn so that its writes reach the backend all together or not at all.
  transaction(fn) {
    if (!this.backend?.begin) return fn();
    this.backend.begin();
    try {
      const result = fn();
      this.backend.commit();
      return result;
    } catch (err) {
      this.backend.rollback();
      throw err;
    }
  }

  clear() {
    for (const t of RESOURCE_TYPES) this.data[t].clear();
    this.byPatient.clear();
    this.byIdentifier.clear();
    this.backend?.clear();
  }

  save() {
    this.backend?.flush?.(this);
  }
}

// Whole-file JSON persistence; flushed on save().
export class JsonBackend {
  constructor(file) { this.file = file; }
  load() {
    if (!existsSync(this.file)) return [];
    const saved = JSON.parse(readFileSync(this.file, 'utf8'));
    return Object.values(saved).flat();
  }
  write() {}
  clear() {}
  flush(store) {
    mkdirSync(dirname(this.file), { recursive: true });
    const out = Object.fromEntries(RESOURCE_TYPES.map((t) => [t, store.all(t)]));
    writeFileSync(`${this.file}.tmp`, JSON.stringify(out));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

// SQLite persistence: each resource is upserted as it is written.
export class SqliteBackend {
  constructor(file, DatabaseSync) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS resources (
        type TEXT NOT NULL, id TEXT NOT NULL, subject TEXT, json TEXT NOT NULL, updated TEXT NOT NULL,
        PRIMARY KEY (type, id));
      CREATE INDEX IF NOT EXISTS resources_subject ON resources(subject);`);
    this.upsert = this.db.prepare(`INSERT INTO resources (type, id, subject, json, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(type, id) DO UPDATE SET subject = excluded.subject, json = excluded.json, updated = excluded.updated`);
  }
  load() {
    return this.db.prepare('SELECT json FROM resources').all().map((r) => JSON.parse(r.json));
  }
  write(r) {
    this.upsert.run(r.resourceType, r.id, subjectOf(r), JSON.stringify(r), r.meta.lastUpdated);
  }
  begin() { this.db.exec('BEGIN'); }
  commit() { this.db.exec('COMMIT'); }
  rollback() { this.db.exec('ROLLBACK'); }
  clear() {
    this.db.exec('DELETE FROM resources');
  }
}

export async function openStore({ kind = process.env.STORE || 'sqlite', file } = {}) {
  if (kind === 'memory') return new Store();
  if (kind === 'json') return new Store(new JsonBackend(file || fileURLToPath(new URL('../data/store.json', import.meta.url))));
  const { DatabaseSync } = await import('node:sqlite');
  return new Store(new SqliteBackend(file || fileURLToPath(new URL('../data/registry.db', import.meta.url)), DatabaseSync));
}
