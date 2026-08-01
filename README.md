# Skymoss

A NeoForge **1.21.1** Minecraft modpack and the infrastructure that runs it.

This repo is the source of truth for the pack, the dedicated server config, the CI/CD that
builds releases, and the Discord ↔ GitHub bridge that keeps conversation in sync across both
surfaces.

---

## Where things live

| Path | What it is |
|---|---|
| `pack/` | **The pack itself**, as [packwiz](https://packwiz.infra.link/) metadata. This is the only definition of the mod set. |
| `overlays/client/` | Files layered onto the **client** artifact only |
| `overlays/server/` | Files layered onto the **server** artifact only |
| `server/` | Dedicated-server config that is *not* part of the pack (`server.properties`, ops, JVM args) |
| `bridge/` | The Discord ↔ GitHub relay service, plus server admin commands |
| `infra/` | The Ubuntu host as code — Docker Compose, Caddy, monitoring, backup scripts |
| `fixes/` | Source for the three custom mods written for this pack |
| `tools/` | Maintenance scripts (manifest import, side classification) |
| `docs/` | Longer-form documentation |

World saves are **not** in this repo. They are backed up hourly with restic to
Cloudflare R2 — deduplicated, encrypted, and offsite. See
[`docs/monitoring.md`](docs/monitoring.md#backups--restic-to-cloudflare-r2).

---

## No jars in this repo

The pack is distributed as **metadata, not binaries**. Every mod is one small `pack/mods/*.pw.toml`
file recording its name, download URL, `side`, and a hash. Jars are fetched at install time and
verified against that hash.

This is deliberate:

- Most mods are all-rights-reserved; this repo is public. Redistributing 423 MB of jars from it
  would not be OK.
- Diffs stay readable — a pack update shows up as a version bump in a text file, not a binary blob.
- Clones stay small.

`.gitignore` blocks `*.jar` repo-wide to keep this true by accident as well as by intent.

---

## Installing

### Client

Grab the `.mrpack` from the [latest release](https://github.com/jerezereh/skymoss-minceraft/releases)
and import it into [Prism Launcher](https://prismlauncher.org/) or the Modrinth App —
both read `.mrpack` natively. Full steps: [`docs/client-setup.md`](docs/client-setup.md).

### Server

See [`docs/server-setup.md`](docs/server-setup.md). Short version: the release tarball plus
`docker compose up` — the container installs the pack from the manifest on boot.

---

## Contributing

Non-technical? **Just talk in Discord.** Every GitHub issue has a matching Discord thread and
messages relay both ways, so you never need to touch GitHub to report a bug or ask for a mod.

Technical? Open an issue or PR here. It'll show up in Discord automatically.

Pack changes must go through `packwiz` rather than hand-editing `index.toml` — see
[`docs/pack-workflow.md`](docs/pack-workflow.md).
