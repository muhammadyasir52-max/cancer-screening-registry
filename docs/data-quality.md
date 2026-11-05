# Data Quality Studio

Before a hospital or registry sends a file to the national registry, the Data
Quality Studio checks it **on the provider's own computer**: in the facility
portal (browser) or in the submission kit (`scripts/submit.js`).

```
CSV export → quality checks → staff resolve queries → de-identify → send to RHEAP
                                                                    (+ quality summary: counts only)
```

The checks run on the raw records, so names and CNICs can be used to find
duplicates and typos. They never leave the machine. The registry receives only
the de-identified records and an aggregate **quality summary**.

Try it in the portal with `public/samples/messy-hospital-export.csv`: a
synthetic file seeded with one of every problem.

## Checks

| Dimension | Check | Severity | What it finds | Typical fix |
| --- | --- | --- | --- | --- |
| Completeness | Required field missing | critical | Event, dates, sex, district, programme/test/result or topography missing | Complete in the source system |
| | No CNIC | warning | Person links only by name and birth date | Add the CNIC where available |
| Validity | Date not valid | critical | Not `YYYY-MM-DD`, or impossible (e.g. 2026-02-30) | Correct the date |
| | Event date in the future | critical | Usually a day/month swap or a wrong year | Correct the date |
| | Event before date of birth | critical | Swapped or mistyped dates | Correct the date |
| | CNIC format not valid | warning | Not `#####-#######-#` or 13 digits | Correct the CNIC |
| | District not recognised | critical | Not in the country pack; **suggests the closest match** (e.g. "Lahor" → Lahore) | One-click fix |
| | Code not recognised | critical | Unknown programme, test or result; **suggests the closest valid code** | One-click fix |
| Uniqueness | Exact duplicate row | warning | Same row twice | Remove one (one click) |
| | Conflicting results | critical | Same person, test and day with different results | Keep the correct one (one click per option) |
| | Identity conflict | critical | One CNIC with different names or birth dates | Correct the CNIC in the source |
| | Probable CNIC typo | warning | Two CNICs one or two digits apart, same birth date, similar name (fuzzy match) | Use one CNIC (one click) |
| | Record number conflict | critical | One record number with different CNICs | Correct in the source |
| Consistency | Sex/programme mismatch | critical | e.g. a man in the cervical programme | Correct sex or programme |
| | Implausible age | warning (critical if under 10 or over 110) | Age far outside the programme's range | Check the date of birth |
| | Screening after opt-out | warning | Events after the person opted out | Confirm consent or exclude |
| | Follow-up without abnormal result | info | Follow-up with no abnormal screen in the file | Fine if submitted earlier |
| | Over-screening | info | Repeat screen within 6 months of a normal result | Review practice |
| Plausibility | Positive rate out of range | warning | e.g. HPV positivity above 30%: possible lab coding issue | Ask the laboratory |
| | Volume spike | warning | A day with far more records than the surrounding month | Check for double entry or upload-day dating |
| | Birth-date heaping | info | Many 1 January birth dates (estimated ages) | Record actual birth dates |
| Integrity | Repeated file | warning | The same file (SHA-256) was submitted before | Usually not intended; duplicates are ignored |

The expected positivity ranges in `src/quality/index.js` are illustrative. A
programme should set them from its own laboratory baselines.

## Resolving queries

For each query, staff can:

- **apply a suggested fix**;
- **exclude** the affected rows;
- **accept** it with a reason (the reason stays on the computer).

Unresolved **critical** queries exclude their rows automatically. The query list can be
exported as CSV (record numbers and messages, never names or CNICs) to fix in
the hospital system. The submission kit has no interactive review: it excludes
unresolved critical rows, or with `--block-on-critical` it sends nothing.

## Score

Each of the six dimensions starts at 100.

- **Row-level findings** cost points in proportion to the share of rows affected, weighted by severity (critical ×3, warning ×1, info ×0.2).
- **Dataset-level findings** cost a fixed amount (critical 25, warning 12, info 5).

The overall score is the average of (a) the mean of the six dimensions and (b) the weakest dimension, so one bad area can't be hidden by strong ones. Ratings: 90+ good, 75–89 fair, below 75 needs attention.

## Quality summary (what RHEAP receives)

The summary contains:

- the overall score and the score for each dimension;
- per check: the number of queries, rows affected and queries resolved;
- the numbers of rows read, sent and excluded;
- the file's SHA-256.

It contains **no** rows, line numbers, record numbers, names, ID numbers, dates
or free text. A whitelist validator (`validateQualitySummary` in
`src/quality/summary.js`) enforces this in the browser and again on the server,
which stores the summary on the import's FHIR `Provenance`. The admin page shows each
import's score. The public dashboard shows the national average for the last 90 days.

## AI data assistant (switched off in the MVP)

A Claude-based assistant explains findings and answers staff questions. It is
**built but switched off** until funding and governance approval. While it is
off, the portal shows a plain-language explanation generated locally from the
summary, labelled "Preview".

When switched on (`ASSISTANT_ENABLED=1` plus an Anthropic API key on the
server, and `npm install` for the optional SDK), the assistant receives only the
validated aggregate summary and the staff question, never rows. If the model
declines or the service is unavailable, the local explanation is shown instead.
See GOVERNANCE.md, "AI and data quality", for the conditions on switching it on.
