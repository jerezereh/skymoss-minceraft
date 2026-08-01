# The Discord ↔ GitHub bridge

Keeps one conversation in two places. A GitHub issue gets a Discord thread; comments
relay both ways; nobody has to leave the surface they're comfortable in.

## How it works

```
GitHub issue opened  ──► forum thread created
GitHub comment       ──► relayed into that thread, as the GitHub author
Discord message      ──► posted as an issue comment, attributed to the Discord user
CI / release events  ──► posted to a separate #ci channel
```

Relayed GitHub comments are posted through a Discord **webhook with a per-message
username and avatar override**, so they appear under each author's own name instead of
all arriving as one anonymous bot.

## Loop prevention

This is the part that matters. Every relay creates a message on the far side, and that
creation fires an event indistinguishable from a human posting. Unguarded, one comment
becomes an infinite loop across two platforms in seconds.

Three independent defences, cheapest first:

1. **Author check** — ignore anything authored by our own bot, our GitHub token's
   account, or any webhook. Catches the common case with no database round-trip.
2. **Marker** — relayed GitHub comments carry an HTML comment marker. This survives
   the database being lost or rebuilt.
3. **`message_links`** — the authoritative record. Every relayed message is stored
   under both its GitHub comment ID and its Discord message ID; a known ID is never
   relayed again.

Any one would usually do. All three are there because the failure is loud, public, and
hits both platforms' rate limits at once. `src/db.test.ts` covers this specifically —
including that a GitHub ID can never cross-match a Discord ID.

## Database

SQLite, at `DATABASE_PATH`. **The live `.db` is not in git** — it is a binary that
rewrites on every message and would conflict on every pull. `migrations/` is the source
of truth for its shape and is applied automatically at startup.

| Table | Purpose |
|---|---|
| `issue_threads` | issue ↔ thread mapping |
| `message_links` | every relayed message, both IDs — loop prevention |
| `actors` | Discord user ↔ GitHub login |
| `event_log` | append-only audit of everything handled |

Back it up on the host:

```bash
sqlite3 /var/lib/docker/volumes/skymoss_bridge-data/_data/bridge.db \
  ".backup '/srv/backups/bridge-$(date +%F).db'"
```

> Losing `message_links` un-protects the relay against echoing anything it had already
> relayed. Restore from backup rather than starting fresh on a live channel.

## Setup

### Discord

1. Create an application and bot at <https://discord.com/developers/applications>.
2. Enable the **Message Content Intent** — without it the bot receives empty message
   bodies and the Discord→GitHub direction silently relays nothing.
3. Invite with scopes `bot applications.commands` and permissions: View Channels,
   Send Messages, Send Messages in Threads, Create Public Threads, Manage Webhooks,
   Add Reactions, Read Message History.
4. Make the issue channel a **forum** channel. A text channel works as a fallback but
   threads are tidier in a forum.

### GitHub

Fine-grained PAT on the repo → `GITHUB_TOKEN`, with four permissions:

| Permission | Needed for |
|---|---|
| Issues: **read & write** | relaying issues and comments, both directions |
| Pull requests: read | announcing opened PRs |
| Contents: read | announcing published releases |
| Actions: read | announcing failed builds |

Only the first is needed for the bridge's core job; the other three are the polled CI
notifications. A token missing one of them fails that stream alone with a 403, logged
as `[poll] ci: <stream> failed`, and the others keep working.

No repo secrets are needed: pull requests, releases, and failed builds are **polled**,
not pushed. Webhooks are **optional** — see below.

> Repo secrets (`BRIDGE_URL`, `CI_EVENT_SECRET`) used to be listed here for CI
> notifications pushed from GitHub Actions. That never worked and could not: a
> GitHub-hosted runner has no route to a bridge on a private network, so every
> notify job skipped silently from the first commit through release v0.2.0.
> `mirror-sync.yml` still uses that path, and legitimately — it runs on a
> **self-hosted** runner on the host, where `http://bridge:3000` resolves.

### Webhooks vs polling

