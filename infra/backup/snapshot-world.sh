#!/usr/bin/env bash
# snapshot-world — take a consistent world snapshot and commit it to skymoss-worlds.
#
#   ./snapshot-world.sh [reason]
#
# Flushes pending chunk writes via RCON, archives the world, then re-enables saving
# and commits the tarball to the worlds repo through Git LFS.
#
# IMPORTANT: `save-off` is paired with a trap, not a trailing command. If this script
# died between save-off and save-on, the server would keep running with saving
# disabled and silently lose everything since the last flush — a far worse outcome
# than a failed backup. The trap guarantees saving is restored on any exit path.
#
# Cadence (see docs/backups.md): frequent local snapshots are restic's job. This
# script is for the snapshots you want *history* for — weekly, pre-release, and
# before any major world-altering change. A snapshot is ~220 MB, so committing
# hourly would blow through GitHub LFS quota fast.

set -euo pipefail

REASON="${1:-scheduled}"
CONTAINER="${MC_CONTAINER:-skymoss-mc}"
WORLD_NAME="${WORLD_NAME:-FlyMoss}"
WORKDIR="${WORLDS_CHECKOUT:-/srv/skymoss-worlds}"
STAGING="${SNAPSHOT_STAGING:-/tmp/skymoss-snapshot}"

log() { printf '[snapshot] %s\n' "$*"; }

rcon() {
  docker exec "$CONTAINER" rcon-cli "$@"
}

saving_disabled=0
restore_saving() {
  if [[ "$saving_disabled" == "1" ]]; then
    log "re-enabling autosave"
    rcon save-on || log "WARNING: failed to re-enable saving — check the server NOW"
    saving_disabled=0
  fi
}
trap restore_saving EXIT INT TERM

# --- flush ------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "flushing world via rcon"
  rcon say "§7Taking a world snapshot…" || true
  rcon save-off
  saving_disabled=1
  rcon save-all flush
  # save-all returns before the write is necessarily complete on disk.
  sleep 5
  SERVER_RUNNING=1
else
  log "container '$CONTAINER' not running — archiving world at rest"
  SERVER_RUNNING=0
fi

# --- archive ----------------------------------------------------------------
WORLD_PATH="$(docker volume inspect skymoss_mc-data --format '{{ .Mountpoint }}' 2>/dev/null || echo '')/${WORLD_NAME}"
if [[ ! -d "$WORLD_PATH" ]]; then
  log "ERROR: world not found at $WORLD_PATH"
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
mkdir -p "$STAGING"
ARCHIVE="$STAGING/${STAMP}.tar.zst"

log "archiving $WORLD_PATH -> $ARCHIVE"
# session.lock is per-run server state and would be stale on restore.
tar --exclude='session.lock' -I 'zstd -19 -T0' -cf "$ARCHIVE" -C "$(dirname "$WORLD_PATH")" "$(basename "$WORLD_PATH")"

restore_saving
if [[ "$SERVER_RUNNING" == "1" ]]; then
  rcon say "§aSnapshot complete." || true
fi

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
log "archive size: $SIZE"

# --- commit -----------------------------------------------------------------
if [[ ! -d "$WORKDIR/.git" ]]; then
  log "ERROR: worlds repo not checked out at $WORKDIR"
  log "  git clone ${WORLDS_REPO:-git@github.com:jerezereh/skymoss-worlds.git} $WORKDIR"
  exit 1
fi

cd "$WORKDIR"
git lfs install --local >/dev/null 2>&1 || true
git pull --ff-only || log "WARNING: pull failed, committing on top of local state"

mkdir -p "snapshots/${WORLD_NAME}"
mv "$ARCHIVE" "snapshots/${WORLD_NAME}/${STAMP}.tar.zst"

# sed rather than `grep -oP`: PCRE mode is unavailable under some locales and fails
# per-call, which would silently record every snapshot as pack version "unknown".
PACK_VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' "${PACK_TOML:-/srv/skymoss-minceraft/pack/pack.toml}" 2>/dev/null | head -1)"
PACK_VERSION="${PACK_VERSION:-unknown}"

{
  echo "- \`${STAMP}\` — ${SIZE} — pack \`${PACK_VERSION}\` — ${REASON}"
} >> "snapshots/${WORLD_NAME}/LOG.md"

git add "snapshots/${WORLD_NAME}/${STAMP}.tar.zst" "snapshots/${WORLD_NAME}/LOG.md"
git commit -m "snapshot(${WORLD_NAME}): ${STAMP} — ${REASON}

Pack version: ${PACK_VERSION}
Archive size: ${SIZE}"

git push
log "pushed ${STAMP}.tar.zst"
