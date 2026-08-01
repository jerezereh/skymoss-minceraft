# Custom fixes

Three small mods written for this pack to fix bugs in mods we depend on. They exist
nowhere upstream — no Modrinth project, no CurseForge page — so this directory is
their canonical source.

| Directory | Mod ID | License | Fixes |
|---|---|---|---|
| `kp-enchant-fix/` | `kp_enchant_fix` | CC0-1.0 | Loyalty/Multishot/Piercing not applying to Farmer's Delight knives |
| `kp-slot-fix/` | `kp_slot_fix` | CC0-1.0 | Thrown knives returning to the wrong inventory slot |
| `vpsunshade/` | `vpsunshade` | MIT | Vampirism vampires burning under a Sable / Create Aeronautics vessel roof |

The built jars are published as GitHub release assets (currently `custom-fixes-v1`)
and referenced from `pack/mods/*.pw.toml` with a pinned sha512.

## Why the source lives here

These are only useful to this pack, so a separate repository would be one more thing
to clone and keep in sync with its only consumer. Keeping them beside
`pack/mods/*.pw.toml` — which references the jars they build into — means "what is
`vpsunshade` and why do we have it" is answered one directory over.

For a while these existed *only* as compiled jars in a release. That was a real risk:
a 5 KB jar with no source is unmaintainable the moment you need to change it, and
irreplaceable if the release is lost.

## Building

### kp-enchant-fix — no build required

Pure data. It contains no code at all: `modLoader = "lowcodefml"` with
`showAsDataPack = true`, overriding three vanilla enchantment definitions so knives
are legal targets. The jar is simply a zip of this directory:

```bash
cd fixes/kp-enchant-fix
zip -r ../../kp-enchant-fix.jar . -x '.*'
```

Read its `README.md` first — it explains why v2 overrides the three enchantment
definitions instead of merging tags, and what that deliberately does *not* change.

> Because it replaces the vanilla enchantment files outright rather than merging,
> it is a frozen copy of their 1.21.1 definitions and must be re-synced by hand if
> the pack moves to a newer Minecraft version.

### kp-slot-fix and vpsunshade — Gradle

Standard NeoForge projects with wrappers committed, so no Gradle install is needed:

```bash
cd fixes/kp-slot-fix    # or fixes/vpsunshade
./gradlew build
ls build/libs/
```

Requires JDK 21. First build downloads the NeoForge toolchain and takes a while.

| | Minecraft | NeoForge |
|---|---|---|
| `kp-slot-fix` | 1.21.1 | 21.1.172 |
| `vpsunshade` | 1.21.1 | 21.1.241 |

## Adding a new fix

Create a directory under `fixes/` and CI picks it up — there is nothing to register.
The build type is inferred from what's inside:

| Directory contains | Treated as | Output name |
|---|---|---|
| `gradlew` | Gradle project | whatever Gradle produces in `build/libs/` |
| `pack.mcmeta` (no `gradlew`) | data-only mod | `<directory>.jar` |
| neither | **build fails** | — |

That last row is deliberate. A directory CI doesn't understand is an error, not a
skip: silently not building a fix is how you end up chasing a bug that was supposedly
already fixed.

Data-only jars take the directory name, with no override. If you want a different
filename, rename the directory — an override would only ever be used to keep a name
inconsistent with everything around it. (Gradle projects name their own output, so
there is nothing to reconcile there.)

For a Gradle fix, copying one of the existing projects is the quickest start; both are
minimal NeoForge setups with the wrapper committed.

Once it builds, add its `pack/mods/<name>.pw.toml` pointing at the release asset with
the sha512 from the CI summary, then `node tools/build-index.ts`.

## CI

`.github/workflows/custom-fixes.yml` builds every directory under `fixes/`:

- **on a PR touching `fixes/`** — builds every fix to catch breakage before merge
- **on a `custom-fixes-*` tag** — builds and attaches the jars to that release, so
  published artifacts come from a reproducible build rather than someone's laptop
- **manually** via workflow_dispatch, which uploads them as run artifacts

The run summary prints each jar's **sha512**, which is what you paste into the
metafile — no need to compute it by hand.

## Publishing a change

packwiz pins a hash per mod — that's its integrity model, and it's why a corrupted or
substituted jar fails cleanly instead of producing a subtly broken world. For the
other 241 mods this is invisible: `packwiz modrinth install` fills it in from the API.
The only reason it needs handling here is that we host these three ourselves.

GitHub publishes a **sha256 digest for every release asset**, so the value already
exists the moment a release is created. `sync-fix-hashes` reads it straight from the
API:

1. **Branch, change the source, open a PR.** CI builds every fix, so breakage is
   caught before merge.

2. **Merge and tag** — CI builds and publishes the jars:
   ```bash
   git tag custom-fixes-v2 && git push origin custom-fixes-v2
   ```

3. **Point the pack at the new release:**
   ```bash
   node tools/sync-fix-hashes.ts --tag custom-fixes-v2
   node tools/build-index.ts && node tools/validate-pack.ts
   ```
   That rewrites `filename`, `url`, and `hash` in each matching metafile from the
   published artifact, and leaves anything already correct alone. Commit the result.

No copying hashes out of build logs, and nothing to keep in step by hand: the digest
describes the exact bytes GitHub is serving, so the manifest is correct by
construction rather than by discipline.

`--check` reports drift without writing, if you want it as a CI or pre-commit guard.

> Only mods whose jar actually changed get rewritten. An untouched fix keeps pointing
> at whichever release it came from, so there's no churn from unrelated rebuilds.

**The tag must not start with `v`** — `release.yml` triggers on `v*` and would build a
pack release into the same tag. See `docs/pack-workflow.md`.

## Sides

All three are `side = "both"` in the manifest, verified rather than assumed: none
contains client code, but packwiz's `server` excludes the client entirely, and the
client's integrated server needs them for singleplayer and LAN. They total 17 KB.
