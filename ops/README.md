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

It finds the app container by its compose service label
(`com.docker.compose.service=telno`), reads the database path from the
container's own `TELNO_DB`, and needs no credentials of its own; running it needs
root only for `docker`.

### Use

```bash
ops/reset-telno-admin.sh                  # the administrator
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

Every session for that user is deleted, including the current browser session.
The password is printed, never stored.

### Exit codes

| code | meaning |
| --- | --- |
| 0 | password changed and proved |
| 1 | not root, or no such user |
| 2 | login check failed or the app could not be reached — **password not changed** |

### Overrides

| variable | default | why |
| --- | --- | --- |
| `TELNO_CONTAINER` | auto-detected, else `telno` | several installs on one host |
| `TELNO_DB_PATH` | the container's `TELNO_DB` | point at a copy to rehearse |
| `TELNO_APP_ORIGIN` | `http://127.0.0.1:8080` | app port inside the container |
| `TELNO_VERIFY` | `1` | `0` skips the login check |
| `TELNO_VERIFY_TIMEOUT_MS` | `15000` | a hung app fails instead of hanging |

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
- A rate-limited or allowlist-refused check reports HTTP 429/403 and rolls back,
  rather than looping.
