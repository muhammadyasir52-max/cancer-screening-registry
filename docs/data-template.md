# Submitting data: the standard template

Providers can submit in their own layout if a mapping exists (`src/ingest/mappings.js`),
or use this standard CSV template. One row per event. A ready-made example is in
[`public/samples/standard-template.csv`](../public/samples/standard-template.csv).

| Column | Required | Values |
| --- | --- | --- |
| `record_id` | yes | Your own record number (e.g. MRN). Used to route alerts back to you. |
| `cnic` | recommended | `#####-#######-#` or 13 digits. Turned into a pseudonym at your site; never sent. |
| `given_name`, `family_name` | if no CNIC | Used only to build a fallback pseudonym; never sent. |
| `sex` | yes | `female` / `male` (or `F` / `M`) |
| `date_of_birth` | yes | `YYYY-MM-DD`. Cut to `YYYY-MM` before sending. |
| `district` | yes | A district listed in `config/countries/pk.json` |
| `province` | no | Derived from district |
| `phone` | no | Never sent |
| `programme` | for screen and follow-up | `cervical`, `breast`, `colorectal`, `oral` |
| `event` | yes | `screen`, `follow-up`, `diagnosis`, `opt-out` |
| `event_date` | yes | `YYYY-MM-DD` |
| `test`, `result` | for `screen` | See below |
| `icdo3_topography`, `icdo3_morphology` | for `diagnosis` | e.g. `C53.9`, `8070/3` |

## Tests and results

| Programme | `test` | `result` |
| --- | --- | --- |
| cervical | `hpv` | `positive`, `negative`, `invalid` |
| cervical | `cytology` | `NILM`, `ASC-US`, `LSIL`, `ASC-H`, `HSIL`, `AGC`, `SCC`, `UNSAT` |
| cervical | `via` | `positive`, `negative`, `invalid` |
| breast | `mammography` | BI-RADS `0`–`6` |
| breast | `cbe` | `normal`, `abnormal` |
| colorectal | `fit` | `positive`, `negative`, `invalid` |
| oral | `ove` | `normal`, `suspicious`, `inadequate` |

`follow-up` means the diagnostic procedure for that programme was done
(colposcopy, breast assessment, colonoscopy, specialist oral assessment).

## Other layouts

- `canreg5`: tab-separated export from IARC CanReg5 (cancer registries). Each row becomes a diagnosis.
- `example-hospital`: shows how to map a laboratory system's own headers and codes.

Add a new mapping by copying one of these in `src/ingest/mappings.js`. It is then
available in both the portal and the submission kit.
