#!/usr/bin/env bash
# import-configs — sync configs from a live Minecraft instance into the pack tree.
#
# Run this after changing configs in-game to bring them back under version control.
# It is idempotent: each target directory is replaced wholesale from the instance.
#
#   ./tools/import-configs.sh /path/to/instance
#
# Portable by design — uses only cp/find, no rsync, so it runs identically in Git Bash
# on the authoring machine and on the Ubuntu host.
#
# Routing:
#   config/            -> pack/config/          (shared; a client mod's config is simply
#                                                never read by the server)
#   config/e4mc/       -> overlays/client/      (client-only tunnel; meaningless on a
#                                                dedicated server and actively confusing)
#   config/servercore/ -> overlays/server/      (server-only)
#   kubejs/            -> pack/kubejs/
#   defaultconfigs/    -> pack/defaultconfigs/
#   datapacks/         -> pack/datapacks/
#   options.txt        -> overlays/client/      (default client settings for new installs)
#
# Deliberately NOT imported:
#   shaderpacks/   Complementary's license restricts redistribution, and shader choice is
#                  a user preference. Documented in docs/client-setup.md instead.
#   *.bak          editor/mod backup files
#   logs, cache, crash-reports, local, .connector, saves — runtime state

set -euo pipefail

SRC="${1:-}"
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  echo "usage: $0 <instance-dir>" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "importing configs from: $SRC"

# Replace DEST wholesale with SRC, so files deleted upstream disappear here too.
sync_dir() {
  local src="$1" dest="$2"
  [[ -d "$src" ]] || return 0
  rm -rf "$dest"
  mkdir -p "$dest"
  # The trailing /. copies contents rather than nesting the directory.
  cp -a "$src/." "$dest/"
}

# Strip files that should never be tracked, wherever they landed.
prune() {
  local root="$1"
  [[ -d "$root" ]] || return 0

  find "$root" -type f \( -name '*.bak' -o -name '.DS_Store' -o -name 'Thumbs.db' \) -delete 2>/dev/null || true

  # Native libraries that mods extract at runtime. These are platform-specific — the
  # Windows .dll from the authoring machine is useless (and misleading) on the Linux
  # server, and every mod that ships one re-extracts it on first launch.
  find "$root" -type f \( -name '*.dll' -o -name '*.so' -o -name '*.dylib' -o -name '*.exe' \) -delete 2>/dev/null || true

  # Generated snapshots that churn on every pack change and are rebuilt on launch.
  rm -f "$root/crash_assistant/modlist.json" 2>/dev/null || true

  # Jars have no business in the config tree, and .gitignore's blanket *.jar rule
  # would keep them out of the repo anyway — leaving them on disk means the mirror
  # published from a dev machine differs from one published from a fresh clone.
  # (The observed case was a Maven -sources.jar dropped into config/originpacks.)
  find "$root" -type f -name '*.jar' -delete 2>/dev/null || true

  # `local/` directories hold per-world, per-player state — JEI bookmarks and search
  # history, keyed by world name. Not pack content, and .gitignore excludes them, so
  # anything left here is drift between this machine and a fresh clone.
  find "$root" -type d -name 'local' -prune -exec rm -rf {} + 2>/dev/null || true

  # NeoForge's rejected-config artifacts. When a hand-edit fails validation it writes
  # the bad candidate to `<name>-N.toml`, keeps a `<name>-N.toml.bak`, and reverts the
  # live file. The `.bak` half is already gone above; the candidate looks like an
  # ordinary config and is not.
  #
  # Tracking one is worse than useless: it is by definition malformed (the observed
  # case, createhorsepower-server-4.toml, had an unterminated string) and it sits
  # beside the real file doing nothing. Only remove `<base>-N.toml` when `<base>.toml`
  # exists, so a mod that legitimately numbers its configs is left alone.
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    base="${candidate%-*}.toml"
    if [[ -f "$base" ]]; then
      echo "  dropping rejected config: ${candidate#"$root"/} (superseded by ${base#"$root"/})"
      rm -f "$candidate"
    fi
  done < <(find "$root" -type f -regex '.*-[0-9]+\.toml' 2>/dev/null || true)

  find "$root" -depth -type d -empty -delete 2>/dev/null || true
}

# Rewrite CRLF to LF in text files.
#
# Not cosmetic. .gitattributes normalises these to LF on commit, so a CRLF working
# tree and its own committed blob are different bytes — and build-index.ts hashes the
# working tree. The result is an index.toml pinning hashes no other checkout will ever
# reproduce, and every install dies with "Hash invalid!". That happened once, across
# 217 files, and cost an evening.
#
# validate-pack.ts already detects the drift, but detecting it leaves an obscure
# manual repair (delete the tree, re-materialise it with `git checkout-index -f`,
# rebuild). Importing correct bytes in the first place is the cheaper half.
#
# `grep -Il ''` is the binary guard: it lists only files with no NUL bytes, so .png,
# .nbt and .dat pass through untouched. A stray CR inside a binary would corrupt it.
#
# The `-U` on the CR test is load-bearing on Windows and easy to lose. Git Bash's grep
# opens files in text mode and strips CR *before* matching, so plain `grep -q $'\r'`
# reports "no CR" on a file that is entirely CRLF — silently turning this whole
# function into a no-op on the one platform that needs it. `-U` is a no-op on Linux.
normalize_eol() {
  local root="$1" n=0
  [[ -d "$root" ]] || return 0

  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if grep -qU $'\r' "$f" 2>/dev/null; then
      # tr, not `sed -i 's/\r$//'`: MSYS sed has the same text-mode behaviour as grep,
      # and a lone CR mid-line would survive it anyway.
      tr -d '\r' < "$f" > "$f.eoltmp" && mv -f "$f.eoltmp" "$f"
      n=$((n + 1))
    fi
  done < <(find "$root" -type f -exec grep -Il '' {} + 2>/dev/null || true)

  [[ "$n" -gt 0 ]] && echo "  normalised line endings: $n file(s) in ${root}"
  return 0
}

# --- shared config -------------------------------------------------------
sync_dir "$SRC/config" pack/config
# These two are side-specific and are re-homed into overlays below.
rm -rf pack/config/e4mc pack/config/servercore
prune pack/config

# --- side-specific overlays ---------------------------------------------
sync_dir "$SRC/config/e4mc" overlays/client/config/e4mc
sync_dir "$SRC/config/servercore" overlays/server/config/servercore

# --- scripts and data ----------------------------------------------------
for dir in kubejs defaultconfigs datapacks; do
  sync_dir "$SRC/$dir" "pack/$dir"
  prune "pack/$dir"
done

# --- client defaults -----------------------------------------------------
if [[ -f "$SRC/options.txt" ]]; then
  mkdir -p overlays/client
  cp "$SRC/options.txt" overlays/client/options.txt
fi

# Run once over everything this script wrote, rather than per-directory, so nothing
# copied in above can slip through with CRLF.
for tree in pack/config pack/kubejs pack/defaultconfigs pack/datapacks overlays; do
  normalize_eol "$tree"
done

count() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }

echo
echo "pack/config:        $(count pack/config) files"
echo "pack/kubejs:        $(count pack/kubejs) files"
echo "pack/datapacks:     $(count pack/datapacks) files"
echo "overlays/client:    $(count overlays/client) files"
echo "overlays/server:    $(count overlays/server) files"
echo
echo "next: node tools/build-index.ts"
