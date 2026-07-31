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
`snapshot-world.sh`, mod installs by the manifest, whitelist by the repo. What was
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

Alerts land in the same `#ci` channel as build and release notifications.

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

### Frequent backups — `mc-backup` sidecar

Runs with the stack. Hourly `tar` backups to `BACKUP_DIR` (default
`/srv/skymoss-backups`), pruned after 7 days, skipped entirely when nobody is
online. It coordinates `save-off` / `save-all` / `save-on` over RCON itself, so a
backup can never catch a half-written region file.

The world volume is mounted **read-only** — a backup tool has no business writing
to the world.

```bash
ls -lht /srv/skymoss-backups | head
docker compose -f infra/docker-compose.yml logs mc-backup | tail -20
```

Restore: stop `mc`, extract the tar over the world volume, start it. Keep the old
world directory until you've confirmed the restore is good.

### Milestone snapshots — weekly, to `skymoss-worlds`

`infra/backup/snapshot-world.sh` compresses the world and commits it to the worlds
repo through Git LFS. This is the offsite, durable, shareable history — the local
backups above don't survive the box dying.

```bash
sudo cp infra/systemd/skymoss-snapshot.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skymoss-snapshot.timer
```

Weekly rather than daily on purpose: a snapshot is ~220 MB, and GitHub LFS gives
1 GB free before it starts costing money. Daily would be ~6.5 GB/month.

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
