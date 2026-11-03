# Data governance

This document describes how the Open Cancer Screening Registry handles data. It
is the starting point for the registry's formal governance framework. Before
any real data is processed it must be reviewed and adopted by RHEAP's board,
reviewed by Pakistani legal counsel, and backed by a completed data protection
impact assessment ([template](docs/dpia-template.md)).

## Roles

| Party | Role | Responsibilities |
| --- | --- | --- |
| **RHEAP** | Owner and data steward (controller of the central registry) | Approves organisations and agreements; holds the pseudonymisation key through a named key custodian; runs the data access committee; publishes this policy and an annual transparency report |
| **BYTEBUZ** | Software developer; operator under contract if it hosts the service | Builds and maintains the open-source software; processes data only on RHEAP's written instructions; no independent use of registry data |
| **Data providers** (hospitals, screening units, existing cancer registries) | Controllers of their own records | Keep their own systems and registries running; de-identify at source with the submission kit; submit only under a signed [data-sharing agreement](docs/data-sharing-agreement-template.md) |
| **Data consumers** (health departments, researchers, UNICEF/WHO programme teams) | Recipients of anonymised data | Apply through a data access request; use data only for the approved purpose; no attempts at re-identification |
| **Government** (federal and provincial health authorities) | Endorser; may later mandate reporting | Sets national screening protocols that replace the illustrative parameters in the country pack |

The registry **complements existing registries**: it does not replace or take
over any provider's records. Population cancer registries continue as they are
and send diagnoses so screening can be evaluated against outcomes.

## Data classification

| Class | Examples | Where it may exist |
| --- | --- | --- |
| Direct identifiers | Name, CNIC, phone number, street address, full date of birth | **Only at the source.** Never sent to, or stored by, the national registry. The server rejects any submission that contains them. |
| Pseudonymised data | Keyed pseudonym, source record number, birth month, sex, district, screening results, diagnoses | Central registry (encrypted at rest, access by role) |
| Anonymised extracts | k-anonymous rows (k ≥ 5): sex, age band, province/district, year, status | Approved consumers, under a data access agreement |
| Aggregate statistics | Counts and percentages with small-number suppression (<5) | Public |

## Principles in the software

1. **De-identification at the source.** The submission kit (`scripts/submit.js`,
   `scripts/pull.js`) and the facility portal remove direct identifiers on the
   provider's own machine. The national ID is replaced with
   HMAC-SHA256(key, ID), so the same person links across providers but cannot be
   identified without the key.
2. **Server-side guard.** `directIdentifierProblems()` in `src/fhir.js` rejects
   any Patient with a name, telecom, street address, full date of birth or an
   unrecognised identifier. Bundles are all-or-nothing.
3. **Agreement-bound flows.** Every organisation is tied to an agreement with a
   reference, validity period, purpose and covered programmes. Submissions and
   exports outside it are refused (`agreementCovers()` in `src/auth.js`).
4. **Least privilege.** Roles: `submitter`, `facility`, `consumer`, `admin`.
   Facilities see only people they submitted, identified only by their own
   record numbers. Consumers never see pseudonyms or record numbers.
5. **Provenance.** Every accepted submission creates a FHIR `Provenance`
   record naming the organisation, agreement and source file.
6. **Audit.** Every authenticated request, including refusals, writes a FHIR
   `AuditEvent`. Administrators review the log; it should be exported to
   write-once storage in production.
7. **Opt-out.** A provider can record a person's opt-out (FHIR `Consent`,
   provision deny). Opted-out people are excluded from alerts, statistics and
   extracts. Their minimal record is kept so the opt-out is honoured if they
   are submitted again.
8. **Disclosure control.** Public figures suppress counts of 1–4 and any
   percentage that would reveal them. Extracts are generalised and suppressed
   to k-anonymity (`src/kanon.js`).

## Pseudonymisation key

- Generated and held by RHEAP's **key custodian** (a named role, not BYTEBUZ).
- Distributed to approved providers over a secure channel together with their
  agreement; never sent to the central registry server.
- Rotation requires re-pseudonymising the store under the custodian's
  supervision. A breach of the key is treated as a personal-data breach.
- MVP trade-off: providers hold the key, so a provider could compute the
  pseudonym of a known ID. The planned upgrade is a trusted-third-party
  linkage service that holds the key so providers never do.

## Data access requests (taking data out)

1. The applicant submits purpose, programmes, variables, period, legal basis,
   ethics approval (for research) and security arrangements.
2. RHEAP's data access committee reviews against necessity and proportionality.
3. If approved: a data access agreement is signed and an organisation with the
   `consumer` role is created, limited to the approved programmes and period.
4. Extracts are k-anonymous and logged. Publications must not report cells
   under 5.

## Retention

- Pseudonymised screening records: kept while the person is within screening
  age plus 10 years, then reduced to anonymised statistics. (Policy decision
  for RHEAP; the software does not yet purge automatically.)
- Audit and provenance records: at least 6 years.
- API keys: revoked when an agreement ends.

## Breach response

1. Contain: revoke affected API keys, isolate the server.
2. Assess within 24 hours: which data, how many people, what risk.
3. Notify RHEAP's leadership, affected providers, and any authority required by
   law (see [docs/pakistan.md](docs/pakistan.md)) without undue delay.
4. Record the incident and the remedial actions in the transparency report.

## Before going live with real data

- [ ] Board adoption of this policy
- [ ] Legal review in Pakistan (federal and each participating province)
- [ ] Completed DPIA
- [ ] Ethics committee review for research use
- [ ] Key custodian appointed and key ceremony held
- [ ] Signed agreements with each provider and consumer
- [ ] Hosting in Pakistan (or as the law requires), TLS, encryption at rest, backups
- [ ] Independent security test
- [ ] Statistical disclosure control review of the dashboard and extracts
- [ ] Synthetic demo organisations and keys removed (`DEMO=0`, fresh database)
