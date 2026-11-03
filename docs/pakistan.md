# Pakistan: legal and institutional context

> **Requires review by Pakistani legal counsel.** This page is orientation for
> planning, not legal advice. Laws and bills change; check the current status
> of everything below before relying on it.

## Points to confirm with counsel

| Topic | What to confirm |
| --- | --- |
| Personal data protection | Whether a federal personal data protection law has been enacted (a Personal Data Protection Bill has been drafted and revised several times) and, if so, its rules on sensitive health data, cross-border transfer, data-subject rights and breach notification. Design the registry to meet the strictest draft. |
| Health is a provincial subject | Since the 18th Constitutional Amendment (2010), health is largely devolved to provinces. Agreements and any mandate to report will likely be needed per province (Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan) plus Islamabad Capital Territory, Gilgit-Baltistan and Azad Jammu and Kashmir. |
| Provincial healthcare commissions and acts | Confidentiality duties of providers under provincial healthcare legislation, and whether sharing pseudonymised data with a non-governmental steward needs explicit authorisation. |
| Cybercrime law | Obligations and offences under the Prevention of Electronic Crimes Act 2016 relevant to unauthorised access and data handling. |
| National ID (CNIC) | Whether using the CNIC to derive a pseudonym is permitted, and NADRA's position on it. The registry never stores or transmits the CNIC itself. |
| Data localisation | Whether health data must be hosted in Pakistan, and any cloud-hosting policy for public-sector data. |
| Research ethics | Role of the National Bioethics Committee and institutional review boards for research use of extracts. |
| Mandatory reporting | The legal instrument the government would use to make reporting compulsory, and what that means for consent (opt-out remains supported). |

## Existing registries to engage

The registry is designed to complement, not replace, existing efforts. Engage
each as a data provider under a data-sharing agreement. Typical candidates
(verify current status and custodians):

- Hospital-based and population-based cancer registries in major cities and
  provinces (for example registries in Karachi and Punjab).
- The national cancer registry effort coordinated with the Pakistan Health
  Research Council.
- Cancer hospitals and their registries (for example those operated by the
  Pakistan Atomic Energy Commission, and private cancer centres).
- Provincial health information systems, including DHIS2 deployments, which
  could become a connector source.

Many population-based cancer registries use IARC's CanReg5; the registry
imports CanReg5 exports directly (`canreg5` mapping). Check each registry's
data dictionary, as variable names can be customised.

## Programme parameters

Pakistan has no national organised screening programme for cervical, breast,
colorectal or oral cancer at the time of writing. The ages and intervals in
`config/countries/pk.json` are **illustrative** and must be replaced with the
protocols set by federal and provincial health authorities.
