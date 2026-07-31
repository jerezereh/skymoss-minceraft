#!/usr/bin/env bash
# sync-mirror — populate the Skymoss mod mirror from a directory of jars.
#
#   ./tools/sync-mirror.sh <jar-dir> [mirror-root]
#   ./tools/sync-mirror.sh --manifest-only [mirror-root]
#
# Two distinct jobs, which is why there are two modes:
#
#   --manifest-only   Publish just the pack manifest (pack.toml, index.toml, the
#                     metafiles, configs). This is all the SERVER needs to install
#                     the pack, because every metafile currently points at Modrinth
#                     or a GitHub release for its jar — nothing resolves to the
#                     mirror. Use this to bootstrap; it needs no jars on the host.
#
#   <jar-dir>         Additionally publish the jars themselves, so the pack keeps
#                     installing if a mod is deleted or delisted upstream. This is
#                     resilience, not a requirement.
#
# Every jar is verified against the hash recorded in its .pw.toml before publishing,
# so a corrupted or substituted file cannot reach the mirror unnoticed.
#
# Run on the Ubuntu host, or locally then copy the tree up.

set -euo pipefail

MANIFEST_ONLY=0
if [[ "${1:-}" == "--manifest-only" ]]; then
  MANIFEST_ONLY=1
  JAR_DIR=""
  MIRROR_ROOT="${2:-/srv/mirror}"
else
  JAR_DIR="${1:-}"
  MIRROR_ROOT="${2:-/srv/mirror}"

  if [[ -z "$JAR_DIR" || ! -d "$JAR_DIR" ]]; then
    echo "usage: $0 <jar-dir> [mirror-root]" >&2
    echo "       $0 --manifest-only [mirror-root]" >&2
    exit 1
  fi
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="$REPO/pack"

mkdir -p "$MIRROR_ROOT/mods" "$MIRROR_ROOT/pack"

published=0
skipped=0
mismatched=0
missing=0
seen=0

# Pull a top-level `key = "value"` out of a .pw.toml. Uses sed rather than `grep -oP`
# because PCRE mode is unavailable under some locales (notably Git Bash on Windows),
# where it fails per-call and would otherwise leave every field silently empty.
toml_get() {
  sed -n "s/^$2 = \"\(.*\)\"$/\1/p" "$1" | head -1
}

# Walk the manifest rather than the jar directory, so the mirror mirrors the pack
# and not whatever happens to be sitting in the folder.
while IFS= read -r meta; do
  if (( MANIFEST_ONLY )); then
    seen=$((seen + 1))
    continue
  fi

  filename="$(toml_get "$meta" filename)"
  want_hash="$(toml_get "$meta" hash)"
  hash_fmt="$(toml_get "$meta" hash-format)"

  if [[ -z "$filename" ]]; then
    echo "UNPARSEABLE $meta" >&2
    mismatched=$((mismatched + 1))
    continue
  fi
  seen=$((seen + 1))

  src="$JAR_DIR/$filename"
  if [[ ! -f "$src" ]]; then
    echo "MISSING  $filename"
    missing=$((missing + 1))
    continue
  fi

  case "$hash_fmt" in
    sha512) got="$(sha512sum "$src" | cut -d' ' -f1)" ;;
    sha256) got="$(sha256sum "$src" | cut -d' ' -f1)" ;;
    sha1)   got="$(sha1sum   "$src" | cut -d' ' -f1)" ;;
    *)      echo "SKIP     $filename (unsupported hash-format '$hash_fmt')"; skipped=$((skipped + 1)); continue ;;
  esac

  if [[ "$got" != "$want_hash" ]]; then
    echo "MISMATCH $filename"
    echo "         manifest: $want_hash"
    echo "         actual:   $got"
    mismatched=$((mismatched + 1))
    continue
  fi

  dest="$MIRROR_ROOT/mods/$filename"
  if [[ -f "$dest" ]]; then
    skipped=$((skipped + 1))
  else
    cp "$src" "$dest"
    published=$((published + 1))
  fi
done < <(find "$PACK_DIR/mods" -name '*.pw.toml' | sort)

# Publish the manifest itself so PACKWIZ_URL can point at the mirror.
cp "$PACK_DIR/pack.toml" "$PACK_DIR/index.toml" "$MIRROR_ROOT/pack/"
mkdir -p "$MIRROR_ROOT/pack/mods"
cp "$PACK_DIR"/mods/*.pw.toml "$MIRROR_ROOT/pack/mods/"
for d in config kubejs defaultconfigs datapacks; do
  [[ -d "$PACK_DIR/$d" ]] || continue
  rm -rf "${MIRROR_ROOT:?}/pack/$d"
  cp -a "$PACK_DIR/$d" "$MIRROR_ROOT/pack/$d"
done

echo
echo "manifest entries: $seen"
if (( MANIFEST_ONLY )); then
  echo "mode: manifest-only (no jars published)"
else
  echo "published: $published   already present: $skipped"
  echo "mismatched: $mismatched   missing: $missing"
fi

# A run that matched nothing means the manifest was unreadable or empty. Reporting
# "OK" there would be worse than failing: it looks like a healthy mirror while the
# mirror is in fact empty.
if (( seen == 0 )); then
  echo
  echo "no manifest entries parsed from $PACK_DIR/mods — refusing to report success." >&2
  exit 1
fi

if (( mismatched > 0 || missing > 0 )); then
  echo
  echo "mirror is INCOMPLETE — the pack will not install cleanly." >&2
  exit 1
fi

if (( MANIFEST_ONLY )); then
  echo "manifest published at $MIRROR_ROOT/pack ($seen mods referenced)"
  echo "Jars resolve from upstream. Re-run with a jar directory to mirror them too."
else
  echo "mirror OK at $MIRROR_ROOT ($seen jars)"
fi
