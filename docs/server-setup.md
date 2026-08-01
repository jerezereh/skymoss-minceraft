# Server setup

Standing up Skymoss on the Ubuntu host. Everything runs in one Docker Compose stack.

## What you need

- ~16 GB RAM (the server is configured for an 8 GB heap; the rest is headroom)
- Ubuntu with sudo

A domain is **not** required. Nothing in the stack needs public HTTP ingress.

## 0. Prerequisites

A fresh Ubuntu box has none of this — Docker in particular is not preinstalled.

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/jerezereh/skymoss-minceraft.git /srv/skymoss-minceraft
cd /srv/skymoss-minceraft

./infra/bootstrap.sh              # report what's missing
./infra/bootstrap.sh --install    # install it
```

What it checks and why:

| | Needed for |
|---|---|
| **docker** + compose plugin | everything |
| **git** | cloning this repo |
| zstd | compressing ad-hoc archives (optional) |
| node | *only* to edit the pack on this host — you can do that on your desktop instead |

After installing Docker you must **log out and back in** before the `docker` command
works without sudo.

## 1. Configure

```bash
cd /srv/skymoss-minceraft/infra
cp .env.example .env
$EDITOR .env
```

Only three values are strictly required: `RCON_PASSWORD`, `CI_EVENT_SECRET`, and the
Discord/GitHub credentials if you want the bridge. Anything left empty either has a
working default or disables that feature cleanly. The stack refuses to start on a
missing *required* value rather than booting into a half-working state.

## 2. Publish the manifest

The server reads the pack manifest from the mirror, so that has to exist first.

```bash
sudo mkdir -p /srv/mirror && sudo chown "$USER" /srv/mirror
bash /srv/skymoss-minceraft/tools/sync-mirror.sh --manifest-only /srv/mirror
```

**You do not need the jars on this host.** Every metafile points at Modrinth (241) or
a GitHub release (3), so the server downloads mods from upstream and only reads the
manifest locally. That's ~2 MB of TOML instead of a 400 MB transfer.

`PACKWIZ_URL` defaults to `http://mirror/pack/pack.toml` over the internal compose
network — no domain, no public hostname.

### Later: archive the jars too (recommended)

The mirror is an **archive**, not a distribution path. Metafiles keep pointing at
Modrinth — this is what you repoint them *to* when a mod is deleted or delisted
upstream. Mods do vanish: authors remove old versions, projects go private, and a
pack that resolves entirely from other people's CDNs is one takedown away from being
uninstallable. Three of these mods already exist nowhere but our own release.

Fetch them on the server, so nothing has to be shipped from a workstation:

```bash
sudo mkdir -p /srv/skymoss-jars && sudo chown "$USER" /srv/skymoss-jars
node tools/fetch-jars.ts --out /srv/skymoss-jars
bash tools/sync-mirror.sh /srv/skymoss-jars /srv/mirror
```

`fetch-jars` verifies every download against the manifest hash and refuses to write a
file that fails — an archive you cannot trust is worse than none, because you only
find out when upstream is already gone. It is re-runnable: verified files are skipped,
so an interrupted run resumes. `sync-mirror` then re-verifies before publishing.

Roughly 400 MB downloaded and a few minutes. Budget **~800 MB of disk**, though:
`sync-mirror` copies rather than links, so the jars end up in both
`/srv/skymoss-jars` and `/srv/mirror/mods`. That is deliberate — the archive stays
intact if the mirror is ever wiped and rebuilt.

`node` is optional on this host (see `bootstrap.sh`), and running a `.ts` file
directly needs **Node ≥ 22.18**, where type stripping is on by default. On an older
Node add `--experimental-strip-types`; with no Node at all, use a container instead:

```bash
docker run --rm --network bridge \
  -v "$PWD:/work" -v /srv/skymoss-jars:/out -w /work \
  node:24-slim node tools/fetch-jars.ts --out /out
sudo chown -R "$USER" /srv/skymoss-jars
```

Nothing else changes: the pack still installs from upstream, and this only matters on
the day something disappears.

**When a mod does vanish**, repoint just that metafile:

```toml
[download]
url = "http://mirror/mods/the-mod-1.2.3.jar"
```

The hash already in the file is what proves the mirrored copy is the same bytes the
pack was built and tested against.

### The three orphan jars

`KPEnchantFix`, `kp_slot_fix`, and `vpsunshade` are bespoke builds that exist nowhere
upstream. They're served from a **GitHub release** rather than the mirror — they're
your own code, not redistributed third-party mods, so the licensing reason that keeps
the other 241 jars out of the repo doesn't apply. A release asset is a stable, free,
backed-up URL that needs no domain.

Create that release once (17 KB total):

```bash
cd /path/to/the/jars
gh release create custom-fixes-v1 \
  KPEnchantFix-neoforge-mod.jar kp_slot_fix-1.0.0.jar vpsunshade-1.0.0.jar \
  --title "Custom fixes v1" \
  --notes "Bespoke jars with no upstream source. Referenced by pack/mods/*.pw.toml."
```

