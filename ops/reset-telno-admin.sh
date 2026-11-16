#!/usr/bin/env bash
# Reset a control-plane password and print it only after the app accepts it.
#
#   ops/reset-telno-admin.sh                  # the administrator (TELNO_ADMIN_USER, default admin)
#   ops/reset-telno-admin.sh someone          # any other username
#   TELNO_VERIFY=0 ops/reset-telno-admin.sh   # no app reachable? skip the check
#
# Runs on the docker host, as root. See ops/README.md before the first real run.
set -euo pipefail

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

USER_NAME="${1:-${TELNO_ADMIN_USER:-admin}}"
ORIGIN="${TELNO_APP_ORIGIN:-http://127.0.0.1:8080}"
VERIFY="${TELNO_VERIFY:-1}"
TIMEOUT_MS="${TELNO_VERIFY_TIMEOUT_MS:-15000}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: the reset writes the app's data volume" >&2
  exit 1
fi

# The install names its own container, so this cannot be a constant. telno is
# both the compose service and the container name in this repository.
if [ -n "${TELNO_CONTAINER:-}" ]; then
  CONTAINER="$TELNO_CONTAINER"
else
  CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=telno' --format '{{.Names}}' 2>/dev/null | head -1)"
  [ -n "$CONTAINER" ] || CONTAINER=telno
fi

# The database path is the app's own setting (TELNO_DB, /data/control-plane.db in
# compose), read from the running container so a moved volume cannot be missed.
if [ -n "${TELNO_DB_PATH:-}" ]; then
  DB="$TELNO_DB_PATH"
else
  DB="$(docker exec "$CONTAINER" printenv TELNO_DB 2>/dev/null || true)"
  [ -n "$DB" ] || DB=/data/control-plane.db
fi

# The program is piped into the container's node over stdin: the container runs
# rootless, so a copied file could not be read (or deleted) by its own user.
WORK="$(mktemp /root/.telno-reset.XXXXXX)"
trap 'rm -f "$WORK" || true' EXIT

cat >"$WORK" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';

const username = process.env.RESET_USER;
const dbFile = process.env.RESET_DB;
const verify = process.env.RESET_VERIFY === '1';
const origin = process.env.RESET_ORIGIN;
const timeoutMs = Number(process.env.RESET_TIMEOUT_MS || 15000);

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 8000');

const account = db.prepare(
  'SELECT id, username, role, password_hash FROM users WHERE username = ?'
).get(username);
if (!account) {
  console.error(`no user named ${username} in ${dbFile}`);
  process.exit(1);
}

// Same scheme as hashPassword() in apps/server/src/db.ts:
// scrypt$<N>$<r>$<p>$<salt hex>$<64-byte key hex>.
const password = randomBytes(18).toString('base64url');
const salt = randomBytes(16);
const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
const hash = `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;

// Written before the change, removed once it is proved: if this script is killed
// mid-run, this file is how the old credential comes back.
const rollbackFile = `${dbFile}.reset-rollback.json`;
writeFileSync(
  rollbackFile,
  JSON.stringify({
    userId: account.id,
    username: account.username,
    password_hash: account.password_hash,
    writtenAt: new Date().toISOString(),
  }, null, 2),
  { mode: 0o600 }
);

db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, account.id);
// Every open console session for this user dies with the old credential.
db.prepare('DELETE FROM sessions WHERE username = ?').run(account.username);

if (verify) {
  let res;
  try {
    res = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: account.username, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(account.password_hash, account.id);
    try { unlinkSync(rollbackFile); } catch {}
    console.error(`login check could not reach ${origin}: ${error.message}`);
    console.error('password NOT changed');
    process.exit(2);
  }
  if (res.status !== 200) {
    const detail = (await res.text()).slice(0, 160);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(account.password_hash, account.id);
    try { unlinkSync(rollbackFile); } catch {}
    console.error(`login check failed: HTTP ${res.status} ${detail}`);
    console.error('password NOT changed');
    process.exit(2);
  }
}

db.close();
try { unlinkSync(rollbackFile); } catch {}

console.log(`user       ${account.username} (${account.role})`);
console.log(`password   ${password}`);
console.log(`sessions   ended — every open console session must sign in again`);
console.log(`verified   ${verify ? 'signed in through the app, HTTP 200' : 'skipped (TELNO_VERIFY=0)'}`);
console.log(`sign in    ${origin}`);
NODE

docker exec -i -e RESET_USER="$USER_NAME" -e RESET_DB="$DB" -e RESET_VERIFY="$VERIFY" \
  -e RESET_ORIGIN="$ORIGIN" -e RESET_TIMEOUT_MS="$TIMEOUT_MS" \
  "$CONTAINER" node --input-type=module < "$WORK"
