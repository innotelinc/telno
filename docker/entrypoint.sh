#!/bin/sh
# The data volume is mounted over /data, and a volume that has just been
# created — by compose, by `docker volume create`, by a first install — arrives
# owned by root, while the application runs as `node`. SQLite then cannot create
# its file and the container restarts forever with "unable to open database
# file". Take ownership once, then drop the privilege: the platform itself never
# runs as root, and a re-run against an existing volume costs one chown.
set -eu

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups \
    node /app/apps/server/dist/index.js
fi

# Started with an explicit --user, or from an image that already dropped root:
# nothing to fix, and nothing to drop.
exec node /app/apps/server/dist/index.js