Until it exists, `node tools/check-urls.ts` will report those three as unreachable and
the pack will not install.

## 3. Optional: Cloudflare tunnel

**Skip this if you don't own a domain** — named tunnel hostnames require a Cloudflare
zone, and quick-tunnel URLs change on every restart. Nothing in the stack needs public
ingress: the server reads the manifest over the internal network, and the bridge polls
GitHub rather than receiving webhooks.

If you do have a domain:

| Hostname | Service |
|---|---|
| `mirror.yourdomain.com` | `http://mirror:80` |
| `bridge.yourdomain.com` | `http://bridge:3000` |

Set `CLOUDFLARE_TUNNEL_TOKEN`, then start it explicitly — it's behind a profile:

```bash
docker compose --profile tunnel up -d
```

Minecraft is **not** proxied through the tunnel; see "Player ingress" below.

## 4. Start

```bash
docker compose up -d
docker compose logs -f mc
```

First boot downloads ~400 MB of mods and builds the mod cache, which takes a while.
The healthcheck has a 10-minute grace period for exactly this reason; don't panic if
the container reports unhealthy before then.

## 5. Migrate the world

```bash
docker compose stop mc
WORLD_VOL=$(docker volume inspect skymoss_mc-data --format '{{ .Mountpoint }}')
cp -a /path/to/Skymoss/saves/FlyMoss "$WORLD_VOL/FlyMoss"
chown -R 1000:1000 "$WORLD_VOL/FlyMoss"
docker compose start mc
```

> **Copy `sublevels/` intact.** It holds the Valkyrien Skies / Create Aeronautics ship
> data. Losing it deletes every ship in the world.

## Player ingress

`e4mc` does **not** work here. It is built for LAN-opened singleplayer worlds and has
no dedicated-server mode — it is in the pack as a `client`-side mod and is simply
unused on the server.

### Cloudflare Tunnel cannot carry Minecraft

Worth stating plainly, because it's a natural assumption once a tunnel is running:
Minecraft Java is **raw TCP on 25565, not HTTP**. Cloudflare Tunnel routes HTTP/HTTPS.
Arbitrary TCP is Cloudflare **Spectrum**, an Enterprise-tier product.

The usual workaround has every player run `cloudflared access tcp` locally — which
means every player installs software before they can join.

The tunnel is still the right tool for the mirror and the bridge. It just can't carry
players.

### Port forward + DuckDNS (what this stack uses)

This host has a **routable WAN address, not CGNAT** — confirmed from playit's own
`client_addr` report. So the simplest path works: forward the port, give it a name.

**1. Get a free hostname.** Sign in at <https://www.duckdns.org>, create a subdomain,
and copy the token from the top of the page. Put both in `infra/.env`:

```
DUCKDNS_SUBDOMAIN=skymoss
DUCKDNS_TOKEN=<token>
```

The `duckdns` service keeps it pointed at your current WAN address, so a change from
your ISP doesn't strand players.

**2. Forward the port on your router.** Exactly one rule:

| | |
|---|---|
| Protocol | **TCP** |
| External port | 25565 |
| Internal IP | this server's LAN address (`ip -4 addr show` / `hostname -I`) |
| Internal port | 25565 |

Give the server a **DHCP reservation** or static LAN IP while you're in there —
otherwise the forward breaks the next time its address changes.

**3. Verify from outside your network.** A test from inside can succeed via LAN and
tell you nothing about whether the forward works:

```bash
docker run --rm itzg/mc-monitor status --host skymoss.duckdns.org --port 25565
```

Run it from a phone hotspot or another machine off your network.

Players connect to `skymoss.duckdns.org`. No port needed — 25565 is the default.

### What forwarding a port actually exposes

Worth being precise, because "it's just one port" undersells it.

The NAT rule is narrow — TCP 25565 to one host, one port. Nobody reaches your NAS,
your router admin page, or any other machine through it. But what sits behind that
port is a **Java application running 200+ third-party mods**, now reachable by anyone
on the internet.

**The whitelist does not gate the attack surface.** It blocks *joining*. The TCP
handshake, protocol negotiation, and login-start packets are all parsed **before**
that check, so any parsing bug in Minecraft or in a mod is reachable pre-auth by a
stranger. Log4Shell is the well-known example; mod-specific RCEs have happened too.

Also true, and unavoidable with this approach:

- **You will be scanned.** Shodan and Censys sweep 25565 continuously; expect bot
  probes within hours of opening it.
- **A compromise lands inside your LAN.** A container is isolation, not a security
  boundary.
- **DDoS takes out your household**, not just the server.
- **Your home IP is public** to anyone who joins.

A relay like playit hides your IP and absorbs DDoS, but **does not shrink the attack
surface** — anyone with the address still reaches the same server. Only restricting
*who can reach the port at all* (Tailscale, or an IP allowlist) does that.

### What the stack does about it

