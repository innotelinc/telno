# Deployment

How the control plane and console actually run on a node. The repository is the
source of truth: the image is built from this tree, and nothing is configured by
hand on the host beyond `.env`.

## Shape

```
Dockerfile          two-stage build: workspaces → runtime (Node 24 + perl)
docker-compose.yml  one service, host network, the telno-data volume
.env                node-specific settings, never committed
```

The runtime image is Node 24 for a specific reason: `@telno/shared` resolves to
TypeScript source, and Node 24 strips types natively. Downgrading the base image
breaks the server at import time, not at build time.

`perl` is installed because the vendored cantus stack in `vendor/cantus` is Perl.

## Build and start

```bash
git pull
docker compose build
docker compose up -d
docker compose logs -f --tail=50
```

The service binds **0.0.0.0:8080** on the host network. Host networking is not a
convenience: the edge proxies over a plain host socket, and device provisioning
and cantus voice need the real source address, which a published port would
replace with the userland proxy's.

## The data volume

`telno_telno-data` is **external** and reused, not renamed: the legacy database,
faxes and recordings live on it.

```
/data/control-plane.db   this application's database (created on first boot)
/data/telno.db           the Asterisk-era database, kept untouched
/data/faxes, /data/recordings
```

Two rule-of-thumb facts that have each already caused an outage:

1. **Ownership.** The image runs as `node` (uid/gid 1000). The volume was
   created by the previous image, which ran as uid 999, so the first start of a
   new image fails with `unable to open database file` until the volume is
   handed over:
   ```bash
   docker run --rm -v telno_telno-data:/data alpine chown -R 1000:1000 /data
   ```
   Rolling back to the old image means handing it back to 999.
2. **Never point `TELNO_DB` at `/data/telno.db`.** The schemas are different; the
   control plane would create its tables inside the legacy file and the old data
   would be unreadable from either side.

## First boot

`TELNO_ADMIN_PASSWORD` seeds the admin user once, when the `users` table is
empty. Set it in `.env` before the first start; changing it afterwards does not
rotate an existing password (use the console or delete the user row).

```bash
grep TELNO_ADMIN_PASSWORD .env
```

## Health checks

```bash
curl -s localhost:8080/api/health            # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/    # console
docker stats --no-stream                     # ~60 MiB idle, capped at 256 MiB heap
```

A `healthy` container plus a 200 on `/api/health` is the gate; the console bundle
is served from the same process, so a missing asset means the build stage did not
copy `apps/console/dist`.

## Ships as the same image behind the edge

The edge (the proxy host) terminates TLS and forwards to `8080` on this node. The
public doors are configured there, not here — `telno.tel`, the directory domains
and `telno.services` all resolve to the same upstream. Changing a door is an edge
change; changing a route is this repository.

## Importing the legacy data

The old product was a different shape (billing, campaigns, trunks, call detail);
none of that is carried over. What still means something — devices, extensions,
confirmed directory listings, brand strings — can be copied:

```bash
docker compose exec telno node scripts/import-legacy.mjs                        # dry run
docker compose exec telno node scripts/import-legacy.mjs --apply                # write
docker compose exec telno node scripts/import-legacy.mjs --apply --replace-lines # legacy wins a collision
```

An extension number is unique, so a legacy extension that collides with a row the
console already has (the seeded samples, typically) is reported as a `conflict`
and left alone unless `--replace-lines` is given. Re-run the dry run afterwards:
everything should read `exists`.

The importer is idempotent, opens the legacy database read-only, and declines a
device whose model it cannot map rather than guessing one. Imported devices carry
a derived `LEGACY-<MAC>` serial and `pending` status: when the hardware enrolls it
presents its real serial and appears as its own device, leaving the imported row
as the record of what was carried over.

## Rollback

The image is built locally and tagged `telno:latest`; there is no registry tag to
fall back to. Keep a known-good image pinned by digest before an upgrade:

```bash
docker image inspect telno:latest --format '{{.Id}}'      # record this
docker tag telno:latest telno:rollback-$(date +%Y%m%d)
```

To go back: `docker tag telno:rollback-<date> telno:latest && docker compose up -d`,
then fix the volume ownership for the older uid if the image is older than the
uid-1000 change.
