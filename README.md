# Open Cancer Screening Registry

An open-source national registry for cancer screening, built on **HL7 FHIR R4**.
It starts in **Pakistan** and is designed to be reused by other countries.

- **Owner:** RHEAP, a neutral organisation that stewards the registry and its data
- **Developer:** BYTEBUZ
- **Licence:** [MIT](LICENSE)

> ⚠️ **MVP running on synthetic data only. No real patients.** Every demo
> record is generated and labelled with the HL7 `HTEST` ("test health data")
> security tag. Screening ages and intervals are illustrative, not clinical
> guidance. See [GOVERNANCE.md](GOVERNANCE.md) for what must happen before any
> real data is processed.

## What it does

| | |
| --- | --- |
| **Four programmes** | Cervical (HPV, cytology, VIA), breast (mammography BI-RADS, clinical exam), colorectal (FIT), oral (visual exam) |
| **Data in** | Hospitals, screening units and existing cancer registries submit through a CSV upload in the browser, a command-line submission kit, or a FHIR connector that pulls from their own FHIR server. CanReg5 exports are supported. |
| **Data Quality Studio** | Before sending, each file is checked on the provider's machine for duplicates, CNIC typos and identity conflicts (fuzzy matching), invalid or impossible values, logic errors, unusual positivity rates, volume spikes and estimated birth dates. Staff fix, exclude or accept each query; RHEAP receives a quality score as counts only. See [docs/data-quality.md](docs/data-quality.md). |
| **AI data assistant (off in the MVP)** | A Claude-based assistant that explains quality findings, built but switched off until funding and governance approval. It would see only aggregate counts, never patient rows. |
| **De-identified at source** | Names, phone numbers and CNICs are removed on the provider's machine. The registry receives a keyed pseudonym (HMAC-SHA256), birth month, sex and district, and rejects anything identifiable. |
| **Record linkage** | The same person seen by two hospitals, and later diagnosed by a cancer registry, links up by pseudonym. |
| **Rules and alerts** | Per programme: up to date, due soon, overdue, never screened, abnormal awaiting follow-up, diagnosed, opted out. Alerts (FHIR `Flag`) go back to the facility, which sees only its own record numbers. |
| **Data out** | A public dashboard (coverage against target, screening cascade, monthly volumes, district heat table, results mix) with suppressed totals and protection against working out hidden counts by subtraction; k-anonymous record-level extracts for approved consumers (NDJSON). |
| **Governance** | Organisations, roles and data-sharing agreements; FHIR `Provenance` per import; FHIR `AuditEvent` for every request; opt-out via FHIR `Consent`. |
| **Complements existing registries** | Existing registries keep running and contribute diagnoses; nothing is taken over. |

## Quick start

Needs Node.js 22.13 or later. No other dependencies.

```bash
npm start
```

The first start loads synthetic demo organisations and about 1,700 synthetic people into `data/registry.db` (SQLite).

| URL | What |
| --- | --- |
| http://localhost:3000/ | Public dashboard |
| http://localhost:3000/portal | Facility portal: alerts, worklist, data-quality check and de-identified upload |
| http://localhost:3000/admin | Organisations, agreements, import history, audit log |
| http://localhost:3000/fhir/metadata | FHIR CapabilityStatement |

**Demo keys** (synthetic data only; never use outside a demo):

| Key | Organisation | Roles |
| --- | --- | --- |
| `demo-admin-key` | RHEAP registry administration | admin |
| `demo-lahore-key` | Demo Teaching Hospital, Lahore | submitter, facility |
| `demo-karachi-key` | Demo General Hospital, Karachi | submitter, facility |
| `demo-kp-key` | Demo Mobile Screening Unit, KP (no colorectal) | submitter, facility |
| `demo-registry-key` | Demo Population Cancer Registry | submitter |
| `demo-research-key` | Demo University Research Group (cervical and breast only) | consumer |

Demo pseudonymisation key: `demo-pseudonymisation-key-not-for-real-data`.

To see the Data Quality Studio, sign in to the portal with `demo-lahore-key`, open **Submit data** and choose `public/samples/messy-hospital-export.csv`.

Other commands: `npm test` runs the test suite. `npm run reset-demo` reloads the demo data. `npm run build:pages` builds the static dashboard.

### Submitting from a provider's site

```bash
PSEUDONYM_KEY=demo-pseudonymisation-key-not-for-real-data node scripts/submit.js --file public/samples/messy-hospital-export.csv --key demo-lahore-key --quality-report queries.csv --block-on-critical --dry-run
```

```bash
PSEUDONYM_KEY=... node scripts/pull.js --source https://emr.hospital.local/fhir --key <API key> --since 2026-01-01
```

The column layout is described in [docs/data-template.md](docs/data-template.md).

### Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `STORE` | `sqlite` | `sqlite`, `json` or `memory` |
| `COUNTRY` | `pk` | Country pack in `config/countries/` |
| `DEMO` | on | `DEMO=0` starts empty, without demo organisations |
| `ADMIN_API_KEY` | unset | Creates an admin organisation for this key on start |
| `PSEUDONYM_KEY` | — | Submission kit only: the key from RHEAP's key custodian |
| `REAL_DATA` | unset | Submission kit only: `1` removes the test-data label (real data under agreement only) |
| `ASSISTANT_ENABLED` | unset | `1` plus `ANTHROPIC_API_KEY` switches on the AI assistant. **Leave unset in the MVP** (see GOVERNANCE.md) |

## API

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /api/public/stats` | public | Suppressed statistics for all programmes |
| `GET /api/public/country` | public | Country pack (regions, parameters) |
| `POST /fhir` | submitter | De-identified FHIR `transaction` Bundle; optional `X-Quality-Summary` header (aggregate counts only, validated) |
| `GET /api/facility/alerts` | facility | Active alerts for the facility's people |
| `GET /api/facility/worklist?programme=&status=` | facility | Worklist |
| `GET /api/export?programme=` | consumer | k-anonymous NDJSON extract |
| `GET /api/admin/organizations`, `POST` | admin | List or create organisations (API key shown once) |
| `GET /api/admin/imports` | admin | Provenance of every import |
| `GET /api/admin/audit` | admin | Audit log |
| `POST /api/assistant` | submitter, facility | AI assistant over an aggregate quality summary (returns 503 while switched off) |
| `GET /api/public/assistant` | public | Whether the assistant is switched on |
| `GET /fhir/{type}[/{id}]` | admin | Raw pseudonymised FHIR resources |

Authenticate with `Authorization: Bearer <API key>`. Errors are FHIR `OperationOutcome`s.

## FHIR model

| Concept | Resource | Coding |
| --- | --- | --- |
| Person (de-identified) | `Patient` | Pseudonym and source-record identifiers; birth month; district and province |
| Screening result | `Observation` | LOINC 21440-3 (HPV), 10524-7 (cytology), 24606-6 (mammography), 29771-3 (FIT); local codes for VIA, clinical breast exam, oral exam and BI-RADS values |
| Follow-up | `Procedure` | SNOMED CT 392003006 (colposcopy), 73761001 (colonoscopy); local codes for breast and oral assessment |
| Cancer diagnosis | `Condition` | ICD-O-3 topography (bodySite) and morphology (code) |
| Opt-out | `Consent` | provision deny |
| Alert | `Flag` | local alert codes plus programme; `flag-priority` extension |
| Organisation and agreement | `Organization` | roles, agreement extension, hashed API key |
| Import record | `Provenance` | agreement as policy |
| Access log | `AuditEvent` | |

Terminology bindings must be verified against a terminology server and national profiles before production.

## Layout

```
config/countries/pk.json   Pakistan country pack: CNIC format, regions, programme parameters, thresholds
src/programmes/            One module per programme: tests, codes, follow-up, classification
src/rules.js               Generic rules engine
src/ingest/                CSV parsing, layout mappings, pseudonymisation, FHIR bundle builder (also runs in the browser)
src/connectors/fhir.js     Pull connector for source FHIR servers
src/registry.js            Ingest, alerts, facility views, statistics, extracts
src/auth.js                Organisations, API keys, roles, agreements
src/quality/               Data Quality Studio: checks, fuzzy matching, scoring, privacy-safe summary (also runs in the browser)
src/assistant.js           Optional AI assistant (off by default)
src/kanon.js               k-anonymity for extracts
src/store.js               In-memory indexed store with SQLite or JSON persistence
src/app.js, src/server.js  HTTP layer
public/                    Dashboard, facility portal, admin pages, shared UI and charts (ui.js), sample files
scripts/                   Submission kit, FHIR pull, demo reset, static build
docs/                      Pakistan context, agreement and DPIA templates, data template
```

## Adding a country

Copy `config/countries/pk.json`, set the national ID format, regions, programme parameters and thresholds, and start with `COUNTRY=<code>`. No code changes are needed.

## Roadmap after the MVP

- Switch on the AI data assistant after funding and governance approval
- Trusted-third-party linkage so providers no longer hold the pseudonymisation key
- DHIS2 connector; more mappings as registries join
- User accounts with SSO/MFA for facility staff; Urdu interface
- Production deployment on a FHIR server (e.g. HAPI FHIR on PostgreSQL) hosted in Pakistan
- Automated retention and purge; formal statistical disclosure control review

## Contributing and security

Issues and pull requests are welcome. Never include real patient data in issues, tests or sample files. See [SECURITY.md](SECURITY.md) to report vulnerabilities.