- `online-mode=true` — Mojang authentication required; cracked clients can't connect
- `white-list=true` + `enforce-whitelist=true` — only listed accounts join
- The server process runs as UID 1000, not root
- `no-new-privileges` on every container
- **Network segmentation** — `mc` sits on `game` and `packnet` only. It has no route
  to `duckdns`, so a compromised game server cannot reach the DuckDNS token and
  repoint your hostname. `mirror` is on an `internal` network with no egress at all.
- `pids_limit` caps fork bombs from an exploited mod
- The bridge drops all capabilities; its endpoints are HMAC- or bearer-authenticated

`mc` and `bridge` still share `game`, because the bridge initiates RCON to the server
and Docker networks are bidirectional. That's why every bridge endpoint requires a
signature or token rather than trusting the network.

### Keeping it that way

- **Update mods.** Most of your risk is third-party code. `node tools/check-urls.ts`
  and `packwiz update` surface what's stale.
- **Keep the whitelist tight.** Remove people who've stopped playing.
- **Watch for oddities** — repeated connections from unknown IPs in the log are worth
  a look. This is what the log-to-issues automation is for.
- **Don't reuse `RCON_PASSWORD`** anywhere else; RCON is a full console.

### playit.gg (fallback, only if you end up behind CGNAT)

Only needed if your ISP puts you behind CGNAT, where port forwarding is impossible.
Check by comparing `curl -s ifconfig.me` against your router's WAN address — if they
differ, or the WAN address is in `100.64.0.0/10`, you're behind CGNAT.

Not started by default:

```bash
docker compose --profile playit up -d
```

**Generate the secret first.** The Docker agent has no interactive claim flow — that's
the native binary's behaviour, not the container's. Get a key at
<https://playit.gg/account/setup/wizard/new-account/docker/docker-name>, put it in
`PLAYIT_SECRET_KEY`, then create a **Minecraft Java** tunnel in the dashboard pointing
at `127.0.0.1:25565`.

Two traps, both hit during setup here:

- **An empty `PLAYIT_SECRET_KEY` is not "unclaimed."** The agent reads it as a bad
  credential, exits, and the container crash-loops.
- **1.0.10 and `:latest` are broken on IPv4-only hosts.** The agent selects an IPv6
  tunnel server, gets `NetworkUnreachable`, and never falls back
  ([upstream #194](https://github.com/playit-cloud/playit-agent/issues/194), open).
  The control session flaps with `SessionNotSetup`, so the relay accepts players and
  immediately resets them — while the dashboard shows the tunnel happily online.
  `PLAYIT_AGENT_VERSION=1.0.8` (or `1.0.7`) predates that code. Never drop to 0.x;
  that line cannot authenticate at all.

You'll get an address like `skymoss.at.ply.gg:7261`. That's what players enter —
pin it in Discord. A custom domain is a paid feature; the free address is stable.

### Alternatives

| Option | Notes |
|---|---|
| **Port forward + DuckDNS** | Free, lowest latency, no third party. Needs router access, and impossible behind CGNAT. Publishes your home IP to everyone who joins. |
| **Tailscale** | Most private, but every player installs Tailscale. |

## Self-hosted runner (optional)

`mirror-sync.yml` runs on a self-hosted runner, because GitHub-hosted runners can't
reach your mirror. To enable it, install a runner on this host with the label
`skymoss`:

```
Settings → Actions → Runners → New self-hosted runner
```

Until that exists, run `tools/sync-mirror.sh` by hand after pack changes.

## Backups

Set up `restic` for frequent backups, and use the snapshot script for milestone
Backups run hourly with restic to Cloudflare R2 — deduplicated, encrypted, offsite,
and skipped when nobody is online. Setup and restore steps are in
[monitoring.md](monitoring.md#backups--restic-to-cloudflare-r2).

```bash
docker compose -f infra/docker-compose.yml logs mc-backup | tail -20
```

## Troubleshooting

**`open /var/lib/snapd/void/…: no such file or directory`** — Docker is installed as a
**snap**. Snap confinement blocks access to paths outside `$HOME`, so it cannot read
the compose file or bind-mount anything under `/srv`; `/var/lib/snapd/void` is the
placeholder directory it falls back to. The file exists, it just isn't visible.

`sudo snap install docker` is what most search results suggest, so this is easy to hit.
Replace it with Docker Engine proper:

```bash
sudo snap remove docker          # deletes containers/volumes the snap managed
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# log out and back in, then:
docker compose -f infra/docker-compose.yml up -d
```

`./infra/bootstrap.sh` detects this case and refuses to treat the snap as usable.

**Server exits immediately** — check `docker compose logs mc` for a missing-mod error.
Usually the mirror is incomplete; re-run `sync-mirror.sh` and read its summary.

**Players kicked for flying** — `allow-flight` must be `true`. Riding a VS2 ship reads
as flight to vanilla anticheat.

**Server freezes then dies under load** — confirm `max-tick-time=-1`. The default
watchdog kills the server mid-tick during heavy chunk generation, which risks
corrupting the world.

**Pack won't install** — run `node tools/check-urls.ts` to find dead download URLs.
