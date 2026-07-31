# Working on the pack

The pack is defined entirely by `pack/` — 244 small TOML files, no jars. Everything
here is about keeping that manifest true.

## The golden rule

**Never hand-edit `pack/index.toml`.** It is generated, and its hashes must match the
files on disk. Regenerate it instead:

```bash
node tools/build-index.ts
```

CI fails the build if the index is stale (`tools/build-index.ts --check`).

## Adding or updating a mod

With packwiz installed (`go install github.com/packwiz/packwiz@latest`):

```bash
cd pack
packwiz modrinth install sodium      # or: packwiz curseforge install <slug>
packwiz refresh
```

Without packwiz, hand-write `pack/mods/<slug>.pw.toml`:

```toml
name = "Some Mod"
filename = "somemod-1.2.3.jar"
side = "both"          # both | client | server

[download]
url = "https://cdn.modrinth.com/data/…/somemod-1.2.3.jar"
hash-format = "sha512"
hash = "…"
```

then `node tools/build-index.ts`.

Check your work before pushing:

```bash
node tools/validate-pack.ts    # side flags, hash lengths, missing URLs, duplicates
node tools/check-urls.ts       # every download URL still resolves
```

## Choosing `side`

`side` is what splits the client and server releases. It exists **only on mod
metafiles** — there is no `side` for plain config files in `index.toml`.

- `both` — the default, and the safe one. An unused mod on the wrong side is usually
  inert; a *missing* mod on the right side is a hard failure.
- `client` — the server must never load it (Sodium, Iris, Distant Horizons).
- `server` — the client must never load it.

When the importer resolved these from Modrinth it used the project's
`client_side`/`server_side` fields, which is more reliable than guessing from a
filename. Several mods that sound client-only — JEI, Distant Horizons, FerriteCore,
Veil — are genuinely `both`, because they ship real server-side components.

## Configs

Run this after changing configs in-game to bring them back under version control:

```bash
./tools/import-configs.sh /path/to/instance
node tools/build-index.ts
```

Most configs live in `pack/config/` and are shared. Only genuinely side-specific
files go in `overlays/client/` or `overlays/server/`, which CI layers onto the
matching artifact at release time.

The importer deliberately drops things that would otherwise rot in the repo: `*.bak`
files, native libraries mods extract at runtime (a Windows `.dll` is worse than
useless on the Linux server), and generated snapshots like
`crash_assistant/modlist.json`.

## Orphan mods

Three mods in this pack exist nowhere upstream — they are bespoke builds:

| File | What it is |
|---|---|
| `KPEnchantFix-neoforge-mod.jar` | Kitchen Projectiles enchantment fix |
| `kp_slot_fix-1.0.0.jar` | Kitchen Projectiles slot fix |
| `vpsunshade-1.0.0.jar` | Valkyrien Skies sublevel sunshade handler |

Their metafiles point at the mirror, and **the mirror is their only source**. If it is
lost and no copy exists, they are gone permanently and the pack cannot be installed
as-is. Make sure they are backed up somewhere off the server as well as on it.

Their `.pw.toml` files currently point at the placeholder host
`mirror.skymoss.example`; `validate-pack.ts` reports how many placeholders remain.
Replace it with your real mirror hostname before cutting a release.

## Releasing

```bash
git tag v0.2.0
git push origin v0.2.0
```

That builds the client `.mrpack` and the server tarball, publishes a GitHub release,
and posts to Discord. Take a world snapshot first — see the worlds repo README.

## Re-importing from scratch

If the manifest ever needs rebuilding from a folder of jars:

```bash
node tools/import-instance.ts --mods /path/to/mods --out pack/mods
node tools/build-index.ts
```

It hashes every jar, bulk-resolves them against Modrinth, falls back to CurseForge
fingerprints when `CURSEFORGE_API_KEY` is set, and reports anything it could not
resolve. On the original import 241 of 244 resolved from Modrinth alone.
