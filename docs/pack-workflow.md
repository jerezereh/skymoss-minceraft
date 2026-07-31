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

Three mods exist nowhere upstream — they're bespoke fixes for bugs in the current pack:

| File | License | What it fixes |
|---|---|---|
| `KPEnchantFix-neoforge-mod.jar` | CC0-1.0 | Loyalty/Multishot/Piercing not applying to Farmer's Delight knives |
| `kp_slot_fix-1.0.0.jar` | CC0-1.0 | Thrown knives returning to the wrong inventory slot |
| `vpsunshade-1.0.0.jar` | MIT | Vampirism vampires burning under a Sable/Create Aeronautics vessel roof |

### Hosting

They're served from the **`custom-fixes-v1` GitHub release** on this repo, not the
mirror. That's deliberate:

- All three are our own work under CC0/MIT, so redistribution is explicitly fine —
  unlike the 241 upstream mods, which is why those stay out of the repo.
- A release asset is a stable, permanent URL requiring no domain and no mirror uptime.
- GitHub backs it up, which matters more here than anywhere else in the pack: **these
  three exist nowhere else on earth.** Lose them and the pack cannot be installed.

Create the release once:

```bash
gh release create custom-fixes-v1 \
  KPEnchantFix-neoforge-mod.jar kp_slot_fix-1.0.0.jar vpsunshade-1.0.0.jar \
  --title "Custom fixes v1" \
  --notes "Bespoke fixes with no upstream source. Referenced by pack/mods/*.pw.toml."
```

**The tag must not start with `v`.** `release.yml` triggers on `push: tags: ['v*']`, so
a tag like `v1.0.0` fires the pack release workflow and dumps a `.mrpack` and server
tarball into the same release as these jars. Keep custom-fix releases on
`custom-fixes-*`; `v*` belongs to pack releases.

If you ever rebuild one, publish it under a **new tag** (`custom-fixes-v2`) rather than
replacing the asset — the hash in the metafile pins the exact bytes, so overwriting an
asset in place breaks installs with a hash mismatch.

Renaming or deleting the tag has the same effect: every URL 404s, packwiz aborts, and
the server crash-loops on startup with no obvious pointer to the cause.

### Why all three are `side = "both"`

None of them contain client code — verified by inspecting the jars, not assumed:

- **KPEnchantFix** has no classes at all; it's `lowcodefml` / `showAsDataPack`, pure
  `data/` overrides.
- **kp_slot_fix** hooks `EntityJoinLevelEvent` and rewrites an `Inventory` slot, with
  zero `net/minecraft/client` references.
- **vpsunshade** calls `net.minecraft.server.level.ServerPlayer` directly.

So all three are server-side *logic*. They're still `both` because packwiz's `server`
means **dedicated server only** — it excludes the client, and the client's integrated
server needs these for singleplayer and LAN worlds. They're 17 KB combined and inert
on a multiplayer client, so `both` costs nothing and avoids a mod-list mismatch.

### Keep the source

Only compiled jars exist for two of them. If whoever wrote them still has the source,
get it into a repo — a 6 KB jar with no source is one lost laptop away from being
unmaintainable. `KPEnchantFix` is the exception: it's pure JSON, so the jar *is* the
source.

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
