# Telno — stack role

**Classification:** VoiceOps

Telno is a platform in the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).

## Owns

- The VoiceOps responsibility for this platform's surface.

## Consumes

- **Authentik** — identity, SSO and group membership.
- **Cerulean Vault** — secrets, resolved from `vault://` references.
- **Cerulean** — DNS and per-zone wildcard TLS.
- **NPM Edge** — public HTTP/S routing.
- **Magnate** — billing and entitlements (optional).

## Does not own

- Users, passwords or sessions (Authentik).
- Credentials at rest (Cerulean Vault).
- DNS records or certificate lifecycle (Cerulean).
- Object/file storage (ONYX).
- Billing (Magnate).
