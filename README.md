# Telno platform 2026

The control plane and operator console for the **Telno T750 2026** desk phone and
**Telno HT802 2026** analog adapter: device inventory, extensions, a shared directory,
first-party signed provisioning, and voice routing through
[cantus](https://github.com/innotelinc/cantus) — no PBX, no SIP registrar, no SDP.

![stack](https://img.shields.io/badge/voice-cantus%201.0-7c74ff) ![runtime](https://img.shields.io/badge/node-%E2%89%A522.5-3ddc97) ![tests](https://img.shields.io/badge/smoke-50%20checks-7c74ff)

## What is here

```
apps/server      control-plane API, provisioning, cantus bridge   (Fastify + node:sqlite)
apps/console     operator console                                 (React + Vite)
packages/shared  product types and the T750/HT802 model catalog
vendor/cantus    the cantus reference stack, unmodified (AGPL-3.0)
scripts/smoke.mjs  end-to-end check of the whole device lifecycle
docs/REPORT.md   reverse-engineering findings, decisions, open questions
```

## Quick start

```bash
npm install
cp .env.example .env          # set a real admin password
npm run build                 # console then server
npm start                     # http://127.0.0.1:8787
```

Put TLS in front for anything beyond this machine. The control plane stays on loopback; Caddy is
the only process on the network:

```bash
npm run proxy                 # https://<lan-ip>:8443 → http://127.0.0.1:8791
```

Caddy and the [`Caddyfile`](Caddyfile) do the work; the launcher only locates the binary and
resolves `.env`. Certificates come from Caddy's **internal CA**, which Caddy installs into the
machine's trust stores on first start, so browsers accept the console with no warning — the
issued certificate is valid and the connection is genuinely verified, not bypassed.

Get the binary without installing anything (Windows): download `caddy_<version>_windows_amd64.zip`
from [the releases page](https://github.com/caddyserver/caddy/releases) into `tools/caddy/`.
`tools/` is gitignored. Any platform's binary works — set `CADDY_BIN` if it lives elsewhere.

The listening addresses are site addresses, not a bind guess, so only names that have a
certificate answer at all:

```
TLS_ADDRESSES=https://192.168.1.17:8443, https://localhost:8443, https://telno.local:8443
```

No HSTS header is sent by default: pinning an internal-CA certificate is a good way to lock
yourself out if the CA is ever recreated. Add it once the certificate is long-lived and trusted.

For development, run the API and the console separately (Vite proxies `/api` and `/prov`):

```bash
npm run dev:server            # :8787
npm run dev:console           # :5178
```

If the port is already taken, set `PORT` (and `TELNO_API` for the Vite proxy). The bootstrap
operator comes from `TELNO_ADMIN_USER` / `TELNO_ADMIN_PASSWORD`; change it in Settings
immediately, which also ends every existing session.

## The console

| Section | What it does |
|---|---|
| **Overview** | Fleet counts, model mix, cantus health, recent activity, what needs attention |
| **Devices** | T750/HT802 inventory, filters and search, enrollment, per-device detail, config revision, token rotation, signature verification |
| **Lines** | Extensions, address of record, account slot, routing mode with business hours and forward target |
| **Directory** | Shared phonebook with favourites and one-click copy |
| **Provisioning** | Per-model profiles, enrollment codes, the device protocol, the signed document |
| **Diagnostics** | cantus self-test, routing document validation, route tester, live NAT/rebind path probe |
| **Settings** | Organisation, voice node, session lifetime, signing-key information, password |

Dark and light themes, `Ctrl/⌘ K` to jump between sections, keyboard-dismissable dialogs,
loading skeletons, empty states and inline error recovery throughout.

## Device provisioning

There is no per-MAC config file and no vendor parameter tree. A device gets one signed
document.

```http
POST /prov/v1/enroll
{ "code": "MU4H-3KNM", "serial": "T750-2026-000418", "mac": "AA:42:10:7C:11:01" }

201 { "token": "tln_…", "configVersion": 1, "configUrl": "/prov/v1/config", "pollSeconds": 900 }
```

```http
GET /prov/v1/config
Authorization: Bearer tln_…
If-None-Match: "v1-1927a411b92e2783"

200  telno.device.config/1  (ETag, X-Telno-Config-Version, X-Telno-Key-Id, X-Telno-Signature)
304  when the revision has not changed
```

```jsonc
{
  "schema": "telno.device.config/1",
  "version": 3,
  "issuedAt": "2026-10-29T06:20:00.000Z",
  "keyId": "tln-k-5a12a6bf86",
  "device": { "serial": "T750-2026-000418", "model": "t750", "label": "Reception desk" },
  "voice": { "transport": "cantus/1", "node": "voice.telno.local", "port": 7443, "reachMs": 300 },
  "accounts": [{ "slot": 1, "aor": "reception@telno.local", "routingMode": "business-hours" }],
  "routing": { "documentId": "rt-39f1c0a7b2de", "revision": 3 },
  "signature": "…"
}
```

Guarantees the device can check on its own:

- the signature is HMAC-SHA256 over a **canonical form**, so key order cannot change it;
- the **key id is inside the signed body**, so it cannot be swapped silently;
- `version` is monotonic and `issuedAt` is fixed per revision, so replay and rollback are visible;
- tokens are stored only as digests and are rotated per device.

Then the device reports what it applied:

```http
POST /prov/v1/report            { "configVersion": 3, "firmware": "2026.1.4" }
```

A device behind the current revision is flagged in the console and in the event ledger.

### The analog adaptor (HT802)

An HT802 is not a small desk phone: it is a box with two FXS ports, its own web console, and a
voice stack that has never heard of cantus. Two firmwares are in the field and they share no
protocol, so the platform asks the box rather than the installer:

| | V1 (1.0.x, incl. 1.0.21.4) | V2 (GWT console) |
|---|---|---|
| Console | mini_httpd, server-rendered CGI | lighttpd over TLS, GWT single page |
| Login | `POST /cgi-bin/dologin` with base64 `P2`, and on 1.0.21.4 also `username`, `Login` and the per-page `session_token` | `username`/`password` form fields, `sid` session |
| State | `/cgi-bin/api-get_*`, plus the status page and the per-port `config_a1`/`config_a2` pages | `/cgi-bin/api.values.get` with P-numbers |
| Trap | writes two status lines and leaks its CGI shebang where a header belongs — `fetch`, curl and undici all reject it | a stale `sid` answers `success` with every value empty |

**Version is not a console family.** The unit at `192.168.1.45` runs Program `1.0.21.4` and is still
the mini_httpd console, so nothing here infers the family from the version string: the client reads
whichever login form the box serves and then follows the navigation that box publishes.

That first trap is why [`apps/server/src/ata/raw.ts`](apps/server/src/ata/raw.ts) speaks HTTP over a
raw socket and parses forgivingly. Nothing is proxied to the device's own page: the platform reads
the box and renders what it found.

Checked against a live unit on the LAN (`192.168.1.45`, Program `1.0.21.4`, serial
`207GHQYM103ED820`, MAC `C0:74:AD:3E:D8:20`, voice image `16472`): the unauthenticated endpoints
answer through the raw transport, and with no password configured the report is `reachable` with the
note that none is set — no attempt is spent learning that.

What that unit reports, and what it will not: the login *response* is the status page, so model,
firmware, serial, MAC and uptime cost no extra request; each FXS port's account comes from its own
tab (`config_a1`, `config_a2`) as raw P-values — `P35`/`P735` SIP user, `P47`/`P747` SIP server,
`P40`/`P740` local port, `P271`/`P401` account active. The status table adds the handset state
(`On Hook`), but **neither page says whether the registration is up**: the box exposes configuration
and hook state, not registration, so the panel says `configured` and never invents `registered`.
That fact has to come from the switch the port is registered to.

The console serves one session at a time and answers a superseded cookie with a bare `301`; a page
read therefore signs in again once instead of reporting a port that does not exist. Ports are read
one page at a time for the same reason, and each port's number comes from its tab label rather than
from its position in a filtered list, so a page that fails cannot renumber the others.

Enrol a unit the usual way; the address it enrols from is recorded as `addr`, which is where the
console then reaches it (set it by hand on the device if the box was enrolled through a proxy).
Set the adaptor's admin password once:

```bash
TELNO_ATA_PASSWORD=…   # used to open a session, never returned by any endpoint
```

Refusals are kept in the database, not in process memory, and are keyed to the credential that was
refused. That matters because the cost is paid by whoever owns the hardware: a restart, or any
second process opening its own connection, would otherwise start from zero and spend the adaptor's
remaining attempts again. A *corrected* password is still allowed one try; the same wrong one never
is. A missing password is not a refusal and is never counted as one.

Open the device in the console and the adaptor panel reports firmware, serial, uptime, each FXS
port and its SIP account — or exactly which of those the firmware would not surrender. It also
reports a lockout: five refused passwords cost fifteen minutes of that console, so the client reads
`api-get_lockouts` first, never retries a password, caches refusals process-wide, and refuses to
spend the last two attempts. A wrong password is a deployment mistake, not something more requests
fix. Reboot is offered on V1 only; the V2's restart lives behind a console operation that has not
been verified, so it says so instead of guessing.

**The voice profile follows the hardware.** A T750 is told `cantus/1`; an HT802 is told `sip`, with
the edge as its server (`sipEdge` in Settings) and PCMU/PCMA rather than the cantus PCM codec. If no
edge is configured the note in the document says the adaptor is registering directly against the
domain on 5060 — the edge is what carries the call onward over cantus, and pretending otherwise
would hand the box a document it cannot act on.

### Devices that cannot trust a private CA

Firmware that has no way to install our CA still has to enroll, so a second listener serves
**`/prov` only**, over plain HTTP, and only to private address ranges:

```
http://<lan-ip>:8088/prov/v1/enroll
http://<lan-ip>:8088/prov/v1/config
```

Everything else on `:8088` answers `404` — the console and its API are never reachable there.
The enrollment response returns an absolute `configUrl`, so a device that arrived over HTTP keeps
using HTTP instead of guessing a scheme.

**The trade-off is explicit:** over plain HTTP the per-device bearer token crosses the LAN
unencrypted, so anyone who can sniff the segment can read a device's configuration. Rotate the
token (Devices → Rotate token) if that happens; the signed document cannot be forged either way.
If your hardware can trust the CA in [`certs/`](certs/README.md), use the TLS address instead and
don't expose `:8088` at all.

## Voice: cantus, not a PBX

`apps/server/src/cantus.ts` generates a Cantus 1.0 routing document from the configured lines,
validates it with the reference stack's own evaluator, and exposes the result:

```bash
perl -I vendor/cantus/lib vendor/cantus/bin/cantus route-test <document.json> --to reception@telno.local
# route   reception-business-hours
# actions answer
```

What the integration actually does:

- **generates** routing documents (predicates `to/from/weekday/time/limit/event/verified`,
  actions `answer/reject/forward/bridge/play/record/pause/noop`);
- **validates** them with `cantus route-test`, reporting `verifiedBy: "cantus"` only when the
  reference stack answered — a local schema check is labelled as such;
- **evaluates** operator questions with `route-test --hour`;
- **reports health** from `cantus version` and `cantus selftest`;
- **invokes real calls** for the path probe: `cantus demo --nat symmetric --rebind`, parsing the
  chosen path, received frames and peak amplitude.

Requirements: Perl 5.16+ (core modules only). `vendor/cantus` is the upstream stack, unmodified.
Override its location with `TELNO_CANTUS_DIR`, or the interpreter with `TELNO_PERL`.

## Access control and TLS

**Console allowlist.** Sign-in and every console API call are checked against a CIDR list before
any credential or session is considered, so a stolen cookie is not portable off the trusted
network. It defaults to loopback plus RFC 1918 and is editable in Settings (apply takes effect
on the next request, no restart). Device provisioning is deliberately exempt — devices live on
the network this list restricts, and authenticate with their own tokens instead.

```
TELNO_TRUSTED_NETWORKS=127.0.0.1/32,::1/128,192.168.1.0/24
```

Matching is family-aware (an IPv4 rule never matches an IPv6 caller), normalises
IPv4-mapped addresses (`::ffff:192.168.1.5`), and fails closed for an empty or unparsable list.

**TLS.** Caddy terminates TLS and forwards to loopback. It sets `X-Forwarded-For` to the real
peer, and the server only trusts forwarding headers from `127.0.0.1` — so a client cannot
declare itself trusted. The public root certificate lives in [`certs/`](certs/README.md) for
installing on devices and workstations; the matching private key never leaves Caddy's data
directory. The session cookie's `Secure` flag follows the scheme the client
actually used: `Secure` over TLS, absent on a deliberate loopback trial over http.

**Where the allowlist really lives.** The saved setting wins after first boot; `
TELNO_TRUSTED_NETWORKS` only seeds it. If the two disagree at startup, the server warns and
names both, because an edited `.env` that silently stops applying is a trap.

## Security notes

- Server-side sessions in `telno_session`, `HttpOnly`, `SameSite=Lax`, `Secure` over TLS,
  expiring per Settings; passwords are scrypt-hashed and every session is revoked on password
  change.
- Sign-in is throttled per address and username, and failures are recorded.
- Mutations reject a foreign `Origin`, so a cross-site form post cannot ride a live session.
- Device endpoints are outside `/api`, authenticated by bearer token only, and never return
  console data.
- The console build is served by a small handler that resolves each path and refuses anything
  outside the build directory (no static-file plugin, and `npm audit --omit=dev` reports 0
  vulnerabilities).
- No secrets are stored in the clear: device tokens and enrollment codes are SHA-256 digests.

## Checks

```bash
npm test --workspace @telno/server      # 42 unit tests: signing, routing, CIDR, adaptor wire format
node scripts/smoke.mjs http://127.0.0.1:8791   # 50 end-to-end checks against the control plane
npm run typecheck                       # both workspaces

# the same suite through the TLS terminator, which Node only trusts when told to
NODE_EXTRA_CA_CERTS=certs/telno-root-ca.crt node scripts/smoke.mjs https://192.168.1.17:8443
```

The proxied run skips the allowlist *denial* probe: the terminator overwrites `X-Forwarded-For`
with the real peer address, so a forged header cannot simulate a foreign caller from there. That
path is covered at the control plane, where the header is trusted only from loopback.

The smoke script signs in, adds a device, enrolls it, fetches and re-fetches its config (200 →
304), reports a revision, rotates the token (old token refused), verifies the signature, creates
a line, builds and validates the routing document with cantus, runs a route test, confirms an
untrusted network is refused at both sign-in and the API, and — against the plain-HTTP listener —
enrolls a second device, proves its config is signed and answers 304 while unchanged, and checks
that every console API path stays closed on that port. It updates settings and cleans up.

## Reset

Delete `.data/telno.db` (and any `-wal`/`-shm` files) to start from an empty database with the
demo seed.

## Status and limits

- Firmware for the T750/HT802 is **not** part of this repository; the provisioning contract is.
- cantus ships a reference stack with a loopback codec and a shared-secret HMAC profile; a
  production voice node needs a conformant implementation.
- cantus and its specification are **AGPL-3.0**. See `docs/REPORT.md` §3 before selling.
- The previous platform's live server was unreachable during the rebuild, so no legacy data was
  imported and no legacy UI was copied; see `docs/REPORT.md` for the evidence and the unknowns.
