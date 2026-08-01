#!/usr/bin/env bash
# bootstrap — check (and optionally install) what a fresh Ubuntu host needs.
#
#   ./infra/bootstrap.sh              # report what's missing, change nothing
#   ./infra/bootstrap.sh --install    # install the missing pieces via apt/docker
#
# Reports by default rather than installing, so you can see what it wants to do to
# your machine before it does it.

set -euo pipefail

INSTALL=0
[[ "${1:-}" == "--install" ]] && INSTALL=1

missing=()
optional_missing=()
snap_docker=0

have() { command -v "$1" >/dev/null 2>&1; }

# Ubuntu ships a `docker` snap, and `sudo snap install docker` is the first thing most
# search results suggest. It cannot be used here: snap confinement blocks access to
# paths outside $HOME, so compose files and bind mounts under /srv are invisible. The
# symptom is baffling — docker resolves the working directory to
# /var/lib/snapd/void and reports "no such file or directory" for a file that exists.
detect_snap_docker() {
  have docker || return 1
  [[ "$(command -v docker)" == /snap/* ]] && return 0
  have snap && snap list docker >/dev/null 2>&1 && return 0
  return 1
}

check() {
  local cmd="$1" label="$2" tier="${3:-required}"
  if have "$cmd"; then
    printf '  \033[32m✓\033[0m %-14s %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '  \033[31m✗\033[0m %-14s %s (%s)\n' "$cmd" "$label" "$tier"
    if [[ "$tier" == "required" ]]; then missing+=("$cmd"); else optional_missing+=("$cmd"); fi
  fi
}

echo "Skymoss host prerequisites"
echo

echo "Required to run the stack:"
if detect_snap_docker; then
  snap_docker=1
  printf '  \033[31m✗\033[0m %-14s %s\n' "docker" "installed via SNAP — confined, cannot read /srv (required)"
  missing+=("docker")
else
  check docker "container runtime"
fi
check git    "to clone this repo"

echo
echo "Optional:"
# Backups run in the mc-backup container via restic, so nothing extra is needed on
# the host. zstd is still handy for ad-hoc archives.
check zstd "compressing ad-hoc archives" optional

echo
echo "Only needed to EDIT the pack on this host (you can do that on your desktop):"
check node "runs tools/*.ts" optional

echo
# The compose plugin is a docker subcommand, not its own binary.
if have docker && (( ! snap_docker )); then
  if docker compose version >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %-14s %s\n' "compose" "$(docker compose version --short 2>/dev/null || echo present)"
  else
    printf '  \033[31m✗\033[0m %-14s %s\n' "compose" "docker compose plugin missing (required)"
    missing+=("docker-compose-plugin")
  fi
fi

echo
if [[ ${#missing[@]} -eq 0 && ${#optional_missing[@]} -eq 0 ]]; then
  echo "All prerequisites present."
  exit 0
fi

if (( ! INSTALL )); then
  echo "To install everything that's missing:"
  echo
  if (( snap_docker )); then
    echo "  # Remove the snap first — it cannot read /srv, and having both installed"
    echo "  # leaves /snap/bin/docker ahead of /usr/bin/docker on PATH."
    echo "  # NOTE: this deletes any containers/volumes the snap was managing."
    echo "  sudo snap remove docker"
    echo
  fi
  if ! have docker || (( snap_docker )); then
    echo "  # Docker Engine + compose plugin (official convenience script)"
    echo "  curl -fsSL https://get.docker.com | sudo sh"
    echo "  sudo usermod -aG docker \$USER    # then log out and back in"
    echo
  fi
  echo "  sudo apt update && sudo apt install -y git zstd"
  echo
  echo "Re-run with --install to do this automatically."
  # Missing required tooling is a failure; missing snapshot/optional tooling is not.
  [[ ${#missing[@]} -gt 0 ]] && exit 1
  exit 0
fi

echo "Installing…"

if (( snap_docker )); then
  echo "==> Removing the docker snap (confined; cannot read /srv)"
  echo "    This deletes containers and volumes the snap was managing."
  read -r -p "    Continue? [y/N] " reply < /dev/tty || reply=n
  if [[ "$reply" != [yY] ]]; then
    echo "    Aborted. The stack cannot run on snap-packaged Docker." >&2
    exit 1
  fi
  sudo snap remove docker
fi

if ! have docker || (( snap_docker )); then
  echo "==> Docker Engine"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "    NOTE: log out and back in before docker works without sudo."
fi

APT_PKGS=()
have git  || APT_PKGS+=(git)
have zstd || APT_PKGS+=(zstd)

if [[ ${#APT_PKGS[@]} -gt 0 ]]; then
  echo "==> apt: ${APT_PKGS[*]}"
  sudo apt update
  sudo apt install -y "${APT_PKGS[@]}"
fi

echo
echo "Done. Next: cp infra/.env.example infra/.env && \$EDITOR infra/.env"
