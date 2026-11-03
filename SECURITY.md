# Security

## Reporting a vulnerability

Please do not open a public issue. Email the maintainers at RHEAP (address to
be published) with details and steps to reproduce. We aim to acknowledge within
3 working days.

## Deployment requirements

The Node server is not meant to face the internet directly. In production:

- Terminate **TLS** at a reverse proxy (e.g. nginx or Caddy) and redirect HTTP to HTTPS; add HSTS.
- Run with `DEMO=0` on a fresh database, and set a strong `ADMIN_API_KEY`.
- Store the database on an **encrypted volume**; back it up encrypted and test restores.
- Restrict network access to the admin and FHIR endpoints where possible (VPN or IP allow-list for providers).
- Ship the audit log (`AuditEvent`) to write-once storage.
- Keep Node.js on a supported LTS release and apply security updates.
- Never put the pseudonymisation key on the registry server.

## Built-in controls

- Per-organisation API keys, stored only as SHA-256 hashes and shown once on creation.
- Role checks on every protected route; agreement validity and programme checks on data in and out.
- Server-side rejection of identifiable Patients; all-or-nothing transaction Bundles.
- Audit entry for every authenticated request, including refusals.
- Security headers on every response (CSP, nosniff, frame denial, no referrer).
- Request body size limit; static file serving restricted to `public/` and an allow-list of browser modules.
- No third-party runtime dependencies.

## Known limitations of the MVP

- API keys rather than user accounts with SSO and MFA; no per-user audit.
- No rate limiting (add at the reverse proxy).
- The audit log lives in the same database as the data.
- Providers hold the pseudonymisation key (see GOVERNANCE.md).
