#!/bin/sh
# Telno — install from the published image.
#
#   TELNO_KEY=<install key> curl -fsSL https://telno.services/install.sh | sh
#
# The release archive is behind the console — it is the application, source
# included — so downloading it needs an install key. Create one there:
# Settings → API keys → scope "install".
# Nothing here needs the source: the compose file, the .env and the release
# archive are all fetched from the same host. Re-run it to upgrade; it will not
# touch an .env you have edited.
#
# Overrides, if you are installing from something other than telno.services:
#   TELNO_URL     where the compose file, release archive and this script are served
#   TELNO_KEY     an install key from the console, to download the archive
#   TELNO_IMAGE   pull this image from a registry instead of the release archive
#   TELNO_DIR     the directory to create (default ./telno)
#
#   sh install.sh --dry-run   fetch and validate, start nothing
#   sh install.sh --keep-archive   do not delete the downloaded release archive

set -eu

BASE="${TELNO_URL:-https://telno.services}"
VERSION="@VERSION@"
DIR="${TELNO_DIR:-telno}"
DRY_RUN=0
FORCE=0
KEEP_ARCHIVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --keep-archive) KEEP_ARCHIVE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

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
  # fetch <url> <destination> <what>
  if ! curl -fsSL "$1" -o "$2.tmp"; then
    rm -f "$2.tmp"
    fail "Could not download $3 from $1 — is this host reachable?"
  fi
  if [ ! -s "$2.tmp" ]; then
    rm -f "$2.tmp"
    fail "$3 came back empty from $1"
  fi
  mv "$2.tmp" "$2"
}

say ""
say "  Telno installer"
say "  release $VERSION"
say "  into    $(cd "$DIR" && pwd)"
say ""

# Docker Desktop does not put a container on the host's network stack, so it gets
# the published-port file; Linux gets host networking, which is what a switch
# wants (no NAT between it and the RTP it advertises).
if docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
  COMPOSE_FILE=docker-compose.desktop.yml
  say "  Docker Desktop detected: publishing ports instead of host networking."
else
  COMPOSE_FILE=docker-compose.yml
fi

if [ -f "$DIR/$COMPOSE_FILE" ] && [ "$FORCE" -eq 0 ]; then
  say "  Keeping the $COMPOSE_FILE already in $DIR."
  say "  Re-run with --force to replace it with the published one."
else
  fetch "$BASE/$COMPOSE_FILE" "$DIR/$COMPOSE_FILE" "$COMPOSE_FILE"
fi

if [ -f "$DIR/.env" ]; then
  say "  Keeping the .env already in $DIR."
else
  fetch "$BASE/env.example" "$DIR/.env" "env.example"
  say "  Wrote $DIR/.env — edit PUBLIC_URL there before exposing this to the internet."
fi

# The compose file has to parse before anything is started: a typo in an .env is
# otherwise reported as a crash inside the container, which reads like a bug in
# the platform rather than in the file beside it.
# Compose picks up docker-compose.yml by default; the Desktop variant is named
# explicitly, which is also what these calls have to do.
COMPOSE_ARGS="-f $COMPOSE_FILE"
cd "$DIR"
# shellcheck disable=SC2086
if ! docker compose $COMPOSE_ARGS config >/dev/null 2>&1; then
  say ""
  # shellcheck disable=SC2086
  docker compose $COMPOSE_ARGS config || true
  fail "$COMPOSE_FILE or .env in $(pwd) is not valid — see the error above."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say ""
  say "  Dry run: files fetched and validated, nothing pulled or started."
  say ""
  exit 0
fi

# ------------------------------------------------------------------- image ----
#
# The release archive on this host is the normal source: a public registry can
# rate-limit or refuse a push, and an install that depends on somebody else's
# quota is not an install. A registry is still supported — set TELNO_IMAGE and
# it is pulled instead, which is also what a pinned copy looks like.

if [ -n "${TELNO_IMAGE:-}" ]; then
  say "  Pulling $TELNO_IMAGE"
  # shellcheck disable=SC2086
  if ! TELNO_IMAGE="$TELNO_IMAGE" docker compose $COMPOSE_ARGS pull; then
    fail "Could not pull $TELNO_IMAGE. Check the image name, or that this host can reach the registry."
  fi
else
  ARCHIVE="telno-$VERSION.tar.gz"
  ARCHIVE_URL="$BASE/download/$ARCHIVE"
  # curl with the install key, when there is one. The server refuses the archive
  # without it, and refuses before it looks for the file, so an unknown key and
  # a missing archive are told apart here rather than guessed at.
  with_key() {
    if [ -n "${TELNO_KEY:-}" ]; then
      curl -H "x-api-key: $TELNO_KEY" "$@"
    else
      curl "$@"
    fi
  }
  if with_key -fsI "$ARCHIVE_URL" >/dev/null 2>&1; then
    say "  Downloading $ARCHIVE — a few hundred megabytes, once."
    if ! with_key -fL --retry 3 -C - "$ARCHIVE_URL" -o "$ARCHIVE"; then
      rm -f "$ARCHIVE"
      fail "Could not download $ARCHIVE from $ARCHIVE_URL"
    fi
    say "  Loading the image"
    if ! docker load -i "$ARCHIVE"; then
      fail "$ARCHIVE did not load — it may be truncated. Delete it and run this again."
    fi
    [ "$KEEP_ARCHIVE" -eq 1 ] || rm -f "$ARCHIVE"
  else
    CODE=$(with_key -s -o /dev/null -w '%{http_code}' -I "$ARCHIVE_URL" 2>/dev/null || true)
    case "$CODE" in
      401|403)
        fail "The release archive on $BASE needs an install key. Create one in the console — Settings, API keys, scope \"install\" — then run this again with TELNO_KEY=<key> in front of the command."
        ;;
    esac
    say "  No release archive at $ARCHIVE_URL; pulling from the registry instead."
    # shellcheck disable=SC2086
    if ! docker compose $COMPOSE_ARGS pull; then
      fail "Could not download $ARCHIVE or pull the image. Check that this host can reach $BASE and a registry."
    fi
  fi
fi

# shellcheck disable=SC2086
docker compose $COMPOSE_ARGS up -d

# Wait for the health endpoint rather than declaring victory on "Started": the
# app generates its secrets and migrates the database on the way up.
say "  Waiting for the platform to answer..."
i=0
while [ "$i" -lt 30 ]; do
  # shellcheck disable=SC2086
  if docker compose $COMPOSE_ARGS exec -T telno curl -fsS http://127.0.0.1:8080/api/healthz >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 3
done

OWNER_URL="$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2- || true)"
[ -n "${OWNER_URL:-}" ] || OWNER_URL="http://localhost:8080"

say ""
say "  Telno is up at $OWNER_URL"
say ""
say "  The owner account is $(grep -E '^ADMIN_EMAIL=' .env 2>/dev/null | cut -d= -f2- || echo 'admin@telno.local')"
say "  Its password, if one was not set in .env:"
say "    docker compose $COMPOSE_ARGS exec telno cat /data/first-run-password.txt"
say ""
say "  Sign in, then finish the first-run steps: terms, details, and a line with"
say "  a number on it. Settings → Vault is where provider keys belong."
say ""
