# Sign-in posture

How the console decides who may sign in, what credential it accepts, and how that
relates to the estate's edge. Everything here was exercised against the estate
deployment at `http://192.168.1.95:8080` on **2026-11-16**; the commands are the
ones that were run, not an illustration.

Two rules are worth stating before the detail: the allowlist is checked **before**
any credential is looked at, and the console ships with **no password** — an unset
`TELNO_ADMIN_PASSWORD` produces a random one that is printed once.

## 1. The console allowlist

The list lives in the `security.trustedNetworks` setting. It is seeded from
`TELNO_TRUSTED_NETWORKS` on first boot and the **saved setting wins** afterwards,
so an operator can tighten it from Settings with no restart. If the two disagree
at startup the server warns and names both (`apps/server/src/index.ts`), because
an edited `.env` that silently stops applying is a trap.

Where it is enforced (`apps/server/src/routes.ts`):

| Surface | Behaviour for an untrusted address |
|---|---|
| `POST /api/auth/login` | `403` before the username or password is read, and the refusal is recorded as a `security` event |
| `GET /api/auth/session` | `403` |
| every other `/api/*` route | `401` via `requireSession`, never a session lookup |

An untrusted caller therefore learns nothing about whether an account exists. The
list is family-aware (an IPv4 rule never matches an IPv6 caller) and normalises
IPv4-mapped addresses, so `::ffff:192.168.1.5` matches `192.168.1.0/24`.
`setTrustedNetworks` validates before storing and refuses an empty or unparsable
list — the failure mode of a bad allowlist is "nobody can sign in", so it is
checked first (`apps/server/src/security.ts`).

**Device provisioning is deliberately exempt.** `/prov` sits outside `/api` and
authenticates with per-device bearer tokens and enrollment codes. Devices live on
the network this list restricts; that is the point of the separate mechanism.

**What this estate runs:** the stock default was loopback plus *all* RFC 1918
(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`). It was tightened on 2026-11-16
to the estate LAN only:

```
TELNO_TRUSTED_NETWORKS=127.0.0.1/32,::1/128,192.168.1.0/24
```

That covers every legitimate caller — the NPM edge container (`192.168.1.71`),
workstations on the LAN, and the node itself — and drops the `10/8` and `172.16/12`
ranges the box has no business accepting.

Applying it, either way:

```bash
# from the UI: Settings → allowlist (takes effect on the next request)
# or over the API with a live session:
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"trustedNetworks":"127.0.0.1/32,::1/128,192.168.1.0/24"}' \
  http://127.0.0.1:8080/api/settings
```

Keep `.env` equal to the saved setting. `.env` only seeds a fresh database, but a
rebuilt volume then seeds the same list instead of the wide default, and the
startup divergence warning stays quiet.

**Verification.** From inside the container, the second line proves the list is
narrowed — the server trusts `X-Forwarded-For` only from loopback, so a forged
header is the only way to simulate a foreign caller without another host:

```bash
incus exec -n telno -- curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'X-Forwarded-For: 10.9.9.9' http://127.0.0.1:8080/api/auth/session   # 403
incus exec -n telno -- curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8080/api/auth/session                                 # 401
```

`403` means the address was refused by the allowlist; `401` means it was allowed
through and simply has no session. Measured `403` / `401` on 2026-11-16.

## 2. Why the edge does not add a second `Authorization` header

The estate's usual pattern for an internal host is a basic-auth access list on the
reverse proxy (NPM's `estate-internal`, stored in `access_list_auth`). It is **not**
attached to this console, and the reason generalises:

- A console that sends `Authorization: Bearer …` on every API call cannot sit
  behind proxy basic auth. A browser sends one `Authorization` header, so nginx
  answers `401` before the application sees the request and the console never
  loads its data. That is exactly what happened to the Stalwart console on
  `admin.mail.innotel.us` (removed 2026-10-29); the host's access list was detached
  rather than the console being left broken.
- **Telno's console does not use a bearer header** — it authenticates with the
  `telno_session` cookie — so a basic-auth layer would *technically* work here.
  It is still not applied: the app's own boundary (allowlist, scrypt hashes,
  per-address/username throttling, foreign-`Origin` rejection, session revocation)
  is the control that matters, and a second plaintext credential in the proxy
  database doubles the rotation surface for no additional enforcement.

If one is ever attached anyway, rotate it together with the console password and
record both in the same place.

## 3. The credential

There is no shipped default. `TELNO_ADMIN_PASSWORD` seeds the admin user **once**,
when the `users` table is empty; if it is unset, a random password is generated and
printed at startup under a `First-run administrator` banner
(`apps/server/src/db.ts`), so a credential never ends up in the repository.

Rotation is a deliberate act, because editing `.env` afterwards changes nothing:

```bash
# current password required; minimum 10 characters; scrypt hash
curl -s -H 'Content-Type: application/json' \
  -d '{"current":"<old>","next":"<new>"}' http://127.0.0.1:8080/api/auth/password
```

Every session for that account is deleted by the same request, so **every browser
signed in is signed out** and must sign in again with the new password. The estate
rotation on 2026-11-16 was verified in both directions: the old value returned
`401`, the new value returned `200` with the admin role.

Keep `.env` in step even though it is not the rotation mechanism:

1. rotate over the API (this is what changes the stored hash);
2. write the same value to `TELNO_ADMIN_PASSWORD` in `/opt/telno/.env`;
3. `docker compose up -d --no-build` so the container's environment is recreated
   from `.env` — otherwise a rebuilt database would reseed the *old* password from
   the stale container environment;
4. re-verify `GET /api/health` and one sign-in, then delete any `.env` backup that
   still holds the retired value.

The estate records the current credential in its internal access list
(`estate-internal-access.txt` on the ops workstation), **not** in this repository.

## 4. Out of scope here

- **TLS is not terminated on this node.** The edge does, and forwards plain HTTP to
  `:8080` over the host socket; the `Secure` cookie flag therefore follows the
  scheme the client actually used. The Caddy terminator described in the README
  (`npm run proxy`, `:8443`) is not part of this deployment.
- **The analog adaptor's console password is separate.** `TELNO_ATA_PASSWORD` is
  used by the server to open a session on an HT802 and is never returned by any
  endpoint; it is unrelated to signing in to Telno itself.
- **Sign-in throttling and failure records** are per address *and* username
  (`apps/server/src/routes.ts`), and refusals are persisted as events. Those
  budgets were not changed by this work.
