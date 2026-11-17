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

ORIGIN="${TELNO_APP_ORIGIN:-http://127.0.0.1:8080}"
VERIFY="${TELNO_VERIFY:-1}"
TIMEOUT_MS="${TELNO_VERIFY_TIMEOUT_MS:-15000}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: the reset writes the app's data volume" >&2
  exit 1
fi

# The install names its own container, so this cannot be a constant. Both
# compose services run the same image: `telno` for host networking and
# `telno-desktop`, which is what the installer starts on Docker Desktop. Looking
# for only the first one left every Mac and Windows install with "no such
# container".
if [ -n "${TELNO_CONTAINER:-}" ]; then
  CONTAINER="$TELNO_CONTAINER"
else
  # Running first; a stopped stack still gets the precise "not running" answer
  # from the inspect check below.
  labeled() {
    docker ps "$@" --filter 'label=com.docker.compose.service=telno' \
      --filter 'label=com.docker.compose.service=telno-desktop' \
      --format '{{.Names}}' 2>/dev/null || true
  }
  MATCHES="$( { labeled; labeled -a; } | awk '!seen[$0]++' )"
  # Several projects on one host is not an error, but picking one at random is:
  # the documented install is named telno, so that one wins when it is there.
  CONTAINER="$(printf '%s\n' "$MATCHES" | grep -x 'telno' || true)"
  [ -n "$CONTAINER" ] || CONTAINER="$(printf '%s\n' "$MATCHES" | head -1)"
  [ -n "$CONTAINER" ] || CONTAINER=telno
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "no container named $CONTAINER — is the stack running?" >&2
  echo "  docker ps    # and set TELNO_CONTAINER if the install named it otherwise" >&2
  exit 1
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]; then
  echo "$CONTAINER is not running — start it before resetting the password:" >&2
  echo "  docker start $CONTAINER" >&2
  exit 1
fi

# The administrator's name is the install's own setting, read from the container
# rather than assumed: an install with TELNO_ADMIN_USER=ops has no user called
# admin, and "no user named admin" reads like a lost account rather than a
# default that was wrong.
if [ -n "${1:-}" ]; then
  USER_NAME="$1"
else
  USER_NAME="$(docker exec "$CONTAINER" printenv TELNO_ADMIN_USER 2>/dev/null || true)"
  [ -n "$USER_NAME" ] || USER_NAME=admin
fi

# The database path is the app's own setting (TELNO_DB, /data/control-plane.db in
# compose), read from the running container so a moved volume cannot be missed.
if [ -n "${TELNO_DB_PATH:-}" ]; then
  DB="$TELNO_DB_PATH"
else
  DB="$(docker exec "$CONTAINER" printenv TELNO_DB 2>/dev/null || true)"
  [ -n "$DB" ] || DB=/data/control-plane.db
fi

if ! docker exec "$CONTAINER" test -f "$DB" 2>/dev/null; then
  echo "no database at $DB inside $CONTAINER — has the platform booted yet?" >&2
  echo "  docker logs --tail 40 $CONTAINER" >&2
  exit 1
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
  if (res.status === 403) {
    // The console checks the allowlist before it looks at any credential, so a
    // 403 says nothing about the password. Reporting it as a failed sign-in
    // sends the operator hunting for the wrong problem.
    const detail = (await res.text()).slice(0, 160);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(account.password_hash, account.id);
    try { unlinkSync(rollbackFile); } catch {}
    console.error(`the console refused the check before reading the password: HTTP 403 ${detail}`);
    console.error('That is the sign-in allowlist (TELNO_TRUSTED_NETWORKS), not a wrong password:');
    console.error('127.0.0.1 is not trusted on this install, so nothing here can prove the credential.');
    console.error('Add 127.0.0.1/32 to the allowlist and run this again — or, if you accept an');
    console.error('unproved credential, re-run with TELNO_VERIFY=0.');
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
  // Every session for this user dies here — the ones that predate the reset,
  // and the one the check just created, which nobody holds. After the proof,
  // not before: a failed check puts the old credential back, and the sessions
  // it would have killed should survive with it.
  db.prepare('DELETE FROM sessions WHERE username = ?').run(account.username);
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
