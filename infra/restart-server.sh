#!/usr/bin/env bash
# restart-server — warn players, flush the world, and restart the server.
#
#   ./restart-server.sh            # full countdown (15/5/1 minutes)
#   ./restart-server.sh --now      # flush and restart immediately
#
# Uses `rcon-cli` inside the mc container rather than a separate RCON client
# image, because it is already there and already proven — no extra image, no
# assumptions about what subcommands some other tool provides.
#
# The server is asked to STOP, not killed: Docker's `restart: unless-stopped`
# policy brings it back. That means an admin restart and a crash-restart take the
# same path, so there is one recovery behaviour to reason about rather than two.
#
# Install as a nightly timer — see docs/monitoring.md.

set -uo pipefail

CONTAINER="${MC_CONTAINER:-skymoss-mc}"
IMMEDIATE=0
[[ "${1:-}" == "--now" ]] && IMMEDIATE=1

log() { printf '[restart] %s\n' "$*"; }

rcon() {
  docker exec "$CONTAINER" rcon-cli "$@" 2>/dev/null
}

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "container '$CONTAINER' is not running — nothing to restart"
  exit 0
fi

# Don't interrupt anyone if the server is empty; the restart is for hygiene, not
# an emergency, and an empty server has nothing to warn about.
if [[ "$IMMEDIATE" == "0" ]]; then
  players="$(rcon list || true)"
  log "${players:-<no response>}"

  if [[ "$players" =~ There\ are\ 0 ]]; then
    log "no players online — restarting without countdown"
    IMMEDIATE=1
  fi
fi

if [[ "$IMMEDIATE" == "0" ]]; then
  rcon say "§eServer restarting in 15 minutes." ; sleep 600
  rcon say "§eServer restarting in 5 minutes."  ; sleep 240
  rcon say "§cServer restarting in 1 minute."   ; sleep 60
fi

log "flushing world"
rcon save-all flush
sleep 10

log "stopping server (Docker will restart it)"
rcon stop

log "done"
