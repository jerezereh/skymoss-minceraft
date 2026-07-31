# Client setup

## Install

1. Install [Prism Launcher](https://prismlauncher.org/) (or the Modrinth App).
2. Download `Skymoss-<version>.mrpack` from the
   [latest release](https://github.com/jerezereh/skymoss-minceraft/releases).
3. Prism: **Add Instance → Import → Browse** → pick the `.mrpack`.
4. Launch. First run downloads ~400 MB of mods.

The `.mrpack` contains no jars — it is a manifest. Every mod is downloaded and checked
against a pinned hash at install time.

## Requirements

| | |
|---|---|
| Minecraft | 1.21.1 |
| Loader | NeoForge 21.1.241 |
| Java | 21 (Prism installs this automatically) |
| RAM | 6 GB minimum, 8 GB recommended |

Set the heap in Prism under **Edit Instance → Settings → Memory**. Do not exceed
about half your system RAM — more is not better; oversized heaps make GC pauses worse.

## Shaders

Shaders are **not** shipped with the pack. Complementary's license restricts
redistribution, and shader choice is personal.

Iris is already installed, so to add shaders yourself:

1. Download a pack — [Complementary Reimagined](https://www.complementary.dev/) is
   what the server has been using.
2. Drop the `.zip` into the instance's `shaderpacks/` folder.
3. In game: **Options → Video Settings → Shader Packs**.

Distant Horizons is included and works alongside Iris, but the combination is
demanding. Turn one off first if you're chasing frames.

## Connecting

The server address depends on which ingress is set up — ask in Discord. `e4mc` is no
longer how this works: it was for LAN-hosted worlds, and the server is now dedicated.

## Updating

When a new release is out, re-import the new `.mrpack` in Prism. Your options,
keybinds, and shaders live in the instance folder and survive an update.

Worth knowing: `options.txt` ships as a *default* for fresh installs only. An existing
instance keeps your settings.

## Troubleshooting

**Out of memory / crash on load** — raise the heap to 8 GB.

**Crash mentioning a specific mod** — open an issue with the crash report from
`crash-reports/`. Right-click the instance → **Folder** to find it. It'll appear in
Discord too, so you can follow up there.

**Mods fail to download** — a URL may have gone dead upstream. Report it; the fix is
re-pointing that mod at the mirror.

**Poor performance** — lower Distant Horizons render distance first; it's usually the
most expensive setting in the pack.
