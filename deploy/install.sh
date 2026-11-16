#!/bin/sh
# Telno — install the control plane on this host from a release archive.
#
#   TELNO_URL=https://telno.example TELNO_USER=admin TELNO_PASSWORD=… \
#     curl -fsSL https://telno.example/install.sh | sh
#
# The release archive is the application itself, source included, so the
# install serving it keeps it behind the console: this signs in first and
# downloads with the session it was given. Nothing here needs the source — the
# compose file, the .env and the archive all come from the same host.
#
# Re-run it to upgrade. An .env you have edited is left alone.
#
# Overrides:
#   TELNO_URL       the install that serves the archive (default http://127.0.0.1:8080)
#   TELNO_USER      console username to sign in with
#   TELNO_PASSWORD  its password
#   TELNO_VERSION   release to fetch (default @VERSION@, the serving platform's)
#   TELNO_ARCHIVE   archive filename on the serving host's release volume
#   TELNO_IMAGE     load this image tarball instead of fetching the archive
#   TELNO_DIR       the directory to create (default ./telno)
#   TELNO_LOCAL_URL where the stack being installed will answer (default
#                   http://127.0.0.1:8080), used to wait for readiness
#
#   sh install.sh --dry-run        fetch and validate, start nothing
#   sh install.sh --force          replace a compose file already in the directory
#   sh install.sh --keep-archive   do not delete the downloaded archive

set -eu

BASE="${TELNO_URL:-http://127.0.0.1:8080}"
VERSION="${TELNO_VERSION:-@VERSION@}"
DIR="${TELNO_DIR:-telno}"
LOCAL="${TELNO_LOCAL_URL:-http://127.0.0.1:8080}"
DRY_RUN=0
FORCE=0
KEEP_ARCHIVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --keep-archive) KEEP_ARCHIVE=1 ;;
    -h|--help)
      sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# The placeholder is filled in by the platform that serves this script. A copy
# run straight out of the repository has not been through that, so take the
# version from the tree beside it — and refuse rather than ask the release
# volume for a file called telno-@VERSION@.tar.gz.
if [ "$VERSION" = "@VERSION@" ]; then
  SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
  if [ -n "${SELF_DIR:-}" ] && [ -f "$SELF_DIR/../package.json" ]; then
    VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SELF_DIR/../package.json" | head -1)
  fi
fi
case "$VERSION" in
  '' | *@*)
    fail "This copy of the installer still carries the @VERSION@ placeholder; the platform that serves it fills that in. Fetch /install.sh from a running install, or set TELNO_VERSION to the release you want."
    ;;
esac

say() { printf '%s\n' "$*"; }
fail() {
  printf '\n  %s\n\n' "$*" >&2
  exit 1
}

# ----------------------------------------------------------------- checks -----

command -v docker >/dev/null 2>&1 ||
  fail "Docker is not installed. Install Docker Engine or Docker Desktop, then run this again."

docker info >/dev/null 2>&1 ||
  fail "Docker is installed but not running (or this user cannot reach the daemon). Start Docker, or run with sudo, then try again."

# Compose v2 is the plugin, not the old python binary: `docker compose`, not
# `docker-compose`. The plugin is what current Docker installs ship.
docker compose version >/dev/null 2>&1 ||
  fail "Docker Compose v2 is missing. It ships with Docker Engine 20.10+ and Docker Desktop; install the compose plugin and try again."

command -v curl >/dev/null 2>&1 || fail "curl is required to fetch the install files."

# ------------------------------------------------------------------ files -----

mkdir -p "$DIR"

fetch() {
  # fetch <path on the serving host> <destination> <what>
  if ! curl -fsSL "$BASE$1" -o "$2.tmp"; then
    rm -f "$2.tmp"
    fail "Could not download $3 from $BASE$1 — is this host reachable?"
  fi
  if [ ! -s "$2.tmp" ]; then
    rm -f "$2.tmp"
    fail "$3 came back empty from $BASE$1"
  fi
  mv "$2.tmp" "$2"
}

say ""
say "  Telno installer"
say "  release $VERSION"
say "  into    $(cd "$DIR" && pwd)"
say ""

COMPOSE_FILE=docker-compose.yml
SERVICE=telno
PROFILE_ARGS=""

# Docker Desktop runs the engine inside a VM, so host networking binds there and
# the console is unreachable at 127.0.0.1 on this machine — the container looks
# healthy and nothing answers. The other service in the same compose file
# publishes the port; both are defined together, off one anchor, so the two
# cannot drift apart.
if docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
  SERVICE=telno-desktop
  PROFILE_ARGS="--profile desktop"
  say "  Docker Desktop detected: publishing the port instead of using host networking."
fi

# The command the operator would type, kept in one place so the hints below name
# the profile and service actually in use.
COMPOSE_CMD="docker compose -f $COMPOSE_FILE${PROFILE_ARGS:+ $PROFILE_ARGS}"
compose() {
  # shellcheck disable=SC2086
  docker compose -f "$COMPOSE_FILE" $PROFILE_ARGS "$@"
}

if [ -f "$DIR/$COMPOSE_FILE" ] && [ "$FORCE" -eq 0 ]; then
  say "  Keeping the $COMPOSE_FILE already in $DIR."
  say "  Re-run with --force to replace it with the served one."
else
  fetch "/$COMPOSE_FILE" "$DIR/$COMPOSE_FILE" "$COMPOSE_FILE"
fi

if [ -f "$DIR/.env" ]; then
  say "  Keeping the .env already in $DIR."
