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
zip -r ../../KPEnchantFix-neoforge-mod.jar . -x '.*'
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

## Publishing a rebuild

The manifest pins each jar by sha512, so **a rebuilt jar is a different file even if
the code is identical** — timestamps alone change the hash. Never replace an asset in
an existing release: every install would fail verification.

1. Build the new jar
2. Publish under a **new tag**: `gh release create custom-fixes-v2 ... --title "Custom fixes v2"`
3. Update that mod's `pack/mods/*.pw.toml` — both `url` and `hash`
4. `node tools/build-index.ts && node tools/validate-pack.ts`
5. `node tools/check-urls.ts` to confirm the new URL resolves

The tag must not start with `v` — `release.yml` triggers on `v*` and would build a
pack release into the same tag. See `docs/pack-workflow.md`.

## Sides

All three are `side = "both"` in the manifest, verified rather than assumed: none
contains client code, but packwiz's `server` excludes the client entirely, and the
client's integrated server needs them for singleplayer and LAN. They total 17 KB.
