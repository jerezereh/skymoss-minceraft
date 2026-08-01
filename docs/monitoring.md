# Monitoring and server control

Two pieces, both reusing infrastructure that already exists:

- **Uptime Kuma** watches things and alerts into Discord when they break.
- **Bot slash commands** give you a console and a restart button without leaving Discord.

## Why not a panel

Crafty and Pelican (the actively maintained Pterodactyl fork) are good software, but
both want to **own the server lifecycle and its files** — and that fights this setup.

Here, git is the source of truth: mods come from the packwiz manifest, configs from
`pack/config/`, and `OVERRIDE_SERVER_PROPERTIES=true` rewrites `server.properties`
from the repo on every boot. Edit a setting in a panel's web UI and it works right up
until the next restart silently reverts it. Neither panel would manage the
compose-defined `mc` service either; both replace it with a container they control.

Most of what a panel offers is already covered — file editing by git, backups by
restic, mod installs by the manifest, whitelist by the repo. What was
genuinely missing was resource graphs, downtime alerting, and a quick console. That's
what this covers.

If you later want a panel anyway, the change is: drop the `mc` service from compose,
set `OVERRIDE_SERVER_PROPERTIES=false`, and accept that server config drifts from git.

## Uptime Kuma

Comes up with the stack, bound to `127.0.0.1:3001` — it's an admin UI with no domain
in front of it, so it isn't exposed to the network. Reach it over SSH:

```bash
ssh -L 3001:localhost:3001 you@your-server
# then open http://localhost:3001
```

or over your tailnet if the box is on one. Create an admin account on first visit.

### Monitors worth adding

| Type | Target | Notes |
|---|---|---|
| **Minecraft server** | `mc:25565` | Kuma has a dedicated Minecraft monitor type — it reports player count too |
| TCP | `mc:25575` | RCON; if this is down, bot commands will fail |
| HTTP | `http://bridge:3000/health` | the bridge |
| HTTP | `http://mirror/pack/pack.toml` | the mirror — catches a broken pack before players do |

Use container names, not `localhost`: Kuma resolves them over the compose network.

### Alerts into Discord

Set up one notification and attach it to every monitor.

1. **Settings → Notifications → Setup Notification**
2. Type: **Webhook**
3. Post URL: `http://bridge:3000/alerts`
4. Content type: `application/json`
5. Additional headers:
   ```json
   { "Authorization": "Bearer YOUR_ALERT_TOKEN" }
   ```

`YOUR_ALERT_TOKEN` is `ALERT_TOKEN` from `infra/.env`. Generate one with
`openssl rand -hex 32`.

Alerts land in `#alerts` (`DISCORD_ALERT_CHANNEL_ID`), not `#ci`. Failed builds on
`main` go there too — the mirror publishes from `main`, so a broken manifest there
breaks every install, which is the same urgency class as the server being down.

Everything else — pull requests, passing builds, releases — stays in `#ci`.

The split is about Discord's notification settings being per-channel. One channel
means choosing between muting a 3am outage and being pinged for every pull request,
and the routine traffic is what trains you to ignore the alert. Turn notifications
on for `#alerts` and mute `#ci`.

If `DISCORD_ALERT_CHANNEL_ID` is unset, alerts fall back to `#ci` and behave as they
did before.

> `/alerts` uses a **bearer token**, not the HMAC signature that `/events` uses.
> That's not an oversight — Uptime Kuma can't compute a signature over its own body,
> so the token is the available option. Keep the endpoint on the internal network or
> behind the tunnel; don't expose it publicly.

Test it without waiting for an outage:

```bash
curl -X POST http://localhost:3000/alerts \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ALERT_TOKEN" \
  -d '{"monitor":{"name":"Skymoss"},"heartbeat":{"status":0,"msg":"test"}}'
```

## Slash commands

Registered against your guild at startup, so they appear immediately.

| Command | Who | What |
|---|---|---|
| `/status` | everyone | Is the server up, plus player list and TPS |
| `/players` | everyone | Who's online |
| `/restart` | admin | Save, warn, and restart |
| `/cmd <command>` | admin | Run any console command |

### Permissions

`/restart` and `/cmd` require the role in `ADMIN_ROLE_ID`.

**`/cmd` is a full RCON console.** It can `op`, `ban`, `deop`, and `stop` — anyone who
can run it effectively controls the server. It fails closed: with `ADMIN_ROLE_ID`
unset, nobody can use it, including you. Grant that role only to people you'd give SSH
access.

### How `/restart` works

There's no Docker socket in the bridge container — mounting one would give the bot
root-equivalent control of the host. Instead `/restart` sends `save-all flush` then
`stop` over RCON, and Compose's `restart: unless-stopped` brings the container back.

A useful side effect: an admin restart and a crash-restart follow exactly the same
path, so there's only one recovery behaviour to reason about.

