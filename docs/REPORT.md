# Telno platform — reverse-engineering report and rebuild record

Date: 2026-10-29
Target: `192.168.1.15` (Telno web platform), plus the `innotelinc/telno` and `innotelinc/cantus`
GitHub repositories.

This report separates **what was observed** from **what was inferred** and **what remains
unknown**, and records the decisions that turned those findings into the code in this
repository.

---

## 1. Scope of the request

- Modernise the existing Telno platform, remove unused surface, and make it friendlier.
- Ship a new UI, robust enough to be the operator console.
- Present the result as the **Telno T750 2026** and **Telno HT802 2026** product family.
- Integrate with `innotelinc/telno` and replace the voice layer with
  `innotelinc/cantus` — explicitly **not** Asterisk.
- Rip out the existing provisioning and write our own.
- Remove third-party branding.

---

## 2. Evidence gathered

| # | Observation | How it was established | Status |
|---|---|---|---|
| E1 | `http://192.168.1.15/` served a single-page app titled **“Telno — telephony platform and world directory”**, described as *“One telephony platform: PBX control, number registry and a worldwide phonebook directory.”* | `curl` of `/` — full 1,387-byte HTML shell kept at [`docs/evidence/telno-192.168.1.15-root.html`](evidence/telno-192.168.1.15-root.html) | observed |
| E2 | The shell was a **Vite-built React SPA**, dark theme by default (`data-theme="dark"`, `#07070d`), with a PWA manifest and an inline SVG phone icon; entry points `/assets/index-B_PkAJF9.js` and `/assets/index-BD5HS-V5.css` | Parsed from the captured shell (E1) | observed |
| E3 | The app advertised a **softphone that “installs as its own window”** — a deliberate PWA/standalone-window install, separate from console browsing | Comment and manifest link in the captured shell (E1) | observed |
| E4 | `:3000` on the same host is an **unrelated product** (“Loomix Mail”, Next.js), not part of Telno | `curl :3000/en` → `Loomix Mail` metadata, `NEXT_LOCALE` cookie, CSP nonce | observed |
| E5 | `:8080` and `:443` are the same service and redirect to `/account` with permissive CORS headers (`Authorization, Content-Type, …`) | `curl -D -` on both ports, identical `302` + headers | observed |
| E5a | Following that redirect returns a small SPA titled **“Portal”** (base `/account/`) with `<meta name="oauth-client-id">`, an OAuth callback route and profile/password/account copy. It is an **identity/account portal**, not the Telno console, and carries no Telno branding | `curl -Lk` of `/account/` plus its 289 KB entry bundle | observed |
| E6 | The Telno listener on `:80` **went away during the investigation**: ping and ARP still answered, TCP became `Connection refused`, and it did not return across ~40 s of retries or a later re-check (three more attempts). `:443`, `:3000` and `:8080` stayed up throughout, so it was the Telno process that stopped, not the host | `curl -v` (`connect … failed: Connection refused`), repeated `/dev/tcp` probes | observed |
| E7 | Because of E6, the SPA **bundle was never retrieved**, so the previous app's component tree, API routes and provisioning code could not be read | `curl` of `/assets/index-*.js` / `.css` returned `000` (no connection) | unknown |
| E8 | `github.com/innotelinc/telno` returns **HTTP 404** — no public source to integrate against | `read_url` on the repository | observed |
| E9 | `github.com/innotelinc/cantus` **exists and is real**: Cantus 1.0, a voice standard with a dependency-free Perl reference stack (~2,500 lines), AGPL-3.0 | Repository README, then a shallow `git clone` | observed |
| E10 | cantus's control surface is a **CLI**, not an HTTP API: `demo`, `route-test`, `encode`, `selftest`, `version` | Source of `bin/cantus` | observed |
| E11 | Routing is a **schema-checked JSON document**: predicates `to, from, weekday, time, limit, event, verified`; actions `answer, reject, forward, bridge, play, record, pause, noop`; first match wins; `reject` takes a reason id | `lib/Cantus/Router.pm`, `examples/routes.json` | observed |
| E12 | Reason ids are positional in `Cantus::Session`: `0 UNSPECIFIED … 2 NOT_FOUND, 3 REJECTED, 4 UNAVAILABLE, 6 NO_CAPABILITY, 13 NORMAL` | `lib/Cantus/Session.pm` | observed |
| E13 | cantus **runs on this machine** (Perl 5.42): `selftest` prints 5 `ok` checks and `PASS`; `route-test` resolves `support@example.net` to `support-hours` → `answer -> bridge`; `demo --nat symmetric` places a real call — *62 frames received, peak amplitude 6000, path relay, ended clean* | Commands executed against the clone | observed |

### What this allowed, and what it did not

- The **visual system and interaction design** of the previous console could not be
  read (E7). The only styling facts available are E1–E3: dark-first, single-accent, PWA-aware,
  telephony-first navigation.
- The **previous API shape** is unknown. Nothing in this repository is presented as a
  reconstruction of it.
- The **telno source repository** does not exist publicly (E8), so “integrate with it” could
  not mean importing code. It is treated as the product name and as an interface contract
  to design against.