GitHub→Discord works two ways, and they can run together.

**Polling** (default) asks GitHub for changes every `GITHUB_POLL_INTERVAL` seconds.
It needs no inbound connectivity, so it works with no domain and no tunnel. Five API
calls per tick — issues, comments, pull requests, releases, failed workflow runs —
about 6% of the rate limit at 60s. The trade is latency: a comment takes up to a
minute to appear.

Failed builds are polled; **successful ones are not reported at all.** Under an
enforced PR flow every change produces a run, and the green tick is already on the PR
that caused it. Announcing successes fills the channel with messages nobody reads,
which is how a notification channel stops working.

**Webhooks** are instant, but GitHub needs a public hostname to POST to. If you have
one, add a repo webhook → `https://bridge.yourdomain.com/webhook/github`, content type
`application/json`, secret matching `GITHUB_WEBHOOK_SECRET`, events **Issues** and
**Issue comments**.

With no secret set, `/webhook/github` returns 503 rather than accepting unverified
payloads — an unauthenticated relay endpoint would let anyone post into your Discord.

Running both is safe: `message_links` dedups whichever path sees an event second.

The poll cursor lives in the `poll_state` table, so a restart doesn't replay old
comments or skip ones that arrived while the bridge was down. On a first run it starts
from *now* rather than relaying the repo's entire history into Discord.

The bot posting as its own account is why the author check works — don't use a PAT
belonging to a human who also comments on issues, or their real comments will be
ignored as self-authored.

## Usage

- Talk in a thread → it lands on the issue.
- Start a line with `//` → local aside, not relayed. Useful for chatter.
- A ✅ reaction means the message reached GitHub.

## Backfill

Issues created before the bridge existed have no thread. To create them:

```bash
PAYLOAD='{}'
SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$CI_EVENT_SECRET" -r | cut -d' ' -f1)"
curl -X POST https://bridge.yourdomain.com/admin/backfill \
  -H 'Content-Type: application/json' -H "X-Skymoss-Signature: $SIG" -d "$PAYLOAD"
```

Safe to re-run — it skips issues that already have a thread, and paces itself to stay
under Discord's channel-creation rate limit.

## Bots and agents

Agents are first-class: they post through the same GitHub or Discord APIs and are
relayed identically. `actors.kind` distinguishes `human` / `bot` / `agent`.

The one thing to watch is that a bot commenting **as the bridge's own GitHub account**
will be ignored by defence 1. Give agents their own identity.

## Development

```bash
cd bridge
npm install
npm run typecheck
npm test
```

Tests cover formatting, loop prevention and CI routing without needing Discord or
GitHub credentials. For a live loop, use `smee.io` to forward webhooks to localhost.

### Deploying a code change

The bridge is a `build:` service, not a pulled image. `docker compose up -d bridge`
**reuses the existing image** and will happily restart the container running the old
code — it only builds when the image is missing. Code changes need `--build`:

```bash
cd ~/skymoss-minceraft && git pull
docker compose -f infra/docker-compose.yml up -d --build bridge
```

Plain `up -d` is correct for `.env` changes and nothing else. To confirm which code
is running, look for this at startup:

```
[poll] ci: watching pull requests, releases, failed runs
```

## Troubleshooting

**Discord→GitHub silently does nothing** — Message Content Intent is off.

**Messages relay twice** — the DB was reset or a second instance is running. Check for
duplicate rows in `message_links` and confirm only one container is up.

**401 on webhooks** — the secret differs between GitHub and `.env`, or a proxy is
re-serializing the body. The HMAC is computed over the exact raw bytes.

**Nothing in #ci** — pull requests, releases and failed builds arrive by polling, so
check the bridge log for `[poll] ci:` lines rather than a workflow step. On first
start the cursors are seeded to *now*, deliberately: anything that already existed is
not replayed into Discord. Only the first new event after that shows up.

**Nothing in #alerts** — `DISCORD_ALERT_CHANNEL_ID` unset falls back to `#ci`, so
alerts are not lost, just co-located.