## Backups, restarts, and logs

Three separate concerns, deliberately handled by three different mechanisms.

### Backups — restic to Cloudflare R2

Hourly, deduplicated, encrypted, offsite. Runs with the stack and coordinates
`save-off` / `save-all` / `save-on` over RCON so a backup can never catch a
half-written region file. The world volume is mounted **read-only**.

Backups run whether or not anyone is online — see
[Monitoring that a backup actually happened](#monitoring-that-a-backup-actually-happened)
for why. An idle world costs almost nothing to back up under restic.

**Why not Git LFS.** The original plan stored snapshots in a `skymoss-worlds` repo.
That was the wrong tool:

| | Git LFS | restic |
|---|---|---|
| First backup | 158 MB | ~370 MB |
| Each weekly after | **+158 MB** (full copy) | **+10–50 MB** (changed chunks) |
| A year of weekly | ~8 GB, unprunable | ~2–3 GB, retention reclaims space |
| Deleting old backups | Rewrite history and force-push | `forget --prune` |
| Encryption | None | Client-side, always |

Remote LFS objects cannot be pruned without rewriting history, so storage only ever
grows — and a binary blob gets none of git's diffing or merging benefits in return.
The worlds repo was deleted; restic replaces it entirely.

**Setup** — see `infra/.env.example`. Create an R2 bucket and an API token, fill in
`RESTIC_*` and `R2_*`, then initialise the repository once:

```bash
cd /srv/skymoss-minceraft/infra
set -a; . ./.env; set +a
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  restic/restic init
```

> **`RESTIC_PASSWORD` is not recoverable.** It encrypts the repository; lose it and
> every backup is permanently unreadable. Store it somewhere other than this server —
> a password manager, not `.env` alone.

**Checking on it:**

```bash
docker compose -f infra/docker-compose.yml logs mc-backup | tail -20

# list snapshots
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  restic/restic snapshots
```

**Restoring:**

```bash
docker compose -f infra/docker-compose.yml stop mc
WORLD_VOL=$(docker volume inspect skymoss_mc-data --format '{{ .Mountpoint }}')
sudo mv "$WORLD_VOL/FlyMoss" "$WORLD_VOL/FlyMoss.before-restore"

docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  -v "$WORLD_VOL:/restore" restic/restic restore latest --target /restore

docker compose -f infra/docker-compose.yml start mc
```

Keep `FlyMoss.before-restore` until you've confirmed the restore is good.

**What is excluded, and why it matters.** `DistantHorizons.sqlite` is a regenerable
client-side LOD render cache. In the original FlyMoss world it was **1.5 GB against
370 MB of actual terrain** — 80% of the save, for data the client rebuilds on its
own. Compression does not rescue you: region files are already zlib-compressed
internally, so a 1.8 GB world gzips to 1.7 GB.

### Monitoring that a backup actually happened

Kuma's other checks are polls — they ask "is this up?". A backup that never runs is
the opposite problem: **nothing happens, and silence is indistinguishable from
success.** No amount of polling detects it.

The tool for that is a **Push** monitor, a dead man's switch. Kuma issues a URL, the
backup pings it after each run, and Kuma alerts when the pings stop.

**1. Create the monitor** in Uptime Kuma:

| Field | Value |
|---|---|
| Monitor Type | **Push** |
| Friendly Name | `Backups` |
| Heartbeat Interval | `5400` (90 min — one hourly cycle plus slack) |
| Retries | `1` |

Copy the **Push URL** it shows. Replace its host with the container name so it
resolves on the compose network:

```
http://uptime-kuma:3001/api/push/<token>
```

**2. Point the backup at it** in `infra/.env`:

```
KUMA_BACKUP_PUSH_URL=http://uptime-kuma:3001/api/push/<token>
```

```bash
docker compose -f infra/docker-compose.yml up -d mc-backup
```

The hook runs after every attempt and reports `status=up` on exit code 0,
`status=down` otherwise — so you learn about a *failing* backup immediately, and a
*silent* one within 90 minutes.

**Why `PAUSE_IF_NO_PLAYERS` is now false.** Pausing while the server is empty was
right for tar backups, where every run was a full copy. With restic it saves close to
nothing — an unchanged world produces no new chunks, only a small snapshot record.
What it costs is this monitor: a paused backup and a broken backup look identical
from outside, so after a quiet weekend the switch would fire with nothing wrong.
Running unconditionally makes "no backup in 90 minutes" unambiguously a fault.

**Verify** rather than assume the ping works — a monitor that never fires is worse
than none, because it reads as healthy:

```bash
docker compose -f infra/docker-compose.yml logs mc-backup | tail -20
```

Within an hour the Push monitor should go green. If the log shows
`could not reach Uptime Kuma`, the container has neither `curl` nor `wget`, or the
URL is using `localhost` instead of the container name.

### Monitoring that GitHub polling is alive

Same problem as the backup, one layer up. The bridge's `/health` is a literal:

```ts
app.get('/health', async () => ({ ok: true }));
```

It reports that the web server is listening — nothing about whether polling works. A
hung `await` inside a tick leaves the process healthy, `/health` returning 200, the
container green, and GitHub activity silently never reaching Discord. **An empty
`#ci` looks exactly like a quiet day.** So a second Push monitor:

| Field | Value |
|---|---|
| Monitor Type | **Push** |
| Friendly Name | `GitHub polling` |
| Heartbeat Interval | `300` (5 min — five missed ticks at the default 60s interval) |
| Retries | `1` |
| Resend Notification if Down X times | `0` |

Attach the same Discord notification used by the other monitors.

Copy the **Push URL**, swap the host for the container name, and put it in
`infra/.env`:

```
KUMA_POLLER_PUSH_URL=http://uptime-kuma:3001/api/push/<token>
```

```bash
docker compose -f infra/docker-compose.yml up -d --build bridge
```

`--build`, not plain `up -d`: the bridge is a `build:` service, so `up -d` restarts
the existing image and your code change never ships.

**Why 300 and not tighter.** The heartbeat fires once per tick, so at a 60s interval
the margin is five missed ticks. Setting it to 120 would page on a single slow GitHub
response, and a monitor that cries wolf gets muted — which costs you the outage it
was built for.

**Two mechanisms, deliberately.** The heartbeat fires in a `finally`, so it reflects
"the loop came back round" rather than "everything succeeded". Individual stream
failures — a 403 from a missing token permission, a network blip — still tick, so
they keep the heartbeat alive and are reported separately in `#alerts` after three
consecutive failures, with the error attached:

> 🔴 **GitHub polling failing: pull requests**
> 3 consecutive failures. GitHub activity of this kind is not reaching Discord.

A recovery notice follows when it starts working again, and only if a failure was
announced — a stream that blipped twice and healed stays silent both ways. The
threshold exists because alerting on the first failure would make `#alerts` noisy,
which is the same failure the channel split exists to prevent.

What the heartbeat catches that Discord alerts cannot is *silence*: a wedged poller
has no error to catch and no code running to send anything.

**Verify** — the heartbeat starts on the first tick, so the monitor should go green
within a minute:

```bash
docker compose -f infra/docker-compose.yml logs bridge | grep '\[poll\]'
```

Expect `[poll] ci: watching …` and a `cursors` line at startup. If the log shows
`kuma push failed`, the URL is using `localhost` instead of the container name.

### Nightly restart

Modded servers leak memory and accumulate entity and chunk cruft. `restart-server.sh`
warns at 15/5/1 minutes, flushes the world, then asks the server to **stop** —
Docker's restart policy brings it back, so an admin restart and a crash-restart take
the same path. If nobody is online it skips the countdown.

```bash
sudo cp infra/systemd/skymoss-restart.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skymoss-restart.timer
systemctl list-timers 'skymoss-*'
```

The timer fires at **04:45** so the countdown *ends* at 05:00.

Run it by hand any time: `./infra/restart-server.sh` (or `--now` to skip warnings).

### Log rotation

Docker's default `json-file` driver has **no size cap**. A 200-mod server is chatty
enough to fill `/var/lib/docker` and wedge the host, and the failure presents as
"everything broke at once" rather than anything log-shaped. Every service now caps at
10 MB × 3 files.

Existing containers keep their old unbounded logs until recreated:

```bash
docker compose -f infra/docker-compose.yml up -d --force-recreate
du -sh /var/lib/docker/containers/*/*-json.log | sort -rh | head -5
```

Minecraft's own `logs/` directory is rotated by log4j and needs nothing.

## What you get where

| | Source |
|---|---|
| TPS, tick profiling, lag spikes | `spark` (already in the pack) — `/spark profiler` in game |
| Player count, uptime, downtime alerts | Uptime Kuma |
| Host CPU / RAM / disk | Uptime Kuma, or add Netdata if you want detail |
| Console access, restart | Discord bot |
| Build and release status | the bridge, in `#ci` |

## Troubleshooting

**Commands don't appear in Discord** — the bot needs the `applications.commands`
scope. Re-invite it if it was added with only `bot`.

**`/status` says the server isn't responding, but it's up** — check `RCON_PASSWORD`
matches between `.env` and the running server, and that `enable-rcon=true`.

**"Admin commands are disabled"** — `ADMIN_ROLE_ID` is unset. That's the fail-closed
default.

**Kuma alerts return 401** — the token in the notification header doesn't match
`ALERT_TOKEN`. Restart the bridge after changing `.env`.

**Kuma alerts return 503** — `ALERT_TOKEN` isn't set at all, so the endpoint is off.
