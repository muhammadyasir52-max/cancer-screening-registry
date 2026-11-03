# Data-sharing agreement: template

> Template for discussion. Must be adapted and reviewed by legal counsel for
> each jurisdiction before signature.

**Agreement reference:** DSA-YYYY-NNN
**Between:** RHEAP (registry steward) and **[Provider name]** (data provider)
**Software developer and operator:** BYTEBUZ, acting on RHEAP's instructions

## 1. Purpose
The provider contributes cancer screening and/or cancer diagnosis data to the
national cancer screening registry to (a) send recall and follow-up alerts back
to the provider, (b) monitor screening coverage and quality, and (c) produce
anonymised statistics for public health planning. No other purpose is
permitted without a new agreement.

## 2. Programmes and data covered
- Programmes: [cervical / breast / colorectal / oral]
- Events: screening results, follow-up procedures, cancer diagnoses (ICD-O-3), opt-outs
- Period: from [date] to [date]

## 3. De-identification
- The provider will remove direct identifiers **before** sending, using the
  registry's submission kit or facility portal and the pseudonymisation key
  issued by RHEAP's key custodian.
- The provider will keep the key confidential and report any suspected
  compromise within 24 hours.
- The registry will reject any submission containing direct identifiers.

## 4. Provider's own records
The provider remains controller of its own records and systems. Nothing in this
agreement transfers ownership of the provider's registry or records.

## 5. Use of alerts
Alerts returned to the provider identify people only by the provider's own
record numbers. The provider is responsible for contacting patients according
to its clinical procedures.

## 6. Security
Both parties will apply appropriate technical and organisational measures,
including protection of API keys, TLS for all transfers, and access limited to
named staff.

## 7. Opt-out and rights
The provider will record patient opt-outs and send them to the registry.
Requests about a person's data are handled by the provider, which can identify
the person, with RHEAP's support.

## 8. Audit
RHEAP may review the provider's submissions and the registry's audit logs
relating to the provider. Each party will cooperate with audits by the other.

## 9. Term, suspension and exit
Either party may suspend or end the agreement with [30] days' notice, or
immediately on a serious breach. On exit, the provider's API key is revoked.
Data already contributed remains in the registry in pseudonymised form under
this agreement's terms unless the parties agree otherwise.

## 10. Liability, law and disputes
[To be completed by counsel.]

**Signatures:** RHEAP ___________  Provider ___________  Date ___________
