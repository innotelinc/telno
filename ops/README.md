# ops

Operational scripts for the control plane. Nothing here is imported by either
app; these are run on the docker host, as root.

## reset-telno-admin.sh

Resets a console password and prints the new one **only after the app accepts
it**. If the login check fails, the old credential is put back and nothing is
printed, so a bad run cannot leave the platform without a working administrator.

### Where it comes from

It ships with the installer. `deploy/install.sh` fetches it from the install it
is installing from and lands it at `<install dir>/ops/reset-telno-admin.sh`
(mode 700). The server serves it from this repository at
`/ops/reset-telno-admin.sh`, next to `/install.sh`.

```bash
curl -fsS http://<install>/ops/reset-telno-admin.sh -o /root/reset-telno-admin.sh
chmod 700 /root/reset-telno-admin.sh
```

It finds the app container by its compose service label — `telno` for host
networking, or `telno-desktop`, which is what the installer starts on Docker
Desktop — preferring a container actually named `telno` when more than one
project runs on the host (`TELNO_CONTAINER` overrides the choice). It then reads
the administrator's name (`TELNO_ADMIN_USER`) and the database path (`TELNO_DB`)
from the container itself, and needs no credentials of its own; running it needs
root only for `docker`.

Two things it refuses to guess at: a container that is not running
(`… is not running — start it before resetting the password`) or absent, and a
database that is not there yet (`no database at /data/control-plane.db inside …
— has the platform booted yet?`).

### Use

```bash
ops/reset-telno-admin.sh                  # the administrator, as the install names it
ops/reset-telno-admin.sh someone          # any other username
TELNO_VERIFY=0 ops/reset-telno-admin.sh   # app not reachable? skip the check
```

Output:

```
user       admin (admin)
password   <24 URL-safe characters>
sessions   ended — every open console session must sign in again
verified   signed in through the app, HTTP 200
sign in    http://127.0.0.1:8080
```

Every session for that user is deleted once the new credential has been proved
— the ones that predate the reset and the one the check itself creates. They are
deleted *after* the check, not before: when a check fails the old password is put
back and its sessions stay valid. The password is printed, never stored.

### Exit codes

| code | meaning |
| --- | --- |
| 0 | password changed and proved |
| 1 | not root, or no such user |
| 2 | login check failed or the app could not be reached — **password not changed** |

### Overrides

| variable | default | why |
| --- | --- | --- |
| `TELNO_CONTAINER` | auto-detected (`telno` or `telno-desktop`), else `telno` | several installs on one host |
| `TELNO_DB_PATH` | the container's `TELNO_DB` | point at a copy to rehearse |
| `TELNO_APP_ORIGIN` | `http://127.0.0.1:8080` | app port inside the container |
| `TELNO_VERIFY` | `1` | `0` skips the login check |
| `TELNO_VERIFY_TIMEOUT_MS` | `15000` | a hung app fails instead of hanging |

### When the console answers 403

The console applies its sign-in allowlist **before** it looks at any credential,
so a 403 says nothing about the password. The script reports it as what it is:

```
the console refused the check before reading the password: HTTP 403 …
That is the sign-in allowlist (TELNO_TRUSTED_NETWORKS), not a wrong password:
127.0.0.1 is not trusted on this install, so nothing here can prove the credential.
password NOT changed
```

The default allowlist is loopback plus RFC 1918, so this only appears on an
install where it was narrowed. Either add `127.0.0.1/32` and run it again, or
accept an unproved credential with `TELNO_VERIFY=0`.

### Rehearse without touching the live password

```bash
docker exec telno node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const from = process.env.TELNO_DB || '/data/control-plane.db';
const d = new DatabaseSync(from);
d.exec(\"VACUUM INTO '/tmp/rehearsal.db'\"); d.close();"
TELNO_DB_PATH=/tmp/rehearsal.db TELNO_VERIFY=0 ops/reset-telno-admin.sh
docker exec telno rm -f /tmp/rehearsal.db
```

### If the script was killed mid-run

The new password exists but was never printed. The old credential is in
`<db>.reset-rollback.json` inside the container's data volume until the run
finishes, so put it back:

```bash
docker exec telno node --input-type=module - <<'EOF'
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, unlinkSync } from 'node:fs';
const db = new DatabaseSync(process.env.TELNO_DB || '/data/control-plane.db');
const saved = JSON.parse(readFileSync(`${process.env.TELNO_DB || '/data/control-plane.db'}.reset-rollback.json`, 'utf8'));
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(saved.password_hash, saved.userId);
db.close();
unlinkSync(`${process.env.TELNO_DB || '/data/control-plane.db'}.reset-rollback.json`);
console.log('restored', saved.username);
EOF
```

### Notes for whoever edits this

- The container runs rootless: a copied file is unreadable (and unremovable) for
  its own user, which is why the program is piped into
  `node --input-type=module` over stdin.
- The hash must stay `scrypt$16384$8$1$<salt hex>$<64-byte hex>` with no
  normalization, matching `hashPassword()` in `apps/server/src/db.ts`; anything
  else fails at sign-in.
- A rate-limited check (HTTP 429) rolls back and says so; it does not retry in
  a loop. A 403 is the allowlist and has its own section above.
- The container lookup matches `telno` and `telno-desktop` because both services
  run the same image; a third name has to come from `TELNO_CONTAINER`.