else
  fetch "/env.example" "$DIR/.env" "env.example"
  say "  Wrote $DIR/.env — review it before exposing this host to the internet."
fi

cd "$DIR"

# The compose file has to parse before anything is started: a typo in .env is
# otherwise reported as a crash inside the container, which reads like a bug in
# the platform rather than in the file beside it.
if ! compose config >/dev/null 2>&1; then
  say ""
  compose config || true
  fail "$COMPOSE_FILE or .env in $(pwd) is not valid — see the error above."
fi

# The data volume is declared external, so a first install has to create it
# before compose will agree the stack is configurable.
if ! docker volume inspect telno_telno-data >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  Would create the telno_telno-data volume."
  else
    docker volume create telno_telno-data >/dev/null
    say "  Created the telno_telno-data volume."
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say ""
  say "  Dry run: files fetched and validated, nothing pulled or started."
  say ""
  exit 0
fi

# ------------------------------------------------------------------ image -----
#
# The release archive on the serving host is the normal source: the archive is
# the product, and depending on a registry's quota is not an install path.
# TELNO_IMAGE still takes a tarball for a box that already has one.

ARCHIVE="${TELNO_ARCHIVE:-telno-$VERSION.tar.gz}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

cleanup_archive() {
  [ "$KEEP_ARCHIVE" -eq 1 ] || rm -f "$ARCHIVE"
}

# JSON string escaping for the credentials: a password is allowed to contain a
# quote or a backslash, and a malformed body would read as a refused sign-in.
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ -n "${TELNO_IMAGE:-}" ]; then
  ARCHIVE="$TELNO_IMAGE"
  say "  Loading $ARCHIVE"
elif [ -z "${TELNO_USER:-}" ] || [ -z "${TELNO_PASSWORD:-}" ]; then
  fail "Fetching the release archive needs a console sign-in. Run this again with TELNO_USER and TELNO_PASSWORD set (the account's own password), or set TELNO_IMAGE to a docker-save tarball you already have."
else
  say "  Signing in to $BASE as $TELNO_USER"
  LOGIN_BODY="{\"username\":\"$(json_escape "$TELNO_USER")\",\"password\":\"$(json_escape "$TELNO_PASSWORD")\"}"
  CODE=$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' \
    -H 'content-type: application/json' -d "$LOGIN_BODY" "$BASE/api/auth/login" || true)
  case "$CODE" in
    200) ;; # signed in; the jar is what the download uses
    401) fail "The console refused those credentials. Check TELNO_USER and TELNO_PASSWORD." ;;
    403) fail "$BASE refused this host: the console allowlist does not include it. Add this machine's network in Settings, or run the installer from an allowed one." ;;
    429) fail "The console is throttling sign-ins from this host. Wait a few minutes and try again." ;;
    *)   fail "Could not sign in to $BASE (HTTP ${CODE:-none}). Is the control plane reachable and serving the console?" ;;
  esac

  ARCHIVE_URL="$BASE/download/$ARCHIVE"
  CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -I "$ARCHIVE_URL" || true)
  case "$CODE" in
    200)
      say "  Downloading $ARCHIVE — resumable, so a dropped link costs only what was lost."
      if ! curl -fsS -b "$JAR" -L --retry 3 -C - "$ARCHIVE_URL" -o "$ARCHIVE"; then
        rm -f "$ARCHIVE"
        fail "Could not download $ARCHIVE from $ARCHIVE_URL"
      fi
      ;;
    404)
      fail "There is no $ARCHIVE on $BASE's release volume. Upload one there, or set TELNO_VERSION/TELNO_ARCHIVE to the name it actually has."
      ;;
    *)
      fail "The release archive answered HTTP ${CODE:-none} on $ARCHIVE_URL."
      ;;
  esac
fi

say "  Loading the image"
if ! docker load -i "$ARCHIVE"; then
  fail "$ARCHIVE did not load — it may be truncated. Delete it and run this again."
fi
cleanup_archive

# --no-build on purpose: the image just came out of the archive, and a build
# would need the source this host does not have. The service is named so the
# desktop profile cannot also start the host-networking one.
compose up -d --no-build "$SERVICE"

# Wait for the control plane rather than declaring victory on "Started": it
# generates its secrets and migrates the database on the way up.
say "  Waiting for the control plane to answer..."
i=0
READY=0
while [ "$i" -lt 40 ]; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL/api/health" 2>/dev/null || true)
  [ "$CODE" = "200" ] && { READY=1; break; }
  i=$((i + 1))
  sleep 3
done
# Not ready is a failed install, not a note beside a success message: the
# container may be restarting (a data volume the app cannot write is the usual
# reason), and saying "up" over a crash loop is how an operator loses an hour.
if [ "$READY" -ne 1 ]; then
  say ""
  say "  The control plane did not answer at $LOCAL. Its log:"
  say ""
  compose logs --tail 40 "$SERVICE" 2>&1 || true
  fail "The stack was installed but is not running — the reason is at the end of the log above."
fi

say ""
say "  Telno is up at $LOCAL"
say ""
say "  Sign in as ${TELNO_ADMIN_USER:-admin}. Nothing ships with a password: the"
say "  first boot generated one and printed it once, here:"
say "    $COMPOSE_CMD logs $SERVICE | grep -A2 'First-run administrator'"
say ""
say "  If that banner is not there, this database already has its administrator and"
say "  the password is the one set then — Settings → Password changes it."
say ""
say "  The installer signed in to fetch the archive; that session is not this install's."
say ""
