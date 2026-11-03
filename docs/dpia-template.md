# Data protection impact assessment: template

Complete before processing any real personal data. Review annually and whenever
the processing changes.

## 1. Description of the processing
- Nature: collection of pseudonymised screening and diagnosis events from
  providers; rules-based recall and follow-up alerts; anonymised statistics and
  extracts.
- Scope: [number of people expected, provinces, programmes]
- Context: [provider types; vulnerable groups; public expectations]
- Purposes: see GOVERNANCE.md

## 2. Necessity and proportionality
| Question | Answer |
| --- | --- |
| Lawful basis (per applicable law) | |
| Is each data item necessary? (birth month, sex, district, results) | |
| Could the purpose be met with less data? | |
| How are people informed? (notices at screening sites) | |
| How can people opt out? | Provider records opt-out; registry excludes them |
| Retention period | |
| International transfers | |

## 3. Risks
| Risk | Likelihood | Severity | Mitigation in the software | Residual |
| --- | --- | --- | --- | --- |
| Re-identification from central data | | | No direct identifiers stored; server-side guard; role-based access | |
| Pseudonymisation key compromise | | | Key held by custodian and providers only; rotation procedure | |
| Re-identification from public statistics | | | Suppression of counts <5 and derived percentages | |
| Re-identification from extracts | | | k-anonymity (k ≥ 5); data access agreements | |
| Unauthorised API access | | | Per-organisation hashed keys; roles; audit log | |
| Wrong person linked (weak pseudonym) | | | Weak links flagged; prefer CNIC | |
| Missed follow-up due to data delay | | | Alerts complement, not replace, provider clinical processes | |
| Loss of availability | | | Backups; SQLite WAL; production FHIR server | |

## 4. Consultation
[Providers, patient representatives, ethics committee, legal counsel]

## 5. Sign-off
Assessor: ________  RHEAP data steward: ________  Date: ________