---

## 3. How cantus is actually integrated

cantus has no HTTP surface (E10), so the platform drives it the way its own CLI does:

1. **Routing documents are generated, not hand-written.** `apps/server/src/cantus.ts` builds a
   Cantus 1.0 document from lines: one in-hours `answer` route plus an after-hours
   `forward`/`reject` route per business-hours line, single-route documents for `always`,
   `forward` and `voicemail`, and `{ "reject": 2 }` (NOT_FOUND) as the default.
2. **Every published document is validated by the reference stack.** The server writes the
   document to a temporary file and runs `perl -I lib bin/cantus route-test …`. The result is
   reported as `verifiedBy: "cantus"`; if the CLI is missing the console says
   `verifiedBy: "local"` and warns that only the schema was checked. It never reports a
   local check as a cantus check.
3. **Routing questions are answered by cantus.** The Route Tester calls `route-test` with
   `--to/--from/--hour` and shows the raw decision line and action chain.
4. **Health is a real run.** `cantus version` establishes availability and `cantus selftest`
   supplies the five individual checks shown in Diagnostics.
5. **The path probe is a real call.** `cantus demo --nat {none|cone|symmetric} [--rebind]` is
   executed on demand; the console parses the reported path (`direct`/`relay`), received frame
   count, peak amplitude, codec and rebind recovery time. Observed output through the UI:
   `passed · relay · pcm-s16/8000/1 · 62 audio frames · peak 6000 · nat symmetric`.

No dialplan is generated, no SDP is written, and no RTP port range is reserved — there is no
Asterisk in the tree, and nothing in the code path shells out to one.

### Licensing note (important)

cantus, including `spec/CANTUS-1.0.md`, is **AGPL-3.0** (E9). The reference stack is vendored
**unmodified** at `vendor/cantus`, with its `LICENSE` intact. Running it as a separate process
is how this platform uses it, but AGPL obligations attach to distribution and to network use of
a modified version, and the spec itself carries the same licence. **Have counsel review this
before selling the product**; the practical options are (a) comply with AGPL for the voice
component and publish its source, or (b) obtain a different licence from the author.

---

## 4. Provisioning: replaced, not ported

The previous provisioning system could not be inspected (E7), so nothing was ported. What
exists now is a new protocol with no vendor dialect in it:

| Concern | Old approach (typical of this device class) | This platform |
|---|---|---|
| Device identity | MAC-derived config filename | One-time enrollment code → per-device bearer token, stored as SHA-256 digest |
| Transport | Plain HTTP file fetch, often with a shared secret in the URL | `POST /prov/v1/enroll`, then `GET /prov/v1/config` with `Authorization: Bearer` |
| Payload | Vendor XML parameter tree | One signed JSON document, `telno.device.config/1` |
| Integrity | None or a shared password | HMAC-SHA256 over a canonical form, with the key id inside the signed body |
| Rollback/replay | Not expressible | Monotonic `version`; device approval is visible per device |
| Polling cost | Full config every cycle | `ETag` + `If-None-Match` → `304` when unchanged |
| Rotation | Change the shared secret for everyone | Per-device token rotation that invalidates the old token immediately |

Verified by `scripts/smoke.mjs`: enrollment, non-reusable codes, token prefix, config binding to
serial, `304` on unchanged revision, token rotation killing the old token, and signature
verification (`signatureMatches: true`).

---

## 5. Branding removal

- No third-party vendor names appear in the UI, the API, the device document schema or the
  configuration keys. The identifiers are `telno.*`, `T750`, `HT802`.
- Model naming is ours: **Telno T750 2026**, **Telno HT802 2026**.
- The console ships its own mark (`apps/console/public/favicon.svg`) and palette derived from
  the observed previous accent, not from any vendor asset.
- What is deliberately **kept**: the cantus copyright/licence inside `vendor/cantus`. Removing an
  upstream licence notice is not branding removal — it is a licence violation.

---

## 6. Open questions

1. **Device firmware.** T750/HT802 firmware is not in this repository. The provisioning
   document defines what a device must consume; implementing the client on the hardware is
   separate, unstarted work. An analog adaptor has since been reached on the LAN and its
   writable account block measured — see [adaptor-account-map.md](adaptor-account-map.md) — but
   that is the adaptor's own console, not the T750 firmware.
2. **The old platform's data.** The `:80` service was unreachable before any inventory could be
   read (E6), so no devices, lines or directory entries were imported. The console starts from a
   demo seed and can be reset by deleting the database.
3. **cantus deployment profile.** The reference stack ships a loopback codec and a
   shared-secret HMAC profile, not Opus/Ed25519 over DTLS. A production voice node needs a
   conformant implementation; the console reports what the CLI reports and does not pretend
   otherwise.
4. **`:443`/`:8080` is identified as an OAuth account portal** (E5a), which fits the old
   deployment fronting its console with a separate identity surface. Which provider backs it,
   and whether the Telno console trusted it for sign-in, was not established — the console
   listener stayed down (E6), so its auth flow could not be observed.
